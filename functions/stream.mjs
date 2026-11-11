// Stream Server 后端：员工挂在一台按 Stream Server API Specification v1.0.0 提供接口的执行 server 上。
// 规范的机器可读表在 functions/streamspec.mjs，这里只是它的客户端。
//
// 三条边界（与云端那条同口径）：
// 1) 令牌只在服务端解出来用，接口只回尾号；出网地址建档时就过了 safeApiBaseUrl，凭据永不落日志。
// 2) 上下文权威在 WorkStream。shared 档每轮把 messages + tools 整个发过去——对方不挂我们的库、
//    也不认识"哪个员工"，所以一台 server 可以分时替任意多个员工干活；dedicated 档把上下文压成一条正文。
// 3) 走哪一档不是猜的：发现响应说了算，发现失败就退回 OpenAI 兼容那一档，结论写进 agents.stream_profile。
//    写它的只有建档/改档/自检三个主人动作，不是一轮任务——提示词措辞与工具注入都发生在调用之前，
//    那一格空着或写着错值，群里看到的就是模型照工具说明写了正文、却一个也发不出去。
import { Interrupted, EGRESS_JSON_MAX_BYTES, EGRESS_JSON_TIMEOUT_MS, egressJson, newId, now } from "./util.mjs";
import { dataOf, flattenPrompt, runSessionTurn } from "./qca.mjs";
import { normalizeUsage } from "./usage.mjs";
import {
  DEDICATED_PROFILE, DISCOVERY_REASONS, ERROR_CODES, FALLBACK_PROFILE, INTERRUPTED_REASON, SHARED_PROFILE,
  STREAM_DONE, STREAM_PROFILE_VALUES, endpointPath, isSegment, parseDescriptor, pickProfile,
} from "./streamspec.mjs";

const TURN_TIMEOUT_MS = 180000;
// 与另外两条出网通道同口径：静默 800ms 也问一次要不要掐断。
const IDLE_MS = 800;

/** 规范那一族码的全集：对方错误正文里带的码只认这些，别的按状态码翻。
 *  认下一个我们字典里没有的标识，界面上就成了「出错了：<内部字符串>」。 */
const KNOWN_CODES = new Set([...ERROR_CODES.client, ...ERROR_CODES.server]);

/** 这台执行 server 回来的失败：带 code 给界面看是哪一个环节，带 status 让轨迹里能分清鉴权/限流/5xx。 */
export class StreamError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "StreamError";
    this.channel = "stream";
    this.code = code;
    this.streamCode = code;
    this.status = status;
  }
}

/** 404 默认是"这条路对方没实现"；取某一轮结果那条自己把它改判成 stream_turn_not_found。 */
const statusToCode = (status) =>
  status === 401 || status === 403 ? "stream_unauthorized"
    : status === 404 || status === 405 ? "stream_endpoint_missing"
    : status === 413 ? "stream_payload_too_large"
    : status === 429 ? "stream_unavailable"
    : status >= 400 && status < 500 ? "stream_bad_request"
    : "stream_unavailable";

/** 出网失败的环节 → 这一族的码。形状与 functions/qca.mjs 的 RAISED 逐格对称：
 *  两条通道共用 util.mjs 的出网纪律与 qca.mjs 的读循环，只有码族各自一份。 */
const RAISED = {
  origin: ["stream_origin_invalid", 400],
  timeout: ["stream_timeout", 504],
  unreachable: ["stream_unreachable", 502],
  redirect: ["stream_redirect_blocked", 502],
  bad_response: ["stream_bad_response", 502],
  too_large: ["stream_response_too_large", 502],
  session_error: ["stream_session_error", 502],
  unfinished: ["stream_turn_incomplete", 502],
  no_reply: ["stream_no_reply", 502],
};

export const streamRaise = (kind, status, bodyCode) => {
  if (kind === "status") {
    return new StreamError(KNOWN_CODES.has(bodyCode) ? bodyCode : statusToCode(status), status);
  }
  const [code, fallback] = RAISED[kind];
  return new StreamError(code, status ?? fallback);
};

const call = ({ origin, token, path, method = "GET", body, timeoutMs = EGRESS_JSON_TIMEOUT_MS }) =>
  egressJson({
    origin, path, method, body, token, timeoutMs, maxBytes: EGRESS_JSON_MAX_BYTES, raise: streamRaise,
  });

