// Conformance Test Suite (CTS) for Stream Server API Specification v1.0.0: the exam a server docks against.
//
// 为什么不用客户端当考官：functions/stream.mjs 读流时带着我们的偏好（800ms 静默问停、断线重连取结果、
// 发现失败退回 OpenAI 兼容），拿它量出来的是「我们的客户端能不能用」，不是「对方合不合规范」。这里只按
// 规范表里写得出来的事实判分：路径从 ENDPOINTS 拼、发现响应交给 parseDescriptor、帧词表照 EVENTS 对——
// 表改了考卷跟着改，不存在第二份口径。
//
// 为什么只 import streamspec.mjs：官网的在线自检由我们自己的服务端跑这份文件（浏览器里既没有我们的 util/qca，
// 站点的 connect-src 'self' 与供应商普遍没有的 CORS 也不允许页面直连对方），site 仓的 scripts/cts.mjs 把本文件
// 与 streamspec.mjs 逐字节复制进 api/，复制前后校验同字节。所以这里自带一个有上限的
// 读体与一个 SSE 分片器：分片形状与 functions/qca.mjs 的 parseFrame 一致，dev/smoke.mjs 钉两者同字节同结果。
//
// 判分三档：pass / fail / skip。skip 必须带理由（规范没钉、caps 声明不支持、服务器匿名所以无从验鉴权）。
// 规范没钉的行为不判 fail：供应商没法 conform 一条没写下来的句子，考卷只把它记成观察值放进 detail。
// 上屏的句子（title 与 detail）一律英文：规范与官网自检页都只有英文一份，中文 detail 贴上去就是没译的文案；
// 令牌永不进任何 detail：考卷的错误信息会显示在界面上，也会进 CLI 的输出。
import {
  EVENTS, SPEC_PREFIX, STREAM_DONE, endpointPath, isSegment, parseDescriptor, pickProfile,
} from "./streamspec.mjs";

/** 单条检查的默认上限：一轮正文可以慢，但考卷不能无限等一台不吐字的 server。 */
export const CTS_TIMEOUT_MS = 45_000;
/** 非流式响应正文上限：考卷只读状态码与错误正文，规范里没有一条会更大；读满即停，不整份进内存。 */
const BODY_CAP = 1024 * 1024;

export class CtsInputError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CtsInputError";
    this.code = code;
    this.detail = detail;
  }
}

/** 一条检查内部的失败：被 runConformance 接住记成 fail，detail 就是这句。 */
class CtsCheckError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CtsCheckError";
    this.code = code;
    this.detail = detail;
  }
}

/** origin 只到 scheme://host[:port]：规范的前缀是绝对的，带 basePath 的 origin 会被 new URL 悄悄丢掉路径，
 *  考卷就会去考一台根路径上没有规范的 server，然后把对方的 404 记成自己的结论。 */
function sanitizeOrigin(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new CtsInputError("origin_not_url", String(value).slice(0, 80));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CtsInputError("origin_not_http", url.protocol);
  // 与 vms.gateway_url 同一条纪律：地址里带 user:pass@ 就等于把凭据写进考卷的每一次输出。
  if (url.username || url.password) throw new CtsInputError("origin_carries_credentials");
  if (url.pathname !== "/" && url.pathname) throw new CtsInputError("origin_has_path", url.pathname);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

async function readCappedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
      if (text.length > BODY_CAP) throw new CtsCheckError("response_too_large", `>${BODY_CAP} bytes`);
    }
  } finally {
    reader.releaseLock();
    await response.body.cancel().catch(() => {});
  }
}

/** 一段已分好的 SSE 块 → data 载荷；没有 data 行回空串。注释行（冒号开头）与 event: 行丢掉。
 *  导出是为了让 dev/smoke.mjs 钉它与 functions/qca.mjs 的 dataOf 同字节同结果：浏览器里跑的那份分片器
 *  是这份的复制品（官网在线自检不能 import 我们的读循环），漂了就是在线自检在替供应商撒谎。 */
export function payloadOf(block) {
  return block.split(/\r?\n/).filter((line) => !line.startsWith(":"))
    .filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
}

