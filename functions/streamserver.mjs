// Stream Server API Specification v1.0.0 的参考实现（shared 档）：一台分时执行器。
//
// 为什么要有这一份：规范（functions/streamspec.mjs）光有表只是一句话——客户端按表选路，
// 供应商按表实现，两边都需要一个真能跑起来对照的东西。这里就是那个对照物：路由、帧词表、
// 发现响应的正文全部从表里长出来，谁改表都会立刻在这儿对不上。它同时是分布式形态里
// 「worker HTTP 最小集」的那一层：把一台 server 替任意多个员工分时干活跑通一次。
//
// 三条边界：
// 1) 不碰数据库。一轮的全部输入都在请求体里（messages + tools），所以这台 server 不需要数据钥匙，
//    也没有「哪个员工」的概念——这正是 shared 档能分时的前提。
// 2) 令牌与上游 Key 只从配置读：不落日志、不进错误正文、不出现在发现响应里（那儿只有模型名）。
// 3) 状态只有一张有界的 turn 表（TTL + 条数上限），进程重启即清空。一轮结果的权威是客户端读到的
//    turn.done 帧；这张表只为「连接断了还能回来取结果」与「叫停」两件事存在。
//
// 只做 shared 档：dedicated 那套帧是云端 Agent 自己的形状（functions/qca.mjs 读它），
// 在本仓里再造一个云服务商没有意义。一台服务器只声明自己真跑得起来的那一档，客户端才不会选错路。
import { chatCompletion, upstreamCode } from "./agents.mjs";
import { Interrupted, readCapped } from "./util.mjs";
import {
  ANY_PROFILE, ENDPOINTS, INTERRUPTED_REASON, SHARED_PROFILE, STREAM_DONE, isSegment, matchEndpoint,
  specDescriptor,
} from "./streamspec.mjs";

// 下面四个默认值都是部署事实（一台 server 同时替多少员工跑、上游多慢），dev/stream-server.mjs
// 从 env 读进来覆盖；写死在这里就等于替所有部署做了同一个决定。
const TURN_TTL_MS = 600_000;
const TURN_MAX = 512;
const UPSTREAM_TIMEOUT_MS = 180_000;
/** 请求体上限：一轮正文可以很大（上下文按字符预算拼），但不是无上界。读满就地 413，不整份进内存。 */
const REQUEST_MAX_BYTES = 8 * 1024 * 1024;

const DECLARED_PROFILES = [SHARED_PROFILE];

/** 这一份实现认哪些 endpoint 名。放在闭包外是为了加载时就能与表对账（形状照 mcp.mjs 那一枪）：
 *  声明了一档 profile 却缺它必需的 endpoint，客户端每轮都失败在调不到路由上，而这里只看得到一句 404。 */
const IMPLEMENTS = ["discovery", "createTurn", "interruptTurn", "getTurn"];