/** 发现与规范路由都挂在服务器根上：档案里的地址允许带路径（退回 OpenAI 兼容那档时要用它拼
 *  /chat/completions），这里只取 origin，否则前缀会拼成 <base>/v1/stream-server/v1。 */
function originOf(agent) {
  try {
    return new URL(agent.api_base_url).origin;
  } catch {
    throw new StreamError("stream_origin_invalid", 400);
  }
}

/** 发现失败分两种，写进档案之前必须分清：
 *  持久型 = 对方答了，但答的那份东西不是规范（没有这条路 / 正文不是描述符）。退回 OpenAI 兼容那一档
 *  是这台服务器的事实，可以当结论存下来。
 *  临时型 = 压根没答上（连不上、超时、鉴权被拒、被重定向拦下）。存下来就是把一次故障钉成对它的永久判决：
 *  它恢复以后我们会一直按退回那一档跑，而界面上再没有一处说得出这件事曾经发生过。 */
const DURABLE_DISCOVERY_FAILURES = new Set([
  "stream_endpoint_missing", "stream_bad_response", "stream_response_too_large",
]);

export const isDurableDiscoveryFailure = (code) =>
  DURABLE_DISCOVERY_FAILURES.has(code) || DISCOVERY_REASONS.includes(code);

/**
 * 问一次对方认哪一档。任何失败都退回 OpenAI 兼容那一档，并把理由带回去（码 + 当时读到的值）：
 * 退回不是猜，它会被写进 agents.stream_profile，提示词措辞与工具注入随后都按这一档走。
 */
export async function discoverStreamServer({ origin, token, timeoutMs = EGRESS_JSON_TIMEOUT_MS }) {
  let body;
  try {
    body = await call({ origin, token, path: endpointPath("discovery"), timeoutMs });
  } catch (error) {
    return {
      descriptor: null,
      profile: FALLBACK_PROFILE,
      code: error?.streamCode ?? "stream_unreachable",
      detail: typeof error?.status === "number" ? String(error.status) : null,
      status: Number.isFinite(Number(error?.status)) ? Number(error.status) : 502,
    };
  }
  const { descriptor, code, detail } = parseDescriptor(body);
  if (!descriptor) {
    return { descriptor: null, profile: FALLBACK_PROFILE, code, detail, status: 200 };
  }
  return { descriptor, profile: pickProfile(descriptor), code: null, detail: null, status: 200 };
}

/** 建档/改档那一步问清楚这一档，返回要存进 agents.stream_profile 的值。
 *  临时型失败抛回调用方（agents.mjs 翻成 Halt），档案一个字都不改——
 *  留着旧值也比写一个"这次没连通"的假结论强。 */
export async function probeStreamProfile({ baseUrl, token }) {
  const found = await discoverStreamServer({ origin: originOf({ api_base_url: baseUrl }), token });
  if (found.descriptor) return found.profile;
  if (!isDurableDiscoveryFailure(found.code)) throw new StreamError(found.code, found.status);
  return FALLBACK_PROFILE;
}

/** 自检用：重新发现一次，如实报对方声明了什么，并说明这个结论能不能写进档案。
 *  storable=false 就是"这次压根没答上"——既不该存，也不该被读成"这台 server 只会 OpenAI 兼容"。 */
export async function checkStreamAccess({ baseUrl, token }) {
  const found = await discoverStreamServer({ origin: originOf({ api_base_url: baseUrl }), token });
  return {
    storable: Boolean(found.descriptor) || isDurableDiscoveryFailure(found.code),
    speaks_spec: found.profile !== FALLBACK_PROFILE,
    profile: found.profile,
    spec: found.descriptor?.spec ?? null,
    profiles: (found.descriptor?.profiles ?? []).map((entry) => entry.id),
    label: found.descriptor?.label ?? null,
    models: found.descriptor?.models ?? null,
    code: found.code,
    detail: found.detail,
  };
}

/**
 * 这一轮走哪一档：只读档案里那一个值。
 * 发现发生在建档/改档/自检三个主人动作里，不在一轮任务里——这一格决定提示词措辞与工具注入，
 * 两样都发生在调用之前；等到这里才发现，措辞已经按错的那一档拼完了。
 * 空值或表外的值就地抛：静默按某一档跑就是群里那次假执行。
 */