/** SSE 分片器：只认 `data:` 行 + JSON 与 [DONE] 哨兵，形状与 functions/qca.mjs 的 parseFrame 一致。 */
async function* framesOf(response, timeoutMs) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      let timer;
      const stall = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
      const next = await Promise.race([reader.read(), stall]).finally(() => clearTimeout(timer));
      if (next === null) throw new CtsCheckError("stream_stalled", `no new byte for ${timeoutMs}ms`);
      if (next.done) return;
      buffer += decoder.decode(next.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const payload = payloadOf(block);
        if (!payload) continue;
        if (payload === STREAM_DONE) {
          yield { sentinel: true, value: null };
          continue;
        }
        let value;
        try {
          value = JSON.parse(payload);
        } catch {
          throw new CtsCheckError("frame_not_json", payload.slice(0, 80));
        }
        yield { sentinel: false, value };
      }
    }
  } finally {
    reader.releaseLock();
    await response.body.cancel().catch(() => {});
  }
}

async function call(ctx, { method, path, body, auth = true }) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth && ctx.token) headers.authorization = `Bearer ${ctx.token}`;
  let response;
  try {
    response = await ctx.fetchImpl(new URL(path, `${ctx.origin}/`).href, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
  } catch (error) {
    throw new CtsCheckError("unreachable", error?.message?.slice(0, 120) ?? String(error).slice(0, 120));
  }
  if (response.status >= 300 && response.status < 400) {
    // 重定向到登录页会带着 200 与一页 HTML 回来：manual 之下在这里停下，才分得清「规范答了」与「网关拦了」。
    throw new CtsCheckError("redirected", String(response.status));
  }
  const text = await readCappedText(response);
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, text };
}

const expect = (condition, code, detail = null) => {
  if (!condition) throw new CtsCheckError(code, detail);
};

const codeOf = (result) => String(result?.json?.error ?? "");

/** 状态码 + 错误码一起判：只判码会把「500 里恰好带了这个词」算成合规，只判状态码会把规范的码当成可选。 */
function expectError(result, status, code, where) {
  expect(result.status === status, "wrong_status", `${where}: expected ${status}, read ${result.status} (${codeOf(result) || result.text.slice(0, 60)})`);
  expect(codeOf(result) === code, "wrong_error_code", `${where}: expected ${code}, read ${codeOf(result) || "(no error field)"}`);
}

