// 云端 Agent 后端（Qoder Cloud Agents，下称 QCA）：员工不走自建 OpenAI 兼容端点，而是挂云上已有的 agent。
// 三条边界：
// 1) PAT 只在服务端解出来用，接口只回尾号；出网地址照旧过 safeApiBaseUrl（线上只收 https，本机调试才放行内网）。
// 2) 上下文权威在 WorkStream：每一轮把我们组好的 memory + 摘要 + 窗口压成一条 user.message 发过去，
//    云端 session 只当云端侧的缓存，所以按 (员工, 群) 各存一条——共用一条会让不同群在云端串台。
// 3) 工具回路在云端：QCA agent 用它自己的工具集，我们的群工具对它不可见，所以这条路径不注入 tools。
//    思考链也不回群里：只取 agent.message 里 type=text 的块，thinking / 工具块一律丢掉。
import { Interrupted, Halt, EGRESS_JSON_MAX_BYTES, EGRESS_JSON_TIMEOUT_MS, egressJson, newId, now } from "./util.mjs";

const AGENT_ID_RE = /^agent_[A-Za-z0-9_-]{1,80}$/;
const ENV_ID_RE = /^env_[A-Za-z0-9_-]{1,80}$/;
const SESSION_ID_RE = /^sess_[A-Za-z0-9_-]{1,80}$/;
const TURN_TIMEOUT_MS = 180000;
// 与自建端点那条通道同口径：静默 800ms 也问一次要不要掐断。
const IDLE_MS = 800;
const PROMPT_MAX_CHARS = 900_000;
const ENV_SCAN_PAGES = 5;
const API_PREFIX = "/api/v1/cloud";

/** 云端回来的失败：带 code 给界面看是哪一个环节，带 status 让轨迹里能分清鉴权/限流/5xx。
 *  channel 是「这条失败属于哪一族码」的标记：共用的出网工具（util.mjs 的 egressJson）与
 *  共用的读循环（下面的 runSessionTurn）靠它认出"已经是本通道的错，别再翻一遍"。 */
export class QcaError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "QcaError";
    this.channel = "qca";
    this.code = code;
    this.qcaCode = code;
    this.status = status;
  }
}

const statusToCode = (status) =>
  status === 401 || status === 403 ? "qca_access_denied"
    : status === 404 ? "qca_resource_not_found"
    : status === 409 ? "qca_conflict"
    : status === 429 ? "qca_rate_limited"
    : status >= 400 && status < 500 ? "qca_request_rejected"
    : "qca_unavailable";

/**
 * 出网失败的环节 → 云端这一族的码。stream 后端有一份同形状的表（functions/stream.mjs）：
 * 两条通道共用一份出网纪律与一份读循环，但码必须各说各的，界面上才分得清是哪条通道坏了。
 */
const RAISED = {
  origin: ["qca_origin_invalid", 400],
  timeout: ["qca_timeout", 502],
  unreachable: ["qca_unreachable", 502],
  redirect: ["qca_redirect_blocked", 502],
  bad_response: ["qca_bad_response", 502],
  too_large: ["qca_response_too_large", 502],
  session_error: ["qca_session_error", 502],
  unfinished: ["qca_stream_ended_unfinished", 502],
  no_reply: ["qca_no_reply", 502],
};

export const qcaRaise = (kind, status) => {
  if (kind === "status") return new QcaError(statusToCode(status), status);
  const [code, fallback] = RAISED[kind];
  return new QcaError(code, status ?? fallback);
};

/** 一次 JSON 请求。path 是从 origin 起的绝对路径（含前缀），由调用方带：
 *  stream 后端的 dedicated 档复用同一份读循环时带的是它自己的前缀。 */
const call = ({ origin, pat, path, method = "GET", body, timeoutMs = EGRESS_JSON_TIMEOUT_MS, raise = qcaRaise }) =>
  egressJson({
    origin, path, method, body, token: pat, timeoutMs, maxBytes: EGRESS_JSON_MAX_BYTES, raise,
  });