{
  const declared = new Set(DECLARED_PROFILES);
  const ours = (entry) => entry.profile === ANY_PROFILE || declared.has(entry.profile);
  const missing = ENDPOINTS.filter((entry) => ours(entry) && !entry.optional && !IMPLEMENTS.includes(entry.name));
  const names = new Set(ENDPOINTS.filter(ours).map((entry) => entry.name));
  const orphan = IMPLEMENTS.filter((name) => !names.has(name));
  if (missing.length || orphan.length) {
    throw new Error(`参考实现对不上规范表：${[
      ...missing.map((entry) => `缺实现 ${entry.name}`),
      ...orphan.map((name) => `表里没有 ${name}`),
    ].join("、")}`);
  }
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/** 一条 SSE 帧。只用 `data:` 行 + JSON，与另外两条通道同一形状（functions/qca.mjs 的 dataOf 读它）。 */
const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

export function createStreamServer({
  upstreamUrl = null,
  upstreamKey = null,
  upstreamModel = null,
  token = null,
  dev = false,
  label = null,
  models = null,
  turnTtlMs = TURN_TTL_MS,
  turnMax = TURN_MAX,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  maxRequestBytes = REQUEST_MAX_BYTES,
} = {}) {
  // 没配令牌又不许匿名，冷启动就崩：一个谁都能调的执行器会拿着我们的上游 Key 替任何人烧 token，
  // 而它在界面上不留痕迹。这类配置缺口不许以一句 WARN 的形式活着。
  if (!token && !dev) {
    throw new Error("stream server 要么配 WORKSTREAM_STREAM_SERVER_TOKEN，要么显式以 dev 模式起（WORKSTREAM_DEV=1）");
  }
  const descriptor = specDescriptor({
    profiles: DECLARED_PROFILES,
    models: models ?? (upstreamModel ? [upstreamModel] : null),
    label,
  });
  /** turn_id → 这一轮的账。Map 保留插入顺序，腾位时按它挑最老的那条已结的。 */
  const turns = new Map();

  /** 过期只清已结的：在跑的那一轮清了，客户端就永远等不到权威帧，而它看不出是被谁丢的。 */
  function prune() {
    const cutoff = Date.now() - turnTtlMs;
    for (const [id, entry] of turns) {
      if (entry.settled_at !== null && entry.settled_at <= cutoff) turns.delete(id);
    }
  }

  /** 满了就腾最老的已结条目；一条都腾不出来才拒新的（503），不砍在跑的。 */
  function makeRoom() {
    prune();
    if (turns.size < turnMax) return true;
    let oldest = null;
    for (const [id, entry] of turns) {
      if (entry.settled_at === null) continue;
      if (!oldest || entry.settled_at < oldest.settled_at) oldest = { id, settled_at: entry.settled_at };
    }
    if (!oldest) return false;
    turns.delete(oldest.id);
    return true;
  }

  /** 权威结果只有一份形状：turn.done 帧与 GET /turns/{id} 回的是同一个对象（都带 state）。
   *  两处各拼一份，断线重连取回来的结果就会与流里读到的不一样——客户端正是靠这两者等价，
   *  才敢在断流之后拿 GET 的结果当权威帧用。
   *  usage 那一格是上游原样的用量块（prompt_tokens/...），不是我们内部那四个数：
   *  归一化是客户端落库前的事，规范线上跑的是上游形状。 */
  const turnPayload = (entry) => ({
    turn_id: entry.turn_id,
    state: entry.state,
    content: entry.content,
    reasoning: entry.reasoning,
    tool_calls: entry.tool_calls,
    usage: entry.usage,
    finish_reason: entry.finish_reason,
    first_token_ms: entry.first_token_ms,
    ...(entry.state === "error" ? { error: entry.error, status: entry.status, detail: entry.detail } : {}),
  });

  function discovery() {
    return json(200, descriptor);
  }

  function getTurn({ params }) {
    const entry = turns.get(params.turn_id);
    if (!entry) return json(404, { error: "stream_turn_not_found", detail: params.turn_id });
    return json(200, turnPayload(entry));
  }

  function interruptTurn({ params }) {
    const entry = turns.get(params.turn_id);
    if (!entry) return json(404, { error: "stream_turn_not_found", detail: params.turn_id });
    entry.stopped = true;
    // 已经结了的那一轮没什么可掐的，但这一发不算错：客户端的叫停本来就是尽力而为，
    // 它随后自己掐读循环。回 404 会让「主人叫停」在界面上长得像服务器坏了。
    return json(200, { ok: true, turn_id: entry.turn_id, state: entry.state });
  }

  async function createTurn({ body }) {
    if (!isSegment(body?.turn_id)) return json(400, { error: "stream_bad_request", detail: "turn_id" });
    if (!Array.isArray(body?.messages) || !body.messages.length) {
      return json(400, { error: "stream_bad_request", detail: "messages" });
    }
    const model = typeof body.model === "string" && body.model ? body.model : upstreamModel;
    if (!upstreamUrl || !upstreamKey || !model) {
      return json(503, { error: "stream_upstream_unconfigured", detail: model ? "upstream" : "model" });
    }
    const turnId = body.turn_id;
    // 客户端每轮自己生成 turn_id，撞上就是重放：再起一次上游等于替同一个请求烧两遍 token。
    if (turns.has(turnId)) return json(400, { error: "stream_bad_request", detail: "turn_id_reused" });
    if (!makeRoom()) return json(503, { error: "stream_unavailable", detail: "turn_table_full" });
    const entry = {
      turn_id: turnId,
      state: "running",
      created_at_ms: Date.now(),
      settled_at: null,
      stopped: false,
      content: "",
      reasoning: "",
      tool_calls: [],
      // 上游原样的用量块（不是归一化后的四个数）：规范线上跑上游形状，归一化是客户端落库前的事。
      usage: null,
      finish_reason: null,
      first_token_ms: null,
      error: null,
      status: null,
      detail: null,
    };
    turns.set(turnId, entry);

    const started = Date.now();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // 客户端断开后 enqueue 会抛：这一轮的账仍要记完（GET 还能取到结果），只是不再往外发。
        const send = (text) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // 对端已走，无处可发。
          }
        };
        try {
          const result = await chatCompletion({
            baseUrl: upstreamUrl,
            apiKey: upstreamKey,
            model,
            messages: body.messages,
            tools: Array.isArray(body.tools) ? body.tools : null,
            maxTokens: Number(body.max_tokens) || null,
            timeoutMs,
            // 叫停走 chatCompletion 已有的那套纪律：分片边界问一次，静默 800ms 也问一次，
            // 不在这里另写一个读循环。
            onInterrupt: async () => (entry.stopped ? { stopped: true } : null),
            onDelta: (delta) => {
              // 只带 usage 的那一发是上游的用量块，不是增量：不发帧、也不算首字延迟。
              if (delta.usage) {
                entry.usage = delta.usage;
                return;
              }
              if (!delta.content && !delta.reasoning) return;
              entry.content += delta.content;
              entry.reasoning += delta.reasoning;
              if (entry.first_token_ms === null) entry.first_token_ms = Date.now() - started;
              send(frame({ type: "turn.delta", content: delta.content, reasoning: delta.reasoning }));
            },
          });
          Object.assign(entry, {
            state: "done",
            content: result.content,
            reasoning: result.reasoning,
            tool_calls: result.tool_calls,
            finish_reason: result.finish_reason,
            first_token_ms: result.first_token_ms,
            settled_at: Date.now(),
          });
          send(frame({ type: "turn.done", ...turnPayload(entry) }));
        } catch (error) {
          if (error instanceof Interrupted) {
            // 被叫停是一轮的正当结局，不是失败：交半截正文 + finish_reason=interrupted，
            // 客户端据此把这封信结在 cancelled。当错误帧发出去，「主人叫停」在界面上就成了「服务器崩了」。
            Object.assign(entry, {
              state: "done", finish_reason: INTERRUPTED_REASON, settled_at: Date.now(),
            });
            send(frame({ type: "turn.done", ...turnPayload(entry) }));
          } else {
            // 上游那一腿的精确码（upstream_*）留在 detail 里当日志数据；error 那一格必须是规范这一族的码，
            // 客户端只认表里的标识，认下一个字典里没有的字符串，界面上就成了「出错了：<内部标识>」。
            Object.assign(entry, {
              state: "error",
              error: "stream_upstream_failed",
              status: Number(error?.status) || 502,
              detail: upstreamCode(error),
              settled_at: Date.now(),
            });
            send(frame({ type: "turn.error", error: entry.error, status: entry.status, detail: entry.detail }));
          }
        } finally {
          // 哨兵裸发，不进 frame()：JSON.stringify 会给它套上引号，而客户端（与 OpenAI 兼容那一路）比的是裸串——
          // 带引号的那一发会被当成一条没有 type 的帧悄悄丢掉，「干净收尾」就读成「连接断了」。
          send(`data: ${STREAM_DONE}\n\n`);
          try {
            controller.close();
          } catch {
            // 已经关过了。
          }
        }
      },
      // 对端取消（客户端超时/走了）也要停上游：不停就是白烧 token，而这台 server 看不见那个群。
      cancel() {
        entry.stopped = true;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  }

  const routes = { discovery, createTurn, interruptTurn, getTurn };
  for (const name of IMPLEMENTS) {
    if (typeof routes[name] !== "function") throw new Error(`参考实现声明了 ${name} 却没有对应函数`);
  }

  /**
   * 一个请求 → 一个响应（Web 标准的 Request/Response，node 与 Deno 两边都能承载）。
   * 鉴权在路由之前：没带对令牌的调用方不该从 404/405 的差别里读出这台 server 实现了哪几条路。
   */
  async function handle(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return json(400, { error: "stream_bad_request", detail: "url" });
    }
    if (token && request.headers.get("authorization") !== `Bearer ${token}`) {
      return json(401, { error: "stream_unauthorized" });
    }
    const matched = matchEndpoint(url.pathname);
    if (!matched) return json(404, { error: "stream_endpoint_missing", detail: url.pathname });
    const method = String(request.method ?? "GET").toUpperCase();
    if (matched.entry.method !== method) {
      return json(405, { error: "stream_method_not_allowed", detail: `${method} ${url.pathname}` });
    }
    if (method === "GET") return routes[matched.name]({ params: matched.params });
    let raw = "";
    try {
      if (request.body) {
        raw = await readCapped(request.body, maxRequestBytes, () => {
          const error = new Error("payload_too_large");
          error.tooLarge = true;
          return error;
        });
      }
    } catch (error) {
      if (error?.tooLarge) return json(413, { error: "stream_payload_too_large" });
      return json(400, { error: "stream_bad_request", detail: "body" });
    }
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "stream_bad_request", detail: "body_not_json" });
      }
    }
    return routes[matched.name]({ params: matched.params, body });
  }

  return {
    handle,
    descriptor,
    /** 表的规模。有界是这台 server 不自爆的前提，得能被断言，不能只写在注释里。
     *  先清一遍过期再报：一个把已过期的条目也算进来的数字，读起来就像表没界。 */
    turnCount: () => {
      prune();
      return turns.size;
    },
  };
}