const freshId = (tag) => `cts-${tag}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/** 读一条流直到结束：返回 { frames, sawDone, doneFrame, errorFrame }，词表之外的 type 记进 unknown。 */
async function collectStream(ctx, response, vocabulary) {
  const frames = [];
  const unknown = [];
  let sawDone = false;
  let doneFrame = null;
  let errorFrame = null;
  for await (const item of framesOf(response, ctx.timeoutMs)) {
    if (item.sentinel) {
      sawDone = true;
      continue;
    }
    frames.push(item.value);
    const type = String(item.value?.type ?? "");
    if (!vocabulary.includes(type)) unknown.push(type || "(no type)");
    if (type === "turn.done") doneFrame = item.value;
    if (type === "turn.error" || type === "session.error") errorFrame = item.value;
  }
  return { frames, unknown, sawDone, doneFrame, errorFrame };
}

const PONG = [{ role: "user", content: "Reply with exactly the word pong and nothing else." }];

const CHECKS = [
  {
    id: "discovery.descriptor",
    profile: "any",
    title: "Discovery answers in the shape the table computes",
    run: async (ctx) => {
      const result = await call(ctx, { method: "GET", path: endpointPath("discovery") });
      expect(result.status === 200, "discovery_not_200", `read ${result.status}`);
      const parsed = parseDescriptor(result.json);
      expect(parsed.descriptor, "descriptor_rejected", `${parsed.code}${parsed.detail ? ` (${parsed.detail})` : ""}`);
      ctx.descriptor = parsed.descriptor;
      const ids = parsed.descriptor.profiles.map((entry) => entry.id);
      if (ctx.wantedProfile) {
        expect(ids.includes(ctx.wantedProfile), "profile_not_declared", `declares ${ids.join(",")}, not ${ctx.wantedProfile}`);
      }
      ctx.profile = ctx.wantedProfile ?? pickProfile(parsed.descriptor);
      ctx.caps = parsed.descriptor.profiles.find((entry) => entry.id === ctx.profile)?.caps ?? null;
      // 发现响应里的 models 是服务器自己说能跑什么：考卷不替供应商猜模型名，缺了才轮到 CLI 的 --model。
      ctx.model = ctx.model ?? parsed.descriptor.models?.[0] ?? null;
      return `spec ${parsed.descriptor.spec}, declares ${ids.join("/")}, examining ${ctx.profile}`;
    },
  },
  {
    id: "discovery.anonymous-or-401",
    profile: "any",
    title: "Without a token: either anonymous, or 401 with the spec's code",
    run: async (ctx) => {
      const result = await call(ctx, { method: "GET", path: endpointPath("discovery"), auth: false });
      if (result.status === 200) {
        ctx.anonymous = true;
        return "server accepts anonymous calls: the two auth checks skip";
      }
      expectError(result, 401, "stream_unauthorized", "discovery without a token");
      return "auth required: 401 with stream_unauthorized";
    },
  },
  {
    id: "auth.wrong-token",
    profile: "any",
    title: "A wrong token is denied, paired with the real token being allowed",
    run: async (ctx) => {
      if (ctx.anonymous) return { skip: "server is anonymous: nothing to verify a wrong token against" };
      const saved = ctx.token;
      ctx.token = `cts-wrong-${freshId("tok")}`;
      try {
        const result = await call(ctx, { method: "GET", path: endpointPath("discovery") });
        expectError(result, 401, "stream_unauthorized", "discovery with a wrong token");
      } finally {
        ctx.token = saved;
      }
      return "wrong token 401, real token 200 (previous check)";
    },
  },
  {
    id: "prefix.fixed",
    profile: "any",
    title: "The prefix is not overridable: the site root must not answer discovery",
    run: async (ctx) => {
      const result = await call(ctx, { method: "GET", path: "/" });
      const parsed = result.status === 200 ? parseDescriptor(result.json) : { descriptor: null };
      expect(!parsed.descriptor, "prefix_overridable", "GET / also answers a discovery descriptor");
      return `the site root is not a discovery response (${result.status})`;
    },
  },
  {
    id: "route.unknown-404",
    profile: "any",
    title: "A path outside the table answers 404 with the spec's code",
    run: async (ctx) => {
      const result = await call(ctx, { method: "GET", path: `${SPEC_PREFIX}/definitely-not-a-route` });
      expectError(result, 404, "stream_endpoint_missing", "a path outside the table");
      return "404 stream_endpoint_missing";
    },
  },
  {
    id: "route.method-405",
    profile: "any",
    title: "Right path, wrong method answers 405, not 404",
    run: async (ctx) => {
      // 两档各挑一条 POST 的路用 GET 敲：404 与 405 分不清的服务器，客户端无从判断「这条路存在但姿势不对」。
      // dedicated 档用一条真建出来的 session：对方先查会话再查方法时，拿不存在的 id 量出来的 404
      // 是「没这个会话」，不是「方法不对」，那一分就量错了地方。
      let path;
      if (ctx.profile === "dedicated") {
        const created = await call(ctx, { method: "POST", path: endpointPath("createSession"), body: { label: "workstream-cts-405" } });
        expect(created.status === 200, "create_session_not_200", `read ${created.status}`);
        expect(isSegment(String(created.json?.session_id ?? "")), "bad_session_id", String(created.json?.session_id ?? "").slice(0, 40));
        path = endpointPath("postEvents", { session_id: created.json.session_id });
      } else {
        path = endpointPath("createTurn");
      }
      const result = await call(ctx, { method: "GET", path });
      expectError(result, 405, "stream_method_not_allowed", "right path, wrong method");
      return "405 stream_method_not_allowed";
    },
  },

  {
    id: "shared.turn.stream",
    profile: "shared",
    title: "One round runs: frames in the vocabulary, turn.done closes, [DONE] ends",
    run: async (ctx) => {
      ctx.turnId = freshId("turn");
      const response = await ctx.fetchImpl(new URL(endpointPath("createTurn"), `${ctx.origin}/`).href, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}),
        },
        body: JSON.stringify({ turn_id: ctx.turnId, model: ctx.model ?? undefined, messages: PONG }),
        redirect: "manual",
      }).catch((error) => {
        throw new CtsCheckError("unreachable", error?.message?.slice(0, 120) ?? String(error).slice(0, 120));
      });
      expect(response.status === 200, "create_turn_not_200", `read ${response.status}`);
      expect(String(response.headers.get("content-type") ?? "").includes("text/event-stream"), "not_sse", String(response.headers.get("content-type")));
      const stream = await collectStream(ctx, response, EVENTS.shared);
      // 词表是「客户端必须读懂哪些帧」，不是线上语法的穷举：多出来的帧客户端忽略即可，判 fail 等于让供应商
      // conform 一条规范没写的禁令；但看见了要记进 detail，观察值不能丢。
      const extra = stream.unknown.length ? `, out-of-vocabulary frames ${stream.unknown.join(",")}` : "";
      expect(stream.errorFrame === null, "turn_error", codeOf({ json: stream.errorFrame }) || "turn.error");
      expect(stream.doneFrame, "no_turn_done");
      expect(stream.sawDone, "no_done_sentinel");
      expect(typeof stream.doneFrame.content === "string" && stream.doneFrame.content.length > 0, "empty_content");
      expect(stream.doneFrame.state === "done", "wrong_state", String(stream.doneFrame.state));
      expect(typeof stream.doneFrame.finish_reason === "string" && stream.doneFrame.finish_reason, "missing_finish_reason");
      ctx.turnDone = stream.doneFrame;
      // caps 是声明，正文是事实：声明 false 却真发了，客户端按声明做的界面就在撒谎。
      const lies = [];
      if (ctx.caps && ctx.caps.usage === false && stream.doneFrame.usage != null) lies.push("usage");
      if (ctx.caps && ctx.caps.reasoning === false && stream.doneFrame.reasoning) lies.push("reasoning");
      expect(lies.length === 0, "caps_contradicted", lies.join(","));
      return `turn.done state=done, ${stream.doneFrame.content.length} chars of content, ${stream.frames.length} frames${extra}`;
    },
  },
  {
    id: "shared.turn.get-equals-stream",
    profile: "shared",
    title: "GET /turns/{id} is the same object the stream's turn.done carried",
    run: async (ctx) => {
      expect(ctx.turnDone, "no_prior_turn", "run shared.turn.stream first");
      const result = await call(ctx, { method: "GET", path: endpointPath("getTurn", { turn_id: ctx.turnId }) });
      expect(result.status === 200, "get_turn_not_200", `read ${result.status}`);
      for (const key of ["turn_id", "state", "content", "finish_reason"]) {
        expect(JSON.stringify(result.json?.[key]) === JSON.stringify(ctx.turnDone[key]), "get_differs_from_stream", key);
      }
      return "turn_id/state/content/finish_reason identical verbatim";
    },
  },
  {
    id: "shared.turn.replay-rejected",
    profile: "shared",
    title: "Replaying a turn_id is rejected (no second upstream burn for one request)",
    run: async (ctx) => {
      expect(ctx.turnId, "no_prior_turn", "run shared.turn.stream first");
      const result = await call(ctx, {
        method: "POST", path: endpointPath("createTurn"), body: { turn_id: ctx.turnId, messages: PONG },
      });
      expectError(result, 400, "stream_bad_request", "a replayed turn_id");
      return "400 stream_bad_request";
    },
  },
  {
    id: "shared.turn.bad-body",
    profile: "shared",
    title: "Empty messages and a slashed turn_id both answer 400",
    run: async (ctx) => {
      const empty = await call(ctx, { method: "POST", path: endpointPath("createTurn"), body: { turn_id: freshId("bad"), messages: [] } });
      expectError(empty, 400, "stream_bad_request", "empty messages");
      const slash = await call(ctx, { method: "POST", path: endpointPath("createTurn"), body: { turn_id: "cts/a", messages: PONG } });
      expectError(slash, 400, "stream_bad_request", "a turn_id carrying a slash");
      return "both bad bodies answer 400 stream_bad_request";
    },
  },
  {
    id: "shared.turn.unknown-404",
    profile: "shared",
    title: "Unknown turn answers 404; a colon id is decoded as an opaque segment",
    run: async (ctx) => {
      const missing = await call(ctx, { method: "GET", path: endpointPath("getTurn", { turn_id: freshId("nope") }) });
      expectError(missing, 404, "stream_turn_not_found", "an unknown turn");
      // endpointPath 会把冒号编码成 %3A：服务器不解码就会把它当另一条路径，回 404 之外的东西。
      const colon = await call(ctx, { method: "GET", path: endpointPath("getTurn", { turn_id: "cts:probe-1" }) });
      expectError(colon, 404, "stream_turn_not_found", "a turn_id carrying a colon");
      return "two 404 stream_turn_not_found";
    },
  },
  {
    id: "shared.interrupt.accepted",
    profile: "shared",
    title: "A stop answers 200 and the stream still closes with turn.done (half a body, not an error frame)",
    run: async (ctx) => {
      if (ctx.caps && ctx.caps.interrupt === false) return { skip: "caps.interrupt declared false: interrupt may degrade to killing the read loop" };
      const turnId = freshId("int");
      const response = await ctx.fetchImpl(new URL(endpointPath("createTurn"), `${ctx.origin}/`).href, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}),
        },
        body: JSON.stringify({
          turn_id: turnId,
          model: ctx.model ?? undefined,
          messages: [{ role: "user", content: "Count from 1 to 400, one number per line, without commentary." }],
        }),
        redirect: "manual",
      });
      expect(response.status === 200, "create_turn_not_200", `read ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDelta = false;
      let earlyDone = null;
      const deadline = Date.now() + ctx.timeoutMs;
      // 先读到第一个增量再叫停：一上来就掐，量的是「服务器会不会 200」，不是「在跑的那一轮能不能被掐」。
      // 但快服务器可能在叫停之前就结了这一轮——那半截已经读进来的帧不能丢，否则收尾帧被算成没收到。
      while (!sawDelta && !earlyDone && Date.now() < deadline) {
        let timer;
        const stall = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5_000); });
        const next = await Promise.race([reader.read(), stall]).finally(() => clearTimeout(timer));
        if (next === null) continue;
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const payload = payloadOf(block);
          if (!payload || payload === STREAM_DONE) continue;
          let value;
          try {
            value = JSON.parse(payload);
          } catch {
            continue;
          }
          if (value?.type === "turn.delta") sawDelta = true;
          if (value?.type === "turn.done") earlyDone = value;
        }
      }
      reader.releaseLock();
      const stopped = await call(ctx, { method: "POST", path: endpointPath("interruptTurn", { turn_id: turnId }) });
      expect(stopped.status === 200, "interrupt_not_200", `read ${stopped.status} (${codeOf(stopped)})`);
      let doneFrame = earlyDone;
      let errorFrame = null;
      if (earlyDone) {
        await response.body.cancel().catch(() => {});
      } else {
        const stream = await collectStream(ctx, response, EVENTS.shared);
        errorFrame = stream.errorFrame;
        doneFrame = stream.doneFrame;
      }
      expect(errorFrame === null, "interrupt_became_error", codeOf({ json: errorFrame }));
      expect(doneFrame, "no_turn_done_after_interrupt");
      const reason = String(doneFrame.finish_reason ?? "");
      return sawDelta && reason === "interrupted"
        ? "interrupted mid-flight: finish_reason=interrupted"
        : `the round had already settled when the stop arrived (finish_reason=${reason || "none"}): 200 and the stream still closes cleanly`;
    },
  },

  {
    id: "dedicated.session.create",
    profile: "dedicated",
    title: "Creating a session returns a session_id usable as a path parameter",
    run: async (ctx) => {
      const result = await call(ctx, { method: "POST", path: endpointPath("createSession"), body: { label: "workstream-cts" } });
      expect(result.status === 200, "create_session_not_200", `read ${result.status}`);
      expect(isSegment(String(result.json?.session_id ?? "")), "bad_session_id", String(result.json?.session_id ?? "").slice(0, 40));
      ctx.sessionId = result.json.session_id;
      return `session_id is a valid path segment (${String(ctx.sessionId).length} chars)`;
    },
  },
  {
    id: "dedicated.session.turn",
    profile: "dedicated",
    title: "Stream first, then post: agent.message is the authoritative body, thought chains stay out",
    run: async (ctx) => {
      expect(ctx.sessionId, "no_prior_session", "run dedicated.session.create first");
      const response = await ctx.fetchImpl(new URL(endpointPath("streamEvents", { session_id: ctx.sessionId }), `${ctx.origin}/`).href, {
        headers: { accept: "text/event-stream", ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}) },
        redirect: "manual",
      });
      expect(response.status === 200, "stream_events_not_200", `read ${response.status}`);
      const posted = await call(ctx, {
        method: "POST",
        path: endpointPath("postEvents", { session_id: ctx.sessionId }),
        body: { events: [{ type: "user.message", content: [{ type: "text", text: "Reply with exactly the word pong and nothing else." }] }] },
      });
      expect(posted.status === 200, "post_events_not_200", `read ${posted.status}`);
      expect(Array.isArray(posted.json?.data) && posted.json.data.length > 0, "post_events_no_ids");
      const stream = await collectStream(ctx, response, EVENTS.dedicated);
      const extra = stream.unknown.length ? `, out-of-vocabulary frames ${stream.unknown.join(",")}` : "";
      expect(stream.errorFrame === null, "session_error", codeOf({ json: stream.errorFrame }) || "session.error");
      const message = stream.frames.find((frame) => frame?.type === "agent.message");
      expect(message, "no_agent_message");
      const text = (Array.isArray(message.content) ? message.content : []).map((part) => String(part?.text ?? "")).join("");
      expect(text.length > 0, "empty_agent_message");
      ctx.agentText = text;
      return `agent.message ${text.length} chars, ${stream.frames.length} frames${extra}`;
    },
  },
  {
    id: "dedicated.session.reuse",
    profile: "dedicated",
    title: "A second round on the same session (the conversation caches vendor-side)",
    run: async (ctx) => {
      expect(ctx.sessionId, "no_prior_session", "run dedicated.session.create first");
      const response = await ctx.fetchImpl(new URL(endpointPath("streamEvents", { session_id: ctx.sessionId }), `${ctx.origin}/`).href, {
        headers: { accept: "text/event-stream", ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}) },
        redirect: "manual",
      });
      expect(response.status === 200, "stream_events_not_200", `read ${response.status}`);
      const posted = await call(ctx, {
        method: "POST",
        path: endpointPath("postEvents", { session_id: ctx.sessionId }),
        body: { events: [{ type: "user.message", content: [{ type: "text", text: "What word did I ask you to reply with last time? Answer with that word only." }] }] },
      });
      expect(posted.status === 200, "post_events_not_200", `read ${posted.status}`);
      const stream = await collectStream(ctx, response, EVENTS.dedicated);
      expect(stream.errorFrame === null, "session_error", codeOf({ json: stream.errorFrame }) || "session.error");
      const message = stream.frames.find((frame) => frame?.type === "agent.message");
      expect(message, "no_agent_message_second_turn");
      return "the second round also yields an agent.message";
    },
  },
  {
    id: "dedicated.session.unknown-observed",
    profile: "dedicated",
    title: "Unknown session: the spec pins no code, observation only",
    run: async (ctx) => {
      const result = await call(ctx, { method: "GET", path: endpointPath("streamEvents", { session_id: freshId("nosess") }) });
      return { skip: `spec v1.0.0 pins no code here; observed ${result.status}${codeOf(result) ? ` ${codeOf(result)}` : ""}` };
    },
  },
  {
    id: "dedicated.interrupt.optional",
    profile: "dedicated",
    title: "Interrupt is optional: implemented answers 200, absent answers the spec's 404",
    run: async (ctx) => {
      if (ctx.caps && ctx.caps.interrupt === false) return { skip: "caps.interrupt declared false" };
      expect(ctx.sessionId, "no_prior_session", "run dedicated.session.create first");
      const result = await call(ctx, { method: "POST", path: endpointPath("interruptSession", { session_id: ctx.sessionId }) });
      if (result.status === 404) {
        expectError(result, 404, "stream_endpoint_missing", "an unimplemented interrupt");
        return "not implemented (optional allows it): 404 stream_endpoint_missing";
      }
      expect(result.status === 200, "interrupt_not_200", `read ${result.status} (${codeOf(result)})`);
      return "implemented: 200";
    },
  },
];