/** 员工用的 environment：优先用建档时存下的那条；没有就先找可复用的，找不到才建。 */
async function ensureEnvironment({ db, agent, origin, pat }) {
  if (ENV_ID_RE.test(String(agent.qca_environment_id ?? ""))) return agent.qca_environment_id;
  let page;
  for (let index = 0; index < ENV_SCAN_PAGES; index += 1) {
    const list = await call({
      origin, pat,
      path: `${API_PREFIX}/environments?limit=100${page ? `&page=${encodeURIComponent(page)}` : ""}`,
    });
    if (!Array.isArray(list?.data)) throw new QcaError("qca_bad_response", 502);
    const usable = list.data.find((row) => !row?.archived_at && ENV_ID_RE.test(String(row?.id ?? "")));
    if (usable) {
      await rememberEnvironment(db, agent, usable.id);
      return usable.id;
    }
    if (!list.has_more) break;
    if (typeof list.next_page !== "string" || !list.next_page) throw new QcaError("qca_bad_response", 502);
    page = list.next_page;
  }
  const created = await call({
    origin, pat, method: "POST", path: `${API_PREFIX}/environments`,
    body: { name: `workstream-${String(agent.name ?? agent.id).slice(0, 24)}`, config: { type: "cloud" } },
  });
  if (!ENV_ID_RE.test(String(created?.id ?? ""))) throw new QcaError("qca_bad_response", 502);
  await rememberEnvironment(db, agent, created.id);
  return created.id;
}

async function rememberEnvironment(db, agent, environmentId) {
  // 写回失败不阻断本轮（下一轮再探测一次），但也不能无声：抛出去让这轮任务标失败，
  // 免得界面显示"已连上云端 Agent"而其实每轮都在重复建 environment。
  const patched = await db.agents.patch([["id", agent.id]], { qca_environment_id: environmentId, updated_at: now() }, { returning: false });
  if (!patched) throw new QcaError("qca_environment_unstored", 503);
  agent.qca_environment_id = environmentId;
}

/** 每个 (员工, 群) 一条云端 session；转录由我们每轮重发，session 只是云端侧的对话缓存。
 *  persist=false 用于压缩这类"一次性提问"：不缓存到群里那条 session，免得摘要指令混进对话史。 */
async function ensureSession({ db, agent, streamId, origin, pat, environmentId, persist = true }) {
  if (!persist) {
    const fresh = await call({
      origin, pat, method: "POST", path: `${API_PREFIX}/sessions`,
      body: { agent: { type: "agent", id: agent.qca_agent_id }, environment_id: environmentId },
    });
    if (!SESSION_ID_RE.test(String(fresh?.id ?? ""))) throw new QcaError("qca_bad_response", 502);
    return fresh.id;
  }
  const existing = await db.qca_sessions.first(
    [["agent_id", agent.id], ["stream_id", streamId]],
    { columns: "id,session_id" },
  );
  if (existing && SESSION_ID_RE.test(String(existing.session_id ?? ""))) return existing.session_id;
  const created = await call({
    origin, pat, method: "POST", path: `${API_PREFIX}/sessions`,
    body: { agent: { type: "agent", id: agent.qca_agent_id }, environment_id: environmentId },
  });
  if (!SESSION_ID_RE.test(String(created?.id ?? ""))) throw new QcaError("qca_bad_response", 502);
  if (existing) {
    const patched = await db.qca_sessions.patch([["id", existing.id]], { session_id: created.id, updated_at: now() }, { returning: false });
    if (!patched) throw new QcaError("qca_session_unstored", 503);
  } else {
    const inserted = await db.qca_sessions.insert({
      id: newId(), agent_id: agent.id, stream_id: streamId, session_id: created.id,
      created_at: now(), updated_at: now(),
    }, { columns: "id" });
    if (!inserted) throw new QcaError("qca_session_unstored", 503);
  }
  return created.id;
}