function profileOf(agent) {
  const cached = agent?.stream_profile ?? null;
  if (!STREAM_PROFILE_VALUES.includes(cached)) throw new StreamError("stream_profile_unknown", 500);
  return cached;
}

/** turn.done 里的工具调用 → 引擎认的那一种形状。没有函数名的丢掉：那不是一个可执行的调用，
 *  递给引擎只会在 TOOL_HANDLERS 里查不到，报一句和真实原因无关的 tool_not_allowed。 */
function normalizeToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => typeof entry?.function?.name === "string" && entry.function.name)
    .map((entry) => ({
      id: typeof entry.id === "string" && entry.id ? entry.id : `call_${newId().slice(0, 8)}`,
      type: "function",
      function: {
        name: entry.function.name,
        arguments: typeof entry.function.arguments === "string" && entry.function.arguments
          ? entry.function.arguments
          : "{}",
      },
    }));
}

/** turn.done / GET 结果里的权威一轮 → 引擎认的返回形状。content 必须是字符串：
 *  规范把它定成权威正文，缺了这一格就不是"这轮没内容"而是"对方没按规范回"。 */
function turnResult(done, { turnId, profile, deltas }) {
  if (typeof done.content !== "string") throw streamRaise("bad_response", 502);
  const finishReason = typeof done.finish_reason === "string" ? done.finish_reason : null;
  // 服务器自己叫停了这一轮（不是我们这边插话）：半截正文不能当成回复发进群。
  // 照引擎已有的口径交上去——它按 stopped 把这封信结在 cancelled。
  if (finishReason === INTERRUPTED_REASON) throw new Interrupted({ stopped: true, partial: done.content });
  const toolCalls = normalizeToolCalls(done.tool_calls);
  if (!done.content && !toolCalls.length) throw streamRaise("no_reply", 502);
  const reported = Number(done.first_token_ms);
  return {
    mode: "stream",
    profile,
    turn_id: turnId,
    content: done.content,
    // 权威帧没带思考链就用增量累加的那一份：两者都来自这一轮，不是拿声明值冒充口径。
    reasoning: typeof done.reasoning === "string" ? done.reasoning : deltas.reasoning,
    finish_reason: finishReason,
    // 对方没回报首字延迟就按我们自己量到的那个；一个增量都没收到就是量不到，留 null 不编数字。
    first_token_ms: Number.isFinite(reported) ? reported : deltas.firstTokenMs,
    tool_calls: toolCalls,
    usage: normalizeUsage(done.usage),
  };
}

/** 取一轮的权威结果。连接断了以后问一次：对方可能在我们断线之后才写完。
 *  问不到就退回原来那个失败——这一发只是补救，不许把"问不到"变成一个新的错。 */
async function fetchTurn({ origin, token, turnId }) {
  try {
    return await call({ origin, token, path: endpointPath("getTurn", { turn_id: turnId }) });
  } catch (error) {
    if (error?.status === 404) throw new StreamError("stream_turn_not_found", 404);
    throw error;
  }
}

/** 叫停这一轮：先告诉服务器别再烧 token，再掐自己的读循环。
 *  这一发失败不追——读循环已经放弃了这一轮，最坏是服务器自己跑到超时，它不知道我们走了。 */
const interruptTurn = ({ origin, token, turnId }) =>
  call({ origin, token, method: "POST", path: endpointPath("interruptTurn", { turn_id: turnId }) })
    .catch(() => {});