export const CTS_CHECKS = CHECKS.map(({ id, profile, title }) => ({ id, profile, title }));

/**
 * 跑一遍考卷。返回 { origin, profile, caps, results, counts }；results 每条
 * { id, title, verdict: pass|fail|skip, detail, ms }。任何一条抛错都记成 fail，考卷本身不中断。
 */
export async function runConformance({
  origin, token = null, profile = null, model = null, timeoutMs = CTS_TIMEOUT_MS, fetchImpl = null, onCheck = null, only = null,
}) {
  const cleanOrigin = sanitizeOrigin(origin);
  const fetcher = fetchImpl ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new CtsInputError("no_fetch");
  const ctx = {
    origin: cleanOrigin,
    token: token || null,
    wantedProfile: profile || null,
    model: model || null,
    timeoutMs,
    fetchImpl: fetcher,
    anonymous: false,
    descriptor: null,
    profile: null,
    caps: null,
  };
  const results = [];
  const wanted = only ? new Set(only) : null;
  for (const check of CHECKS) {
    if (wanted && !wanted.has(check.id)) continue;
    if (check.profile !== "any" && ctx.profile && check.profile !== ctx.profile) continue;
    const started = Date.now();
    let entry;
    try {
      if (check.profile !== "any" && !ctx.descriptor) {
        entry = { verdict: "skip", detail: "discovery failed: no profile to examine" };
      } else {
        const outcome = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new CtsCheckError("check_timeout", `the check did not settle within ${timeoutMs}ms`)), timeoutMs);
          check.run(ctx).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
        });
        entry = typeof outcome === "object" && outcome?.skip
          ? { verdict: "skip", detail: outcome.skip }
          : { verdict: "pass", detail: typeof outcome === "string" ? outcome : "" };
      }
    } catch (error) {
      if (error instanceof CtsInputError) throw error;
      entry = { verdict: "fail", detail: error?.detail ? `${error.code ?? error.name}: ${error.detail}` : (error?.code ?? error?.message ?? String(error)).slice(0, 200) };
    }
    const result = { id: check.id, title: check.title, ms: Date.now() - started, ...entry };
    results.push(result);
    if (onCheck) await onCheck(result);
  }
  const counts = results.reduce((acc, item) => {
    acc[item.verdict] = (acc[item.verdict] ?? 0) + 1;
    return acc;
  }, {});
  return { origin: cleanOrigin, profile: ctx.profile, caps: ctx.caps, results, counts };
}