/** 把已经组好的 messages 压成一条正文：云端 agent 有自己的 system，我们只能用正文把设定与上下文递过去。 */
export function flattenPrompt(messages) {
  const label = { system: "设定与技能说明", user: "群上下文与本次指令", assistant: "你之前的回复" };
  const blocks = (messages ?? []).map((message) => {
    const content = typeof message?.content === "string" ? message.content : "";
    return `〔${label[message?.role] ?? String(message?.role ?? "上下文")}〕\n${content}`;
  });
  const prompt = blocks.join("\n\n");
  if (Array.from(prompt).length > PROMPT_MAX_CHARS) throw new QcaError("qca_prompt_too_large", 413);
  return prompt;
}

/** 只认 text 块：云端把思考链与工具调用也塞在 content 里，进群聊的那一段必须是正文。
 *  导出给 stream 后端的 dedicated 档复用（functions/stream.mjs）：那一档的帧词表与这里逐字相同。 */
export function textOf(event) {
  const blocks = Array.isArray(event?.content) ? event.content : [];
  return blocks.filter((block) => block?.type === "text" && typeof block?.text === "string")
    .map((block) => block.text)
    .join("");
}

/** 一条 SSE 帧里的 data: 字段拼起来（注释行与 event: 行丢掉）。没有 data 就回空串。
 *  导出给 stream 后端复用：它那边要先认出 `[DONE]` 哨兵再决定解不解 JSON。 */
export function dataOf(raw) {
  return raw.split(/\r?\n/).filter((line) => !line.startsWith(":"))
    .filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
}

/** 一条 SSE 帧 → JSON 对象；解析不了的丢掉。
 *  导出给 stream 后端复用：两档的帧词表不同，但「只用 data: 行 + JSON」这一层是同一件事。 */
export function parseFrame(raw) {
  const data = dataOf(raw);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * 一轮云端对话：先连流再发问（连晚了会错过增量），收到规范的 agent.message 就收工。
 * 增量只用来在中断时交出半截正文；权威文本以 buffered agent.message 为准。
 * 路径与错误码由调用方给（默认是云端那一套）：stream 后端的 dedicated 档复用这一份读循环，
 * 只换前缀与码族——静默也问 onInterrupt、半截上交这些语义不该在第二处重新实现一遍。
 */
const CLOUD_PATHS = {
  stream: (sessionId) => `${API_PREFIX}/sessions/${sessionId}/events/stream?event_deltas%5B%5D=agent.message`,
  events: (sessionId) => `${API_PREFIX}/sessions/${sessionId}/events`,
};

export async function runSessionTurn({
  origin, pat, sessionId, prompt, timeoutMs = TURN_TIMEOUT_MS, onInterrupt,
  paths = CLOUD_PATHS, raise = qcaRaise, mode = "qca",
}) {
  const controller = new AbortController();
  const lifetime = setTimeout(() => controller.abort(), timeoutMs);
  let draft = "";
  let replyId = "";
  try {
    const streamResponse = await fetch(
      new URL(paths.stream(sessionId), origin).href,
      {
        headers: { authorization: `Bearer ${pat}`, accept: "text/event-stream" },
        redirect: "manual",
        signal: controller.signal,
      },
    );
    if (!streamResponse.ok || !streamResponse.body) {
      await streamResponse.body?.cancel().catch(() => {});
      throw raise("status", streamResponse.status);
    }
    const sent = await call({
      origin, pat, method: "POST", path: paths.events(sessionId),
      body: { events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }] },
      raise,
    });
    const sentIds = new Set((Array.isArray(sent?.data) ? sent.data : [])
      .map((event) => String(event?.id ?? "")).filter(Boolean));

    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inflight = null;
    const ensureRead = () => {
      if (!inflight) inflight = reader.read().then((result) => { inflight = null; return result; });
      return inflight;
    };
    const stopNow = async () => {
      if (!onInterrupt) return;
      const stop = await onInterrupt();
      if (!stop) return;
      await reader.cancel().catch(() => {});
      throw new Interrupted({ ...stop, partial: draft });
    };
    try {
      for (;;) {
        let timer;
        const idle = new Promise((resolve) => { timer = setTimeout(() => resolve("idle"), IDLE_MS); });
        const outcome = await Promise.race([ensureRead().then((result) => ({ result })), idle])
          .finally(() => clearTimeout(timer));
        if (outcome === "idle") {
          // 云端 agent 跑自己的工具时可能很久不吐 agent.message 增量：静默也要问一次要不要停，
          // 否则这条通道的 preempt 只能等到 180s 整轮超时，跟自建端点那条差一截。
          await stopNow();
          continue;
        }
        if (outcome.result.done) break;
        buffer += decoder.decode(outcome.result.value, { stream: true });
        const completed = buffer.split(/\r?\n\r?\n/);
        buffer = completed.pop() ?? "";
        for (const raw of completed) {
          const frame = parseFrame(raw);
          if (!frame) continue;
          if (frame.type === "session.error" || frame?.event?.type === "session.error") {
            throw raise("session_error", 502);
          }
          if (frame.type === "event_delta" && frame?.delta?.content?.type === "text") {
            draft += String(frame.delta.content.text ?? "");
            continue;
          }
          const event = frame.type === "agent.message" ? frame : frame?.event;
          if (event?.type === "agent.message" && !sentIds.has(String(event?.id ?? ""))) {
            const content = textOf(event);
            if (content) {
              replyId = String(event.id ?? "");
              return {
                content, reasoning: "", usage: null, finish_reason: "stop", first_token_ms: null,
                mode, session_id: sessionId, reply_event_id: replyId,
              };
            }
          }
        }
        // 分片边界问一次要不要停：群里有人插话时，云端这轮的生成就地放弃，半截正文交给上层。
        await stopNow();
      }
    } finally {
      reader.releaseLock();
    }
    // 流走完还没拿到规范正文：不能拿半截增量冒充回复，如实报错让这轮标失败。
    throw raise(replyId || draft ? "unfinished" : "no_reply", 502);
  } catch (error) {
    // channel 标记认「这条失败已经是本通道的码」：共用读循环的两条通道各有各的族，
    // 按 instanceof 认会把对方那一族的错再翻一遍，界面上就分不清是哪条通道坏了。
    if (error instanceof Interrupted || error?.channel) throw error;
    if (error?.name === "AbortError") throw raise("timeout", 504);
    throw raise("unreachable", 502);
  } finally {
    clearTimeout(lifetime);
    controller.abort();
  }
}

