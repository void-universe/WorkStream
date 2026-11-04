// 端到端自检：直接用真实 handler + 本机假数据库跑通全部主流程，不含任何云端凭据。
// 用法：node dev/smoke.mjs（可反复跑，每次从全新数据库开始）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { makeHandler } from "../functions/handler.mjs";
import { serveSite } from "../functions/adapter.mjs";
import { executeTool, INTERNAL_TOOL_NAMES } from "../functions/mcp.mjs";
import { connectorToolDefs } from "../functions/plugins.mjs";
import { isUpdateAvailable } from "../functions/registries.mjs";
import { CACHE_BREAKPOINT_ID, DEMO_QUOTABLE_HEADERS, PROMPT_SECTIONS, composeSystemPrompt } from "../functions/prompt.mjs";
import { delegateWindow } from "../functions/delegate.mjs";
import { skillPrompt } from "../functions/skills.mjs";
import { store } from "../functions/store.mjs";
import { closeOrphanSteps, createStepWriter } from "../functions/steps.mjs";
import { askCloudAgent, flattenPrompt, parseAgentId, QcaError } from "../functions/qca.mjs";
import { completeForAgent } from "../functions/agents.mjs";
import { Interrupted } from "../functions/util.mjs";
import { createFixtureClient } from "./fixture-supabase.mjs";
import { fileRenderers, registerFileRenderer, renderGroupFile } from "../src/lib/renderers/index.mjs";

const dir = mkdtempSync(join(tmpdir(), "ws-smoke-"));
const file = join(dir, "db.json");
process.env.WORKSTREAM_DEV = "1";
const supabase = createFixtureClient(file);
const db = store(supabase);
const handler = makeHandler({ env: (name) => process.env[name] });
// 生产形态的 env（没有 WORKSTREAM_DEV）：用来验证 SSRF 与私网拦截。
const prodHandler = makeHandler({ env: () => undefined });

// 1×1 PNG：只验证头像的存取与展示链路，不关心图案。
const AVATAR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// 1×1 WebP：内置默认头像烤出来就是 WebP，单独验一次这一档收不收得下。
const AVATAR_WEBP = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=";

let passed = 0;
const failures = [];