/** 官网在线自检的入口闸：同一个请求方地址两次起跑之间必须「超过」spacingMs，且同一地址同时只跑一轮。
 *  被挡下的那一次不续期——否则连点的人会把自己越锁越久；地址表封顶，满了先清早已出窗口、手上没活的项，
 *  公开入口上每个来访地址一行，不清就是一条只涨不落的表。 */
export const CTS_GATE_SPACING_MS = 10_000;
export function createCtsGate({ spacingMs = CTS_GATE_SPACING_MS, maxEntries = 4096, now = Date.now } = {}) {
  const seen = new Map();
  return {
    /** 放行返回 { ok: true }；不放行返回 { ok: false, reason, retryAfterMs }，reason 是码，句子在页面那侧。 */
    admit(ip) {
      const at = now();
      const entry = seen.get(ip);
      if (entry?.busy) return { ok: false, reason: "run_in_flight", retryAfterMs: spacingMs };
      if (entry && at - entry.startedAt <= spacingMs) {
        return { ok: false, reason: "too_soon", retryAfterMs: entry.startedAt + spacingMs + 1 - at };
      }
      if (seen.size >= maxEntries) {
        for (const [key, value] of seen) if (!value.busy && at - value.startedAt > spacingMs) seen.delete(key);
      }
      seen.set(ip, { startedAt: at, busy: true });
      return { ok: true };
    },
    release(ip) {
      const entry = seen.get(ip);
      if (entry) entry.busy = false;
    },
  };
}