/** 引擎侧唯一入口：agent.backend === "qca" 时走这里，返回形状与 chatCompletion 一致。 */
export async function askCloudAgent({
  db, agent, streamId, pat, messages, timeoutMs = TURN_TIMEOUT_MS, onInterrupt, persistSession = true,
}) {
  if (!AGENT_ID_RE.test(String(agent.qca_agent_id ?? ""))) throw new QcaError("qca_agent_id_missing", 400);
  const origin = agent.api_base_url;
  const environmentId = await ensureEnvironment({ db, agent, origin, pat });
  const sessionId = await ensureSession({
    db, agent, streamId, origin, pat, environmentId, persist: streamId && persistSession,
  });
  return runSessionTurn({ origin, pat, sessionId, prompt: flattenPrompt(messages), timeoutMs, onInterrupt });
}

/** 建档/自检用的轻量校验：拉一次模型清单，确认 PAT 与 origin 成对且云端可达。 */
export async function checkCloudAccess({ origin, pat }) {
  const list = await call({ origin, pat, path: `${API_PREFIX}/models?limit=1` });
  if (!Array.isArray(list?.data)) throw new QcaError("qca_bad_response", 502);
  return { reachable: true, models: list.data.length };
}

/** 云端 agent 清单里挑一个 id：创建表单粘控制台链接时也用它做校验。 */
export function parseAgentId(value) {
  const raw = String(value ?? "").trim();
  const direct = raw.match(AGENT_ID_RE)?.[0];
  if (direct) return direct;
  try {
    const found = new URL(raw).pathname.match(/agent_[A-Za-z0-9_-]{1,80}/)?.[0];
    if (found) return found;
  } catch {
    // 不是 URL 就按原样判失败，让界面报 qca_agent_id_invalid，而不是悄悄换成别的。
  }
  throw new Halt("qca_agent_id_invalid", 400);
}