async function call(action, { body, token, method = "POST", entry = null } = {}) {
  const url = new URL(`http://local/functions/v1/app?action=${encodeURIComponent(action)}`);
  if (method === "GET") {
    for (const [key, value] of Object.entries(body ?? {})) url.searchParams.set(key, String(value));
  }
  const request = new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const response = await (entry ?? handler)({ request, supabase });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` → ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  }
}

const step = (title) => console.log(`\n${title}`);

/**
 * 本机假上游（OpenAI 兼容 SSE）：正文逐字下发、工具参数分片下发、故意够慢，
 * 才能真的验证流式累加、工具拼接、插话掐断和多模态部件。
 */
function startMockUpstream() {
  const seen = [];
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      seen.push(body);
      res.on("error", () => {});
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const send = (delta, finishReason = null) => res.write(
        `data: ${JSON.stringify({ id: "mock", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
      const alive = () => !res.destroyed && !res.writableEnded;
      // 思考链增量 + 只在请求带了 stream_options.include_usage 时才补的用量块：
      // 两者一起验“我们有发、有收”，不然轨迹里的用量列会悄悄全是空。
      const think = (text) => { if (alive()) send({ reasoning_content: text }); };
      const usageChunk = () => {
        if (!alive() || body.stream_options?.include_usage !== true) return;
        res.write(`data: ${JSON.stringify({
          id: "mock",
          choices: [],
          usage: {
            prompt_tokens: 812, completion_tokens: 24, total_tokens: 836,
            prompt_tokens_details: { cached_tokens: 640 },
            completion_tokens_details: { reasoning_tokens: 9 },
          },
        })}\n\n`);
      };
      const finish = () => {
        if (!alive()) return;
        usageChunk();
        res.write("data: [DONE]\n\n");
        res.end();
      };
      const say = async (text, gap = 30) => {
        think("先想一步再动笔。");
        for (const piece of Array.from(text)) {
          if (!alive()) return;
          send({ content: piece });
          await sleep(gap);
        }
        finish();
      };
      // 除“慢慢写”“插话重答”两条剧本外，其余一次写完，免得自检被人为拖慢。
      const sayFast = (text) => {
        think("先看上下文，再定结论。");
        send({ content: text });
        send({}, "stop");
        finish();
      };
      const system = String(body.messages?.[0]?.content ?? "");
      const last = body.messages?.[body.messages.length - 1];
      if (system.includes("被 @ 你的新消息打断")) { sayFast("已按插话重排：一、准备；二、执行；三、复盘。"); return; }
      // 按触发消息本身认剧本：下一轮的转录里也带着上一轮的关键词，按全文匹配会把两封混成一份。
      const trig = String(system.split("\n\n").find((b) => b.startsWith("上一条 @ 你的消息")) ?? "");
      if (trig.includes("突发甲")) { sayFast("回甲已落群"); return; }
      if (trig.includes("突发乙")) { sayFast("回乙已落群"); return; }
      if (trig.includes("慢慢写")) { await say("正在慢慢写这段长正文", 140); return; }
      // 自建端点只吐两个字就卡住：验证静默期间照样问一次要不要掐断，跟云端那条通道对齐。
      if (String(last?.content ?? "").includes("静默卡住")) {
        think("先想一步再动笔。");
        send({ content: "半截" });
        while (!res.destroyed && !res.writableEnded) await sleep(50);
        return;
      }
      if (Array.isArray(last?.content) && last.content.some((part) => part.type === "image_url")) {
        sayFast("图里是一块红色的方砖。");
        return;
      }
      if (body.tools?.length && !body.messages.some((m) => m.role === "tool") && trig.includes("查历史")) {
        think("这条要查历史，先调 search_history。");
        send({ tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "search_history" } }] });
        await sleep(10);
        for (const piece of ['{"query":', '"发布清单","limit":5}']) {
          send({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
          await sleep(10);
        }
        send({}, "tool_calls");
        finish();
        return;
      }
      // 模型编出清单外的工具名：第一轮照样发 tool_calls，第二轮才收敛成正文。
      if (body.tools?.length && !body.messages.some((m) => m.role === "tool") && trig.includes("轨迹越界工具")) {
        send({ tool_calls: [{ index: 0, id: "call_ghost_1", type: "function", function: { name: "drop_table" } }] });
        await sleep(5);
        send({ tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] });
        send({}, "tool_calls");
        finish();
        return;
      }
      if (trig.includes("轨迹越界工具")) {
        think("清单里没有这个工具，我直接按现有信息回答。");
        send({ content: "那个工具不在清单里，我按现有信息回答。" });
        send({}, "stop");
        finish();
        return;
      }
      // 主人接了外部插件：第一轮点它带进来的工具，第二轮才成正文。
      if (body.tools?.length && !body.messages.some((m) => m.role === "tool") && trig.includes("插件天气")) {
        think("清单里多了个外部工具，先调它。");
        send({ tool_calls: [{ index: 0, id: "call_plugin_1", type: "function", function: { name: "get_weather" } }] });
        await sleep(5);
        send({ tool_calls: [{ index: 0, function: { arguments: '{"city":"杭州"}' } }] });
        send({}, "tool_calls");
        finish();
        return;
      }
      if (trig.includes("插件天气")) { sayFast("杭州晴 26 度，已经报回群里。"); return; }
      if (body.tools?.length) { sayFast("查到 3 条历史记录，已按时间排好。"); return; }
      sayFast("收到，我按上下文回应。");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

/**
 * 本机假的外部 MCP 服务：JSON-RPC over HTTP 的 initialize / tools/list / tools/call，
 * 外加几条坏路径（非 JSON、超大回包、401）和 404，用来验客户端的各条失败分支。
 * headers / calls 记下真实收到的东西，好让断言落在“对方确实接到了什么”上。
 */
function startMockConnector() {
  const headers = [];
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const reply = (result) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      };
      res.on("error", () => {});
      const path = new URL(req.url, "http://local").pathname;
      if (path === "/bad") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("这不是 JSON");
        return;
      }
      if (path === "/huge") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: Array.from({ length: 30 }, (_, i) => ({
            name: `big_${i}`, description: "字".repeat(25000), inputSchema: { type: "object", properties: {} },
          })) },
        }));
        return;
      }
      if (path === "/deny") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (path !== "/mcp") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      let message = null;
      try {
        message = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      headers.push(req.headers.authorization ?? "");
      const params = message.params ?? {};
      if (message.method === "initialize") {
        reply({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock-connector", version: "1" } });
        return;
      }
      if (message.method === "tools/list") {
        reply({ tools: [
          { name: "get_weather", description: "查一个城市今天的天气", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
          { name: "search_history", description: "和内置工具重名的外部工具", inputSchema: { type: "object", properties: {} } },
          { name: "long_text", description: "回一段超长正文", inputSchema: { type: "object", properties: {} } },
          { name: "boom", description: "外部服务自己报错", inputSchema: { type: "object", properties: {} } },
          { name: "bad name!", description: "名字不合 OpenAI 的规矩", inputSchema: { type: "object", properties: {} } },
          { name: "no_schema", description: "没有入参声明" },
          { name: "get_weather", description: "同名再来一次", inputSchema: { type: "object", properties: {} } },
        ] });
        return;
      }
      if (message.method === "tools/call") {
        calls.push(params);
        if (params.name === "boom") { reply({ isError: true, content: [{ type: "text", text: "外部服务炸了" }] }); return; }
        if (params.name === "long_text") { reply({ content: [{ type: "text", text: "天".repeat(7000) }] }); return; }
        reply({ content: [
          { type: "text", text: `${params.arguments?.city ?? "?"}：晴 26 度` },
          { type: "text", text: "风力 2 级" },
        ] });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unknown method" } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        headers,
        calls,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

/**
 * 本机假技能源：一个 index JSON 加若干正文，同时覆盖合法条目、各种坏条目和正文层面的坑。
 * state 可以中途改：改版本号用来验"有更新"，隐藏 slug 用来验"源上已撤下"。
 */
function startMockRegistry() {
  const requests = [];
  const state = { version: "1.2.0", hidden: [], body: "# 发布前检查\n- 备份\n- 灰度" };
  const entry = (slug, extra = {}) => ({
    slug,
    name: `${slug} 技能`,
    summary: "一条用于自检的技能",
    category: "交付",
    version: state.version,
    updated_at: "2026-01-02T00:00:00.000Z",
    body_url: `/skills/${slug}.md`,
    size: 30,
    ...extra,
  });
  const buildIndex = () => ({
    schema: 1,
    name: "社区技能源",
    skills: [
      entry("release-check"),
      entry("Standup Note"), // slug 不合规矩
      entry("no-name", { name: "" }), // 没有名字
      entry("elsewhere", { body_url: "https://elsewhere.example.com/x.md" }), // 正文跨了源
      entry("no-body", { body_url: "" }), // 没有正文地址
      entry("release-check", { name: "重复一条" }), // 重复 slug
      entry("too-large", { body_url: "/skills/huge.md" }),
      entry("empty-body", { body_url: "/skills/empty.md" }),
      entry("binary-body", { body_url: "/skills/bin.dat" }),
      entry("long-body", { body_url: "/skills/long.md" }),
    ].filter((item) => !state.hidden.includes(item.slug)),
  });
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://local").pathname;
    requests.push(path);
    res.on("error", () => {});
    const send = (type, body) => {
      res.writeHead(200, { "content-type": type });
      res.end(body);
    };
    if (path === "/index.json") return send("application/json", JSON.stringify(buildIndex()));
    if (path === "/many.json") {
      return send("application/json", JSON.stringify({
        schema: 1,
        skills: Array.from({ length: 205 }, (_, i) => entry(`many-${i}`)),
      }));
    }
    if (path === "/bad.json") return send("application/json", "这不是 JSON");
    if (path === "/schema2.json") return send("application/json", JSON.stringify({ schema: 2, skills: [] }));
    if (path === "/deny.json") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end("{}");
    }
    if (path === "/move.json") {
      res.writeHead(302, { location: "/index.json" });
      return res.end();
    }
    if (path === "/skills/huge.md") return send("text/plain; charset=utf-8", "x".repeat(210000));
    if (path === "/skills/empty.md") return send("text/plain; charset=utf-8", "   \n  ");
    if (path === "/skills/bin.dat") return send("application/octet-stream", "一段二进制");
    if (path === "/skills/long.md") return send("text/plain; charset=utf-8", "字".repeat(20001));
    if (path.startsWith("/skills/")) return send("text/plain; charset=utf-8", state.body);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        requests,
        state,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

/**
 * 本机假 QCA（Qoder Cloud Agents）：模型清单、environment、session、事件投递与 SSE 增量都按真的契约回，
 * 另外留三个异常出口（PAT 不认、云端报错、流走光没正文）和一个慢速增量模式，
 * 用来验证云端后端的每段衔接——尤其"半截增量不能冒充回复"。
 */
function startMockQca() {
  const requests = [];
  const state = {
    mode: "ok",
    text: "云端正文：先做对，再做快。",
    reasoning: "云端思考链：先想三步……",
    environments: [],
    sessionCreated: 0,
    models: 3,
    promptSeen: null,
  };
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  let environmentSeq = 0;
  let userEventSeq = 0;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      const path = new URL(req.url, "http://mock").pathname;
      const method = req.method;
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = { bad_json: true };
      }
      requests.push({ method, path, body, auth: req.headers.authorization ?? "" });
      const send = (payload) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const deny = (status) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end("{}");
      };
      // PAT 前缀照云端规矩认：不匹配的自检必须落到 qca_access_denied，而不是"看起来连上了"。
      if (!/^Bearer pt-[A-Za-z0-9-]+$/.test(String(req.headers.authorization ?? ""))) return deny(401);

      if (method === "GET" && path === "/api/v1/cloud/models") {
        return send({ data: Array.from({ length: state.models }, (_, i) => ({ id: `model-${i}`, enabled: true })) });
      }
      if (method === "GET" && path === "/api/v1/cloud/environments") return send({ data: state.environments, has_more: false });
      if (method === "POST" && path === "/api/v1/cloud/environments") {
        const row = { id: `env_mock_${(environmentSeq += 1)}`, config: body?.config, archived_at: null };
        state.environments.push(row);
        return send(row);
      }
      if (method === "POST" && path === "/api/v1/cloud/sessions") {
        if (!body?.agent?.id || !body?.environment_id) return deny(400);
        state.sessionCreated += 1;
        return send({ id: `sess_mock_${state.sessionCreated}`, agent: body.agent });
      }
      const eventsStream = path.match(/^\/api\/v1\/cloud\/sessions\/(sess_[A-Za-z0-9_]+)\/events\/stream$/);
      if (method === "GET" && eventsStream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        if (state.mode === "silent") return res.end();
        const replyId = "evt_assistant_1";
        if (state.mode === "error") {
          res.write(frame({ type: "event_start", event: { id: replyId, type: "agent.message" } }));
          res.write(frame({ type: "session.error", error: { message: "云端这轮挂了" } }));
          return res.end();
        }
        if (state.mode === "slow") {
          res.write(frame({ type: "event_start", event: { id: replyId, type: "agent.message" } }));
          for (let i = 0; i < 400; i += 1) {
            if (res.destroyed || res.writableEnded) return;
            res.write(frame({
              type: "event_delta", event_id: replyId,
              delta: { type: "content_delta", index: 0, content: { type: "text", text: `慢${i}` } },
            }));
            await sleep(10);
          }
          return res.end();
        }
        if (state.mode === "stall") {
          // 云端 agent 在自己那边跑工具：吐了两句增量就长时间不吭声，也不收尾。
          res.write(frame({ type: "event_start", event: { id: replyId, type: "agent.message" } }));
          res.write(frame({
            type: "event_delta", event_id: replyId,
            delta: { type: "content_delta", index: 0, content: { type: "text", text: "静默前两句" } },
          }));
          while (!res.destroyed && !res.writableEnded) await sleep(50);
          return;
        }
        // 故意把首帧切成两个分片下发：断帧拼接没写对，这里就会漏事件。
        const start = frame({ type: "event_start", event: { id: replyId, type: "agent.message" } });
        res.write(start.slice(0, 18));
        await sleep(5);
        res.write(start.slice(18));
        res.write(frame({
          type: "event_delta", event_id: replyId,
          delta: { type: "content_delta", index: 0, content: { type: "text", text: state.text.slice(0, 4) } },
        }));
        res.write(frame({
          type: "event_delta", event_id: replyId,
          delta: { type: "content_delta", index: 0, content: { type: "text", text: state.text.slice(4) } },
        }));
        if (state.mode === "eof") return res.end();
        res.write(": 心跳注释行\n\n");
        // 规范回复里思考链与正文混在同一个 content 数组：只有 text 块允许进群。
        res.write(frame({
          type: "agent.message",
          id: replyId,
          content: [
            { type: "thinking", thinking: state.reasoning },
            { type: "text", text: state.text },
          ],
        }));
        return res.end();
      }
      const eventsPost = path.match(/^\/api\/v1\/cloud\/sessions\/(sess_[A-Za-z0-9_]+)\/events$/);
      if (method === "POST" && eventsPost) {
        const prompt = body?.events?.[0]?.content?.[0]?.text;
        if (typeof prompt !== "string") return deny(400);
        state.promptSeen = { prompt, hasTools: body?.tools !== undefined, sessionId: eventsPost[1] };
        userEventSeq += 1;
        return send({ data: [{ id: `evt_user_${userEventSeq}`, type: "user.message" }] });
      }
      return deny(404);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        get origin() { return `http://127.0.0.1:${server.address().port}`; },
        requests,
        state,
        count: (method, match) => requests.filter((r) => r.method === method && match.test(r.path)).length,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

async function main() {
  step("1. 注册与邮箱验证（开发态收件箱）");
  const a = await call("auth.register", { body: { email: "ana@example.com", password: "passw0rd-1", display_name: "Ana" } });
  check("注册 Ana 返回用户", a.status === 200 && a.payload.ok && !a.payload.user.email_verified, a.payload);
  const verifyLink = a.payload.verify_link ?? "";
  const verifyToken = decodeURIComponent(verifyLink.split("token=")[1] ?? "");
  const verify = await call("auth.verify", { body: { token: verifyToken } });
  check("验证链接可用", verify.status === 200 && verify.payload.ok, verify.payload);
  const dupe = await call("auth.register", { body: { email: "ana@example.com", password: "passw0rd-2", display_name: "Ana2" } });
  check("重复邮箱被拒", dupe.status === 409 && dupe.payload.error === "email_taken", dupe.payload);

  const b = await call("auth.register", { body: { email: "bo@example.com", password: "passw0rd-3", display_name: "Bo" } });
  const bToken = b.payload.user ? (await call("auth.login", { body: { email: "bo@example.com", password: "passw0rd-3" } })).payload.token : null;
  check("Bo 可注册并登录", Boolean(bToken), b.payload);
  const login = await call("auth.login", { body: { email: "ana@example.com", password: "passw0rd-1" } });
  const ana = login.payload.token;
  check("Ana 登录拿到会话", Boolean(ana), login.payload);
  check("口令错误被拒", (await call("auth.login", { body: { email: "ana@example.com", password: "wrong" } })).status === 401);
  check("未登录访问被拒", (await call("streams.mine", { method: "GET" })).status === 401);

  const withAvatar = await call("auth.patch", { token: ana, body: { avatar: AVATAR } });
  check("真实员工可以设置头像", withAvatar.payload.user?.avatar === AVATAR, withAvatar.payload.user);
  const meAvatar = await call("auth.me", { token: ana, method: "GET" });
  check("头像随会话回读", meAvatar.payload.user?.avatar === AVATAR, meAvatar.payload.user);
  const badAvatar = await call("auth.patch", { token: ana, body: { avatar: "javascript:alert(1)" } });
  check("非图片头像被拒", badAvatar.status === 400 && badAvatar.payload.error === "invalid_avatar", badAvatar.payload);
  // 内置默认头像在前端烤成 128×128 WebP 再交上来，字段口径要和上传那条完全一致。
  const webpAvatar = await call("auth.patch", { token: ana, body: { avatar: AVATAR_WEBP } });
  check("WebP 头像收得下（内置默认头像就是这一档）", webpAvatar.payload.user?.avatar === AVATAR_WEBP, webpAvatar.payload.user);
  const svgAvatar = await call("auth.patch", { token: ana, body: { avatar: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=" } });
  check("SVG 头像被拒：默认头像只在前端画，进库的必须是烤好的位图",
    svgAvatar.status === 400 && svgAvatar.payload.error === "invalid_avatar", svgAvatar.payload);
  await call("auth.patch", { token: ana, body: { avatar: AVATAR } });

  step("2. 虚拟员工：独立 Key + OpenAI 兼容地址 + 两级 memory");
  const agent = await call("agents.create", {
    token: ana,
    body: {
      name: "小Q", role: "资料整理", signature: "资料整理 · 先列清单再动手",
      avatar: AVATAR,
      api_base_url: "demo://local", api_key: "demo-key-1234",
      model: "demo", system_prompt: "回答要给出下一步待办。", context_chars: 6000,
    },
  });
  const agentId = agent.payload.agent?.id;
  check("创建虚拟员工", Boolean(agentId), agent.payload);
  check("建档时带上的个性签名会回读", agent.payload.agent?.signature === "资料整理 · 先列清单再动手", agent.payload.agent);
  check("虚拟员工建档时能带头像", agent.payload.agent?.avatar === AVATAR, agent.payload.agent);
  check("响应不回显明文 Key", !JSON.stringify(agent.payload).includes("demo-key-1234"));
  const ping = await call("agents.test", { token: ana, body: { id: agentId } });
  check("连接自检可用（演示模型）", ping.payload.result?.reachable === true, ping.payload);
  const badUrl = await call("agents.create", {
    token: ana,
    entry: prodHandler,
    body: { name: "内网", role: "x", api_base_url: "https://169.254.169.254/v1", api_key: "k12345678", model: "gpt" },
  });
  check("生产形态下元数据地址被 SSRF 规则拒绝", badUrl.status === 400 && badUrl.payload.error === "private_api_base_url", badUrl.payload);
  const httpUrl = await call("agents.create", {
    token: ana,
    entry: prodHandler,
    body: { name: "明文", role: "x", api_base_url: "http://api.example.com/v1", api_key: "k12345678", model: "gpt" },
  });
  check("生产形态拒绝 http 明文端点", httpUrl.status === 400 && httpUrl.payload.error === "insecure_api_base_url", httpUrl.payload);
  const mem = await call("agents.memory.put", { token: ana, body: { agent_id: agentId, scope: "common", content: "我负责把会议记录整理成待办。" } });
  check("写入 common memory", Boolean(mem.payload.id), mem.payload);

  // 回归：agents.delete 会连带复位 slice_prefs，表名写错时这里会直接 500。
  const temp = await call("agents.create", {
    token: ana,
    body: { name: "临时", role: "试删", api_base_url: "demo://local", api_key: "demo-key-9999", model: "demo" },
  });
  const tempId = temp.payload.agent?.id;
  const drop = await call("agents.delete", { token: ana, body: { id: tempId } });
  check("删除虚拟员工成功（含 slice_prefs 复位）", drop.payload.ok === true, drop.payload);
  const afterDelete = await call("agents.list", { token: ana, method: "GET" });
  check("删除后列表里不再有它", !afterDelete.payload.items?.some((item) => item.id === tempId), afterDelete.payload);

  step("2b. 技能市场：内置技能、默认安装、上传、搜索与安装");
  const market = await call("skills.market", { token: ana, method: "GET" });
  check("市场第一条是内置 WorkStream 技能", market.payload.items?.[0]?.name === "WorkStream 平台技能"
    && market.payload.items[0].always_on === true, market.payload);
  const installed = await call("skills.installed", { token: ana, method: "GET", body: { agent_id: agentId } });
  check("新员工自动安装默认公共技能",
    (installed.payload.items ?? []).some((item) => item.name === "周报与进度同步"), installed.payload);
  const uploaded = await call("skills.upload", {
    token: ana,
    body: {
      name: "发布检查清单", summary: "上线前的检查项与回滚条件。", category: "交付",
      body: "# 发布检查清单\n1. 备份\n2. 灰度\n3. 回滚演练", is_public: true,
    },
  });
  check("上传技能到市场", Boolean(uploaded.payload.skill?.id), uploaded.payload);
  const searched = await call("skills.market", { token: ana, method: "GET", body: { q: "回滚" } });
  check("市场按名称/摘要搜索", (searched.payload.items ?? []).some((item) => item.id === uploaded.payload.skill.id), searched.payload);
  const installSkill = await call("skills.install", {
    token: ana, body: { skill_id: uploaded.payload.skill.id, agent_id: agentId },
  });
  check("把技能安装到指定员工", installSkill.payload.installed === true, installSkill.payload);
  const readInstalled = await call("agents.get", { token: ana, method: "GET", body: { id: agentId } });
  check("员工详情列出已安装技能",
    (readInstalled.payload.skills ?? []).some((item) => item.name === "发布检查清单"), readInstalled.payload);
  const injected = await skillPrompt(store(supabase), agentId);
  check("技能正文注入员工上下文（两个内置技能排最前）",
    injected.startsWith("### WorkStream 平台技能")
      && injected.includes("### DevStream 群文件与公告")
      && injected.includes("发布检查清单"), injected.slice(0, 160));

  step("3. 群：UUID、申请、审批、角色");
  const stream = await call("streams.create", { token: ana, body: { name: "上线前定稿", agent_ids: [agentId], announcement: "本周五定稿。" } });
  const streamId = stream.payload.stream?.id;
  check("建群返回 UUID", Boolean(streamId) && /^[0-9a-f-]{36}$/.test(streamId), stream.payload);
  const directory = await call("streams.get", { token: ana, method: "GET", body: { id: streamId } });
  const humanMember = (directory.payload.members ?? []).find((m) => m.type === "human" && m.id === a.payload.user.id);
  const agentMember = (directory.payload.members ?? []).find((m) => m.type === "agent");
  check("成员目录带真人头像与员工头像",
    humanMember?.avatar === AVATAR && agentMember?.agent?.avatar === AVATAR, directory.payload.members);
  const apply = await call("streams.apply", { token: bToken, body: { stream_uuid: streamId } });
  check("Bo 用 UUID 申请进群", Boolean(apply.payload.request_id), apply.payload);
  const peekBefore = await call("messages.list", { token: bToken, method: "GET", body: { stream_id: streamId } });
  check("审批前 Bo 读不到群消息", peekBefore.status === 403, peekBefore.payload);
  const requests = await call("streams.requests", { token: ana, method: "GET", body: { stream_id: streamId } });
  const requestId = requests.payload.items?.[0]?.id;
  check("群主能看到待审批", Boolean(requestId), requests.payload);
  const wrongApprover = await call("streams.decide", { token: bToken, body: { request_id: requestId, approve: true } });
  check("非管理员不能审批", wrongApprover.status === 403, wrongApprover.payload);
  const decide = await call("streams.decide", { token: ana, body: { request_id: requestId, approve: true } });
  check("群主通过申请", decide.payload.status === "approved", decide.payload);
  const after = await call("messages.list", { token: bToken, method: "GET", body: { stream_id: streamId } });
  check("审批后 Bo 能读消息", after.status === 200 && after.payload.items?.length > 0, after.payload);

  step("4. @ 派发、虚拟邮箱队列与时间片");
  const send = await call("messages.send", {
    token: ana,
    body: {
      stream_id: streamId,
      content: "@小Q 把这三件事排个顺序，并 @Bo 复核",
      mentions: [{ type: "agent", id: agentId }, { type: "human", id: b.payload.user.id }],
    },
  });
  const sendClean = await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: `@小Q 请把发布清单列成三条`, mentions: [{ type: "agent", id: agentId }] },
  });
  check("消息入队并派发任务", sendClean.payload.queued?.length === 1, sendClean.payload ?? send.payload);
  check("@ 同时通知群内真人", (send.payload.notified ?? []).length === 1, send.payload);
  const pending = await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } });
  const pendingMsg = (pending.payload.items ?? []).find((m) => m.id === sendClean.payload.message?.id);
  const pendingDelivery = (pendingMsg?.deliveries ?? []).find((d) => d.agent_id === agentId);
  check("派发后、开跑前，群里这条消息对员工显示未读",
    pendingDelivery?.status === "queued" && pendingDelivery?.agent_name === "小Q", pendingMsg);
  const foreign = await call("messages.send", {
    token: bToken,
    body: { stream_id: streamId, content: "@小Q 你没有权限", mentions: [{ type: "agent", id: "00000000-0000-4000-8000-000000000009" }] },
  });
  check("@ 不在群里的员工被拒", foreign.status === 400, foreign.payload);
  const tick = await call("scheduler.tick", { token: ana, method: "GET" });
  const ran = tick.payload.ran ?? [];
  check("tick 跑掉了队列任务", ran.some((r) => r.status === "done"), tick.payload);
  check("同一员工同一群一轮只跑一封，第二封按 FIFO 等下一轮",
    ran.length === 1 && tick.payload.queued === 1, tick.payload);
  const tickAgain = await call("scheduler.tick", { token: ana, method: "GET" });
  check("下一轮把排队那封也跑掉", (tickAgain.payload.ran ?? []).some((r) => r.status === "done"), tickAgain.payload);
  const history = await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } });
  const agentReply = (history.payload.items ?? []).find((m) => m.sender_type === "agent");
  check("虚拟员工的回复落进群聊", Boolean(agentReply), history.payload);
  const doneMsg = (history.payload.items ?? []).find((m) => m.id === sendClean.payload.message?.id);
  const doneDelivery = (doneMsg?.deliveries ?? []).find((d) => d.agent_id === agentId);
  check("任务跑完后同一条消息对员工变已读", doneDelivery?.status === "done", doneMsg);
  const idlePresence = (history.payload.presence ?? []).find((row) => row.agent_id === agentId);
  check("群现场带出签名与空闲状态",
    idlePresence?.working === false && idlePresence?.signature === "资料整理 · 先列清单再动手", idlePresence);
  check("群现场带出员工头像", idlePresence?.avatar === AVATAR, idlePresence);
  const board = await call("scheduler.board", { token: ana, method: "GET" });
  const boardStream = board.payload.boards?.[0]?.streams?.[0];
  check("调度台显示权重与均分占比", boardStream?.share === 100, board.payload);
  const weight = await call("scheduler.weight", { token: ana, body: { stream_id: streamId, agent_id: agentId, weight: 3 } });
  check("领导可确认优先级权重", weight.payload.weight === 3, weight.payload);

  step("4b. 员工现场：签名、忙态与详情可见性");
  const sig = await executeTool(db, { agentId }, "set_signature", { signature: "细节控 · 交付前必跑回归" });
  check("员工能用 set_signature 改自己的签名", sig.ok === true && String(sig.signature).includes("回归"), sig);
  const sigView = await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } });
  check("新签名立刻出现在群现场数据里",
    (sigView.payload.presence ?? []).find((row) => row.agent_id === agentId)?.signature === "细节控 · 交付前必跑回归",
    sigView.payload.presence);
  const anchor = (sigView.payload.items ?? []).find((m) => m.sender_type === "agent");
  const runningMail = await db.mail.insert({
    id: crypto.randomUUID(),
    agent_id: agentId,
    stream_id: streamId,
    message_id: anchor?.id ?? null,
    trigger_seq: 0,
    priority: 1,
    status: "running",
    slice_count: 0,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const busyView = await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } });
  const busyRow = (busyView.payload.presence ?? []).find((row) => row.agent_id === agentId);
  check("有 running 任务时头像侧显示在忙，并指出当前焦点消息",
    busyRow?.working === true && busyRow?.current?.mail_id === runningMail?.id
      && Number(busyRow?.current?.seq) > 0 && String(busyRow?.current?.preview).length > 0,
    busyRow);
  const ownerView = await call("agents.presence", { token: ana, method: "GET", body: { agent_id: agentId } });
  check("主人能打开员工详情并看到当前任务",
    ownerView.payload.is_owner === true && ownerView.payload.current?.mail_id === runningMail?.id, ownerView.payload);
  check("详情接口只回资料，不含 Key、提示词与记忆",
    !JSON.stringify(ownerView.payload).includes("api_key")
      && !("system_prompt" in (ownerView.payload.profile ?? {}))
      && !("common_memory" in ownerView.payload), ownerView.payload.profile);
  const guestView = await call("agents.presence", { token: bToken, method: "GET", body: { agent_id: agentId } });
  check("同群成员可以看这位员工的现场",
    guestView.payload.is_owner === false
      && (guestView.payload.streams ?? []).some((row) => row.stream_id === streamId), guestView.payload);
  check("非主人视角也能看到头像", guestView.payload.profile?.avatar === AVATAR, guestView.payload.profile);
  const dee = await call("auth.register", { body: { email: "dee@example.com", password: "passw0rd-7", display_name: "Dee" } });
  const deeToken = (await call("auth.login", { body: { email: "dee@example.com", password: "passw0rd-7" } })).payload.token;
  check("陌生人注册（用于隔离测试）", Boolean(dee.payload.user?.id) && Boolean(deeToken), dee.payload);
  const outsiderView = await call("agents.presence", { token: deeToken, method: "GET", body: { agent_id: agentId } });
  check("不同群的用户读不到员工现场",
    outsiderView.status === 403 && outsiderView.payload.error === "agent_profile_forbidden", outsiderView);
  await db.mail.remove([["id", runningMail.id]]);

  step("5. 真人 @ 通知：默认虚拟邮箱，可切真实邮箱");
  const inboxBo = await call("inbox.list", { token: bToken, method: "GET" });
  check("Bo 的开发态收件箱收到 @ 通知", (inboxBo.payload.items ?? []).some((m) => m.kind === "mention"), inboxBo.payload);
  const switchReal = await call("auth.patch", { token: bToken, body: { at_channel: "real_email" } });
  check("未验证邮箱不能切真实邮箱", switchReal.status === 409 && switchReal.payload.error === "email_not_verified", switchReal.payload);
  await call("auth.verify", { body: { token: decodeURIComponent((b.payload.verify_link ?? "").split("token=")[1] ?? "") } });
  const switchAfter = await call("auth.patch", { token: bToken, body: { at_channel: "real_email" } });
  check("验证后可以切真实邮箱通道", switchAfter.payload.user?.at_channel === "real_email", switchAfter.payload);

  step("6. 公告、群文件、虚拟机授权");
  const announce = await call("streams.announcement", { token: ana, body: { stream_id: streamId, content: "周五 18:00 前定稿，逾期顺延。" } });
  check("群主更新公告", announce.payload.ok === true, announce.payload);
  const announceDenied = await call("streams.announcement", { token: bToken, body: { stream_id: streamId, content: "不该由成员改" } });
  check("普通成员不能改公告", announceDenied.status === 403, announceDenied.payload);
  const file = await call("files.upload", {
    token: ana,
    body: { stream_id: streamId, name: "发布清单.md", content_type: "text/markdown", content: "# 发布清单\n1. 备份\n2. 灰度\n3. 回滚方案" },
  });
  check("上传群文件", Boolean(file.payload.file?.id), file.payload);
  const preview = await call("files.get", { token: ana, method: "GET", body: { id: file.payload.file.id } });
  check("在线预览能取回文件正文",
    preview.payload.content === "# 发布清单\n1. 备份\n2. 灰度\n3. 回滚方案", preview.payload);
  const badName = await call("files.upload", { token: ana, body: { stream_id: streamId, name: "../etc/passwd", content: "x" } });
  check("穿越文件名被拒", badName.status === 400, badName.payload);
  const vm = await call("vms.create", {
    token: ana,
    body: { label: "构建机", host: "build.internal.example", port: 22, username: "ci", auth_kind: "password", secret: "s3cret", workdir: "/srv/app" },
  });
  check("登记办公虚拟机", Boolean(vm.payload.vm?.id), vm.payload);
  check("虚拟机凭据不明文返回", !JSON.stringify(vm.payload).includes("s3cret"));
  const grant = await call("streams.vms.grant", { token: ana, body: { stream_id: streamId, vm_id: vm.payload.vm?.id, level: "member" } });
  check("虚拟机授权到群", Boolean(grant.payload.grant_id), grant.payload);
  const probe = await call("vms.probe", { token: ana, body: { id: vm.payload.vm?.id } });
  check("探活有明确结论", typeof probe.payload.probe?.reachable === "boolean", probe.payload);

  step("7. MCP：内部工具与对外端点");
  const rotate = await call("streams.mcpkey.rotate", { token: ana, body: { stream_id: streamId } });
  const mcpKey = rotate.payload.key;
  check("群主可颁发 MCP key（明文仅此一次）", Boolean(mcpKey), rotate.payload);
  const mcpList = await call("mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  const mcpAuthed = await rawMcp(mcpKey, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const mcpNames = (mcpAuthed.result?.tools ?? []).map((item) => item.name);
  const expectedMcp = [
    "search_history", "read_window", "list_files", "read_file", "upload_file", "delete_file",
    "get_announcement", "get_context",
    "list_skills", "read_skill", "send_message", "invite_member", "set_announcement",
  ];
  check("带 key 的 tools/list 返回本群 13 个工具（含文件读写与公告）",
    mcpNames.length === expectedMcp.length && expectedMcp.every((name) => mcpNames.includes(name)), mcpAuthed);
  check("无 key 被拒", mcpList.status === 401, mcpList.payload);
  const mcpSearch = await rawMcp(mcpKey, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "search_history", arguments: { query: "发布", limit: 5 } },
  });
  const hits = JSON.parse(mcpSearch.result?.content?.[0]?.text ?? "{}");
  check("MCP 能查到群历史", (hits.hits ?? []).length > 0, hits);
  const mcpSend = await rawMcp(mcpKey, {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "send_message", arguments: { content: "外部 MCP 补一条记录" } },
  });
  const mcpSendOut = JSON.parse(mcpSend.result?.content?.[0]?.text ?? "{}");
  check("外部 MCP 能以群主身份写消息", Number(mcpSendOut.seq) > 0, mcpSendOut);
  const mcpCreate = await rawMcp(mcpKey, {
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "create_stream", arguments: { name: "越权建群" } },
  });
  check("外部 MCP 不能越权建群",
    (mcpCreate.result?.error ?? mcpCreate.error)?.message === "tool_not_allowed", mcpCreate);

  const mcpUpload = await rawMcp(mcpKey, {
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "upload_file", arguments: { name: "mcp草稿.md", content: "# 外部 MCP 写入\n第二行" } },
  });
  const mcpUploadOut = JSON.parse(mcpUpload.result?.content?.[0]?.text ?? "{}");
  check("外部 MCP 能上传群文件", Boolean(mcpUploadOut.file?.id), mcpUploadOut);
  const mcpFiles = JSON.parse((await rawMcp(mcpKey, {
    jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_files", arguments: {} },
  })).result?.content?.[0]?.text ?? "{}");
  check("外部 MCP 的文件列表能看到刚上传的文件",
    (mcpFiles.files ?? []).some((row) => row.name === "mcp草稿.md"), mcpFiles);
  const mcpRead = JSON.parse((await rawMcp(mcpKey, {
    jsonrpc: "2.0", id: 8, method: "tools/call",
    params: { name: "read_file", arguments: { name: "mcp草稿.md" } },
  })).result?.content?.[0]?.text ?? "{}");
  check("外部 MCP 能读回群文件正文", String(mcpRead.content ?? "").includes("外部 MCP 写入"), mcpRead);
  const mcpAnnouncement = JSON.parse((await rawMcp(mcpKey, {
    jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_announcement", arguments: {} },
  })).result?.content?.[0]?.text ?? "{}");
  check("外部 MCP 能读群公告", mcpAnnouncement.announcement === "周五 18:00 前定稿，逾期顺延。", mcpAnnouncement);
  const mcpDelete = JSON.parse((await rawMcp(mcpKey, {
    jsonrpc: "2.0", id: 10, method: "tools/call",
    params: { name: "delete_file", arguments: { name: "mcp草稿.md" } },
  })).result?.content?.[0]?.text ?? "{}");
  check("外部 MCP 能删除群文件", mcpDelete.ok === true, mcpDelete);

  const scope = { agentId, streamId, ownerId: a.payload.user.id };
  const skillTool = await executeTool(db, scope, "read_skill", { name: "WorkStream 平台技能" });
  check("内部工具能读到内置技能全文", String(skillTool.body ?? "").includes("create_stream"), skillTool);
  const devSkill = await executeTool(db, scope, "read_skill", { name: "DevStream 群文件与公告" });
  check("内置 DevStream 技能覆盖文件与公告工具",
    ["list_files", "read_file", "upload_file", "delete_file", "get_announcement", "set_announcement"]
      .every((name) => String(devSkill.body ?? "").includes(name)), devSkill);
  const skillList = await executeTool(db, scope, "list_skills", {});
  check("内置技能有两个（平台 + DevStream）",
    (skillList.skills ?? []).filter((item) => item.builtin).length === 2, skillList);
  const toolFile = await executeTool(db, scope, "upload_file", { name: "员工草稿.md", content: "# 员工写入\n第二条" });
  check("内部工具可以上传群文件", Boolean(toolFile.file?.id), toolFile);
  const toolRead = await executeTool(db, scope, "read_file", { name: "员工草稿.md" });
  check("内部工具可以读回群文件", String(toolRead.content ?? "").includes("员工写入"), toolRead);
  const toolAnnouncement = await executeTool(db, scope, "get_announcement", {});
  check("内部工具可以读群公告", toolAnnouncement.announcement === "周五 18:00 前定稿，逾期顺延。", toolAnnouncement);
  const toolDelete = await executeTool(db, scope, "delete_file", { id: toolFile.file?.id });
  check("内部工具可以删除群文件", toolDelete.ok === true, toolDelete);
  const toolStream = await executeTool(db, scope, "create_stream", { name: "技能随手建的群" });
  check("内部工具可以建群并自动入群", Boolean(toolStream.stream_id), toolStream);
  const toolInvite = await executeTool(db, scope, "invite_member", { email: "cy@example.com" });
  check("内部工具可以发邀请", toolInvite.email === "cy@example.com", toolInvite);
  const toolVm = await executeTool(db, scope, "register_vm", {
    label: "技能登记机", host: "skill.example.com", port: 22, username: "ci",
    auth_kind: "password", secret: "pw-123456", grant_stream_id: streamId,
  }, (name) => process.env[name]);
  check("内部工具可以登记并授权虚拟机", Boolean(toolVm.vm_id) && toolVm.granted_to === streamId, toolVm);
  const mcpWrongKey = await rawMcp("deadbeef", { jsonrpc: "2.0", id: 3, method: "tools/list" });
  check("错误 key 被拒", mcpWrongKey.status === 403, mcpWrongKey);

  step("8. 超上下文后按 stream 压缩");
  for (let i = 0; i < 16; i += 1) {
    await call("messages.send", {
      token: ana,
      body: { stream_id: streamId, content: `补长上下文 ${i}：${"细节".repeat(400)}` },
    });
  }
  await call("messages.send", { token: ana, body: { stream_id: streamId, content: "@小Q 收个尾", mentions: [{ type: "agent", id: agentId }] } });
  const tick2 = await call("scheduler.tick", { token: ana, method: "GET" });
  check("压缩后任务仍能完成", (tick2.payload.ran ?? []).some((r) => r.status === "done" && r.mode !== "compress"), tick2.payload);
  check("压缩转成后台信排队，不占回复的关键路径", (tick2.payload.queued ?? 0) >= 1, tick2.payload);
  const tick3 = await call("scheduler.tick", { token: ana, method: "GET" });
  check("后台压缩信下一轮跑完", (tick3.payload.ran ?? []).some((r) => r.status === "done" && r.mode === "compress"), tick3.payload);
  const memory = await call("agents.memory.list", { token: ana, method: "GET", body: { agent_id: agentId, scope: "stream", stream_id: streamId } });
  const summary = (memory.payload.items ?? []).find((m) => m.kind === "summary");
  check("写入本群压缩摘要并记录覆盖序号", Boolean(summary) && Number(summary.covers_through_seq) > 0, memory.payload);

  step("8b. 流式上游：插话、叫停与原图");
  const mock = await startMockUpstream();
  const PNG_B64 = AVATAR.split(",")[1];
  const mockAgent = await call("agents.create", {
    token: ana,
    body: {
      name: "小M", role: "流式联调", api_base_url: `http://127.0.0.1:${mock.port}/v1`,
      api_key: "mock-key-1", model: "mock", context_chars: 8000,
    },
  });
  const mockAgentId = mockAgent.payload.agent?.id;
  await call("streams.agents.add", { token: ana, body: { stream_id: streamId, agent_id: mockAgentId } });

  // 图片：原件进群文件表，消息只留引用，上游收到多模态部件。
  const imageSend = await call("messages.send", {
    token: ana,
    body: {
      stream_id: streamId, content: "@小M 这张图里是什么颜色",
      mentions: [{ type: "agent", id: mockAgentId }],
      attachments: [{ name: "红色方块.png", content_type: "image/png", data: PNG_B64 }],
    },
  });
  const fileRef = imageSend.payload.message?.attachments?.[0];
  check("图片随消息发出，消息里只留引用", imageSend.payload.message?.attachments?.length === 1 && Boolean(fileRef?.file_id), imageSend.payload);
  await call("scheduler.tick", { token: ana, method: "GET" });
  check("发给上游的上下文带上了 image_url 部件",
    mock.seen.some((body) => Array.isArray(body.messages?.[1]?.content)
      && body.messages[1].content.some((part) => part.type === "image_url" && String(part.image_url?.url).startsWith("data:image/png;base64,"))));
  const imageReply = ((await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } })).payload.items ?? [])
    .find((m) => m.sender_id === mockAgentId);
  check("虚拟员工读图后能回答颜色", String(imageReply?.content).includes("红色"), imageReply);
  const fetchImage = await call("messages.attachment", { token: ana, method: "GET", body: { id: fileRef?.file_id } });
  check("群成员能取回原图 base64", fetchImage.payload.attachment?.data === PNG_B64, fetchImage.payload);
  const stealImage = await call("messages.attachment", { token: deeToken, method: "GET", body: { id: fileRef?.file_id } });
  check("非群成员取不到原图", stealImage.status === 403, stealImage.payload);
  const badType = await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "带张不支持的图", attachments: [{ name: "a.svg", content_type: "image/svg+xml", data: PNG_B64 }] },
  });
  check("白名单外的图片类型被拒", badType.status === 400 && badType.payload.error === "unsupported_image_type", badType.payload);
  const emptySend = await call("messages.send", { token: ana, body: { stream_id: streamId, content: "" } });
  check("空正文且无图被拒", emptySend.status === 400 && emptySend.payload.error === "invalid_content", emptySend.payload);

  // 工具回路走 SSE 分片拼接。
  await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "@小M 查历史里的发布清单", mentions: [{ type: "agent", id: mockAgentId }] },
  });
  await call("scheduler.tick", { token: ana, method: "GET" });
  check("SSE 分片拼出的工具参数能真的执行", mock.seen.some((body) => body.messages?.some((m) => m.role === "tool")));

  // 插话：正在流式生成时新的 @ 掐断半截，按新消息重答，只回一条。
  const steerSend = await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "@小M 慢慢写一份周报", mentions: [{ type: "agent", id: mockAgentId }] },
  });
  check("开跑前插话消息仍会排队", steerSend.payload.queued?.length === 1, steerSend.payload);
  const steerTick = call("scheduler.tick", { token: ana, method: "GET" });
  await new Promise((resolve) => { setTimeout(resolve, 700); });
  const steer = await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "@小M 只要三条就行", mentions: [{ type: "agent", id: mockAgentId }] },
  });
  const steerRan = (await steerTick).payload;
  check("任务正在跑时，新的 @ 登记成插话而不是另起一条任务",
    steer.payload.interrupted?.length === 1 && (steer.payload.queued ?? []).length === 0, steer.payload);
  check("插话后任务照样收尾", (steerRan.ran ?? []).some((r) => r.status === "done"), steerRan);
  const afterSteer = ((await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } })).payload.items ?? [])
    .filter((m) => m.sender_id === mockAgentId);
  check("半截正文不会落进群里", afterSteer.every((m) => !String(m.content).includes("慢慢写")), afterSteer.map((m) => m.content));
  check("落进群里的是按插话重答的那条", afterSteer.some((m) => String(m.content).includes("已按插话重排")), afterSteer.map((m) => m.content));
  const steerMsg = ((await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } })).payload.items ?? [])
    .find((m) => m.id === steer.payload.message?.id);
  check("插话那条消息对员工显示已处理", (steerMsg?.deliveries ?? []).some((d) => d.status === "done"), steerMsg);

  // 叫停：不插话，直接掐断，不产出回复。
  await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "@小M 慢慢写一份月报", mentions: [{ type: "agent", id: mockAgentId }] },
  });
  const stopTick = call("scheduler.tick", { token: ana, method: "GET" });
  await new Promise((resolve) => { setTimeout(resolve, 700); });
  const stop = await call("scheduler.interrupt", { token: ana, body: { stream_id: streamId, agent_id: mockAgentId } });
  await stopTick;
  check("主人可以叫停正在生成的回复", stop.payload.mode === "stop", stop.payload);
  const stopMails = await call("mail.list", { token: ana, method: "GET", body: { agent_id: mockAgentId } });
  check("被叫停的任务留痕为 cancelled/interrupted",
    (stopMails.payload.items ?? []).some((m) => m.status === "cancelled" && m.error === "interrupted"), stopMails.payload);
  const afterStop = ((await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } })).payload.items ?? [])
    .filter((m) => m.sender_id === mockAgentId);
  check("叫停后不会吐半截回复", afterStop.every((m) => !String(m.content).includes("慢慢写")), afterStop.map((m) => m.content));
  const strangerStop = await call("scheduler.interrupt", { token: bToken, body: { stream_id: streamId, agent_id: mockAgentId } });
  check("别人不能叫停你的虚拟员工",
    strangerStop.status === 403 && strangerStop.payload.error === "agent_not_owned", strangerStop.payload);
  const noRun = await call("scheduler.interrupt", { token: ana, body: { stream_id: streamId, agent_id: mockAgentId } });
  check("没在跑时叫停给出明确错误", noRun.status === 409 && noRun.payload.error === "nothing_running", noRun.payload);
  step("8c. 上下文窗口：预算够就装全量，装不下就取最新并自动补齐摘要");
  await call("agents.update", { token: ana, body: { id: mockAgentId, context_chars: 200000 } });
  for (let i = 0; i < 405; i += 1) {
    await call("messages.send", { token: ana, body: { stream_id: streamId, content: `长流水 ${i}` } });
  }
  await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "@小M 复述最后一条流水号", mentions: [{ type: "agent", id: mockAgentId }] },
  });
  await call("scheduler.tick", { token: ana, method: "GET" });
  const seenWith = (needle) => String((mock.seen
    .filter((body) => String(body.messages?.[0]?.content ?? "").includes(needle))
    .pop() ?? {}).messages?.[0]?.content ?? "");
  const wideSystem = seenWith("复述最后一条流水号");
  check("预算够大时窗口装下全部记录（不再有条数上限把最旧的挤掉）",
    wideSystem.includes("长流水 404") && wideSystem.includes("长流水 0"), wideSystem.slice(0, 200));

  await call("agents.update", { token: ana, body: { id: mockAgentId, context_chars: 8000 } });
  await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "@小M 预算调小了，再报一次最后一条流水号", mentions: [{ type: "agent", id: mockAgentId }] },
  });
  const narrowTick = await call("scheduler.tick", { token: ana, method: "GET" });
  const narrowSystem = seenWith("预算调小了");
  check("预算装不下时窗口留下的是最新记录",
    narrowSystem.includes("长流水 404") && !narrowSystem.includes("长流水 0"), narrowSystem.slice(0, 200));
  check("窗口被截断就补投压缩信，被挤出去的记录不会永远进不了摘要", (narrowTick.payload.queued ?? 0) >= 1, narrowTick.payload);

  // 积压由后台压缩信自己排空，不用真人再发消息；排空后窗口就该从水位线连续往下。
  const readCovers = async () => {
    const mem = await call("agents.memory.list", {
      token: ana, method: "GET", body: { agent_id: mockAgentId, scope: "stream", stream_id: streamId },
    });
    return Number((mem.payload.items ?? []).find((m) => m.kind === "summary")?.covers_through_seq ?? 0);
  };
  for (let round = 0; round < 40; round += 1) {
    const tick = await call("scheduler.tick", { token: ana, method: "GET" });
    const compressing = (tick.payload.ran ?? []).some((r) => r.mode === "compress");
    if (!compressing && (tick.payload.queued ?? 0) === 0) break;
  }
  const covers = await readCovers();
  await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "@小M 收尾核对", mentions: [{ type: "agent", id: mockAgentId }] },
  });
  await call("scheduler.tick", { token: ana, method: "GET" });
  const finalSeq = Number(/最近记录：\n#(\d+)/.exec(seenWith("收尾核对"))?.[1] ?? 0);
  check("摘要覆盖序号把水位线推到最新记录之前（积压真的排空了）", covers > 0, { covers });
  check("窗口从水位线连续往下，中间不留既看不见也没被摘要覆盖的缺口",
    finalSeq === covers + 1, { finalSeq, covers });

  step("8d. 前缀缓存：稳定态下上一轮窗口整段可复用");
  for (const word of ["前缀甲", "前缀乙"]) {
    await call("messages.send", {
      token: ana,
      body: { stream_id: streamId, content: `@小M ${word}`, mentions: [{ type: "agent", id: mockAgentId }] },
    });
    await call("scheduler.tick", { token: ana, method: "GET" });
  }
  // 按「上一条 @ 你的消息」那一块认轮次：下一轮的转录里也带着上一轮的关键词，按全文匹配会两轮取到同一份。
  const triggered = (needle) => String(mock.seen
    .map((body) => String(body.messages?.[0]?.content ?? ""))
    .filter((system) => (system.split("\n\n").find((b) => b.startsWith("上一条 @ 你的消息")) ?? "").includes(needle))
    .pop() ?? "");
  const [prev, curr] = [triggered("前缀甲"), triggered("前缀乙")];
  let shared = 0;
  while (shared < prev.length && shared < curr.length && prev[shared] === curr[shared]) shared += 1;
  // 转录窗口之后才是每轮必变的块（本群记忆 / 触发消息），公共前缀至少要覆盖到窗口末尾。
  const windowEnd = ["\n\n本群记忆", "\n\n上一条 @ 你的消息"]
    .map((mark) => prev.indexOf(mark)).find((at) => at > 0) ?? prev.length;
  check("两轮请求的公共前缀覆盖整段上一轮窗口（头部没滑动，提供商侧前缀缓存能吃下）",
    shared >= windowEnd && windowEnd > 0,
    { 命中率: `${((shared / curr.length) * 100).toFixed(1)}%`, 断点后: curr.slice(shared, shared + 40) });
  check("每轮只新付本轮新增的记录与触发消息（可复用前缀 ≥95%）", shared / curr.length >= 0.95,
    { 命中率: `${((shared / curr.length) * 100).toFixed(1)}%`, 长度: [prev.length, curr.length], 断点后: curr.slice(shared, shared + 60) });

  step("8d2. 提示词槽位表：位置是从表里领的号，缓存断点写在表里");
  check("槽位 id 唯一、都有整数 order 和 build（重复 id 会静默覆盖，重复 order 让顺序取决于插入先后）",
    new Set(PROMPT_SECTIONS.map((section) => section.id)).size === PROMPT_SECTIONS.length
    && PROMPT_SECTIONS.every((section) => Number.isInteger(section.order) && typeof section.build === "function"),
    { 槽位数: PROMPT_SECTIONS.length });
  check("缓存断点就是 memory.common：它之前的块在稳态下逐字复用",
    CACHE_BREAKPOINT_ID === "memory.common", { CACHE_BREAKPOINT_ID });
  const slotCtx = {
    agent: { name: "小S", role: "测试", signature: "一句签名", system_prompt: "一条守则", backend: "openai" },
    stream: { name: "槽位群", announcement: "一条公告" },
    prepared: {
      common: [{ content: "长期记忆甲" }],
      summary: "摘要正文",
      windowStart: 3,
      window: [{ seq: 4, sender_type: "agent", sender_name: "小S", content: "窗口里的一条" }],
      notes: [{ content: "本群记忆甲" }],
    },
    trigger: { sender_name: "安娜", content: "@小S 干活" },
    skills: "### 技能正文",
    steerNote: "",
    cloud: false,
  };
  const composed = composeSystemPrompt(slotCtx);
  check("落下的槽位与顺序按表分配（这一份夹具应当是这十一个块）",
    composed.promptSlots.map(([id]) => id).join(",") ===
      "identity,signature,guide,announcement,skills,history.access,memory.common,summary,transcript,memory.stream,trigger",
    { 实际: composed.promptSlots.map(([id]) => id) });
  check("正文逐字对得上：身份打头、触发消息收尾，块之间恰好一个空行",
    composed.system.startsWith("你是虚拟员工「小S」（角色：测试），正在 WorkStream 群「槽位群」里工作。\n\n")
    && composed.system.endsWith("上一条 @ 你的消息：安娜：@小S 干活")
    && !composed.system.includes("\n\n\n")
    && composed.system.split("\n\n").length === composed.promptSlots.length,
    { 字符数: composed.system.length });
  const trimmed = composeSystemPrompt({
    ...slotCtx,
    agent: { ...slotCtx.agent, signature: "", system_prompt: "" },
    stream: { ...slotCtx.stream, announcement: "" },
    prepared: { ...slotCtx.prepared, common: [], notes: [], summary: "" },
    skills: "",
  });
  check("没有内容的槽位不落块，也不在正文里留下空段",
    trimmed.promptSlots.map(([id]) => id).join(",") === "identity,history.access,transcript,trigger"
    && trimmed.system.split("\n\n").length === 4 && !trimmed.system.includes("\n\n\n"),
    { 实际: trimmed.promptSlots.map(([id]) => id) });
  const clouded = composeSystemPrompt({ ...slotCtx, agent: { ...slotCtx.agent, backend: "qca" }, cloud: true });
  check("云端通道只多一块云端须知、只换这两处措辞，其余块和它们的顺序照旧",
    clouded.promptSlots.map(([id]) => id).filter((id) => id !== "backend.cloud").join(",")
      === composed.promptSlots.map(([id]) => id).join(",")
    && clouded.system.includes("本次由云端 Agent 作答")
    && clouded.system.includes("由 WorkStream 侧补给你")
    && !clouded.system.includes("需要时用 set_signature 更新"),
    { 云端槽位: clouded.promptSlots.map(([id]) => id) });
  check("对照：自建端点那一份仍然是本地措辞（不是所有员工都被当成云端）",
    composed.system.includes("调用 search_history / read_window 工具")
    && composed.system.includes("需要时用 set_signature 更新")
    && !composed.system.includes("本次由云端 Agent 作答"), {});
  // 演示模型按抬头挑可摘录的块：改了块措辞没改这份清单，过滤会静默失效、内部指令又会被念进群。
  check("演示模型允许摘录的抬头都真的出现在装配出来的正文里",
    DEMO_QUOTABLE_HEADERS.every((header) => composed.system.includes(header)),
    { 缺: DEMO_QUOTABLE_HEADERS.filter((header) => !composed.system.includes(header)) });
  step("8e. 突发排队：同群第二封的上下文里必须带着第一封刚落的回复");
  const burst = async (content) => call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: `@小M ${content}`, mentions: [{ type: "agent", id: mockAgentId }] },
  });
  const [firstMail, secondMail] = [await burst("突发甲"), await burst("突发乙")];
  check("连发两封 @ 排成两封任务（第二封不会被当成插话）",
    firstMail.payload.queued.length === 1 && secondMail.payload.queued.length === 1
    && secondMail.payload.interrupted.length === 0,
    { 第一轮: firstMail.payload.queued, 第二轮: secondMail.payload.queued, 插话: secondMail.payload.interrupted });
  const burstTick1 = await call("scheduler.tick", { token: ana, method: "GET" });
  check("同一群同一员工一轮只放最早的一封（并发跑两封会把顺序写乱）",
    (burstTick1.payload.ran ?? []).length === 1, burstTick1.payload.ran);
  const burstTick2 = await call("scheduler.tick", { token: ana, method: "GET" });
  check("第二轮把积压的第二封跑掉", (burstTick2.payload.ran ?? []).length === 1, burstTick2.payload.ran);
  const secondSystem = triggered("突发乙");
  check("第二封的上下文能看到第一封的回复（窗口不按触发序号设上界，突发不会重复作答）",
    secondSystem.includes("回甲已落群") && secondSystem.includes("突发甲"),
    { 触发块: secondSystem.split("\n\n").find((b) => b.startsWith("上一条 @ 你的消息"))?.slice(0, 60) });
  await mock.close();

  step("9. 成员管理：提管理员、拉人、踢人");
  const members = await call("streams.get", { token: ana, method: "GET", body: { id: streamId } });
  const boMembership = (members.payload.members ?? []).find((m) => m.type === "human" && m.display_name === "Bo");
  check("群详情列出成员", Boolean(boMembership), members.payload);
  const promote = await call("streams.members.promote", { token: ana, body: { stream_id: streamId, membership_id: boMembership?.membership_id, role: "admin" } });
  check("群主提升 Bo 为管理员", promote.payload.role === "admin", promote.payload);
  const invite = await call("streams.invite", { token: bToken, body: { stream_id: streamId, email: "cy@example.com" } });
  check("管理员可以邀请真人", invite.payload.ok === true, invite.payload);
  const demote = await call("streams.members.promote", { token: bToken, body: { stream_id: streamId, membership_id: boMembership?.membership_id, role: "member" } });
  check("管理员不能自降权限（仅群主可改角色）", demote.status === 403, demote.payload);
  const kickTarget = await call("streams.get", { token: bToken, method: "GET", body: { id: streamId } });
  const agentMembership = (kickTarget.payload.members ?? []).find((m) => m.type === "agent");
  const kick = await call("streams.members.remove", { token: bToken, body: { stream_id: streamId, membership_id: agentMembership?.membership_id } });
  check("管理员不能踢虚拟员工（需群主）", kick.status === 403, kick.payload);
  const kickByOwner = await call("streams.members.remove", { token: ana, body: { stream_id: streamId, membership_id: agentMembership?.membership_id } });
  check("群主把虚拟员工移出群", kickByOwner.payload.removed === agentMembership?.membership_id, kickByOwner.payload);

  step("10. 会话与隔离");
  const noAuth = await call("streams.get", { method: "GET", body: { id: streamId } });
  check("无会话读不到群", noAuth.status === 401, noAuth.payload);
  const c = await call("auth.register", { body: { email: "cy@example.com", password: "passw0rd-9", display_name: "Cy" } });
  const cToken = (await call("auth.login", { body: { email: "cy@example.com", password: "passw0rd-9" } })).payload.token;
  const stranger = await call("streams.get", { token: cToken, method: "GET", body: { id: streamId } });
  check("非成员读群详情被拒", stranger.status === 403, stranger.payload);
  const lookup = await call("streams.lookup", { token: cToken, method: "GET", body: { id: streamId } });
  check("UUID 预览只给名字与进群方式", lookup.payload.preview?.name === "上线前定稿"
    && lookup.payload.preview.members === undefined && !("announcement" in (lookup.payload.preview ?? {})), lookup.payload);
  const strangerSend = await call("messages.send", { token: cToken, body: { stream_id: streamId, content: "混进来" } });
  check("非成员发消息被拒", strangerSend.status === 403, strangerSend.payload);
  const strangerAgent = await call("agents.get", { token: cToken, method: "GET", body: { id: agentId } });
  check("非主人读不到别人的虚拟员工", strangerAgent.status === 403, strangerAgent.payload);
  const logout = await call("auth.logout", { token: cToken });
  check("登出后会话失效", logout.payload.ok === true && (await call("auth.me", { token: cToken, method: "GET" })).status === 401);

  step("11. 部署适配层边界：前端凭据怎么进来");
  // 站点适配层会剥掉浏览器带上的 authorization / cookie，只保留自定义头。
  // 这里跑真的 serveSite 包装，确保线上的取令牌路径和本机一致。
  const siteHandler = serveSite(handler, {
    createClient: () => supabase,
    env: (name) => ({ SUPABASE_URL: "https://db.invalid", SUPABASE_ANON_KEY: "anon-key" })[name] ?? "",
    fetch: async () => new Response("[]", { status: 200 }),
  });
  const viaSite = async (headers) => {
    const response = await siteHandler(new Request("http://site.example/functions/v1/app?action=auth.me", {
      method: "GET",
      headers: { "x-instance-id": crypto.randomUUID(), ...headers },
    }));
    return { status: response.status, payload: await response.json().catch(() => ({})) };
  };
  const stripped = await viaSite({ authorization: `Bearer ${ana}` });
  check("只剩 authorization 时登录不上（适配层会剥掉）", stripped.status === 401, stripped.payload);
  const customHeader = await viaSite({ "x-workstream-token": ana });
  check("自定义令牌头能穿过适配层完成鉴权",
    customHeader.payload?.ok === true && customHeader.payload?.user?.email === "ana@example.com", customHeader.payload);

  // site.meta 是登录页用来决定"用什么方式收验证码、Key 存在哪儿"的唯一入口，必须不带会话也读得到。
  const meta = await call("site.meta", { method: "GET" });
  check("site.meta 不带会话也能读（公开路由）",
    meta.status === 200 && meta.payload.name === "WorkStream" && meta.payload.user === undefined, meta.payload);
  check("site.meta 报出服务端时间", Boolean(meta.payload.server_time), meta.payload);
  check("本机形态：库内加密 + 开发态收件箱 + 本地开发标记 + 没有平台 Storage",
    meta.payload.data_key === "database" && meta.payload.smtp === false
    && meta.payload.local_dev === true && meta.payload.storage_mode === "database", meta.payload);
  process.env.WORKSTREAM_SMTP_URL = "http://127.0.0.1:2525/relay";
  process.env.WORKSTREAM_DATA_KEY = "a".repeat(44);
  const metaDeployed = await call("site.meta", { method: "GET", entry: prodHandler });
  check("配了中转端点与独立数据密钥后，site.meta 如实切换到 secret/relay",
    metaDeployed.payload.smtp === true && metaDeployed.payload.data_key === "secret", metaDeployed.payload);
  delete process.env.WORKSTREAM_SMTP_URL;
  delete process.env.WORKSTREAM_DATA_KEY;

  step("12. 群管理面：改名与进群设置");
  const g1 = await call("streams.create", { token: ana, body: { name: "临时协调组", agent_ids: [agentId] } });
  const g1id = g1.payload.stream?.id;
  check("为管理面测试新建一个群", Boolean(g1id), g1.payload);
  const x12Rename = await call("streams.rename", { token: ana, body: { stream_id: g1id, name: "改过名字的协调组" } });
  const x12RenameRead = await call("streams.get", { token: ana, method: "GET", body: { id: g1id } });
  check("streams.rename：群主改名后详情回读", x12Rename.payload.name === "改过名字的协调组"
    && x12RenameRead.payload.stream?.name === "改过名字的协调组", x12Rename.payload);
  const x12Long = await call("streams.rename", { token: ana, body: { stream_id: g1id, name: "长".repeat(21) } });
  check("streams.rename：名字超限被拒", x12Long.status === 400 && x12Long.payload.error === "invalid_name", x12Long.payload);
  const x12Outsider = await call("streams.rename", { token: deeToken, body: { stream_id: g1id, name: "外人改名" } });
  check("streams.rename：非成员改不了群名", x12Outsider.status === 403, x12Outsider.payload);
  const x12SetByOther = await call("streams.settings", { token: bToken, body: { stream_id: g1id, context_chars: 4000 } });
  check("streams.settings：只有群主能改（管理员也不行）", x12SetByOther.status === 403
    && x12SetByOther.payload.error === "owner_only", x12SetByOther.payload);
  const x12Tiny = await call("streams.settings", { token: ana, body: { stream_id: g1id, context_chars: 1999 } });
  check("streams.settings：预算低于 2000 被拒", x12Tiny.status === 400
    && x12Tiny.payload.error === "invalid_context_chars", x12Tiny.payload);
  const x12Policy = await call("streams.settings", { token: ana, body: { stream_id: g1id, join_policy: "anyone" } });
  check("streams.settings：非法进群方式被拒", x12Policy.status === 400
    && x12Policy.payload.error === "invalid_join_policy", x12Policy.payload);
  const x12Peek = await call("streams.settings", { token: ana, body: { stream_id: g1id } });
  check("streams.settings：空请求体只回读不改设置", x12Peek.payload.ok === true
    && x12Peek.payload.context_chars === 200000 && x12Peek.payload.join_policy === undefined, x12Peek.payload);
  const x12Set = await call("streams.settings", { token: ana, body: { stream_id: g1id, context_chars: 6000, join_policy: "invite_only" } });
  const x12SetRead = await call("streams.get", { token: ana, method: "GET", body: { id: g1id } });
  check("streams.settings：预算与进群方式真的落库", x12Set.payload.ok === true
    && x12SetRead.payload.stream?.context_chars === 6000
    && x12SetRead.payload.stream?.join_policy === "invite_only", { 写: x12Set.payload, 读: x12SetRead.payload.stream });
  const x12Apply = await call("streams.apply", { token: deeToken, body: { stream_uuid: g1id } });
  check("切成仅邀请后，拿 UUID 申请被拒", x12Apply.status === 409 && x12Apply.payload.error === "invite_only", x12Apply.payload);

  step("13. 邀请闭环：待办、接受、拒绝与越权");
  const cyToken = (await call("auth.login", { body: { email: "cy@example.com", password: "passw0rd-9" } })).payload.token;
  const x13Invite = await call("streams.invite", { token: ana, body: { stream_id: g1id, email: "bo@example.com" } });
  check("streams.invite：群主邀请 Bo 进临时群", x13Invite.payload.email === "bo@example.com", x13Invite.payload);
  const x13Dup = await call("streams.invite", { token: ana, body: { stream_id: g1id, email: "bo@example.com" } });
  check("streams.invite：重复邀请短路，不落第二封", x13Dup.payload.duplicate === true, x13Dup.payload);
  const x13BadEmail = await call("streams.invite", { token: ana, body: { stream_id: g1id, email: "not-an-email" } });
  check("streams.invite：非法邮箱被拒", x13BadEmail.status === 400 && x13BadEmail.payload.error === "invalid_email", x13BadEmail.payload);
  const x13StrangerInvite = await call("streams.invite", { token: bToken, body: { stream_id: g1id, email: "ed@example.com" } });
  check("streams.invite：还不是成员的人发不出邀请", x13StrangerInvite.status === 403, x13StrangerInvite.payload);
  const x13DeeList = await call("streams.invites.mine", { token: deeToken });
  check("streams.invites.mine：没被邀请的人待办为空", (x13DeeList.payload.items ?? []).length === 0, x13DeeList.payload);
  const x13BoList = await call("streams.invites.mine", { token: bToken });
  const boG1Invite = (x13BoList.payload.items ?? []).find((row) => row.stream_id === g1id);
  check("streams.invites.mine：待办里出现邀请并带上改后的群名", boG1Invite?.stream_name === "改过名字的协调组", x13BoList.payload);
  const x13Decline = await call("streams.invites.decline", { token: bToken, body: { request_id: boG1Invite?.id } });
  check("streams.invites.decline：Bo 拒绝邀请", x13Decline.payload.ok === true, x13Decline.payload);
  const x13AcceptAfterDecline = await call("streams.invites.accept", { token: bToken, body: { request_id: boG1Invite?.id } });
  check("拒绝之后不能再接受", x13AcceptAfterDecline.status === 409
    && x13AcceptAfterDecline.payload.error === "request_handled", x13AcceptAfterDecline.payload);
  const x13BoList2 = await call("streams.invites.mine", { token: bToken });
  check("拒绝后待办里不再有这封", !(x13BoList2.payload.items ?? []).some((row) => row.id === boG1Invite?.id), x13BoList2.payload);
  const x13Reinvite = await call("streams.invite", { token: ana, body: { stream_id: g1id, email: "bo@example.com" } });
  check("拒绝后群主能再邀一次（旧的 rejected 不挡路）", x13Reinvite.payload.ok === true
    && x13Reinvite.payload.duplicate !== true, x13Reinvite.payload);
  const boG1Invite2 = (await call("streams.invites.mine", { token: bToken })).payload.items
    ?.find((row) => row.stream_id === g1id);
  const x13BoAccept = await call("streams.invites.accept", { token: bToken, body: { request_id: boG1Invite2?.id } });
  const x13BoRead = await call("streams.get", { token: bToken, method: "GET", body: { id: g1id } });
  check("streams.invites.accept：Bo 接受后成为成员", x13BoAccept.payload.stream_id === g1id
    && x13BoRead.payload.my_role === "member", { 接受: x13BoAccept.payload, 读: x13BoRead.payload.my_role });
  const x13DupAccept = await call("streams.invites.accept", { token: bToken, body: { request_id: boG1Invite2?.id } });
  check("重复接受被拒", x13DupAccept.status === 409 && x13DupAccept.payload.error === "request_handled", x13DupAccept.payload);
  const x13Steal = await call("streams.invites.accept", { token: deeToken, body: { request_id: boG1Invite2?.id } });
  check("别人不能拿他人的邀请进群", x13Steal.status === 404 && x13Steal.payload.error === "invite_not_found", x13Steal.payload);
  const x13StealDecline = await call("streams.invites.decline", { token: deeToken, body: { request_id: boG1Invite2?.id } });
  check("别人也不能替他人拒绝邀请", x13StealDecline.status === 404
    && x13StealDecline.payload.error === "invite_not_found", x13StealDecline.payload);
  const x13BadId = await call("streams.invites.accept", { token: cyToken, body: { request_id: "not-uuid" } });
  check("邀请 id 非法时给 400", x13BadId.status === 400 && x13BadId.payload.error === "invalid_request_id", x13BadId.payload);
  await call("streams.invite", { token: ana, body: { stream_id: g1id, email: "cy@example.com" } });
  const x13CyList = await call("streams.invites.mine", { token: cyToken });
  const cyG1 = (x13CyList.payload.items ?? []).find((row) => row.stream_id === g1id);
  const cyMain = (x13CyList.payload.items ?? []).find((row) => row.stream_id === streamId);
  check("Cy 的待办同时列出主群与临时群两封邀请", Boolean(cyG1) && Boolean(cyMain), x13CyList.payload);
  const x13CyAccept = await call("streams.invites.accept", { token: cyToken, body: { request_id: cyG1?.id } });
  check("streams.invites.accept：Cy 接受临时群邀请", x13CyAccept.payload.ok === true, x13CyAccept.payload);
  const x13CyMain = await call("streams.invites.accept", { token: cyToken, body: { request_id: cyMain?.id } });
  const x13CyMainRead = await call("messages.list", { token: cyToken, method: "GET", body: { stream_id: streamId } });
  check("Cy 接受主群邀请后以普通成员身份能读消息", x13CyMain.payload.ok === true && x13CyMainRead.payload.ok === true,
    { 接受: x13CyMain.payload, 读: x13CyMainRead.status });
  // 群已经不在了但邀请还挂着的兜底名：直接用库造一条孤儿邀请。
  await db.requests.insert({
    id: crypto.randomUUID(), stream_id: crypto.randomUUID(), kind: "invite", applicant_user_id: null,
    applicant_email: "dee@example.com", applicant_name: null, agent_id: null, status: "pending",
    handled_by: null, handled_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { columns: "id" });
  const x13Orphan = await call("streams.invites.mine", { token: deeToken });
  check("孤儿邀请在待办里显示为「已删除的群」而不是空白", (x13Orphan.payload.items ?? [])
    .some((row) => row.stream_name === "已删除的群"), x13Orphan.payload);

  step("14. 移交、退群与停用：权限跟着群主一起走");
  const g1Dir = await call("streams.get", { token: ana, method: "GET", body: { id: g1id } });
  const anaMembershipG1 = (g1Dir.payload.members ?? []).find((m) => m.type === "human" && m.id === a.payload.user.id);
  const boMembershipG1 = (g1Dir.payload.members ?? []).find((m) => m.type === "human" && m.email === "bo@example.com");
  const cyMembershipG1 = (g1Dir.payload.members ?? []).find((m) => m.type === "human" && m.email === "cy@example.com");
  const agentMembershipG1 = (g1Dir.payload.members ?? []).find((m) => m.type === "agent");
  const x14TransferDenied = await call("streams.transfer", { token: bToken, body: { stream_id: g1id, membership_id: cyMembershipG1?.membership_id } });
  check("streams.transfer：非群主不能移交", x14TransferDenied.status === 403
    && x14TransferDenied.payload.error === "owner_only", x14TransferDenied.payload);
  const x14Foreign = await call("streams.transfer", { token: ana, body: { stream_id: g1id, membership_id: boMembership?.membership_id } });
  check("streams.transfer：不能把群主交给别的群的成员", x14Foreign.status === 404
    && x14Foreign.payload.error === "member_missing", x14Foreign.payload);
  const x14ToAgent = await call("streams.transfer", { token: ana, body: { stream_id: g1id, membership_id: agentMembershipG1?.membership_id } });
  check("streams.transfer：不能把群主交给虚拟员工", x14ToAgent.status === 404
    && x14ToAgent.payload.error === "member_missing", x14ToAgent.payload);
  const x14Transfer = await call("streams.transfer", { token: ana, body: { stream_id: g1id, membership_id: boMembershipG1?.membership_id } });
  const g1AfterTransfer = await call("streams.get", { token: bToken, method: "GET", body: { id: g1id } });
  check("streams.transfer：移交后新群主是 Bo，旧群主降为管理员", x14Transfer.payload.ok === true
    && g1AfterTransfer.payload.stream?.owner_id === b.payload.user.id
    && g1AfterTransfer.payload.my_role === "owner"
    && (g1AfterTransfer.payload.members ?? []).find((m) => m.id === a.payload.user.id)?.role === "admin",
  { 移交: x14Transfer.payload, 新群主视角: g1AfterTransfer.payload.stream });
  const x14OwnerLeave = await call("streams.leave", { token: bToken, body: { stream_id: g1id } });
  check("streams.leave：群主必须先移交才能退群", x14OwnerLeave.status === 409
    && x14OwnerLeave.payload.error === "owner_must_transfer", x14OwnerLeave.payload);
  const x14OldAdminSettings = await call("streams.settings", { token: ana, body: { stream_id: g1id, context_chars: 3000 } });
  check("移交后前群主改不了群设置（权限真的跟着走了）", x14OldAdminSettings.status === 403
    && x14OldAdminSettings.payload.error === "owner_only", x14OldAdminSettings.payload);
  const x14Back = await call("streams.transfer", { token: bToken, body: { stream_id: g1id, membership_id: anaMembershipG1?.membership_id } });
  const g1AfterBack = await call("streams.get", { token: ana, method: "GET", body: { id: g1id } });
  check("streams.transfer：可以移交给回原群主", x14Back.payload.ok === true
    && g1AfterBack.payload.stream?.owner_id === a.payload.user.id, g1AfterBack.payload.stream);
  const x14Leave = await call("streams.leave", { token: cyToken, body: { stream_id: g1id } });
  check("streams.leave：普通成员可以退群", x14Leave.payload.ok === true, x14Leave.payload);
  const x14LeaveRead = await call("streams.get", { token: cyToken, method: "GET", body: { id: g1id } });
  check("退群后读不到这个群", x14LeaveRead.status === 403, x14LeaveRead.payload);
  const x14LeaveAgain = await call("streams.leave", { token: cyToken, body: { stream_id: g1id } });
  check("退第二次给明确拒绝而不是静默成功", x14LeaveAgain.status === 403, x14LeaveAgain.payload);
  const x14Queue = await call("messages.send", {
    token: ana,
    body: { stream_id: g1id, content: "@小Q 停群前的一句话", mentions: [{ type: "agent", id: agentId }] },
  });
  const x14MailId = (x14Queue.payload.queued ?? [])[0]?.mail_id;
  check("临时群里先排进一封待办任务", Boolean(x14MailId), x14Queue.payload);
  const x14Rotate = await call("streams.mcpkey.rotate", { token: ana, body: { stream_id: g1id } });
  const x14Key = x14Rotate.payload.key;
  const x14McpBefore = await rawMcp(x14Key, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("停用前这个群的 MCP 钥匙可用", x14McpBefore.status === 200, x14Rotate.payload);
  const x14DeleteDenied = await call("streams.delete", { token: bToken, body: { stream_id: g1id } });
  check("streams.delete：管理员删不掉群", x14DeleteDenied.status === 403
    && x14DeleteDenied.payload.error === "owner_only", x14DeleteDenied.payload);
  const x14Delete = await call("streams.delete", { token: ana, body: { stream_id: g1id } });
  check("streams.delete：群主能停用", x14Delete.payload.ok === true, x14Delete.payload);
  const x14MineAna = await call("streams.mine", { token: ana });
  const x14MineBo = await call("streams.mine", { token: bToken });
  check("停用后这个群不再出现在群主与成员的群列表",
    !(x14MineAna.payload.items ?? []).some((s) => s.id === g1id)
    && !(x14MineBo.payload.items ?? []).some((s) => s.id === g1id),
  { Ana: (x14MineAna.payload.items ?? []).map((s) => s.name), Bo: (x14MineBo.payload.items ?? []).map((s) => s.name) });
  const x14SendAfter = await call("messages.send", { token: ana, body: { stream_id: g1id, content: "停群后还能发？" } });
  check("停用后群主自己也发不进消息", x14SendAfter.status === 403, x14SendAfter.payload);
  const x14ReadAfter = await call("streams.get", { token: ana, method: "GET", body: { id: g1id } });
  check("停用后读不到群详情", x14ReadAfter.status === 404, x14ReadAfter.payload);
  const x14McpAfter = await rawMcp(x14Key, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  check("停用后这个群的 MCP 钥匙一起失效", x14McpAfter.status === 403, x14McpAfter.payload);
  const x14LookupAfter = await call("streams.lookup", { token: cyToken, method: "GET", body: { id: g1id } });
  check("停用后 UUID 预览入口关闭", x14LookupAfter.status === 404, x14LookupAfter.payload);
  const x14ApplyAfter = await call("streams.apply", { token: cyToken, body: { stream_uuid: g1id } });
  check("停用后不能再申请进群（不留无人能批的悬空申请）", x14ApplyAfter.status === 404
    && x14ApplyAfter.payload.error === "stream_not_found", x14ApplyAfter.payload);
  const x14MailAfter = await call("mail.list", { token: ana, method: "GET", body: { agent_id: agentId } });
  const deadMail = (x14MailAfter.payload.items ?? []).find((row) => row.id === x14MailId);
  check("停用把队列里的待办标成 cancelled，不留悄悄跑不了的任务",
    deadMail?.status === "cancelled" && deadMail?.error === "stream_closed", deadMail);
  const x14Tick = await call("scheduler.tick", { token: ana, method: "GET" });
  check("停用后调度轮询不崩，也不再跑这个群的活", x14Tick.payload.ok === true
    && (x14Tick.payload.ran ?? []).every((row) => row.stream_id !== g1id), x14Tick.payload);
  const x14DeleteAgain = await call("streams.delete", { token: ana, body: { stream_id: g1id } });
  check("重复停用给 404 而不是假装成功", x14DeleteAgain.status === 404, x14DeleteAgain.payload);

  step("15. 群文件：列表、上传人回显与删除权限");
  const x15List = await call("files.list", { token: ana, method: "GET", body: { stream_id: streamId } });
  const x15AnnounceFile = (x15List.payload.items ?? []).find((row) => row.name === "发布清单.md");
  check("files.list：列出群文件并回显上传人", x15AnnounceFile?.uploaded_name === "Ana", x15List.payload);
  const x15StrangerList = await call("files.list", { token: deeToken, method: "GET", body: { stream_id: streamId } });
  check("files.list：非成员看不到群文件", x15StrangerList.status === 403, x15StrangerList.payload);
  const x15BadStream = await call("files.list", { token: ana, method: "GET", body: { stream_id: "not-uuid" } });
  check("files.list：群 id 非法给 400", x15BadStream.status === 400
    && x15BadStream.payload.error === "invalid_stream_id", x15BadStream.payload);
  const x15BoFile = await call("files.upload", { token: bToken, body: { stream_id: streamId, name: "Bo的笔记.md", content: "# Bo 的笔记" } });
  const x15List2 = await call("files.list", { token: ana, method: "GET", body: { stream_id: streamId } });
  check("files.upload：成员能上传且列表回显为 Bo", Boolean(x15BoFile.payload.file?.id)
    && (x15List2.payload.items ?? []).find((row) => row.name === "Bo的笔记.md")?.uploaded_name === "Bo", x15BoFile.payload);
  const x15StrangerGet = await call("files.get", { token: deeToken, method: "GET", body: { id: file.payload.file?.id } });
  check("files.get：非成员预览被拒", x15StrangerGet.status === 403, x15StrangerGet.payload);
  const x15CrossDelete = await call("files.delete", { token: cyToken, body: { id: file.payload.file?.id } });
  check("files.delete：普通成员删不掉别人的文件", x15CrossDelete.status === 403
    && x15CrossDelete.payload.error === "permission_denied", x15CrossDelete.payload);
  const x15CyFile = await call("files.upload", { token: cyToken, body: { stream_id: streamId, name: "Cy的草稿.md", content: "自己传的" } });
  const x15CyDelete = await call("files.delete", { token: cyToken, body: { id: x15CyFile.payload.file?.id } });
  check("files.delete：上传者能删自己的文件", x15CyDelete.payload.id === x15CyFile.payload.file?.id, x15CyDelete.payload);
  const x15AfterDelete = await call("files.list", { token: ana, method: "GET", body: { stream_id: streamId } });
  check("删除后文件列表里不再有它", !(x15AfterDelete.payload.items ?? []).some((row) => row.name === "Cy的草稿.md"), x15AfterDelete.payload);
  const x15DeleteAgain = await call("files.delete", { token: cyToken, body: { id: x15CyFile.payload.file?.id } });
  check("再删一次给 404", x15DeleteAgain.status === 404
    && x15DeleteAgain.payload.error === "file_not_found", x15DeleteAgain.payload);
  const x15BadDelete = await call("files.delete", { token: cyToken, body: { id: "not-uuid" } });
  check("files.delete：非法 id 给 400", x15BadDelete.status === 400 && x15BadDelete.payload.error === "invalid_id", x15BadDelete.payload);
  const x15Cleanup = await call("files.upload", { token: ana, body: { stream_id: streamId, name: "待清理.md", content: "占位" } });
  const x15AdminDelete = await call("files.delete", { token: bToken, body: { id: x15Cleanup.payload.file?.id } });
  check("files.delete：管理员可以替成员清理", x15AdminDelete.payload.ok === true, x15AdminDelete.payload);

  step("16. 账号：重发验证、改口令与收件箱已读");
  const ed = await call("auth.register", { body: { email: "ed@example.com", password: "passw0rd-5", display_name: "Ed" } });
  const edToken = (await call("auth.login", { body: { email: "ed@example.com", password: "passw0rd-5" } })).payload.token;
  check("Ed 注册并登录（尚未验证邮箱）", Boolean(edToken) && ed.payload.user?.email_verified === false, ed.payload);
  const x16Resend = await call("auth.resend", { token: edToken, body: {} });
  check("auth.resend：未验证账号能重发验证链接", x16Resend.status === 200 && x16Resend.payload.ok === true
    && String(x16Resend.payload.verify_link).includes("token="), x16Resend.payload);
  const x16NoToken = await call("auth.resend", { body: {} });
  check("auth.resend：没登录时要求登录而不是 500", x16NoToken.status === 401, x16NoToken.payload);
  const x16Verify0 = await call("auth.verify", { body: { token: decodeURIComponent((ed.payload.verify_link ?? "").split("token=")[1] ?? "") } });
  check("原始注册链接仍可验证", x16Verify0.payload.ok === true, x16Verify0.payload);
  const x16ResendTwice = await call("auth.resend", { token: edToken, body: {} });
  check("auth.resend：已验证账号提示 already_verified", x16ResendTwice.status === 200
    && x16ResendTwice.payload.error === "already_verified", x16ResendTwice.payload);
  const x16Token1 = decodeURIComponent((x16Resend.payload.verify_link ?? "").split("token=")[1] ?? "");
  const x16Verify1 = await call("auth.verify", { body: { token: x16Token1 } });
  const x16Verify2 = await call("auth.verify", { body: { token: x16Token1 } });
  check("重发的链接可用且一次性（第二次 410 link_used）",
    x16Verify1.payload.ok === true && x16Verify2.status === 410 && x16Verify2.payload.error === "link_used",
  { 第一次: x16Verify1.payload, 第二次: x16Verify2.payload });
  const x16VerifyBad = await call("auth.verify", { body: { token: "x".repeat(40) } });
  check("陌生验证链接给 404 link_invalid", x16VerifyBad.status === 404
    && x16VerifyBad.payload.error === "link_invalid", x16VerifyBad.payload);
  const x16Inbox = await call("inbox.list", { token: edToken, method: "GET" });
  const x16MailItem = (x16Inbox.payload.items ?? []).find((row) => row.kind === "verify" && !row.read_at);
  check("inbox.list：Ed 的开发态收件箱里有验证信", Boolean(x16MailItem), x16Inbox.payload);
  const x16Read = await call("inbox.read", { token: edToken, body: { id: x16MailItem?.id } });
  const x16Inbox2 = await call("inbox.list", { token: edToken, method: "GET" });
  check("inbox.read：标记已读后回读带 read_at", x16Read.payload.ok === true
    && (x16Inbox2.payload.items ?? []).find((row) => row.id === x16MailItem?.id)?.read_at != null, x16Read.payload);
  const x16ReadOther = await call("inbox.read", { token: ana, body: { id: x16MailItem?.id } });
  check("inbox.read：不能替别人标记已读", x16ReadOther.status === 404
    && x16ReadOther.payload.error === "message_missing", x16ReadOther.payload);
  const x16ReadBad = await call("inbox.read", { token: edToken, body: { id: "not-uuid" } });
  check("inbox.read：非法 id 给 400", x16ReadBad.status === 400 && x16ReadBad.payload.error === "invalid_id", x16ReadBad.payload);
  const x16PwdWrong = await call("auth.password", { token: edToken, body: { current_password: "wrong-pass", new_password: "passw0rd-55" } });
  check("auth.password：旧口令不对被拒", x16PwdWrong.status === 401
    && x16PwdWrong.payload.error === "bad_credentials", x16PwdWrong.payload);
  const x16PwdShort = await call("auth.password", { token: edToken, body: { current_password: "passw0rd-5", new_password: "short" } });
  check("auth.password：新口令太短被拒", x16PwdShort.status === 400
    && x16PwdShort.payload.error === "invalid_new_password", x16PwdShort.payload);
  const x16Pwd = await call("auth.password", { token: edToken, body: { current_password: "passw0rd-5", new_password: "passw0rd-55" } });
  const x16OldSession = await call("auth.me", { token: edToken, method: "GET" });
  const x16OldLogin = await call("auth.login", { body: { email: "ed@example.com", password: "passw0rd-5" } });
  const x16NewLogin = await call("auth.login", { body: { email: "ed@example.com", password: "passw0rd-55" } });
  check("auth.password：改口令后旧会话与旧口令一起作废", x16Pwd.payload.ok === true
    && x16OldSession.status === 401 && x16OldLogin.status === 401 && Boolean(x16NewLogin.payload.token),
  { 改: x16Pwd.payload, 旧会话: x16OldSession.status, 旧口令: x16OldLogin.status });
  const x16MeAna = await call("auth.me", { token: ana, method: "GET" });
  check("改口令只踢自己设备的会话，不影响别人", x16MeAna.payload.ok === true, x16MeAna.payload);

  step("17. 虚拟机：归属、更新、授权撤销与 MCP 钥匙清理");
  const x17BoVm = await call("vms.create", {
    token: bToken,
    body: { label: "Bo 的测试机", host: "bo.internal.example", port: 22, username: "bo", auth_kind: "key", secret: "bo-secret-text" },
  });
  const boVmId = x17BoVm.payload.vm?.id;
  check("vms.create：Bo 能登记自己的机器", Boolean(boVmId) && x17BoVm.payload.vm?.auth_kind === "key", x17BoVm.payload);
  check("vms.create：响应不回显凭据", !JSON.stringify(x17BoVm.payload).includes("bo-secret-text"), x17BoVm.payload);
  const x17BadPort = await call("vms.create", { token: bToken, body: { label: "x", host: "a.example", port: 70000, username: "u", auth_kind: "password", secret: "s3cret-long" } });
  check("vms.create：端口越界被拒", x17BadPort.status === 400 && x17BadPort.payload.error === "invalid_port", x17BadPort.payload);
  const x17BadHost = await call("vms.create", { token: bToken, body: { label: "x", host: "not a host", port: 22, username: "u", auth_kind: "password", secret: "s3cret-long" } });
  check("vms.create：主机名非法被拒", x17BadHost.status === 400 && x17BadHost.payload.error === "invalid_host", x17BadHost.payload);
  const x17BadAuth = await call("vms.create", { token: bToken, body: { label: "x", host: "a.example", port: 22, username: "u", auth_kind: "telepathy", secret: "s3cret-long" } });
  check("vms.create：未知凭据类型被拒", x17BadAuth.status === 400 && x17BadAuth.payload.error === "invalid_auth_kind", x17BadAuth.payload);
  const x17CrossUpdate = await call("vms.update", { token: ana, body: { id: boVmId, label: "改成 Ana 的" } });
  check("vms.update：别人改不了我的机器", x17CrossUpdate.status === 403 && x17CrossUpdate.payload.error === "vm_not_owned", x17CrossUpdate.payload);
  const x17CrossDelete = await call("vms.delete", { token: ana, body: { id: boVmId } });
  check("vms.delete：别人删不了我的机器", x17CrossDelete.status === 403 && x17CrossDelete.payload.error === "vm_not_owned", x17CrossDelete.payload);
  const x17Update = await call("vms.update", { token: bToken, body: { id: boVmId, label: "Bo 的构建机", port: 2222, workdir: "/home/bo/app" } });
  check("vms.update：主人能改标签、端口与工作目录", x17Update.payload.vm?.label === "Bo 的构建机"
    && x17Update.payload.vm?.port === 2222 && x17Update.payload.vm?.workdir === "/home/bo/app", x17Update.payload);
  const x17UpdateBadPort = await call("vms.update", { token: bToken, body: { id: boVmId, port: 70000 } });
  check("vms.update：端口越界被拒", x17UpdateBadPort.status === 400 && x17UpdateBadPort.payload.error === "invalid_port", x17UpdateBadPort.payload);
  const x17UpdateMissing = await call("vms.update", { token: bToken, body: { id: crypto.randomUUID(), label: "不存在" } });
  check("vms.update：不存在的机器给 404", x17UpdateMissing.status === 404 && x17UpdateMissing.payload.error === "vm_not_found", x17UpdateMissing.payload);
  const x17UpdateRotate = await call("vms.update", { token: bToken, body: { id: boVmId, secret: "bo-secret-v2" } });
  check("vms.update：换凭据后仍不回显明文", x17UpdateRotate.payload.ok === true
    && !JSON.stringify(x17UpdateRotate.payload).includes("bo-secret-v2"), x17UpdateRotate.payload);
  const x17BoList = await call("vms.list", { token: bToken });
  check("vms.list：只列自己的机器且不返回密文",
    (x17BoList.payload.items ?? []).length === 1 && (x17BoList.payload.items ?? [])[0]?.id === boVmId
    && !JSON.stringify(x17BoList.payload).includes("bo-secret") && !JSON.stringify(x17BoList.payload).includes("s3cret")
    && !("secret_cipher" in ((x17BoList.payload.items ?? [])[0] ?? {})), x17BoList.payload);
  const x17AnaList = await call("vms.list", { token: ana });
  check("vms.list：Ana 的授权清单里能看到已授权的机器",
    (x17AnaList.payload.items ?? []).some((row) => row.id === vm.payload.vm?.id
      && (row.granted_to ?? []).some((g) => g.stream_id === streamId)), x17AnaList.payload);
  const x17GrantByBo = await call("streams.vms.grant", { token: bToken, body: { stream_id: streamId, vm_id: boVmId, level: "sudo" } });
  check("streams.vms.grant：管理员把自有机器授权进群", Boolean(x17GrantByBo.payload.grant_id), x17GrantByBo.payload);
  const x17MineBo = await call("streams.mine.vms", { token: bToken, method: "GET", body: { stream_id: streamId } });
  check("streams.mine.vms：成员能看到本群授权并带上级别与机器资料",
    (x17MineBo.payload.items ?? []).some((row) => row.vm_id === boVmId && row.level === "sudo" && row.vm?.label === "Bo 的构建机"), x17MineBo.payload);
  const x17MineStranger = await call("streams.mine.vms", { token: deeToken, method: "GET", body: { stream_id: streamId } });
  check("streams.mine.vms：非成员看不到本群机器", x17MineStranger.status === 403, x17MineStranger.payload);
  const x17GrantForeignVm = await call("streams.vms.grant", { token: ana, body: { stream_id: streamId, vm_id: boVmId } });
  check("streams.vms.grant：不能把别人的机器授权进群", x17GrantForeignVm.status === 403
    && x17GrantForeignVm.payload.error === "vm_not_owned", x17GrantForeignVm.payload);
  const x17GrantDenied = await call("streams.vms.grant", { token: cyToken, body: { stream_id: streamId, vm_id: vm.payload.vm?.id } });
  check("streams.vms.grant：普通成员没有授权权限", x17GrantDenied.status === 403
    && x17GrantDenied.payload.error === "permission_denied", x17GrantDenied.payload);
  const x17Revoke = await call("streams.vms.revoke", { token: bToken, body: { stream_id: streamId, grant_id: x17GrantByBo.payload.grant_id } });
  check("streams.vms.revoke：管理员能撤销本群授权", x17Revoke.payload.removed === x17GrantByBo.payload.grant_id, x17Revoke.payload);
  const x17RevokeAgain = await call("streams.vms.revoke", { token: bToken, body: { stream_id: streamId, grant_id: x17GrantByBo.payload.grant_id } });
  check("重复撤销给 404 grant_not_found", x17RevokeAgain.status === 404
    && x17RevokeAgain.payload.error === "grant_not_found", x17RevokeAgain.payload);
  const x17MineAna = await call("streams.mine.vms", { token: ana, method: "GET", body: { stream_id: streamId } });
  const buildGrant = (x17MineAna.payload.items ?? []).find((row) => row.vm_id === vm.payload.vm?.id);
  check("streams.mine.vms：Ana 的构建机仍在本群授权里", Boolean(buildGrant), x17MineAna.payload);
  const x17DeleteVm = await call("vms.delete", { token: ana, body: { id: vm.payload.vm?.id } });
  check("vms.delete：主人能删自己的机器", x17DeleteVm.payload.id === vm.payload.vm?.id, x17DeleteVm.payload);
  const x17MineAfter = await call("streams.mine.vms", { token: ana, method: "GET", body: { stream_id: streamId } });
  check("删机后本群授权清单里没有幽灵行",
    !(x17MineAfter.payload.items ?? []).some((row) => row.vm === null || row.vm_id === vm.payload.vm?.id), x17MineAfter.payload);
  const x17DetailAfter = await call("streams.get", { token: ana, method: "GET", body: { id: streamId } });
  check("群详情的虚拟机列表也不再挂 revoked/已删除记录",
    (x17DetailAfter.payload.vms ?? []).every((row) => row.level !== "revoked" && row.label !== "已删除的虚拟机"),
  x17DetailAfter.payload.vms);
  const x17DeleteAgain = await call("vms.delete", { token: ana, body: { id: vm.payload.vm?.id } });
  check("重复删机器给 404", x17DeleteAgain.status === 404 && x17DeleteAgain.payload.error === "vm_not_found", x17DeleteAgain.payload);
  const x17RotateDenied = await call("streams.mcpkey.rotate", { token: bToken, body: { stream_id: streamId } });
  check("streams.mcpkey.rotate：只有群主能换钥匙", x17RotateDenied.status === 403
    && x17RotateDenied.payload.error === "owner_only", x17RotateDenied.payload);
  const x17Rotate = await call("streams.mcpkey.rotate", { token: ana, body: { stream_id: streamId } });
  const x17NewKey = x17Rotate.payload.key;
  check("换钥匙后旧钥匙立刻失效", x17NewKey !== mcpKey
    && (await rawMcp(mcpKey, { jsonrpc: "2.0", id: 3, method: "tools/list" })).status === 403
    && (await rawMcp(x17NewKey, { jsonrpc: "2.0", id: 4, method: "tools/list" })).status === 200, x17Rotate.payload);
  const x17ClearDenied = await call("streams.mcpkey.clear", { token: bToken, body: { stream_id: streamId } });
  check("streams.mcpkey.clear：管理员不能清钥匙", x17ClearDenied.status === 403
    && x17ClearDenied.payload.error === "owner_only", x17ClearDenied.payload);
  const x17Clear = await call("streams.mcpkey.clear", { token: ana, body: { stream_id: streamId } });
  check("streams.mcpkey.clear：群主清空后外部 MCP 进不来", x17Clear.payload.ok === true
    && (await rawMcp(x17NewKey, { jsonrpc: "2.0", id: 5, method: "tools/list" })).status === 403, x17Clear.payload);
  const x17ClearRead = await call("streams.get", { token: ana, method: "GET", body: { id: streamId } });
  check("清空后群详情里 mcp_key_set 回到 false", x17ClearRead.payload.stream?.mcp_key_set === false, x17ClearRead.payload.stream);
  const x17BoVmDelete = await call("vms.delete", { token: bToken, body: { id: boVmId } });
  check("vms.delete：Bo 删掉自己的机器收尾", x17BoVmDelete.payload.ok === true, x17BoVmDelete.payload);

  step("18. 技能与记忆：可见性、计数、卸载与归属");
  const builtinId = market.payload.items?.[0]?.id;
  const x18Get = await call("skills.get", { token: ana, method: "GET", body: { id: builtinId } });
  check("skills.get：内置技能能读到正文且标 always_on", x18Get.payload.skill?.always_on === true
    && String(x18Get.payload.skill?.body).includes("create_stream"), x18Get.payload);
  const x18BadId = await call("skills.get", { token: ana, method: "GET", body: { id: "not-uuid" } });
  check("skills.get：非法 id 给 400", x18BadId.status === 400 && x18BadId.payload.error === "invalid_id", x18BadId.payload);
  const x18Missing = await call("skills.get", { token: ana, method: "GET", body: { id: crypto.randomUUID() } });
  check("skills.get：不存在的技能给 404", x18Missing.status === 404
    && x18Missing.payload.error === "skill_not_found", x18Missing.payload);
  const x18Priv = await call("skills.upload", {
    token: ana,
    body: { name: "Ana 的私有手册", summary: "只给自家员工用", category: "内部", body: "# 私有\n不外传", is_public: false },
  });
  const privSkillId = x18Priv.payload.skill?.id;
  check("skills.upload：可以上传不公开的技能", x18Priv.payload.skill?.is_public === false, x18Priv.payload);
  const x18PrivGet = await call("skills.get", { token: bToken, method: "GET", body: { id: privSkillId } });
  check("skills.get：别人读不到私有技能", x18PrivGet.status === 403
    && x18PrivGet.payload.error === "skill_forbidden", x18PrivGet.payload);
  const x18MarketBo = await call("skills.market", { token: bToken, method: "GET" });
  check("skills.market：私有技能不进别人的市场",
    !(x18MarketBo.payload.items ?? []).some((row) => row.id === privSkillId), x18MarketBo.payload);
  const x18DefaultFlag = await call("skills.upload", {
    token: ana, body: { name: "私有默认", summary: "只给自家新员工", body: "私有默认正文。", is_default: true },
  });
  const x18DefaultId = x18DefaultFlag.payload.skill?.id;
  check("skills.upload：私有技能也能标成默认，供主人以后的员工自动装",
    x18DefaultFlag.payload.skill?.is_default === true && x18DefaultFlag.payload.skill?.is_public === false, x18DefaultFlag.payload);
  const x18DefaultOff = await call("skills.setDefault", { token: bToken, body: { skill_id: x18DefaultId, is_default: true } });
  check("skills.setDefault：别人改不了你的默认标记", x18DefaultOff.status === 403
    && x18DefaultOff.payload.error === "skill_forbidden", x18DefaultOff.payload);
  const x18DefaultUnset = await call("skills.setDefault", { token: ana, body: { skill_id: x18DefaultId, is_default: false } });
  check("skills.setDefault：主人能把默认取消掉", x18DefaultUnset.payload.skill?.is_default === false, x18DefaultUnset.payload);
  const x18BuiltinDownload = await call("skills.download", { token: ana, body: { id: builtinId } });
  check("skills.download：内置技能不占计数", x18BuiltinDownload.payload.skill?.downloads === 0, x18BuiltinDownload.payload);
  const x18DownloadForbidden = await call("skills.download", { token: bToken, body: { id: privSkillId } });
  check("skills.download：别人下载私有技能被拒", x18DownloadForbidden.status === 403, x18DownloadForbidden.payload);
  const x18D1 = await call("skills.download", { token: ana, body: { id: uploaded.payload.skill?.id } });
  const x18D2 = await call("skills.download", { token: ana, body: { id: uploaded.payload.skill?.id } });
  check("skills.download：上传的技能每次下载 +1", Number(x18D1.payload.skill?.downloads) === 1
    && Number(x18D2.payload.skill?.downloads) === 2, { 第一次: x18D1.payload.skill?.downloads, 第二次: x18D2.payload.skill?.downloads });
  const x18Install = await call("skills.install", { token: ana, body: { skill_id: privSkillId, agent_id: mockAgentId } });
  check("skills.install：私有技能能装到自家员工", x18Install.payload.installed === true, x18Install.payload);
  const x18InstallsBefore = (await call("skills.get", { token: ana, method: "GET", body: { id: privSkillId } })).payload.skill?.installs;
  const x18Locked = await call("skills.uninstall", { token: ana, body: { agent_id: agentId, skill_id: builtinId } });
  check("skills.uninstall：内置技能卸不掉", x18Locked.status === 400
    && x18Locked.payload.error === "builtin_skill_locked", x18Locked.payload);
  const x18Foreign = await call("skills.uninstall", { token: bToken, body: { agent_id: mockAgentId, skill_id: privSkillId } });
  check("skills.uninstall：不能卸别人员工的技能", x18Foreign.status === 403
    && x18Foreign.payload.error === "agent_not_owned", x18Foreign.payload);
  const x18Uninstall = await call("skills.uninstall", { token: ana, body: { agent_id: mockAgentId, skill_id: privSkillId } });
  const x18InstalledAfter = await call("skills.installed", { token: ana, method: "GET", body: { agent_id: mockAgentId } });
  check("skills.uninstall：卸载后已安装列表里没有它", x18Uninstall.payload.ok === true
    && !(x18InstalledAfter.payload.items ?? []).some((row) => row.name === "Ana 的私有手册"), x18InstalledAfter.payload);
  const x18InstallsAfter = (await call("skills.get", { token: ana, method: "GET", body: { id: privSkillId } })).payload.skill?.installs;
  check("卸载后安装数 -1", Number(x18InstallsAfter) === Number(x18InstallsBefore) - 1, { before: x18InstallsBefore, after: x18InstallsAfter });
  const x18UninstallAgain = await call("skills.uninstall", { token: ana, body: { agent_id: mockAgentId, skill_id: privSkillId } });
  check("重复卸载给 404 skill_not_installed", x18UninstallAgain.status === 404
    && x18UninstallAgain.payload.error === "skill_not_installed", x18UninstallAgain.payload);
  const x18MemDelete = await call("agents.memory.delete", { token: ana, body: { agent_id: agentId, id: mem.payload.id } });
  check("agents.memory.delete：主人能删自己的记忆", x18MemDelete.payload.id === mem.payload.id, x18MemDelete.payload);
  const x18MemList = await call("agents.memory.list", { token: ana, method: "GET", body: { agent_id: agentId, scope: "common" } });
  check("删除后记忆列表里不再有它", !(x18MemList.payload.items ?? []).some((row) => row.id === mem.payload.id), x18MemList.payload);
  const x18MemAgain = await call("agents.memory.delete", { token: ana, body: { agent_id: agentId, id: mem.payload.id } });
  check("重复删记忆给 404 memory_missing", x18MemAgain.status === 404
    && x18MemAgain.payload.error === "memory_missing", x18MemAgain.payload);
  const x18Mem2 = await call("agents.memory.put", { token: ana, body: { agent_id: agentId, scope: "common", content: "第二条待删记忆。" } });
  const x18MemForeign = await call("agents.memory.delete", { token: bToken, body: { agent_id: agentId, id: x18Mem2.payload.id } });
  check("别人删不掉你员工的记忆", x18MemForeign.status === 403
    && x18MemForeign.payload.error === "agent_not_owned", x18MemForeign.payload);
  const x18MemCross = await call("agents.memory.delete", { token: ana, body: { agent_id: mockAgentId, id: x18Mem2.payload.id } });
  check("按员工过滤：不能借另一个员工 id 删记忆", x18MemCross.status === 404
    && x18MemCross.payload.error === "memory_missing", x18MemCross.payload);
  await call("agents.memory.delete", { token: ana, body: { agent_id: agentId, id: x18Mem2.payload.id } });

  step("19. MCP 内部工具面：上下文、历史窗口、资源清单、拉人、公告、授权与 @ 触发");
  // 与 engine.mjs 的调用包装保持一致：参数校验抛出的 Halt 会转成 { error }，而不是打断任务。
  const toolSafe = async (toolScope, name, args) => {
    try {
      return await executeTool(db, toolScope, name, args, (key) => process.env[key]);
    } catch (error) {
      return { error: error?.error ?? "tool_failed", thrown: true };
    }
  };
  const anaId = a.payload.user.id;
  const boId = b.payload.user.id;
  const x19Scope = { agentId, streamId, ownerId: anaId };
  const x19Seqs = await db.messages.list([["stream_id", streamId]], {
    columns: "seq", limit: 500, order: ["seq", { ascending: true }],
  });

  const x19Ctx = await toolSafe(x19Scope, "get_context", {});
  check("get_context：回群名、群 UUID 与当前公告",
    x19Ctx.stream?.name === "上线前定稿" && x19Ctx.stream?.uuid === streamId
      && x19Ctx.stream?.announcement === "周五 18:00 前定稿，逾期顺延。", x19Ctx.stream);
  check("get_context：真人与虚拟员工分类型列进成员表，被移出群的员工不再出现",
    (x19Ctx.members ?? []).some((m) => m.type === "human" && m.name === "Ana")
      && (x19Ctx.members ?? []).some((m) => m.type === "agent" && m.name === "小M")
      && !(x19Ctx.members ?? []).some((m) => m.name === "小Q"), x19Ctx.members);
  check("get_context：授权虚拟机带级别与 workdir，且不泄露密文",
    (x19Ctx.vms ?? []).some((row) => row.label === "技能登记机" && row.level === "member"
      && row.host === "ci@skill.example.com:22" && row.workdir === "")
      && !JSON.stringify(x19Ctx).includes("pw-123456"), x19Ctx.vms);
  check("get_context：带上员工在本群的压缩摘要记忆",
    (x19Ctx.stream_memory ?? []).some((row) => row.kind === "summary"
      && Number(row.covers_through_seq) > 0), x19Ctx.stream_memory);
  const x19CtxGhost = await toolSafe({ agentId, streamId: crypto.randomUUID(), ownerId: anaId }, "get_context", {});
  check("get_context：群不存在给 stream_not_found", x19CtxGhost.error === "stream_not_found", x19CtxGhost);
  const x19CtxExternal = await toolSafe({ streamId, ownerId: anaId }, "get_context", {});
  check("get_context：对外 MCP（没有员工身份）能读群与成员，但不带员工记忆",
    x19CtxExternal.stream?.uuid === streamId && (x19CtxExternal.members ?? []).length > 0
      && (x19CtxExternal.stream_memory ?? []).length === 0, x19CtxExternal);

  const x19Win = await toolSafe(x19Scope, "read_window", { from_seq: x19Seqs[0].seq, to_seq: x19Seqs[2].seq });
  check("read_window：按 seq 升序返回整段原文",
    (x19Win.messages ?? []).length === 3 && x19Win.messages.every((m) => m.seq != null && m.content != null)
      && x19Win.messages.map((m) => m.seq).join(",") === "1,2,3", x19Win.messages?.map((m) => m.seq));
  const x19WinBackward = await toolSafe(x19Scope, "read_window", { from_seq: 10, to_seq: 9 });
  check("read_window：区间倒挂给 invalid_window", x19WinBackward.error === "invalid_window", x19WinBackward);
  const x19WinNaN = await toolSafe(x19Scope, "read_window", { from_seq: "abc", to_seq: 8 });
  check("read_window：非整数 seq 给 invalid_window", x19WinNaN.error === "invalid_window", x19WinNaN);
  const x19WinCap = await toolSafe(x19Scope, "read_window", { from_seq: 1, to_seq: 500 });
  check("read_window：一次最多翻到 from+60，长历史要靠翻页而不是一次灌满上下文",
    x19Seqs.length > 61 && (x19WinCap.messages ?? []).length === 61
      && x19WinCap.messages.every((m) => m.seq <= 61),
    { 群里总条数: x19Seqs.length, 取回条数: (x19WinCap.messages ?? []).length });

  const x19Res = await toolSafe(x19Scope, "list_my_resources", {});
  check("list_my_resources：列出主人名下员工（带 id 与状态）",
    (x19Res.agents ?? []).some((row) => row.id === agentId && row.status === "active")
      && (x19Res.agents ?? []).some((row) => row.id === mockAgentId), x19Res.agents);
  check("list_my_resources：列出主人名下虚拟机与所在群（不含密文）",
    (x19Res.vms ?? []).some((row) => row.label === "技能登记机" && row.username === "ci")
      && (x19Res.streams ?? []).some((row) => row.stream_id === streamId && row.role === "owner")
      && !JSON.stringify(x19Res).includes("secret_cipher"), x19Res.vms);
  check("list_my_resources：已删除的群不再出现在主人清单里",
    !(x19Res.streams ?? []).some((row) => row.stream_id === g1id), x19Res.streams);
  const x19ResExternal = await toolSafe({ streamId, ownerId: anaId }, "list_my_resources", {});
  check("list_my_resources：对外部 MCP 关闭（internal_only）",
    x19ResExternal.error === "internal_only", x19ResExternal);
  const x19ResNoOwner = await toolSafe({ agentId, streamId }, "list_my_resources", {});
  check("list_my_resources：没有主人身份给 owner_missing", x19ResNoOwner.error === "owner_missing", x19ResNoOwner);
  const x19Unknown = await toolSafe(x19Scope, "drop_table", {});
  check("未注册的工具名一律 tool_not_allowed", x19Unknown.error === "tool_not_allowed", x19Unknown);

  const x19FreshAgent = await call("agents.create", {
    token: ana,
    body: { name: "小N", role: "外接", api_base_url: "demo://local", api_key: "demo-key-n", model: "demo" },
  });
  const x19FreshId = x19FreshAgent.payload.agent?.id;
  const x19Add = await toolSafe(x19Scope, "add_agent_to_stream", { agent_id: x19FreshId });
  check("add_agent_to_stream：主人把自己另一个员工拉进群",
    x19Add.ok === true && x19Add.duplicate !== true && x19Add.stream_id === streamId, x19Add);
  const x19AddAgain = await toolSafe(x19Scope, "add_agent_to_stream", { agent_id: x19FreshId });
  check("add_agent_to_stream：重复拉人只回 duplicate，不插第二行成员",
    x19AddAgain.ok === true && x19AddAgain.duplicate === true, x19AddAgain);
  const x19AddDir = await call("streams.get", { token: ana, method: "GET", body: { id: streamId } });
  check("拉进来的员工在群成员里只出现一次",
    (x19AddDir.payload.members ?? []).filter((m) => m.type === "agent" && m.agent?.id === x19FreshId).length === 1,
    (x19AddDir.payload.members ?? []).filter((m) => m.type === "agent").map((m) => m.agent?.name));
  const x19BoAgent = await call("agents.create", {
    token: bToken,
    body: { name: "Bo的助理", role: "外接", api_base_url: "demo://local", api_key: "demo-key-bo", model: "demo" },
  });
  const x19Foreign = await toolSafe(x19Scope, "add_agent_to_stream", { agent_id: x19BoAgent.payload.agent?.id });
  check("add_agent_to_stream：不能拉别人的员工", x19Foreign.error === "agent_not_owned", x19Foreign);
  const x19GhostAgent = await toolSafe(x19Scope, "add_agent_to_stream", { agent_id: crypto.randomUUID() });
  check("add_agent_to_stream：不存在的员工给 agent_not_found", x19GhostAgent.error === "agent_not_found", x19GhostAgent);
  const x19NotMember = await toolSafe({ agentId, streamId, ownerId: dee.payload.user.id },
    "add_agent_to_stream", { agent_id: x19FreshId });
  check("add_agent_to_stream：主人不是群成员时拒绝", x19NotMember.error === "not_stream_member", x19NotMember);
  const x19BadAgentId = await toolSafe(x19Scope, "add_agent_to_stream", { agent_id: "not-uuid" });
  check("add_agent_to_stream：非法 id 抛错也被转成错误码",
    x19BadAgentId.error === "invalid_agent_id" && x19BadAgentId.thrown === true, x19BadAgentId);

  const x19AnnDenied = await toolSafe({ agentId, streamId, ownerId: c.payload.user.id },
    "set_announcement", { content: "普通成员写的公告" });
  check("set_announcement：普通成员改公告被拒", x19AnnDenied.error === "permission_denied", x19AnnDenied);
  const x19Ann = await toolSafe(x19Scope, "set_announcement", { content: "公告已由内部工具改写。" });
  check("set_announcement：群主写入公告并回显", x19Ann.ok === true
    && x19Ann.announcement === "公告已由内部工具改写。", x19Ann);
  const x19AnnRead = await toolSafe({ streamId, ownerId: anaId }, "get_announcement", {});
  check("set_announcement 之后 get_announcement 读到新值",
    x19AnnRead.announcement === "公告已由内部工具改写。", x19AnnRead);
  const x19AnnView = await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } });
  check("改公告在群里落的系统消息同时带 system 标记（正文与转录前缀一致）",
    (x19AnnView.payload.items ?? []).some((m) => m.kind === "system"
      && m.sender_type === "system"
      && String(m.content).includes("公告已由内部工具改写")),
    (x19AnnView.payload.items ?? []).slice(-3).map((m) => ({ kind: m.kind, sender_type: m.sender_type, content: m.content })));
  const x19AnnTooLong = await toolSafe(x19Scope, "set_announcement", { content: "长".repeat(4001) });
  check("set_announcement：超长公告被参数校验挡下", x19AnnTooLong.error === "invalid_content", x19AnnTooLong);
  const x19AnnClear = await toolSafe(x19Scope, "set_announcement", { content: "" });
  check("set_announcement：空串即清空公告", x19AnnClear.ok === true && x19AnnClear.announcement === "", x19AnnClear);

  const x19Vm = await call("vms.create", {
    token: ana,
    body: { label: "MCP授权机", host: "mcp.internal.example", port: 22, username: "deploy",
      auth_kind: "key", secret: "private-key-material", workdir: "/srv/mcp" },
  });
  const x19BoVm = await call("vms.create", {
    token: bToken,
    body: { label: "Bo的机器", host: "bo.internal.example", port: 22, username: "bo",
      auth_kind: "password", secret: "bo-secret" },
  });
  const x19Grant = await toolSafe(x19Scope, "grant_vm", { vm_id: x19Vm.payload.vm?.id, level: "sudo" });
  check("grant_vm：群主把自己机器授权成 sudo", x19Grant.ok === true && x19Grant.level === "sudo", x19Grant);
  const x19GrantAgain = await toolSafe(x19Scope, "grant_vm", { vm_id: x19Vm.payload.vm?.id, level: "member" });
  check("grant_vm：重复授权改级别而不是再加一行",
    x19GrantAgain.ok === true && x19GrantAgain.grant_id === x19Grant.grant_id
      && x19GrantAgain.level === "member", x19GrantAgain);
  const x19GrantRows = await db.stream_vms.list([["stream_id", streamId], ["vm_id", x19Vm.payload.vm?.id]], {
    columns: "id,level", limit: 10,
  });
  check("改级别后群里只有一条授权行", x19GrantRows.length === 1 && x19GrantRows[0].level === "member", x19GrantRows);
  const x19GrantMember = await toolSafe({ agentId, streamId, ownerId: c.payload.user.id },
    "grant_vm", { vm_id: x19Vm.payload.vm?.id });
  check("grant_vm：普通成员不能把机器授权给群", x19GrantMember.error === "permission_denied", x19GrantMember);
  const x19GrantForeign = await toolSafe(x19Scope, "grant_vm", { vm_id: x19BoVm.payload.vm?.id });
  check("grant_vm：不能授权别人的机器", x19GrantForeign.error === "vm_not_owned", x19GrantForeign);
  const x19GrantGhost = await toolSafe(x19Scope, "grant_vm", { vm_id: crypto.randomUUID() });
  check("grant_vm：机器不存在给 vm_not_found", x19GrantGhost.error === "vm_not_found", x19GrantGhost);
  const x19GrantBadLevel = await toolSafe(x19Scope, "grant_vm", { vm_id: x19Vm.payload.vm?.id, level: "root" });
  check("grant_vm：level 只收 member/sudo", x19GrantBadLevel.error === "invalid_level", x19GrantBadLevel);
  const x19CtxGranted = await toolSafe(x19Scope, "get_context", {});
  check("授权后 get_context 立刻能看到这台机器",
    (x19CtxGranted.vms ?? []).some((row) => row.label === "MCP授权机" && row.workdir === "/srv/mcp"
      && row.host === "deploy@mcp.internal.example:22")
      && !JSON.stringify(x19CtxGranted).includes("private-key-material"), x19CtxGranted.vms);

  const x19Send = await toolSafe({ agentId: mockAgentId, streamId, ownerId: anaId },
    "send_message", { content: "@Bo 看下 MCP 面，@小M 自己不该再起任务。" });
  const x19SentId = (await db.messages.first([["stream_id", streamId], ["seq", x19Send.seq]], { columns: "id" }))?.id;
  const x19Mailed = await db.mail.list([["message_id", x19SentId]], { columns: "agent_id,status", limit: 20 });
  check("内部 send_message：@ 到的人与员工都记进 mentions",
    Number(x19Send.seq) > 0 && (x19Send.mentions ?? []).length === 2, x19Send);
  check("内部 send_message：发起者自己 @ 自己不另起任务", x19Mailed.length === 0, x19Mailed);
  const x19Outbox = await db.outbox.list([["stream_id", streamId], ["user_id", boId]], {
    columns: "id,kind,subject", limit: 20,
  });
  check("内部 send_message：被 @ 的真人拿到通知",
    x19Outbox.some((row) => row.kind === "mention" && String(row.subject).includes("MCP 面")), x19Outbox);
  const x19SendEmpty = await toolSafe(x19Scope, "send_message", { content: "" });
  check("内部 send_message：空正文被参数校验挡下", x19SendEmpty.error === "invalid_content", x19SendEmpty);

  const x19VmCleanup = await call("vms.delete", { token: ana, body: { id: x19Vm.payload.vm?.id } });
  const x19CtxAfterDelete = await toolSafe(x19Scope, "get_context", {});
  check("删掉机器后 get_context 里不再有它（也不留 revoked 幽灵行）",
    x19VmCleanup.payload.ok === true
      && (x19CtxAfterDelete.vms ?? []).every((row) => row.label !== "MCP授权机"), x19CtxAfterDelete.vms);
  await call("vms.delete", { token: bToken, body: { id: x19BoVm.payload.vm?.id } });

  step("\n§20 轨迹：步骤落库、原文截断与读取权限");
  const mock20 = await startMockUpstream();
  await call("agents.update", {
    token: ana, body: { id: mockAgentId, api_base_url: `http://127.0.0.1:${mock20.port}/v1` },
  });
  const zed = await call("auth.register", { body: { email: "zed@example.com", password: "passw0rd-12", display_name: "Zed" } });
  const zedToken = (await call("auth.login", { body: { email: "zed@example.com", password: "passw0rd-12" } })).payload.token;
  const newestMail = async () => (await db.mail.list([["agent_id", mockAgentId]], {
    columns: "id,status,message_id", order: ["created_at", { ascending: false }], limit: 1,
  }))[0]?.id;
  const sendFor = async (content) => {
    await call("messages.send", {
      token: ana, body: { stream_id: streamId, content, mentions: [{ type: "agent", id: mockAgentId }] },
    });
    await call("scheduler.tick", { token: ana, method: "GET" });
    return newestMail();
  };

  const x20Mail = await sendFor("@小M 查历史里的发布清单（轨迹样本）");
  const x20Traj = await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: x20Mail } });
  const x20Steps = x20Traj.payload.steps ?? [];
  check("一次带工具的运行落成 模型→工具→模型 三步", x20Traj.payload.ok === true
    && x20Steps.map((row) => row.kind).join(",") === "model,tool,model", x20Steps.map((row) => row.kind));
  check("步骤序号在同一封运行里密排", x20Steps.map((row) => row.seq).join(",") === "1,2,3", x20Steps.map((row) => row.seq));
  check("每一步都带起止与耗时且已合上", x20Steps.every((row) => row.status === "done"
    && Number(row.duration_ms) >= 0 && row.started_at && row.finished_at), x20Steps);
  check("思考链增量真的被抓进 model 步", String(x20Steps[0]?.detail?.reasoning ?? "").includes("search_history"), x20Steps[0]?.detail);
  check("模型步记下本轮上下文的口径", Number(JSON.parse(String(x20Steps[0]?.detail?.context ?? "{}")).blocks) === 2
    && Number(JSON.parse(String(x20Steps[0]?.detail?.context ?? "{}")).chars) > 0, x20Steps[0]?.detail?.context);
  // 提示词槽位清单单独一列：命中率掉了要能对着这一步列出是哪几块、各多少字。
  const x20Slots = JSON.parse(String(x20Steps[0]?.detail?.prompt_slots ?? "[]"));
  check("模型步记下这一步真正落下的提示词槽位（含易变的转录与触发消息）",
    Array.isArray(x20Slots) && x20Slots.some(([id, chars]) => id === "transcript" && Number(chars) > 0)
    && x20Slots.some(([id]) => id === "trigger")
    && x20Slots.every(([id, chars, volatile]) => typeof id === "string" && Number.isInteger(chars) && typeof volatile === "boolean"),
    x20Steps[0]?.detail?.prompt_slots);
  check("请求带了 stream_options，用量四列才落得下来", Number(x20Steps[0]?.input_tokens) === 812
    && Number(x20Steps[0]?.output_tokens) === 24 && Number(x20Steps[0]?.cached_tokens) === 640
    && Number(x20Steps[0]?.reasoning_tokens) === 9, x20Steps[0]);
  check("首字延迟被单独记成一个数", x20Steps[0]?.first_token_ms !== null
    && Number.isFinite(Number(x20Steps[0]?.first_token_ms)), x20Steps[0]?.first_token_ms);
  check("工具步把参数与结果原文都留在轨迹里", x20Steps[1]?.name === "search_history"
    && String(x20Steps[1]?.detail?.args ?? "").includes("发布清单")
    && String(x20Steps[1]?.detail?.result ?? "").includes("hits"), x20Steps[1]);
  check("工具步与模型调用按 call_id 成对", String(x20Steps[1]?.call_id ?? "").startsWith("call_mock_"), x20Steps[1]?.call_id);
  check("轨迹响应带出工具的入参 Schema，检视器才有 Schema 页",
    (x20Traj.payload.schemas ?? []).some((row) => row.name === "search_history" && row.parameters?.properties?.query),
    x20Traj.payload.schemas);
  const x20Presence = await call("agents.presence", { token: ana, method: "GET", body: { agent_id: mockAgentId } });
  const x20LaneMail = (x20Presence.payload.queue ?? []).find((row) => row.id === x20Mail);
  check("现场状态把步骤一起带回，时间线不必逐封再问", x20LaneMail?.steps?.length === 3, x20Mail);
  check("时间线用的轻列不含正文，点开某一步才取 detail",
    (x20LaneMail?.steps ?? []).every((row) => row.detail === undefined)
    && x20Steps.every((row) => row.detail !== undefined), x20LaneMail?.steps?.[0]);

  const x20GhostMail = await sendFor("@小M 轨迹越界工具试一下");
  const x20GhostSteps = (await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: x20GhostMail } })).payload.steps ?? [];
  const x20Rejected = x20GhostSteps.find((row) => row.name === "drop_table");
  check("模型编出来的工具名也留一条失败步骤，而不是悄悄消失",
    x20Rejected?.status === "failed" && x20Rejected?.error === "tool_not_allowed"
    && String(x20Rejected?.detail?.args ?? "").includes("\"x\""), x20Rejected);
  check("越界工具不拖垮这轮：最终仍回一条", (await db.mail.byId(x20GhostMail, { columns: "status" }))?.status === "done", x20GhostMail);

  const x20NoTrace = await call("agents.trajectory", { token: zedToken, method: "GET", body: { mail_id: x20Mail } });
  check("非主人且非群成员读不到轨迹", x20NoTrace.status === 403 && x20NoTrace.payload.error === "trajectory_forbidden", x20NoTrace.payload);
  const x20Member = await call("agents.trajectory", { token: bToken, method: "GET", body: { mail_id: x20Mail } });
  check("同群成员能看这封运行的轨迹", x20Member.payload.ok === true
    && x20Member.payload.mail?.agent?.name === "小M", x20Member.payload);
  const x20GhostId = await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: crypto.randomUUID() } });
  check("没有这封运行给 mail_not_found", x20GhostId.payload.error === "mail_not_found", x20GhostId.payload);
  const x20BadId = await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: "not-a-uuid" } });
  check("mail_id 非法直接挡下", x20BadId.payload.error === "invalid_mail_id", x20BadId.payload);

  // 单步上限：直接在管道上验，不靠模型凑出超长正文。
  const x20ProbeMail = crypto.randomUUID();
  const x20Probe = createStepWriter(db, { mailId: x20ProbeMail, agentId: mockAgentId, streamId });
  const x20TraceScope = { agentId: mockAgentId, streamId, ownerId: anaId, trace: x20Probe };
  await toolSafe(x20TraceScope, "upload_file", { name: "轨迹大文件.txt", content: "字".repeat(13000) });
  const x20Uploaded = await toolSafe(x20TraceScope, "read_file", { name: "轨迹大文件.txt" });
  const x20ProbeSteps = await db.run_steps.list([["mail_id", x20ProbeMail]], {
    columns: "seq,kind,name,status,detail,chars", order: ["seq", { ascending: true }],
  });
  const x20Args = x20ProbeSteps[0]?.detail ?? {};
  check("超上限的参数截到上限并记下原文长度",
    String(x20Args.args ?? "").length === 2000 && Number(x20Args.args_clipped) > 13000, { clipped: x20Args.args_clipped });
  const x20Result = x20ProbeSteps[1]?.detail ?? {};
  check("超上限的结果同样截断并留 digest", String(x20Result.result ?? "").length === 8000
    && Number(x20Result.result_clipped) > 8000 && Number(x20ProbeSteps[1]?.chars) > 12000, {
    len: String(x20Result.result ?? "").length, clipped: x20Result.result_clipped,
  });
  check("截断只发生在轨迹里，工具本身照常把结果还给模型", x20Uploaded.name === "轨迹大文件.txt"
    && String(x20Uploaded.content ?? "").length > 8000, { name: x20Uploaded.name, contentLength: String(x20Uploaded.content ?? "").length });
  const x20ProbeBefore = await db.run_steps.total([["mail_id", x20ProbeMail]]);
  await toolSafe({ agentId: mockAgentId, streamId, ownerId: anaId }, "get_announcement", {});
  check("外部 MCP（作用域里没有 trace）不落步骤",
    (await db.run_steps.total([["mail_id", x20ProbeMail]])) === x20ProbeBefore, x20ProbeBefore);
  const x20Orphan = await x20Probe.openModel({ model: "mock" });
  const x20Reaped = await closeOrphanSteps(db, x20ProbeMail, { error: "slice_interrupted" });
  const x20OrphanRow = await db.run_steps.byId(x20Orphan.id, { columns: "status,error,finished_at" });
  check("没合上的步骤会被结掉，时间线不留假高光", x20Reaped === 1 && x20OrphanRow?.status === "cancelled"
    && x20OrphanRow?.error === "slice_interrupted" && Boolean(x20OrphanRow?.finished_at), x20OrphanRow);
  await mock20.close();

  step("\n§21 插件：外部 MCP 连接器的接入、隔离与调用");
  const mock21 = await startMockConnector();
  const pluginBase = `http://127.0.0.1:${mock21.port}`;
  const x21Scope = { agentId: mockAgentId, streamId, ownerId: anaId };
  const x21Add = await call("plugins.add", {
    token: ana, body: { name: "天气插件", endpoint: `${pluginBase}/mcp`, token: "sk-weather-1234" },
  });
  const x21Id = x21Add.payload.plugin?.id;
  check("接入连接器：探通并把工具缓存进库里", x21Add.payload.ok === true
    && x21Add.payload.plugin?.status === "ready" && x21Add.payload.plugin?.tool_count === 4, x21Add.payload);
  check("不合规矩的工具如实记成 skipped，不做静默改名",
    (x21Add.payload.probe?.skipped ?? []).map((row) => row.reason).join(",") === "invalid_name,no_schema,duplicate_name",
    x21Add.payload.probe?.skipped);
  check("令牌只回尾号，密文列从不出现在响应里",
    x21Add.payload.plugin?.auth_tail === "••••1234" && !JSON.stringify(x21Add.payload).includes("auth_cipher"), x21Add.payload.plugin);
  check("探测真的带上 Bearer 头",
    mock21.headers.length >= 2 && mock21.headers.every((row) => row === "Bearer sk-weather-1234"), mock21.headers);
  check("清单里带出状态与工具数",
    (await call("plugins.list", { token: ana, method: "GET" })).payload.items
      ?.some((row) => row.id === x21Id && row.status === "ready" && row.tool_count === 4), x21Id);
  check("未登录读不到插件清单", (await call("plugins.list", { method: "GET" })).status === 401);

  const x21BoList = await call("plugins.list", { token: bToken, method: "GET" });
  check("别人的连接器不出现在我的清单", (x21BoList.payload.items ?? []).every((row) => row.id !== x21Id), x21BoList.payload.items);
  check("别人探测我的连接器给 plugin_not_owned",
    (await call("plugins.probe", { token: bToken, body: { id: x21Id } })).payload.error === "plugin_not_owned");
  check("别人改不了我的连接器",
    (await call("plugins.update", { token: bToken, body: { id: x21Id, enabled: false } })).payload.error === "plugin_not_owned");
  check("别人删不掉我的连接器",
    (await call("plugins.remove", { token: bToken, body: { id: x21Id } })).payload.error === "plugin_not_owned");
  check("查不到的连接器给 plugin_not_found",
    (await call("plugins.probe", { token: ana, body: { id: crypto.randomUUID() } })).payload.error === "plugin_not_found");

  const x21Insecure = await call("plugins.add", { token: ana, body: { name: "内网", endpoint: "http://127.0.0.1:9/mcp" }, entry: prodHandler });
  check("生产形态拒掉 http 明文地址", x21Insecure.payload.error === "insecure_api_base_url", x21Insecure.payload);
  const x21Meta = await call("plugins.add", { token: ana, body: { name: "元数据", endpoint: "https://169.254.169.254/mcp" }, entry: prodHandler });
  check("生产形态连 https 的链路本地地址也挡", x21Meta.payload.error === "private_api_base_url", x21Meta.payload);
  const x21Demo = await call("plugins.add", { token: ana, body: { name: "演示", endpoint: "demo://local" } });
  check("内置演示端点不是插件地址", x21Demo.payload.error === "invalid_api_base_url", x21Demo.payload);
  const x21Creds = await call("plugins.add", { token: ana, body: { name: "带凭据", endpoint: "https://u:p@example.com/mcp" }, entry: prodHandler });
  check("URL 里塞用户名密码直接拒", x21Creds.payload.error === "invalid_api_base_url", x21Creds.payload);
  const x21LongName = await call("plugins.add", { token: ana, body: { name: "名".repeat(41), endpoint: `${pluginBase}/mcp` } });
  check("插件名超 40 字挡下", x21LongName.payload.error === "invalid_plugin_name", x21LongName.payload);
  check("被挡下的地址一行都没落库", (await call("plugins.list", { token: ana, method: "GET" })).payload.items?.length === 1);

  const x21Dead = await call("plugins.add", { token: ana, body: { name: "死服务", endpoint: "http://127.0.0.1:1/mcp" } });
  check("连不上也留下行并标 error，用户能就地重测", x21Dead.payload.ok === true
    && x21Dead.payload.plugin?.status === "error" && x21Dead.payload.probe_error === "plugin_unreachable"
    && x21Dead.payload.plugin?.last_error === "plugin_unreachable", x21Dead.payload);
  const x21Bad = await call("plugins.add", { token: ana, body: { name: "乱回", endpoint: `${pluginBase}/bad` } });
  check("非 JSON 回包判 plugin_bad_response", x21Bad.payload.probe_error === "plugin_bad_response", x21Bad.payload);
  const x21Huge = await call("plugins.add", { token: ana, body: { name: "超大", endpoint: `${pluginBase}/huge` } });
  check("回包超过 512KB 直接判失败，不把库里塞满", x21Huge.payload.probe_error === "plugin_too_large", x21Huge.payload);
  const x21Deny = await call("plugins.add", { token: ana, body: { name: "要鉴权", endpoint: `${pluginBase}/deny` } });
  check("401 判 plugin_unauthorized", x21Deny.payload.probe_error === "plugin_unauthorized", x21Deny.payload);
  for (const id of [x21Dead, x21Bad, x21Huge, x21Deny].map((row) => row.payload.plugin?.id)) {
    await call("plugins.remove", { token: ana, body: { id } });
  }
  check("删除后清单回到一条", (await call("plugins.list", { token: ana, method: "GET" })).payload.items?.length === 1);

  const zedId = zed.payload.user?.id;
  const stamp = new Date().toISOString();
  for (let i = 0; i < 12; i += 1) {
    await db.plugins.insert({
      id: crypto.randomUUID(), owner_id: zedId, name: `占位${i}`, endpoint: `${pluginBase}/mcp`,
      auth_cipher: null, auth_tail: "", tools: [], tools_at: null, status: "untested",
      last_error: null, enabled: true, created_at: stamp, updated_at: stamp,
    });
  }
  const x21HeadersBefore = mock21.headers.length;
  const x21Full = await call("plugins.add", { token: zedToken, body: { name: "第 13 条", endpoint: `${pluginBase}/mcp` } });
  check("每人最多接 12 条连接器", x21Full.payload.error === "too_many_plugins", x21Full.payload);
  check("超量这条在出网之前就被挡下", mock21.headers.length === x21HeadersBefore, {
    before: x21HeadersBefore, after: mock21.headers.length,
  });
  await db.plugins.removeAll([["owner_id", zedId]]);
  const x21Zed = await call("plugins.add", { token: zedToken, body: { name: "Zed 自己的", endpoint: `${pluginBase}/mcp`, token: "zed-7777" } });
  check("腾出额度后能再接，且各人的连接器互不进对方的清单", x21Zed.payload.plugin?.status === "ready"
    && (await connectorToolDefs(db, anaId, INTERNAL_TOOL_NAMES)).every((row) => row.function.name !== "zed_only"), x21Zed.payload);

  const x21Defs = await connectorToolDefs(db, anaId, INTERNAL_TOOL_NAMES);
  check("主人启用中连接器的工具并进员工清单",
    x21Defs.some((row) => row.function.name === "get_weather") && x21Defs.some((row) => row.function.name === "long_text"),
    x21Defs.map((row) => row.function.name));
  check("与内置重名的外部工具让位，不出现两份",
    !x21Defs.some((row) => row.function.name === "search_history"), x21Defs.map((row) => row.function.name));

  await call("plugins.update", { token: ana, body: { id: x21Id, enabled: false } });
  check("停用后外部声明立刻从清单消失", (await connectorToolDefs(db, anaId, INTERNAL_TOOL_NAMES)).length === 0);
  check("停用中的连接器工具调用被拒", (await toolSafe(x21Scope, "get_weather", { city: "杭州" })).error === "tool_not_allowed");
  const x21Re = await call("plugins.update", { token: ana, body: { id: x21Id, enabled: true } });
  check("重新启用后名字与开关都如实回显", x21Re.payload.plugin?.name === "天气插件" && x21Re.payload.plugin?.enabled === true, x21Re.payload);
  const x21Call = await toolSafe(x21Scope, "get_weather", { city: "杭州" });
  check("员工调用外部工具拿到拼接后的文本", x21Call.ok === true
    && String(x21Call.text).includes("杭州：晴 26 度") && String(x21Call.text).includes("风力 2 级"), x21Call);
  check("调用带上解密出来的同一个令牌", mock21.headers.at(-1) === "Bearer sk-weather-1234", mock21.headers.at(-1));
  check("工具名与参数原样发给外部服务", mock21.calls.at(-1)?.name === "get_weather"
    && mock21.calls.at(-1)?.arguments?.city === "杭州", mock21.calls.at(-1));
  const x21Capped = await toolSafe(x21Scope, "long_text", {});
  check("外部结果超过 6000 字截到 6000，不撑爆上下文", x21Capped.ok === true && x21Capped.text?.length === 6000, { len: x21Capped.text?.length });
  const x21Boom = await toolSafe(x21Scope, "boom", {});
  check("外部工具自己报错如实传成错误，不装成成功", x21Boom.error === "plugin_tool_failed" && String(x21Boom.text).includes("炸了"), x21Boom);
  check("对外 MCP 那条路（作用域里没有 agentId）碰不到插件工具",
    (await toolSafe({ streamId, ownerId: anaId }, "get_weather", { city: "杭州" })).error === "tool_not_allowed");

  const x21Moved = await call("plugins.update", { token: ana, body: { id: x21Id, name: "改名插件", endpoint: `${pluginBase}/other` } });
  check("换端点先清掉旧工具缓存，再如实重测", x21Moved.payload.plugin?.name === "改名插件"
    && x21Moved.payload.plugin?.tools?.length === 0 && x21Moved.payload.plugin?.status === "error"
    && x21Moved.payload.probe_error === "plugin_rejected", x21Moved.payload);
  const x21Token = await call("plugins.update", { token: ana, body: { id: x21Id, token: "sk-weather-9999" } });
  check("换令牌只回新尾号，密文不外泄", x21Token.payload.plugin?.auth_tail === "••••9999"
    && !JSON.stringify(x21Token.payload).includes("auth_cipher"), x21Token.payload.plugin);
  const x21Back = await call("plugins.update", { token: ana, body: { id: x21Id, endpoint: `${pluginBase}/mcp` } });
  check("换回可用端点会重新探通并回填工具", x21Back.payload.plugin?.status === "ready"
    && x21Back.payload.plugin?.tool_count === 4, x21Back.payload.plugin);

  const mock21b = await startMockUpstream();
  await call("agents.update", { token: ana, body: { id: mockAgentId, api_base_url: `http://127.0.0.1:${mock21b.port}/v1` } });
  const x21Mail = await sendFor("@小M 用插件查一下杭州天气（插件天气）");
  const x21ReqTools = mock21b.seen[0]?.tools ?? [];
  check("发给模型的清单里并进了外部工具", x21ReqTools.some((row) => row.function?.name === "get_weather"), x21ReqTools.map((row) => row.function?.name));
  check("内置与外部同名的工具只发一份", x21ReqTools.filter((row) => row.function?.name === "search_history").length === 1);
  const x21Traj = await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: x21Mail } });
  const x21Steps = x21Traj.payload.steps ?? [];
  check("插件调用走同一条管道：模型→工具→模型", x21Steps.map((row) => row.kind).join(",") === "model,tool,model", x21Steps.map((row) => row.kind));
  check("外部工具的参数与结果都落进轨迹", x21Steps[1]?.name === "get_weather"
    && String(x21Steps[1]?.detail?.args ?? "").includes("杭州") && String(x21Steps[1]?.detail?.result ?? "").includes("晴 26 度"), x21Steps[1]);
  check("检视器的 Schema 页也拿得到外部工具的入参声明",
    (x21Traj.payload.schemas ?? []).some((row) => row.name === "get_weather" && row.parameters?.properties?.city), x21Traj.payload.schemas);
  check("外部服务慢或报错都不拖垮这轮：最终仍回一条",
    (await db.mail.byId(x21Mail, { columns: "status" }))?.status === "done", x21Mail);
  await mock21b.close();
  await call("plugins.remove", { token: zedToken, body: { id: x21Zed.payload.plugin?.id } });
  await call("plugins.remove", { token: ana, body: { id: x21Id } });
  check("清空后插件清单是空的", (await call("plugins.list", { token: ana, method: "GET" })).payload.items?.length === 0);
  await mock21.close();

  step("\n§22 远端技能市场：技能源、快照安装、版本自查与更新");
  const mock22 = await startMockRegistry();
  const regBase = `http://127.0.0.1:${mock22.port}`;
  const x22Insecure = await call("registries.add", { token: ana, body: { name: "明文源", index_url: `${regBase}/index.json` }, entry: prodHandler });
  check("生产形态拒掉 http 明文的技能源", x22Insecure.payload.error === "insecure_api_base_url", x22Insecure.payload);
  const x22Meta = await call("registries.add", { token: ana, body: { name: "元数据源", index_url: "https://169.254.169.254/index.json" }, entry: prodHandler });
  check("生产形态连 https 的链路本地地址也挡", x22Meta.payload.error === "private_api_base_url", x22Meta.payload);
  const x22Creds = await call("registries.add", { token: ana, body: { name: "带凭据", index_url: "https://u:p@example.com/index.json" }, entry: prodHandler });
  check("源地址里塞用户名密码直接拒", x22Creds.payload.error === "invalid_api_base_url", x22Creds.payload);
  const x22Query = await call("registries.add", { token: ana, body: { name: "带查询", index_url: `${regBase}/index.json?raw=1` } });
  check("源地址不收查询串：少一个绕过校验的花样", x22Query.payload.error === "invalid_api_base_url", x22Query.payload);
  check("被挡下的源一行都没落库", (await call("registries.list", { token: ana, method: "GET" })).payload.items?.length === 0, x22Query.payload);

  const x22Add = await call("registries.add", { token: ana, body: { name: "社区技能源", index_url: `${regBase}/index.json` } });
  const regId = x22Add.payload.registry?.id;
  check("加源：拉通 index 并记下条数与时间", x22Add.payload.ok === true
    && x22Add.payload.registry?.skill_count === 5 && x22Add.payload.registry?.last_error === null
    && Boolean(x22Add.payload.registry?.skills_at), x22Add.payload);
  check("坏条目如实记成 skipped，不悄悄丢掉", (x22Add.payload.probe?.skipped ?? []).map((row) => row.reason).join(",")
    === "invalid_slug,invalid_name,invalid_body_url,invalid_body_url,duplicate_slug", x22Add.payload.probe?.skipped);
  check("正文跨源的路子被挡在条目级：别人的地址进不了我们的抓取",
    (x22Add.payload.probe?.skipped ?? []).some((row) => row.slug === "elsewhere" && row.reason === "invalid_body_url"));
  check("未登录读不到源清单", (await call("registries.list", { method: "GET" })).status === 401);
  const x22Dupe = await call("registries.add", { token: ana, body: { name: "同一个源", index_url: `${regBase}/index.json` } });
  check("同一地址不重复加", x22Dupe.payload.error === "registry_exists", x22Dupe.payload);
  check("查重挡下时没有多发一次请求", mock22.requests.length === 1, mock22.requests);

  const x22List = await call("skills.remoteList", { token: ana, method: "GET" });
  check("远端清单带出版本、大小与正文链接", x22List.payload.items?.length === 5
    && x22List.payload.items.every((row) => row.version === "1.2.0"
      && String(row.body_url).startsWith(regBase) && row.size === 30
      && row.registry_name === "社区技能源"), x22List.payload.items?.[0]);
  check("清单里的正文链接已归一化成绝对地址，且还在这个源上", x22List.payload.items?.every(
    (row) => row.body_url.startsWith(`${regBase}/`)), x22List.payload.items?.map((row) => row.body_url));
  check("远端条目在装之前不冒充已装", x22List.payload.items?.every((row) => row.installed_skill_id === null), x22List.payload.items);
  check("远端按关键词过滤", (await call("skills.remoteList", { token: ana, method: "GET", body: { q: "release" } })).payload.items?.length === 1, x22List.payload.items);

  const x22InstalledBefore = (await call("skills.installed", { token: ana, method: "GET", body: { agent_id: mockAgentId } })).payload.items?.length;
  const x22Install = await call("skills.remoteInstall", { token: ana, body: { registry_id: regId, slug: "release-check", agent_id: mockAgentId } });
  const snapId = x22Install.payload.skill?.id;
  check("从远端装：正文抄一份到本地并记下版本", x22Install.payload.ok === true
    && x22Install.payload.skill?.source === "remote" && x22Install.payload.skill?.version === "1.2.0"
    && x22Install.payload.skill?.source_registry_id === regId, x22Install.payload.skill);
  check("装完这条员工就有了", (await call("skills.installed", { token: ana, method: "GET", body: { agent_id: mockAgentId } })).payload.items?.length === x22InstalledBefore + 1);
  check("快照正文就是源上那一刻的正文", (await call("skills.get", { token: ana, method: "GET", body: { id: snapId } })).payload.skill?.body === mock22.state.body);
  check("快照进本地市场，带着版本与来源", (await call("skills.market", { token: ana, method: "GET" })).payload.items
    ?.some((row) => row.id === snapId && row.version === "1.2.0" && row.source_registry_id === regId));
  check("快照正文注入员工上下文", (await skillPrompt(store(supabase), mockAgentId)).includes("### release-check 技能"));
  check("快照不进别人的市场", !(await call("skills.market", { token: bToken, method: "GET" })).payload.items?.some((row) => row.id === snapId));
  const x22Again = await call("skills.remoteInstall", { token: ana, body: { registry_id: regId, slug: "release-check", agent_id: mockAgentId } });
  check("重复装同一员工不建第二条快照", x22Again.payload.skill?.id === snapId
    && x22Again.payload.install?.agents?.[0]?.duplicate === true, x22Again.payload);
  check("重复装不加安装数", Number((await call("skills.get", { token: ana, method: "GET", body: { id: snapId } })).payload.skill?.installs) === 1);

  const x22AgentCount = (await call("agents.list", { token: ana, method: "GET" })).payload.items?.length;
  const x22All = await call("skills.remoteInstall", { token: ana, body: { registry_id: regId, slug: "release-check", all_agents: true } });
  check("装到全部现有员工：新增加已有等于员工数", x22All.payload.install?.scope === "all_agents"
    && x22All.payload.install?.added + x22All.payload.install?.already === x22AgentCount, x22All.payload.install);
  check("批量安装按真实新增数累加安装数",
    Number((await call("skills.get", { token: ana, method: "GET", body: { id: snapId } })).payload.skill?.installs)
      === 1 + x22All.payload.install?.added, { added: x22All.payload.install?.added });

  const x22Future = await call("skills.remoteInstall", { token: ana, body: { registry_id: regId, slug: "release-check", all_agents: true, include_future: true } });
  check("标成默认后，以后新建的员工也会带上它", x22Future.payload.future?.is_default === true, x22Future.payload);
  const x22NewAgent = await call("agents.create", {
    token: ana, body: { name: "小远", role: "远端技能", api_base_url: "demo://local", api_key: "demo-key-9", model: "demo" },
  });
  check("主人新建员工自动装上他的默认技能", (await call("skills.installed", { token: ana, method: "GET", body: { agent_id: x22NewAgent.payload.agent?.id } })).payload.items
    ?.some((row) => row.id === snapId), x22NewAgent.payload);
  const x22BoAgent = await call("agents.create", {
    token: bToken, body: { name: "Bo 的员工", role: "对照", api_base_url: "demo://local", api_key: "demo-key-8", model: "demo" },
  });
  const x22BoAgentId = x22BoAgent.payload.agent?.id;
  check("主人的私有默认不会装到别人的新员工", (await call("skills.installed", { token: bToken, method: "GET", body: { agent_id: x22BoAgentId } })).payload.items
    ?.every((row) => row.id !== snapId), x22BoAgent.payload);

  const x22Same = await call("skills.checkUpdates", { token: ana, method: "GET", body: { agent_id: mockAgentId } });
  check("版本自查：源上没出新版本就不提示更新", x22Same.payload.items?.some((row) => row.skill_id === snapId
    && row.update_available === false), x22Same.payload);
  mock22.state.version = "1.10.0";
  mock22.state.body = "# 发布前检查 v1.10\n- 备份\n- 灰度\n- 回滚演练";
  const x22Newer = await call("skills.remoteList", { token: ana, method: "GET" });
  check("远端清单发现新版本，给出更新依据", x22Newer.payload.items?.some((row) => row.slug === "release-check"
    && row.update_available === true && row.installed_version === "1.2.0"), x22Newer.payload.items?.[0]);
  const x22Check = await call("skills.checkUpdates", { token: ana, method: "GET", body: { agent_id: mockAgentId } });
  check("员工已装列表能查出该更新了", x22Check.payload.items?.some((row) => row.skill_id === snapId
    && row.update_available === true && row.latest_version === "1.10.0"), x22Check.payload);
  const x22Update = await call("skills.remoteUpdate", { token: ana, body: { skill_id: snapId } });
  const x22UpdatedBody = (await call("skills.get", { token: ana, method: "GET", body: { id: snapId } })).payload.skill?.body;
  check("更新：正文与版本号一起换过来", x22Update.payload.skill?.version === "1.10.0"
    && x22Update.payload.from_version === "1.2.0" && x22UpdatedBody === mock22.state.body, x22Update.payload);
  check("更新响应只回元数据，正文要另外读", x22Update.payload.skill?.body === undefined);
  check("更新后不再提示", (await call("skills.checkUpdates", { token: ana, method: "GET", body: { agent_id: mockAgentId } })).payload.items
    ?.some((row) => row.skill_id === snapId && row.update_available === false));
  const x22UpdateAgain = await call("skills.remoteUpdate", { token: ana, body: { skill_id: snapId } });
  check("重复更新只刷那一条快照", x22UpdateAgain.payload.skill?.id === snapId
    && (await db.skills.total([["source_registry_id", regId]], { columns: "id" })) === 1, x22UpdateAgain.payload);

  mock22.state.hidden = ["release-check"];
  const x22Gone = await call("skills.checkUpdates", { token: ana, method: "GET", body: { agent_id: mockAgentId } });
  check("源上撤下的条目如实报 skill_not_in_registry", x22Gone.payload.unavailable?.some((row) => row.skill_id === snapId
    && row.reason === "skill_not_in_registry"), x22Gone.payload);
  check("撤下的条目装不了", (await call("skills.remoteInstall", { token: ana, body: { registry_id: regId, slug: "release-check", agent_id: mockAgentId } })).payload.error === "skill_not_in_registry");
  mock22.state.hidden = [];

  for (const [slug, want] of [
    ["too-large", "registry_body_too_large"], ["empty-body", "registry_body_empty"],
    ["binary-body", "registry_body_binary"], ["long-body", "skill_body_too_large"],
  ]) {
    const guarded = await call("skills.remoteInstall", { token: ana, body: { registry_id: regId, slug, agent_id: mockAgentId } });
    check(`${slug}：正文不合规矩整条拒收，报 ${want}`, guarded.payload.error === want, guarded.payload);
  }
  check("被拒的正文不留半条快照", (await db.skills.total([["source_registry_id", regId]], { columns: "id" })) === 1);
  check("装一条被跳过的条目，报出跳过的原因", (await call("skills.remoteInstall", { token: ana, body: { registry_id: regId, slug: "Standup Note", agent_id: mockAgentId } })).payload.error === "skill_skipped_invalid_slug");
  check("装源上没有的 slug", (await call("skills.remoteInstall", { token: ana, body: { registry_id: regId, slug: "nope", agent_id: mockAgentId } })).payload.error === "skill_not_in_registry");

  check("别人看不到我的源", (await call("registries.refresh", { token: bToken, body: { id: regId } })).payload.error === "registry_not_owned");
  check("别人改不了我的源", (await call("registries.update", { token: bToken, body: { id: regId, enabled: false } })).payload.error === "registry_not_owned");
  check("别人删不掉我的源", (await call("registries.remove", { token: bToken, body: { id: regId } })).payload.error === "registry_not_owned");
  check("别人不能从我的源装技能", (await call("skills.remoteInstall", { token: bToken, body: { registry_id: regId, slug: "empty-body", agent_id: x22BoAgentId } })).payload.error === "registry_not_owned");
  check("我自己的源还能刷", (await call("registries.refresh", { token: ana, body: { id: regId } })).payload.registry?.skill_count === 5);
  check("查不到的源给 registry_not_found", (await call("registries.refresh", { token: ana, body: { id: crypto.randomUUID() } })).payload.error === "registry_not_found");
  check("别人更新不了我的快照", (await call("skills.remoteUpdate", { token: bToken, body: { skill_id: snapId } })).payload.error === "skill_not_owned");
  check("别人的员工查更新被拒", (await call("skills.checkUpdates", { token: bToken, method: "GET", body: { agent_id: mockAgentId } })).payload.error === "agent_not_owned");
  check("本地上传的技能没有源可更", (await call("skills.remoteUpdate", { token: ana, body: { skill_id: uploaded.payload.skill?.id } })).payload.error === "skill_not_remote");

  const x22Bad = await call("registries.add", { token: ana, body: { name: "乱回", index_url: `${regBase}/bad.json` } });
  check("非 JSON 的 index 标 registry_bad_response，源行留着可重测", x22Bad.payload.ok === true
    && x22Bad.payload.registry?.last_error === "registry_bad_response" && x22Bad.payload.probe?.error === "registry_bad_response", x22Bad.payload);
  const x22Schema = await call("registries.add", { token: ana, body: { name: "版本不认", index_url: `${regBase}/schema2.json` } });
  check("index 的 schema 版本不认识就整源拒收", x22Schema.payload.probe?.error === "registry_schema_unsupported", x22Schema.payload);
  const x22Move = await call("registries.add", { token: ana, body: { name: "跳转源", index_url: `${regBase}/move.json` } });
  check("源用重定向把人引去别处：拒收", x22Move.payload.probe?.error === "registry_redirect_blocked", x22Move.payload);
  const x22Deny = await call("registries.add", { token: ana, body: { name: "要鉴权", index_url: `${regBase}/deny.json` } });
  check("401 的源标 registry_unauthorized", x22Deny.payload.probe?.error === "registry_unauthorized", x22Deny.payload);
  for (const id of [x22Bad, x22Schema, x22Move, x22Deny].map((row) => row.payload.registry?.id)) {
    await call("registries.remove", { token: ana, body: { id } });
  }
  check("清掉坏源后回到一条", (await call("registries.list", { token: ana, method: "GET" })).payload.items?.length === 1);

  const x22Dead = await call("registries.add", { token: ana, body: { name: "死源", index_url: "http://127.0.0.1:1/index.json" } });
  check("连不上也留下源行并标 error", x22Dead.payload.ok === true && x22Dead.payload.registry?.last_error === "registry_unreachable", x22Dead.payload);
  const x22Mixed = await call("skills.remoteList", { token: ana, method: "GET" });
  check("一个源挂了不影响另一个出条目，错误标在挂掉那个上", x22Mixed.payload.registries?.some((row) => row.error === "registry_unreachable")
    && x22Mixed.payload.items?.length === 5, x22Mixed.payload.registries);
  await call("registries.remove", { token: ana, body: { id: x22Dead.payload.registry?.id } });

  const x22Many = await call("registries.add", { token: ana, body: { name: "超大清单", index_url: `${regBase}/many.json` } });
  check("单源最多收 200 条，多出来的记成 over_limit", x22Many.payload.registry?.skill_count === 200
    && x22Many.payload.probe?.skipped?.some((row) => row.reason === "over_limit"), x22Many.payload.registry);
  const manyId = x22Many.payload.registry?.id;
  const x22Off = await call("registries.update", { token: ana, body: { id: manyId, enabled: false } });
  check("停用后远端清单不再拉这个源", x22Off.payload.registry?.enabled === false
    && (await call("skills.remoteList", { token: ana, method: "GET" })).payload.items?.length === 5, x22Off.payload);
  check("点名查某个源时，停用了也查得到", (await call("skills.remoteList", { token: ana, method: "GET", body: { registry_id: manyId } })).payload.items?.length === 200);

  const stamp22 = new Date().toISOString();
  const placeholderIds = [];
  for (let i = 0; i < 6; i += 1) {
    const row = await db.skill_registries.insert({
      id: crypto.randomUUID(), owner_id: anaId, name: `占位${i}`,
      index_url: `https://placeholder${i}.example.com/index.json`, skill_count: 0,
      last_error: null, skills_at: null, enabled: true, created_at: stamp22, updated_at: stamp22,
    });
    placeholderIds.push(row.id);
  }
  const x22ReqBefore = mock22.requests.length;
  const x22Full = await call("registries.add", { token: ana, body: { name: "第九个源", index_url: `${regBase}/index.json` } });
  check("每人最多 8 个技能源", x22Full.payload.error === "too_many_registries", x22Full.payload);
  check("超量这条在出网之前就被挡下", mock22.requests.length === x22ReqBefore, {
    before: x22ReqBefore, after: mock22.requests.length,
  });
  for (const id of placeholderIds) await db.skill_registries.remove([["id", id]]);

  await call("registries.remove", { token: ana, body: { id: manyId } });
  check("删源不抽走已抄到本地的技能", (await call("skills.get", { token: ana, method: "GET", body: { id: snapId } })).payload.skill?.id === snapId);
  await call("registries.remove", { token: ana, body: { id: regId } });
  check("源没了，版本自查如实报 registry_not_found", (await call("skills.checkUpdates", { token: ana, method: "GET", body: { agent_id: mockAgentId } })).payload.unavailable
    ?.some((row) => row.skill_id === snapId && row.reason === "registry_not_found"));
  check("清空后源清单是空的", (await call("registries.list", { token: ana, method: "GET" })).payload.items?.length === 0);
  check("版本比对按数字段比大小：1.10 新于 1.2", isUpdateAvailable("1.2.0", "1.10.0") === true
    && isUpdateAvailable("1.10.0", "1.9.9") === false);
  check("版本比对：没装过报有更新，源上没版本不误报，相同不报", isUpdateAvailable("", "1.0.0") === true
    && isUpdateAvailable("1.0.0", "") === false && isUpdateAvailable("1.0.0", "1.0.0") === false);
  check("版本比对：比不动的非数字版本，不同就算有更新", isUpdateAvailable("v1", "v2") === true
    && isUpdateAvailable("v2", "v2") === false);
  await mock22.close();

  step("\n§23 云端 Agent 后端（QCA）：建档、自检、@ 派发与回群");
  const qca = await startMockQca();
  const PAT = "pt-smoke-token-1";
  const badId = await call("agents.create", {
    token: ana,
    body: { name: "坏链接", role: "x", backend: "qca", api_base_url: qca.origin, api_key: PAT, qca_agent_id: "https://qoder.cn/dashboard" },
  });
  check("云端 Agent 的 id 只认 agent_ 前缀，粘别的链接会被挡下",
    badId.status === 400 && badId.payload.error === "qca_agent_id_invalid", badId.payload);

  const qcaAgent = await call("agents.create", {
    token: ana,
    body: {
      name: "小C", role: "云端联调", backend: "qca", context_chars: 8000,
      qca_agent_id: "https://qoder.cn/cloud/agents/agent_00udpumq8ag3kz1958f3",
      api_base_url: qca.origin, api_key: PAT,
    },
  });
  const qcaId = qcaAgent.payload.agent?.id;
  check("建档：控制台链接里能提出 agent id",
    qcaAgent.payload.agent?.qca_agent_id === "agent_00udpumq8ag3kz1958f3", qcaAgent.payload);
  check("建档：后端记成 qca，模型位只留展示名",
    qcaAgent.payload.agent?.backend === "qca" && qcaAgent.payload.agent?.model === "云端 Agent", qcaAgent.payload);
  check("建档：令牌只回尾号，明文与密文都不外泄",
    qcaAgent.payload.agent?.api_key_tail === `••••${PAT.slice(-4)}`
    && !JSON.stringify(qcaAgent.payload).includes(PAT) && !JSON.stringify(qcaAgent.payload).includes("api_key_cipher"),
    qcaAgent.payload);
  const qcaProd = await call("agents.create", {
    token: ana, entry: prodHandler,
    body: { name: "元数据", role: "x", backend: "qca", qca_agent_id: "agent_ok", api_base_url: "https://169.254.169.254", api_key: PAT },
  });
  check("云端后端照旧过 SSRF：元数据地址被拒",
    qcaProd.status === 400 && qcaProd.payload.error === "private_api_base_url", qcaProd.payload);

  const qcaPing = await call("agents.test", { token: ana, body: { id: qcaId } });
  check("连接自检打通云端：报出可见模型数量",
    qcaPing.payload.result?.reachable === true && qcaPing.payload.result?.mode === "qca"
    && String(qcaPing.payload.result?.note).includes("可见模型 3 个"), qcaPing.payload);
  check("自检只读模型清单，不建 environment 也不建 session",
    qca.count("POST", /\/(environments|sessions)$/) === 0, qca.requests.map((r) => `${r.method} ${r.path}`));
  await call("agents.update", { token: ana, body: { id: qcaId, api_key: "sk-not-a-pat" } });
  const deniedPing = await call("agents.test", { token: ana, body: { id: qcaId } });
  check("令牌不对时自检如实报 qca_access_denied",
    deniedPing.payload.result?.reachable === false && deniedPing.payload.result?.error === "qca_access_denied", deniedPing.payload);
  await call("agents.update", { token: ana, body: { id: qcaId, api_key: PAT } });
  const switchBack = await call("agents.update", { token: ana, body: { id: agentId, backend: "qca", qca_agent_id: "agent_abc" } });
  check("切后端必须同时换令牌（自建端点的 Key 在云上没用）",
    switchBack.payload.error === "agent_key_required_for_backend", switchBack.payload);

  await call("streams.agents.add", { token: ana, body: { stream_id: streamId, agent_id: qcaId } });
  const qcaSend = await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "@小C 用一句话讲发布节奏", mentions: [{ type: "agent", id: qcaId }] },
  });
  check("云端员工也能被 @ 派发", qcaSend.payload.queued?.length === 1, qcaSend.payload);
  const qcaTick = await call("scheduler.tick", { token: ana, method: "GET" });
  check("云端这一轮跑完", (qcaTick.payload.ran ?? []).some((r) => r.status === "done"), qcaTick.payload);
  const qcaHistory = await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } });
  const qcaReply = (qcaHistory.payload.items ?? []).find((m) => m.sender_id === qcaId);
  check("云端的规范回复落进群聊", String(qcaReply?.content).includes("先做对，再做快"), qcaReply);
  check("云端的思考链不进群聊", !JSON.stringify(qcaReply).includes("云端思考链"), qcaReply);
  const qcaPrompt = qca.state.promptSeen?.prompt ?? "";
  check("上下文压成一条正文：设定与本次指令分段都在里面",
    qcaPrompt.includes("〔设定与技能说明〕") && qcaPrompt.includes("〔群上下文与本次指令〕")
    && qcaPrompt.includes("用一句话讲发布节奏"), qcaPrompt.slice(0, 160));
  check("我们的群工具不塞给云端 Agent（它用它自己的工具集）",
    qca.state.promptSeen?.hasTools === false, qca.state.promptSeen);
  check("云端员工的上下文改口说明群工具调不到，不叫它照着技能说明假执行",
    qcaPrompt.includes("本次由云端 Agent 作答") && qcaPrompt.includes("请把结论直接写进正文")
    && !qcaPrompt.includes("按需调用对应工具") && !qcaPrompt.includes("调用 search_history / read_window 工具"),
    qcaPrompt.slice(0, 260));
  const qcaAgentRow = (await call("agents.get", { token: ana, method: "GET", body: { id: qcaId } })).payload.agent;
  check("第一轮建出的 environment 记回员工档案",
    qca.count("POST", /\/environments$/) === 1 && qcaAgentRow?.qca_environment_id === "env_mock_1", qcaAgentRow);

  await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "@小C 再补一句", mentions: [{ type: "agent", id: qcaId }] },
  });
  const qcaTick2 = await call("scheduler.tick", { token: ana, method: "GET" });
  check("第二轮也跑完", (qcaTick2.payload.ran ?? []).some((r) => r.status === "done"), qcaTick2.payload);
  check("同群第二轮复用同一条云端 session", qca.count("POST", /\/sessions$/) === 1, qca.requests.map((r) => r.path));
  check("environment 记下来之后不再每轮重探", qca.count("GET", /\/environments$/) === 1, qca.requests.map((r) => r.path));
  const qcaSessions = await db.qca_sessions.list([["agent_id", qcaId]], { columns: "id,stream_id,session_id", limit: 20 });
  check("每个 (员工,群) 只存一条云端 session", qcaSessions.length === 1, qcaSessions);

  const qcaRoom = await call("streams.create", { token: ana, body: { name: "云端隔离组", agent_ids: [qcaId] } });
  const qcaRoomId = qcaRoom.payload.stream?.id;
  await call("messages.send", {
    token: ana,
    body: { stream_id: qcaRoomId, content: "@小C 换个群问", mentions: [{ type: "agent", id: qcaId }] },
  });
  await call("scheduler.tick", { token: ana, method: "GET" });
  const qcaSessions2 = await db.qca_sessions.list([["agent_id", qcaId]], { columns: "id,stream_id,session_id", limit: 20 });
  check("换群就换云端 session：不同群不会在云上串台",
    qca.count("POST", /\/sessions$/) === 2 && qcaSessions2.length === 2
    && new Set(qcaSessions2.map((r) => r.session_id)).size === 2, qcaSessions2);

  qca.state.mode = "error";
  const errorSend = await call("messages.send", {
    token: ana,
    body: { stream_id: qcaRoomId, content: "@小C 云端这轮会挂", mentions: [{ type: "agent", id: qcaId }] },
  });
  const errorTick = await call("scheduler.tick", { token: ana, method: "GET" });
  check("云端报错这一轮如实失败",
    (errorTick.payload.ran ?? []).some((r) => r.status === "failed" && r.error === "qca_session_error"),
    { send: errorSend.payload, ran: errorTick.payload.ran });
  qca.state.mode = "eof";
  await call("messages.send", {
    token: ana,
    body: { stream_id: qcaRoomId, content: "@小C 流提前断了", mentions: [{ type: "agent", id: qcaId }] },
  });
  const eofTick = await call("scheduler.tick", { token: ana, method: "GET" });
  check("流走光还没拿到规范正文：不拿半截增量冒充回复",
    (eofTick.payload.ran ?? []).some((r) => r.status === "failed" && r.error === "qca_stream_ended_unfinished"), eofTick.payload.ran);
  const qcaRoomHistory = await call("messages.list", { token: ana, method: "GET", body: { stream_id: qcaRoomId } });
  check("失败的那两轮只留系统提示，正文半截不落群",
    (qcaRoomHistory.payload.items ?? []).filter((m) => m.sender_id === qcaId).length === 1, qcaRoomHistory.payload.items);
  qca.state.mode = "ok";

  const qcaMembership = (await call("streams.get", { token: ana, method: "GET", body: { id: qcaRoomId } })).payload.members
    ?.find((m) => m.type === "agent" && m.agent?.id === qcaId);
  await call("streams.members.remove", { token: ana, body: { stream_id: qcaRoomId, membership_id: qcaMembership?.membership_id } });
  const qcaSessionsAfterKick = await db.qca_sessions.list([["agent_id", qcaId]], { columns: "id,stream_id", limit: 20 });
  check("员工被移出群时，他在云端那条 session 缓存一起作废",
    qcaSessionsAfterKick.length === 1 && qcaSessionsAfterKick[0].stream_id === streamId, qcaSessionsAfterKick);

  // 放行侧断言：另一条通道（自建 OpenAI 兼容端点）必须照旧带着工具说明，别把抑制写过头。
  const local = await startMockUpstream();
  const localAgent = await call("agents.create", {
    token: ana,
    body: {
      name: "小L", role: "对照", api_base_url: `http://127.0.0.1:${local.port}/v1`,
      api_key: "mock-key-2", model: "mock", context_chars: 8000,
    },
  });
  const localId = localAgent.payload.agent?.id;
  await call("streams.agents.add", { token: ana, body: { stream_id: qcaRoomId, agent_id: localId } });
  await call("messages.send", {
    token: ana,
    body: { stream_id: qcaRoomId, content: "@小L 对照一句", mentions: [{ type: "agent", id: localId }] },
  });
  await call("scheduler.tick", { token: ana, method: "GET" });
  const localSystem = String(local.seen.at(-1)?.messages?.[0]?.content ?? "");
  check("对照：自建端点那条通道照旧带着工具说明，也没被塞云端须知",
    localSystem.includes("按需调用对应工具") && localSystem.includes("调用 search_history / read_window 工具")
    && !localSystem.includes("本次由云端 Agent 作答"), localSystem.slice(0, 200));
  await local.close();

  // 直连一次：验证一次性会话（压缩用）不落到群里那条 session，也验证中断交出半截正文。
  const qcaRow = { ...qcaAgentRow, qca_environment_id: null };
  const sessionsBeforeEphemeral = qca.count("POST", /\/sessions$/);
  const rowsBeforeEphemeral = (await db.qca_sessions.list([["agent_id", qcaId]], { columns: "id", limit: 20 })).length;
  const ephemeral = await askCloudAgent({
    db, agent: qcaRow, streamId: qcaRoomId, pat: PAT,
    messages: [{ role: "system", content: "压缩成三条要点" }, { role: "user", content: "旧对话" }],
    persistSession: false,
  });
  check("一次性会话照旧能回话", ephemeral.content === qca.state.text && ephemeral.mode === "qca", ephemeral);
  check("一次性会话不落库（摘要指令不混进群聊历史）",
    qca.count("POST", /\/sessions$/) === sessionsBeforeEphemeral + 1
    && (await db.qca_sessions.list([["agent_id", qcaId]], { columns: "id", limit: 20 })).length === rowsBeforeEphemeral,
    { 出网次数: qca.count("POST", /\/sessions$/) });
  qca.state.mode = "slow";
  let interruptSeen = 0;
  let interrupted = null;
  try {
    await askCloudAgent({
      db, agent: qcaRow, streamId: qcaRoomId, pat: PAT,
      messages: [{ role: "user", content: "长跑一下" }],
      onInterrupt: async () => {
        interruptSeen += 1;
        return interruptSeen >= 2 ? { by: "human", seq: 99 } : null;
      },
    });
  } catch (error) {
    interrupted = error;
  }
  qca.state.mode = "ok";
  check("群里插话时云端这轮就地掐断，半截正文交给上层",
    interrupted instanceof Interrupted && String(interrupted.payload.partial).startsWith("慢0慢1"),
    { name: interrupted?.name, partial: interrupted?.payload?.partial?.slice(0, 12) });

  // 云端 agent 在自己那边跑工具时，SSE 可以整段静默：这条通道必须也按静默去问要不要停。
  qca.state.mode = "stall";
  let stallPolls = 0;
  let stallStopped = null;
  const stallStarted = Date.now();
  try {
    await completeForAgent({
      db, agent: qcaRow, streamId: qcaRoomId, key: PAT,
      messages: [{ role: "user", content: "云端在跑自己的工具，半天不吭声" }],
      onInterrupt: async () => {
        stallPolls += 1;
        return stallPolls >= 2 ? { by: "human", seq: 77 } : null;
      },
    });
  } catch (error) {
    stallStopped = error;
  }
  const stallMs = Date.now() - stallStarted;
  qca.state.mode = "ok";
  check("云端整段静默（在自己那边跑工具）时，插话照样在两秒内掐断，不必等 180s 整轮超时",
    stallStopped instanceof Interrupted && stallStopped.payload.partial === "静默前两句"
    && stallStopped.payload.seq === 77 && stallMs < 3000,
    { 报错: stallStopped?.name, 半截: stallStopped?.payload?.partial, 用时ms: stallMs, 轮询次数: stallPolls });

  // 放行侧断言：自建端点那条通道静默时同样掐断——两条后端的 preempt 是同一套口径。
  const idleMock = await startMockUpstream();
  let idlePolls = 0;
  let idleStopped = null;
  const idleStarted = Date.now();
  try {
    await completeForAgent({
      db,
      agent: { id: "agent-openai", backend: "openai", model: "mock", api_base_url: `http://127.0.0.1:${idleMock.port}/v1` },
      key: "mock-key-2",
      messages: [{ role: "user", content: "静默卡住" }],
      onInterrupt: async () => {
        idlePolls += 1;
        return idlePolls >= 2 ? { by: "human", seq: 78 } : null;
      },
    });
  } catch (error) {
    idleStopped = error;
  }
  const idleMs = Date.now() - idleStarted;
  await idleMock.close();
  check("对照：自建端点静默时同样按 800ms 问一次，两条通道的中断语义一致",
    idleStopped instanceof Interrupted && idleStopped.payload.partial === "半截"
    && idleStopped.payload.seq === 78 && idleMs < 3000,
    { 报错: idleStopped?.name, 半截: idleStopped?.payload?.partial, 用时ms: idleMs, 轮询次数: idlePolls });
  qca.state.mode = "silent";
  let noReply = null;
  try {
    await askCloudAgent({ db, agent: qcaRow, streamId: qcaRoomId, pat: PAT, messages: [{ role: "user", content: "云端一个字都没回" }] });
  } catch (error) {
    noReply = error;
  }
  qca.state.mode = "ok";
  check("云端一个字都没回：如实报 qca_no_reply，不产出空回复",
    noReply instanceof QcaError && noReply.code === "qca_no_reply", noReply?.code);

  const flat = flattenPrompt([
    { role: "system", content: "S" }, { role: "user", content: "U" }, { role: "assistant", content: "A" },
  ]);
  check("压平后的正文按角色分段，顺序不变",
    flat.indexOf("〔设定与技能说明〕") < flat.indexOf("〔群上下文与本次指令〕")
    && flat.indexOf("〔群上下文与本次指令〕") < flat.indexOf("〔你之前的回复〕"), flat);
  let tooLarge = null;
  try {
    flattenPrompt([{ role: "user", content: "字".repeat(900001) }]);
  } catch (error) {
    tooLarge = error;
  }
  check("超长的上下文在出网之前就被挡下",
    tooLarge instanceof QcaError && tooLarge.code === "qca_prompt_too_large", tooLarge?.code);
  check("parseAgentId 认裸 id 也认控制台链接",
    parseAgentId("agent_abc-1") === "agent_abc-1"
    && parseAgentId(" https://qoder.cn/cloud/agents/agent_00udpumq8ag3kz1958f3?tab=log ") === "agent_00udpumq8ag3kz1958f3");

  const reBindBefore = (await db.qca_sessions.list([["agent_id", qcaId]], { columns: "id", limit: 20 })).length;
  await call("agents.update", { token: ana, body: { id: qcaId, qca_agent_id: "agent_another01" } });
  check("改绑云端 Agent 后，旧的 session 缓存全部作废",
    (await db.qca_sessions.list([["agent_id", qcaId]], { columns: "id", limit: 20 })).length === 0, reBindBefore);
  const qcaList = await call("agents.list", { token: ana, method: "GET" });
  const listed = (qcaList.payload.items ?? []).find((row) => row.id === qcaId);
  check("列表里的云端员工带着后端与新绑的 id", listed?.backend === "qca" && listed?.qca_agent_id === "agent_another01", listed);
  await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "@小C 改绑之后再答一句", mentions: [{ type: "agent", id: qcaId }] },
  });
  const reBindTick = await call("scheduler.tick", { token: ana, method: "GET" });
  check("改绑之后用的是新云端 Agent 的会话",
    (reBindTick.payload.ran ?? []).some((r) => r.status === "done")
    && (await db.qca_sessions.list([["agent_id", qcaId]], { columns: "id,session_id", limit: 20 })).length === 1,
    reBindTick.payload.ran);
  await call("agents.delete", { token: ana, body: { id: qcaId } });
  check("删云端员工不会留下孤儿 session",
    (await db.qca_sessions.list([["agent_id", qcaId]], { columns: "id", limit: 20 })).length === 0);
  await qca.close();

  step("\n§24 群文件渲染器：注册即返回精确 disposer，drawio 出结构");
  const drawioModel = `<mxGraphModel><root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="2" value="开始 &lt;测试&gt;" vertex="1" style="rounded=0;fillColor=#dae8fc;strokeColor=#6c8ebf" parent="1">
      <mxGeometry x="40" y="40" width="120" height="60" as="geometry" />
    </mxCell>
    <mxCell id="3" value="结束" vertex="1" parent="1">
      <mxGeometry x="40" y="200" width="120" height="60" as="geometry" />
    </mxCell>
    <mxCell id="4" value="&lt;b&gt;走&lt;/b&gt;" edge="1" source="2" target="3" parent="1">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>
  </root></mxGraphModel>`;
  // diagrams.net 存盘时默认把页体 encodeURIComponent + raw DEFLATE + base64，这里用同一套 API 造样本。
  const packDiagram = async (xml) => {
    const bytes = new TextEncoder().encode(encodeURIComponent(xml));
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    return btoa(String.fromCharCode(...packed));
  };

  check("内置渲染器在模块加载时就挂上注册表", fileRenderers().some((row) => row.id === "drawio"), fileRenderers().map((row) => row.id));
  const plainView = await renderGroupFile({ name: "流程图.drawio", content_type: "text/plain", content: drawioModel });
  check("未压缩的 mxGraphModel 出结构预览：两个节点一条连线", plainView?.rendererId === "drawio"
    && plainView.view.kind === "svg" && plainView.view.summary === "2 个节点 · 1 条连线", plainView?.view?.summary);
  check("节点画成方框、连线画成带箭头的直线", (String(plainView?.view?.markup).match(/<rect /g) ?? []).length === 2
    && (String(plainView?.view?.markup).match(/<line /g) ?? []).length === 1
    && String(plainView?.view?.markup).includes('marker-end="url(#ws-arrow)"'), String(plainView?.view?.markup).slice(0, 160));
  check("作者写的颜色保留、没写的走主题变量", String(plainView?.view?.markup).includes('fill="#dae8fc"')
    && String(plainView?.view?.markup).includes('fill="var(--card)"'), String(plainView?.view?.markup).slice(0, 200));
  check("标签里的实体与富文本只留纯文本，出图时再转义回 XML", String(plainView?.view?.markup).includes("开始 &lt;测试&gt;")
    && String(plainView?.view?.markup).includes(">走<") && !String(plainView?.view?.markup).includes("<b>"), String(plainView?.view?.markup));
  check("生成的图里没有可执行入口", !/<script|onload=|onclick=|javascript:/i.test(String(plainView?.view?.markup)));

  const contrastView = await renderGroupFile({
    name: "d.drawio",
    content_type: "text/plain",
    content: "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>"
      + "<mxCell id=\"2\" value=\"浅底\" vertex=\"1\" style=\"fillColor=#d5e8d4\" parent=\"1\"><mxGeometry x=\"0\" y=\"0\" width=\"100\" height=\"40\" as=\"geometry\"/></mxCell>"
      + "<mxCell id=\"3\" value=\"深底\" vertex=\"1\" style=\"fillColor=#1f2a44\" parent=\"1\"><mxGeometry x=\"0\" y=\"80\" width=\"100\" height=\"40\" as=\"geometry\"/></mxCell>"
      + "<mxCell id=\"4\" value=\"没配色\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"0\" y=\"160\" width=\"100\" height=\"40\" as=\"geometry\"/></mxCell>"
      + "</root></mxGraphModel>",
  });
  const markupOf = (word) => String(contrastView?.view?.markup)
    .match(new RegExp(`<text[^>]*fill="([^"]+)"[^>]*>${word}<`))?.[1];
  check("节点标签的底色跟着节点自己的颜色走，不跟主题走",
    markupOf("浅底") === "#141416" && markupOf("深底") === "#f4f4f5" && markupOf("没配色") === "var(--foreground)",
    [markupOf("浅底"), markupOf("深底"), markupOf("没配色")]);

  const singleCell = await renderGroupFile({
    name: "a.drawio",
    content_type: "text/plain",
    content: `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="只有一个框" vertex="1" parent="1"><mxGeometry x="10" y="20" width="30" height="40" as="geometry"/></mxCell></root></mxGraphModel>`,
  });
  check("自闭合的 mxCell 不会抢走下一个节点的坐标", singleCell?.view?.summary === "1 个节点 · 0 条连线"
    && String(singleCell?.view?.markup).includes('x="10" y="20" width="30" height="40"'), singleCell?.view?.summary);

  const zipped = await renderGroupFile({
    name: "b.drawio",
    content_type: "text/plain",
    content: `<mxfile host="app.diagrams.net"><diagram id="p1" name="第 1 页">${await packDiagram(drawioModel)}</diagram></mxfile>`,
  });
  check("diagrams.net 默认的压缩页（base64 + raw DEFLATE）也出结构", zipped?.view?.summary === "2 个节点 · 1 条连线", zipped?.view?.summary);
  check("解析不出结构时如实回 null，界面落回纯文本而不是空白框",
    (await renderGroupFile({ name: "c.drawio", content_type: "text/plain", content: "<mxfile><diagram></diagram></mxfile>" })) === null);
  check("普通文本文件不进任何渲染器，仍走原来的纯文本",
    (await renderGroupFile({ name: "清单.md", content_type: "text/markdown", content: "# 标题" })) === null);

  const dispose = registerFileRenderer({
    id: "smoke-probe",
    order: 1,
    match: (file) => file.name.endsWith(".probe"),
    render: () => ({ kind: "text", text: "命中探针" }),
  });
  check("注册之后立刻可见，并按 order 排在内置渲染器之前", fileRenderers()[0]?.id === "smoke-probe", fileRenderers().map((row) => row.id));
  const probeHit = await renderGroupFile({ name: "x.probe", content_type: "text/plain", content: "" });
  check("匹配上的渲染器接管这一份文件", probeHit?.rendererId === "smoke-probe" && probeHit.view.kind === "text", probeHit);
  check("注销句柄摘掉自己那一条之后不再接管", dispose() === true
    && (await renderGroupFile({ name: "x.probe", content_type: "text/plain", content: "" })) === null);

  const keepFirst = registerFileRenderer({ id: "shared", order: 50, match: () => false, render: () => null });
  let duplicated = null;
  try {
    registerFileRenderer({ id: "shared", order: 60, match: () => false, render: () => null });
  } catch (error) {
    duplicated = error;
  }
  check("同 id 重复注册就地抛错，而不是悄悄覆盖", duplicated instanceof Error && /id 重复/.test(duplicated.message), String(duplicated));
  check("抛错之后原来那条仍留在注册表里", fileRenderers().some((row) => row.id === "shared" && row.order === 50));
  check("缺 render 的注册在登记时就抛", (() => {
    try {
      registerFileRenderer({ id: "bad", order: 1, match: () => false });
      return false;
    } catch (error) {
      return /match 与 render/.test(String(error?.message));
    }
  })());
  keepFirst();
  check("精确 disposer：注销后彻底消失", !fileRenderers().some((row) => row.id === "shared"));

  step("\n§25 替身：真人不在时由本人名下的虚拟员工代答");
  const DAY = 24 * 60 * 60 * 1000;
  const iso = (ms) => new Date(ms).toISOString();
  const T0 = Date.parse("2026-01-10T12:00:00Z");

  // 生效判定是纯函数：派发路径和界面用同一把尺子，所以先把尺子本身钉死。
  check("没排班表、群内也没单独开：不生效，如实说未开启",
    delegateWindow({ mode: "inherit", scheduled: false, atMs: T0 }).reason === "not_enabled");
  check("排了班表但没给时段：立即生效",
    delegateWindow({ mode: "inherit", scheduled: true, atMs: T0 }).active === true);
  check("时段内生效",
    delegateWindow({ mode: "inherit", scheduled: true, startAt: iso(T0 - 60000), endAt: iso(T0 + 60000), atMs: T0 }).active === true);
  check("时段左端取得到（到点即生效）",
    delegateWindow({ mode: "inherit", scheduled: true, startAt: iso(T0), endAt: iso(T0 + 60000), atMs: T0 }).active === true);
  check("时段右端取不到（到点即失效，不留一秒重叠）",
    delegateWindow({ mode: "inherit", scheduled: true, startAt: iso(T0 - 60000), endAt: iso(T0), atMs: T0 }).reason === "expired");
  check("还没到时段：如实说没开始",
    delegateWindow({ mode: "inherit", scheduled: true, startAt: iso(T0 + 60000), atMs: T0 }).reason === "not_started");
  check("只填结束且还没到：生效",
    delegateWindow({ mode: "inherit", scheduled: true, endAt: iso(T0 + 60000), atMs: T0 }).active === true);
  check("只填开始且已经过去：生效",
    delegateWindow({ mode: "inherit", scheduled: true, startAt: iso(T0 - 60000), atMs: T0 }).active === true);
  check("本群关掉压过班表：关就是关",
    delegateWindow({ mode: "off", scheduled: true, atMs: T0 }).reason === "stream_off");
  check("本群单独开不依赖班表：没排班也能只在这个群生效",
    delegateWindow({ mode: "on", scheduled: false, atMs: T0 }).active === true);

  const lin = await call("auth.register", { body: { email: "lin@example.com", password: "passw0rd-25", display_name: "林" } });
  const linId = lin.payload.user?.id;
  await call("auth.verify", { body: { token: decodeURIComponent((lin.payload.verify_link ?? "").split("token=")[1] ?? "") } });
  const linToken = (await call("auth.login", { body: { email: "lin@example.com", password: "passw0rd-25" } })).payload.token;
  const han = await call("auth.register", { body: { email: "han@example.com", password: "passw0rd-26", display_name: "韩" } });
  const hanId = han.payload.user?.id;
  const hanToken = (await call("auth.login", { body: { email: "han@example.com", password: "passw0rd-26" } })).payload.token;
  const standIn = await call("agents.create", {
    token: linToken,
    body: { name: "小L", role: "值班", api_base_url: "demo://local", api_key: "demo-key-25", model: "demo" },
  });
  const standInId = standIn.payload.agent?.id;
  const dStream = await call("streams.create", { token: linToken, body: { name: "替身值班组", agent_ids: [standInId] } });
  const dStreamId = dStream.payload.stream?.id;
  const dApply = await call("streams.apply", { token: hanToken, body: { stream_uuid: dStreamId } });
  await call("streams.decide", { token: linToken, body: { request_id: dApply.payload.request_id, approve: true } });

  // 成对：同一个员工，别人拿来当替身被拒、本人拿来用放行——只比 owner 时两条会同时通过或同时失败。
  const steal = await call("delegate.set", { token: hanToken, body: { mode: "now", agent_id: standInId } });
  check("借别人的虚拟员工当替身被拒", steal.status === 403 && steal.payload.error === "agent_not_owned", steal.payload);
  const ownSet = await call("delegate.set", { token: linToken, body: { mode: "now", agent_id: standInId } });
  check("对照：本人名下的员工就能立为替身", ownSet.payload.ok === true, ownSet.payload);
  const anonymousSet = await call("delegate.set", { body: { mode: "now", agent_id: standInId } });
  check("未登录改班表被拒", anonymousSet.status === 401, anonymousSet.payload);
  check("班表只写在自己的账号行上：韩的班表仍是空的",
    (await call("auth.me", { token: hanToken, method: "GET" })).payload.user?.delegate?.agent_id === null, hanId);
  const badMode = await call("delegate.set", { token: linToken, body: { mode: "always", agent_id: standInId } });
  check("不认识的替身模式被拒", badMode.status === 400 && badMode.payload.error === "invalid_mode", badMode.payload);
  check("时间段两头都不填被拒",
    (await call("delegate.set", { token: linToken, body: { mode: "window", agent_id: standInId } })).payload.error === "window_needs_bounds");
  check("结束早于开始被拒",
    (await call("delegate.set", { token: linToken, body: { mode: "window", agent_id: standInId, start_at: iso(T0), end_at: iso(T0 - 1000) } })).payload.error === "window_inverted");
  check("排到 90 天以后被拒：没人会记得自己开过这么远的替身",
    (await call("delegate.set", { token: linToken, body: { mode: "window", agent_id: standInId, start_at: iso(Date.now() + 200 * DAY) } })).payload.error === "window_too_far_ahead");
  check("时刻格式不合法就地炸，不静默按立即处理",
    (await call("delegate.set", { token: linToken, body: { mode: "window", agent_id: standInId, start_at: "明天下午" } })).payload.error === "invalid_start_at");

  const dSend = await call("messages.send", {
    token: hanToken,
    body: { stream_id: dStreamId, content: "@林 这个报错你帮我看下", mentions: [{ type: "human", id: linId }] },
  });
  check("@ 真人时替身接到一封任务",
    (dSend.payload.delegated ?? []).some((d) => d.user_id === linId && d.active && d.agent_id === standInId), dSend.payload);
  check("@ 真人时本人照旧收到通知：代答不等于代收",
    (dSend.payload.notified ?? []).some((n) => n.user_id === linId), dSend.payload);
  const dMail = await db.mail.list([["message_id", dSend.payload.message?.id]], { columns: "agent_id,status,meta", limit: 5 });
  check("落下的任务里记着替谁说话", dMail.length === 1 && dMail[0].meta?.on_behalf_of === linId, dMail);
  const dTick = await call("scheduler.tick", { token: linToken, method: "GET" });
  check("替身把这封任务跑掉了",
    (dTick.payload.ran ?? []).some((r) => r.agent_id === standInId && r.status === "done"), dTick.payload);
  const dHistory = await call("messages.list", { token: hanToken, method: "GET", body: { stream_id: dStreamId } });
  const dReply = (dHistory.payload.items ?? []).find((m) => m.sender_type === "agent");
  check("回复署名是替身本人，不是被替的真人",
    dReply?.sender_name === "小L" && dReply?.sender_id === standInId, dReply);
  check("回复带着 on_behalf_of，界面据此标出是代答", dReply?.on_behalf_of === linId, dReply);
  check("代答正文不念内部指令：替身须知和触发消息都留在提示词里",
    !String(dReply?.content).includes("这一轮你是") && !String(dReply?.content).includes("上一条 @ 你的消息"), dReply?.content);
  check("对照：转录与记忆照旧摘录得出来（演示模型仍能证明上下文进得去）",
    /建档：|韩：@林/.test(String(dReply?.content)), dReply?.content);
  // 演示模型会把触发消息原样摘录进回复，所以这条回复天然又 @ 了主人：正是自我触发的现场。
  const dLoopMail = await db.mail.list([["agent_id", standInId], ["stream_id", dStreamId]], { columns: "id,status,message_id", limit: 10 });
  check("替身的回复里 @ 了主人：不再给自己派活，队列里没有第二封",
    dLoopMail.length === 1, dLoopMail);

  const offHere = await call("delegate.stream", { token: linToken, body: { stream_id: dStreamId, mode: "off" } });
  check("本群关掉压过全局「立即」", offHere.payload.active === false && offHere.payload.reason === "stream_off", offHere.payload);
  const dSendOff = await call("messages.send", {
    token: hanToken,
    body: { stream_id: dStreamId, content: "@林 还在吗", mentions: [{ type: "human", id: linId }] },
  });
  check("关掉之后 @ 真人不再落替身任务",
    dSendOff.payload.delegated?.[0]?.active === false && dSendOff.payload.delegated[0].reason === "stream_off", dSendOff.payload);
  const onHere = await call("delegate.stream", { token: linToken, body: { stream_id: dStreamId, mode: "on" } });
  check("对照：同一处改成只在本群开就重新生效", onHere.payload.active === true && onHere.payload.agent_name === "小L", onHere.payload);
  const dSendOn = await call("messages.send", {
    token: hanToken,
    body: { stream_id: dStreamId, content: "@林 这条要接", mentions: [{ type: "human", id: linId }] },
  });
  check("对照：重新打开之后 @ 真人又会落替身任务",
    dSendOn.payload.delegated?.[0]?.active === true, dSendOn.payload);
  const selfSend = await call("messages.send", {
    token: linToken,
    body: { stream_id: dStreamId, content: "@林 自己 @ 自己", mentions: [{ type: "human", id: linId }] },
  });
  check("自己 @ 自己不触发替身", (selfSend.payload.delegated ?? []).length === 0, selfSend.payload);

  const standIn2 = await call("agents.create", {
    token: linToken,
    body: { name: "小M", role: "备份替身", api_base_url: "demo://local", api_key: "demo-key-26", model: "demo" },
  });
  const standIn2Id = standIn2.payload.agent?.id;
  const notInRoom = await call("delegate.stream", { token: linToken, body: { stream_id: dStreamId, mode: "on", agent_id: standIn2Id } });
  check("替身不在本群：如实说不在，不硬派",
    notInRoom.payload.active === false && notInRoom.payload.reason === "agent_not_in_stream", notInRoom.payload);
  await call("streams.agents.add", { token: linToken, body: { stream_id: dStreamId, agent_id: standIn2Id } });
  const inRoom = await call("delegate.stream", { token: linToken, body: { stream_id: dStreamId, mode: "on", agent_id: standIn2Id } });
  check("对照：把这位员工拉进群后，本群替身就用 ta",
    inRoom.payload.active === true && inRoom.payload.agent_name === "小M", inRoom.payload);
  await call("agents.update", { token: linToken, body: { id: standIn2Id, status: "paused" } });
  check("替身被停用：如实说停用，不派给一个不会回话的员工",
    (await call("delegate.stream", { token: linToken, body: { stream_id: dStreamId, mode: "on", agent_id: standIn2Id } })).payload.reason === "agent_paused");
  await call("agents.update", { token: linToken, body: { id: standIn2Id, status: "active" } });
  await call("delegate.stream", { token: linToken, body: { stream_id: dStreamId, mode: "inherit" } });

  const hanOverride = await call("delegate.stream", { token: hanToken, body: { stream_id: dStreamId, mode: "off" } });
  check("群内覆盖只改自己那条成员记录：韩能关掉韩自己的替身", hanOverride.payload.ok === true, hanOverride.payload);
  const linStill = await call("streams.get", { token: linToken, method: "GET", body: { id: dStreamId } });
  check("对照：韩的覆盖动不到林的班表", linStill.payload.my_delegate?.active === true, linStill.payload.my_delegate);
  const hanView = await call("streams.get", { token: hanToken, method: "GET", body: { id: dStreamId } });
  check("别人的替身班表不从群现场里漏出去",
    hanView.payload.my_delegate?.schedule?.agent_id === null && hanView.payload.my_delegate?.mode === "off", hanView.payload.my_delegate);

  // 到期靠时钟判定，不靠"到点翻牌"：没有任何常驻进程保证那次写入发生。
  const pastWindow = await call("delegate.set", {
    token: linToken,
    body: { mode: "window", agent_id: standInId, start_at: iso(Date.now() - 2 * DAY), end_at: iso(Date.now() - DAY) },
  });
  check("已经结束的时段存得下来（不需要谁去翻牌）", pastWindow.payload.ok === true, pastWindow.payload);
  const dSendExpired = await call("messages.send", {
    token: hanToken,
    body: { stream_id: dStreamId, content: "@林 时段过了还找我吗", mentions: [{ type: "human", id: linId }] },
  });
  check("时段已过：不再派任务，如实说已过期",
    dSendExpired.payload.delegated?.[0]?.active === false && dSendExpired.payload.delegated[0].reason === "expired", dSendExpired.payload);

  const offAll = await call("delegate.set", { token: linToken, body: { mode: "off" } });
  check("全局一键关掉", offAll.payload.ok === true && offAll.payload.delegate.agent_id === null, offAll.payload);
  check("关掉后账号里读得到空班表",
    (await call("auth.me", { token: linToken, method: "GET" })).payload.user?.delegate?.agent_id === null);
  const onlyHere = await call("delegate.stream", { token: linToken, body: { stream_id: dStreamId, mode: "on", agent_id: standInId } });
  check("全局关着仍可在单个群单独启用", onlyHere.payload.active === true, onlyHere.payload);
  const dSendLocal = await call("messages.send", {
    token: hanToken,
    body: { stream_id: dStreamId, content: "@林 只在这个群找你", mentions: [{ type: "human", id: linId }] },
  });
  check("单独启用的那个群会落任务", dSendLocal.payload.delegated?.[0]?.active === true, dSendLocal.payload);

  const withDelegate = composeSystemPrompt({ ...slotCtx, delegate: { name: "林", id: linId } });
  check("替身这一轮单独成一块，位置在本群记忆之后、触发消息之前",
    withDelegate.promptSlots.map(([id]) => id).join(",")
      === "identity,signature,guide,announcement,skills,history.access,memory.common,summary,transcript,memory.stream,delegate,trigger",
    withDelegate.promptSlots.map(([id]) => id));
  check("这块要求替身自报是替身，且不冒充本人、不替本人承诺",
    withDelegate.system.includes("你是「林」的替身") && withDelegate.system.includes("不要冒充 ta 本人"));
  check("替身块标注为易变：它不会打断平时接活的那段前缀",
    PROMPT_SECTIONS.find((section) => section.id === "delegate")?.volatile === true);
  check("不是替身的那一轮不落这一块", !composed.promptSlots.some(([id]) => id === "delegate"));

  console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length) {
    console.log(`失败：\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  }
}

async function rawMcp(key, payload) {
  const request = new Request("http://local/functions/v1/app/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-workstream-mcp-key": key },
    body: JSON.stringify(payload),
  });
  const response = await handler({ request, supabase });
  return { status: response.status, ...(await response.json().catch(() => ({}))) };
}

main()
  .catch((error) => {
    console.error("自检崩溃：", error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(dir, { recursive: true, force: true }));