/** shared 档的读循环：turn.delta 累加、turn.done 权威、turn.error 对方报错、`[DONE]` 收尾。 */
async function readTurnStream({ body, origin, token, turnId, onInterrupt, started }) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deltas = { content: "", reasoning: "", firstTokenMs: null };
  let buffer = "";
  let done = null;
  let sawDone = false;
  const stopNow = async () => {
    if (!onInterrupt) return;
    const stop = await onInterrupt();
    if (!stop) return;
    await interruptTurn({ origin, token, turnId });
    await reader.cancel().catch(() => {});
    throw new Interrupted({ ...stop, partial: deltas.content });
  };
  try {
    for (;;) {
      let timer;
      const idle = new Promise((resolve) => { timer = setTimeout(() => resolve("idle"), IDLE_MS); });
      const outcome = await Promise.race([reader.read().then((result) => ({ result })), idle])
        .finally(() => clearTimeout(timer));
      if (outcome === "idle") {
        // 对方跑长活时可能很久不吐增量：静默也要问一次要不要停，
        // 否则这条通道的 preempt 只能等到整轮超时，跟自建端点那条差一截。
        await stopNow();
        continue;
      }
      if (outcome.result.done) break;
      buffer += decoder.decode(outcome.result.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const raw of frames) {
        const payload = dataOf(raw);
        if (!payload) continue;
        if (payload === STREAM_DONE) {
          sawDone = true;
          continue;
        }
        let frame;
        try {
          frame = JSON.parse(payload);
        } catch {
          continue;
        }
        // 规范外的帧丢掉：对方多发的东西不该改变这一轮的结果。
        if (frame?.type === "turn.delta") {
          const text = typeof frame.content === "string" ? frame.content : "";
          const thinking = typeof frame.reasoning === "string" ? frame.reasoning : "";
          // 首字延迟按"第一个有用增量"算：思考链的增量先于正文，正文之前的等待同样是用户等到的延迟。
          if (deltas.firstTokenMs === null && (text || thinking)) deltas.firstTokenMs = Date.now() - started;
          deltas.content += text;
          deltas.reasoning += thinking;
        } else if (frame?.type === "turn.done") {
          done = frame;
        } else if (frame?.type === "turn.error") {
          throw streamRaise("status", Number(frame.status) || 502, typeof frame.error === "string" ? frame.error : null);
        }
      }
      await stopNow();
    }
  } finally {
    reader.releaseLock();
  }
  if (!done) {
    // 流断了没等到权威帧：先问一次服务器那一轮到底成没成，问不到再按断流报错。
    const fetched = await fetchTurn({ origin, token, turnId }).catch(() => null);
    if (fetched?.state === "done") done = fetched;
    else if (fetched?.state === "error") {
      throw streamRaise("status", Number(fetched.status) || 502, typeof fetched.error === "string" ? fetched.error : null);
    }
  }
  // 权威帧没来，分两种坏法：收到了 [DONE] 说明对方干净收尾却没给结果（no_reply）；
  // 连 [DONE] 都没有说明这条连接是断的，这时候有半截增量就叫"说到一半断了"（turn_incomplete）。
  // 两种都不许把半截增量冒充回复——照另外两条通道的做法如实报错，让这轮标失败。
  if (!done) {
    const partial = Boolean(deltas.content || deltas.reasoning);
    throw streamRaise(!sawDone && partial ? "unfinished" : "no_reply", 502);
  }
  return turnResult(done, { turnId, profile: SHARED_PROFILE, deltas });
}

/** shared 档：一轮的全部输入都在请求里，服务器不挂我们的库，所以它不需要数据库钥匙。 */
async function runSharedTurn({ origin, token, model, messages, tools, maxTokens, thinking, timeoutMs, onInterrupt }) {
  const started = Date.now();
  // turn_id 由客户端生成：连接断了也要能叫停与取结果，等对方在响应体里回一个 id 就晚了。
  const turnId = newId();
  const controller = new AbortController();
  const lifetime = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(new URL(endpointPath("createTurn"), origin).href, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          turn_id: turnId,
          model,
          messages,
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(thinking ? { thinking } : {}),
          ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
        }),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      throw streamRaise(error?.name === "AbortError" ? "timeout" : "unreachable", 504);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw streamRaise("status", response.status);
    }
    return await readTurnStream({ body: response.body, origin, token, turnId, onInterrupt, started });
  } finally {
    clearTimeout(lifetime);
    controller.abort();
  }
}

/** 每个 (员工, 群) 一条对方那侧的 session：转录由我们每轮重发，session 只是对方的对话缓存。
 *  persist=false 用于压缩这类一次性提问，不缓存到群里那条 session，免得摘要指令混进对话史。 */
async function ensureSession({ db, agent, streamId, origin, token, persist }) {
  const create = async () => {
    const created = await call({
      origin, token, method: "POST", path: endpointPath("createSession"),
      body: { label: `workstream-${String(agent.name ?? agent.id).slice(0, 24)}` },
    });
    // 对方的 session_id 要拼进后面的路由：不合规就地报成本通道的失败，
    // 别等 endpointPath 抛一句只有开发者看得懂的话。
    if (!isSegment(created?.session_id)) throw streamRaise("bad_response", 502);
    return created.session_id;
  };
  if (!persist) return create();
  const existing = await db.stream_sessions.first(
    [["agent_id", agent.id], ["stream_id", streamId]], { columns: "id,session_id" },
  );
  if (existing && isSegment(existing.session_id)) return existing.session_id;
  const sessionId = await create();
  if (existing) {
    const patched = await db.stream_sessions.patch(
      [["id", existing.id]], { session_id: sessionId, updated_at: now() }, { returning: false },
    );
    if (!patched) throw new StreamError("stream_session_unstored", 503);
  } else {
    const inserted = await db.stream_sessions.insert({
      id: newId(), agent_id: agent.id, stream_id: streamId, session_id: sessionId,
      created_at: now(), updated_at: now(),
    }, { columns: "id" });
    if (!inserted) throw new StreamError("stream_session_unstored", 503);
  }
  return sessionId;
}

/** dedicated 档：会话在对方那侧，帧词表沿用云端那一套，所以读循环是同一份（functions/qca.mjs）。 */
async function runDedicatedTurn({ db, agent, streamId, origin, token, messages, timeoutMs, onInterrupt, persistSession }) {
  const sessionId = await ensureSession({
    db, agent, streamId, origin, token, persist: Boolean(streamId) && Boolean(persistSession),
  });
  const result = await runSessionTurn({
    origin,
    pat: token,
    sessionId,
    prompt: flattenPrompt(messages),
    timeoutMs,
    onInterrupt,
    paths: {
      stream: (id) => endpointPath("streamEvents", { session_id: id }),
      events: (id) => endpointPath("postEvents", { session_id: id }),
    },
    raise: streamRaise,
    mode: "stream",
  });
  return { ...result, profile: DEDICATED_PROFILE };
}

/**
 * profile → 实现。规范声明了这一档而这里缺一条，冷启动就抛——照 mcp.mjs 扫「声明了但没实现」的形状，
 * 不留到运行时静默走成别的那一档。
 */
const PROFILE_ROUTES = {
  // 退回的那一档：这台服务器只认 OpenAI 兼容。实现由 TRANSPORT_ROUTES 注入（不是 import）——
  // agents.mjs 要 import 本模块来挂路由，反过来 import 就成了环。
  [FALLBACK_PROFILE]: ({ agent, key, messages, tools, maxTokens, timeoutMs, onInterrupt, openai }) => {
    if (typeof openai !== "function") {
      throw new Error("退回 OpenAI 兼容那一档却没拿到实现：TRANSPORT_ROUTES 要把 chat 那条递进来");
    }
    return openai({ agent, key, messages, tools, maxTokens, timeoutMs, onInterrupt });
  },
  [SHARED_PROFILE]: ({ origin, key, agent, messages, tools, maxTokens, timeoutMs, onInterrupt }) =>
    runSharedTurn({
      origin, token: key, model: agent.model, messages, tools, maxTokens, thinking: agent.think_effort, timeoutMs, onInterrupt,
    }),
  [DEDICATED_PROFILE]: ({ db, agent, streamId, origin, key, messages, timeoutMs, onInterrupt, persistSession }) =>
    runDedicatedTurn({
      db, agent, streamId, origin, token: key, messages, timeoutMs, onInterrupt, persistSession,
    }),
};

{
  const implemented = new Set(Object.keys(PROFILE_ROUTES));
  const declared = new Set(STREAM_PROFILE_VALUES);
  const missing = [...declared].filter((id) => !implemented.has(id));
  const orphan = [...implemented].filter((id) => !declared.has(id));
  if (missing.length || orphan.length) {
    throw new Error(`profile 路由对不上规范：${[...missing.map((id) => `缺实现 ${id}`), ...orphan.map((id) => `规范里没有 ${id}`)].join("、")}`);
  }
}

/**
 * 引擎侧唯一入口：agent.backend === "stream" 时走这里，返回形状与 chatCompletion 一致。
 */
export async function askStreamServer({
  db, agent, streamId, key, messages, tools, maxTokens, timeoutMs = TURN_TIMEOUT_MS,
  onInterrupt, persistSession = true, openai,
}) {
  const profile = profileOf(agent);
  return PROFILE_ROUTES[profile]({
    db, agent, streamId, origin: originOf(agent), key, messages, tools, maxTokens, timeoutMs,
    onInterrupt, persistSession, openai,
  });
}
