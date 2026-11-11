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
import { catchUp, clockToMs, dueOwnerIds, fireDueSchedules, nextOccurrence, upcomingOccurrences } from "../functions/cron.mjs";
import { isUpdateAvailable } from "../functions/registries.mjs";
import { CACHE_BREAKPOINT_ID, PROMPT_SECTIONS, composeSystemPrompt } from "../functions/prompt.mjs";
import { delegateWindow } from "../functions/delegate.mjs";
import { BACKENDS, BACKEND_IDS, DEMO_BASE_URL, backendFor, validateBackends } from "../functions/backends.mjs";
import { LOCALE_IDS } from "../functions/locales.mjs";
import { skillPrompt } from "../functions/skills.mjs";
import { store } from "../functions/store.mjs";
import { closeOrphanSteps, createStepWriter } from "../functions/steps.mjs";
import { askCloudAgent, dataOf, flattenPrompt, parseAgentId, QcaError } from "../functions/qca.mjs";
import { askStreamServer, checkStreamAccess, isDurableDiscoveryFailure } from "../functions/stream.mjs";
import { createCtsGate, payloadOf, runConformance } from "../functions/streamcts.mjs";
import { createStreamServer } from "../functions/streamserver.mjs";
import { listenStreamServer } from "./stream-server.mjs";
import {
  CAP_KEYS, DISCOVERY_REASONS, ENDPOINTS, SHARED_PROFILE, SPEC_ID, STREAM_PROFILE_VALUES, endpointPath,
  matchEndpoint, parseDescriptor, pickProfile, specDescriptor, validateSpec,
} from "../functions/streamspec.mjs";
import { completeForAgent } from "../functions/agents.mjs";
import { actions, reapStale, reapThreshold, runTask } from "../functions/engine.mjs";
import { startWorker } from "../functions/worker.mjs";
import { demoCopy, systemCopy } from "../functions/copy.mjs";
import { parseTranscript, renderTranscript } from "../functions/transcript.mjs";
import { Interrupted, newId, now } from "../functions/util.mjs";
import { createFixtureClient } from "./fixture-supabase.mjs";
import { fileRenderers, registerFileRenderer, renderGroupFile } from "../src/lib/renderers/index.mjs";
import { hitRateOf, newUsage, tallyUsage } from "../src/lib/usageStats.mjs";

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
  // 压缩信的那次调用按剧本换德性：ok 正常出摘要，empty 只回空正文，boom 直接 500，long 一次吐满摘要上限，
  // slow 慢慢吐（用来在折叠正跑着的时候插一次 @）。
  // 折不动时水位线该不该动是摘要覆盖对不对得上的关键，所以两种坏德性都要能重跑。
  // 归并（dreaming）同样三种德性：它的空正文和 5xx 都不许抬覆盖水位，所以也做成开关而不是关键词。
  // chat 是自建通道整条链路的故障开关（ok / 500 / eof / half）：坏上游的用例要能随跑随切，
  // 不能用触发关键词认剧本——上一轮的转录里也带着那个词，会把本来正常的轮次一起带坏，
  // 于是"这轮为什么失败"永远说不清。形状照云端那条的 state.mode（见 startMockQca）。
  const scripts = { compress: "ok", chat: "ok", dream: "ok" };
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
      const system = String(body.messages?.[0]?.content ?? "");
      // 按触发消息本身认剧本：下一轮的转录里也带着上一轮的关键词，按全文匹配会把两封混成一份。
      const trig = String(system.split("\n\n").find((b) => b.startsWith("上一条 @ 你的消息")) ?? "");
      // 排程那一轮没有触发消息，按排程块认剧本：静默巡检只回空正文（正文空着才是这一轮的正当结局），其余一次说清。
      const cronBlock = String(system.split("\n\n").find((b) => b.startsWith("这一轮是你自己的排程到点了")) ?? "");
      // 接龙剧本（§30）认的是「谁在说话」：设定块第一句带着员工名，两个员工才能各自回敬对方。
      const speakerOf = (text) => /你是虚拟员工「(.+?)」/.exec(text)?.[1] ?? "";
      // 压缩剧本 boom 要在 SSE 头发出之前决定状态码，所以这一条单独前置。
      if (system.includes("压成不超过 600 字") && scripts.compress === "boom") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock_compress_boom" } }));
        return;
      }
      // 归并剧本 boom 同样要在 SSE 头之前定状态码：失败时覆盖水位不许动，这条得能重跑。
      if (system.includes("主人全局记忆") && scripts.dream === "boom") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock_dream_boom" } }));
        return;
      }
      // 交付登记之后上游第二轮崩：这一轮没有回复落群，卡片也就不该发出去。
      if (trig.includes("交付后崩") && body.messages.some((m) => m.role === "tool")) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock_present_then_boom" } }));
        return;
      }
      // 故障开关只管真人 @ 那一链路：压缩信、排程轮次、归并信各按自己的剧本走，别被一起带坏。
      if (scripts.chat !== "ok" && !system.includes("压成不超过 600 字")
        && !system.includes("主人全局记忆") && !cronBlock) {
        const sseHead = { "content-type": "text/event-stream", "cache-control": "no-store" };
        const frame = (delta, finishReason = null) => `data: ${JSON.stringify({ id: "mock", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
        if (scripts.chat === "500") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "mock_chat_boom" } }));
          return;
        }
        if (scripts.chat === "eof") {
          // 表头给完、一个字节没吐就挂断：连接是通的，回的是"没有回复"这件事。
          res.writeHead(200, sseHead);
          res.end();
          return;
        }
        // half：正文吐到一半，既没有 finish_reason 也没有 [DONE]，然后挂断。
        res.writeHead(200, sseHead);
        res.write(frame({ content: "这段回复" }));
        res.write(frame({ content: "说到一半" }));
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const send = (delta, finishReason = null) => res.write(
        `data: ${JSON.stringify({ id: "mock", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
      const alive = () => !res.destroyed && !res.writableEnded;
      // 思考链增量 + 只在请求带了 stream_options.include_usage 时才补的用量块：
      // 两者一起验“我们有发、有收”，不然轨迹里的用量列会悄悄全是空。
      const think = (text) => { if (alive()) send({ reasoning_content: text }); };
      // 用量块的四种真实口径：full 带两个子桶、bare 只有总数、sketchy 子桶比总数还大、none 压根不回了。
      // 落库要分得清"没这项"和"这项是 0"，所以形状得能按剧本换，不能只验最整齐的那一种。
      const USAGE = {
        full: {
          prompt_tokens: 812, completion_tokens: 24, total_tokens: 836,
          prompt_tokens_details: { cached_tokens: 640 },
          completion_tokens_details: { reasoning_tokens: 9 },
        },
        bare: { prompt_tokens: 812, completion_tokens: 24 },
        sketchy: {
          prompt_tokens: 812, completion_tokens: 24,
          prompt_tokens_details: { cached_tokens: 1200 },
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      };
      let usageMode = "full";
      const usageChunk = () => {
        if (!alive() || body.stream_options?.include_usage !== true || usageMode === "none") return;
        res.write(`data: ${JSON.stringify({ id: "mock", choices: [], usage: USAGE[usageMode] })}\n\n`);
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
      // 交付剧本共用的两轮形状：第一轮把 present 的 tool_call 分片吐完，第二轮才成正文。
      const presentCall = (index, id, name, note) => ({
        index, id,
        args: `{"name":${JSON.stringify(name)},"note":${JSON.stringify(note)}}`,
      });
      const presentRound = async (calls) => {
        send({ tool_calls: calls.map(({ index, id }) => ({ index, id, type: "function", function: { name: "present" } })) });
        await sleep(5);
        for (const { index, args } of calls) {
          send({ tool_calls: [{ index, function: { arguments: args } }] });
        }
        send({}, "tool_calls");
        finish();
      };
      const last = body.messages?.[body.messages.length - 1];
      // 归并信按剧本回正文：空正文等于一个群都没并进去，覆盖水位不该抬（boom 那条在前置分支里给状态码）。
      if (system.includes("主人全局记忆")) {
        if (scripts.dream === "empty") { send({}, "stop"); finish(); return; }
        sayFast("全局记忆归并结果（哨标DREAMOUT）：跨群都成立的稳定事实与未办完的待办。");
        return;
      }
      // 压缩信按剧本回空正文：一条都没折进摘要，就不该把水位线抬上去（5xx 那条在前置分支里直接给状态码）。
      if (system.includes("压成不超过 600 字") && scripts.compress === "empty") { send({}, "stop"); finish(); return; }
      // slow：摘要一字一字慢慢吐，好让自检有机会在这封信正跑着的时候 @ 一次员工。
      if (system.includes("压成不超过 600 字") && scripts.compress === "slow") { await say("正在慢慢折这一段", 140); return; }
      // long：一次就吐满引擎那一侧的摘要上限（600 字），用来把某个群的摘要堆到够长。
      // 归并的输入预算压不到 2000 字以下，所以要撞预算只能让摘要本身长，不是把群开得更多。
      if (system.includes("压成不超过 600 字") && scripts.compress === "long") {
        sayFast("要点：跨群的稳定事实与还没办完的待办。".repeat(60));
        return;
      }
      // 排程那一轮的剧本（cronBlock 已在前面按槽位认出）：静默巡检只回空正文，其余一次说清。
      if (cronBlock) {
        if (cronBlock.includes("静默巡检")) { send({}, "stop"); finish(); return; }
        // 排程那一轮只交文件、正文留空：交付优先于静默，否则活干完了群里看不见（§27）。
        if (cronBlock.includes("交付巡检")) {
          if (body.tools?.length && !body.messages.some((m) => m.role === "tool")) {
            await presentRound([presentCall(0, "call_present_7", "排程巡检表.md", "巡检表按排程交出来")]);
            return;
          }
          send({}, "stop");
          finish();
          return;
        }
        sayFast("排程巡检：一切正常，无需同事动手。");
        return;
      }
      // 连续插话剧本：插话之后的重跑也保持慢，否则一轮就回完了，撞不到重跑上限。
      // 这条排在下面"插话重排"之前：重跑那一轮的上下文里同时带着半截提示和这条新的触发消息，
      // 先认提示会让它秒回，就再也掐不出第二次插话。
      if (trig.includes("慢慢改")) { await say("正在慢慢改这一版，一行一行来", 140); return; }
      if (system.includes("被 @ 你的新消息打断")) { sayFast("已按插话重排：一、准备；二、执行；三、复盘。"); return; }
      // 真人 @ 的那轮回空正文是失败（同事在等回答），和排程那一轮的"没事就不说话"是两种德性。
      if (trig.includes("空手回话")) { send({}, "stop"); finish(); return; }
      if (trig.includes("突发甲")) { sayFast("回甲已落群"); return; }
      if (trig.includes("突发乙")) { sayFast("回乙已落群"); return; }
      if (trig.includes("慢慢写")) { await say("正在慢慢写这段长正文", 140); return; }
      // 接龙剧本（§30）：回复正文里 @ 谁由测试现场给名字，改档案名不用动剧本。
      // 互点那一支挑「说话者之外那一个」，两个员工才接得起来，也才撞得到跳数上限。
      if (trig.includes("接下去")) {
        const names = scripts.chain ?? [];
        sayFast(`@${names.find((n) => n && n !== speakerOf(system)) ?? ""} 这段请接下去（哨标CHAIN）`);
        return;
      }
      // 自己接自己、@ 一个指定名字（真人 / 不在本群 / 已停用）：fanout 的三条分支各占一种。
      if (trig.includes("接给自己")) { sayFast(`@${speakerOf(system)} 我自己接（哨标CHAIN）`); return; }
      if (trig.includes("接给指定")) { sayFast(`@${scripts.chainPick ?? ""} 请看这段（哨标CHAIN）`); return; }
      // 按剧本换用量形状：同一个上游的三种回报德性，落库的空/有数要当场分出来。
      if (trig.includes("用量只报总数")) { usageMode = "bare"; sayFast("这轮的用量只有两个总数。"); return; }
      if (trig.includes("用量子桶越界")) { usageMode = "sketchy"; sayFast("这轮把缓存数报得比输入数还大。"); return; }
      if (trig.includes("用量完全不回")) { usageMode = "none"; sayFast("这轮末尾没有用量块。"); return; }
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
      // 交付物剧本：第一轮调 present 登记群文件，第二轮才成正文（§27）。
      if (body.tools?.length && !body.messages.some((m) => m.role === "tool") && trig.includes("交付台账")) {
        think("台账已经传上来了，标成交付物。");
        await presentRound([presentCall(0, "call_present_1", "交付台账.md", "按这份台账验收（哨标DELIVNOTE）")]);
        return;
      }
      if (trig.includes("交付台账")) { sayFast("台账交出去了，验收照它来。"); return; }
      // 同一件文件在一轮里交两遍：只该有一张卡片，后一次的说明盖掉前一次。
      if (body.tools?.length && !body.messages.some((m) => m.role === "tool") && trig.includes("交付两遍")) {
        await presentRound([
          presentCall(0, "call_present_2", "交付台账.md", "第一遍的口径"),
          presentCall(1, "call_present_3", "交付台账.md", "第二遍改了口径"),
        ]);
        return;
      }
      if (trig.includes("交付两遍")) { sayFast("两遍说的是同一份台账。"); return; }
      // 别的群才有的文件：本群的 present 找不到它，卡片也不该跨群挂过去。
      if (body.tools?.length && !body.messages.some((m) => m.role === "tool") && trig.includes("交付别群文件")) {
        await presentRound([presentCall(0, "call_present_4", "别群的秘密.md", "想把那个群的台账交过来")]);
        return;
      }
      if (trig.includes("交付别群文件")) { sayFast("那个文件不在本群，我没交。"); return; }
      // 只交文件、正文一个字不写：卡片照样是这一轮的结局。
      if (body.tools?.length && !body.messages.some((m) => m.role === "tool") && trig.includes("只交文件")) {
        await presentRound([presentCall(0, "call_present_5", "只交的清单.txt", "这一轮只交了文件")]);
        return;
      }
      if (trig.includes("只交文件")) { send({}, "stop"); finish(); return; }
      // 交付登记之后第二轮崩（状态码在前置分支里给）：这一轮没有回复，也就没有卡片。
      if (body.tools?.length && !body.messages.some((m) => m.role === "tool") && trig.includes("交付后崩")) {
        await presentRound([presentCall(0, "call_present_6", "交付后崩的台账.md", "交完就崩")]);
        return;
      }
      if (body.tools?.length) { sayFast("查到 3 条历史记录，已按时间排好。"); return; }
      sayFast("收到，我按上下文回应。");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        seen,
        scripts,
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

/**
 * 假 dedicated 档执行器：帧词表借云端那一套（event_delta / agent.message），路由挂在规范前缀下。
 * GET stream 先连上挂着，POST events 到了才往那条挂着的连接里写回复——runSessionTurn 的顺序是
 * 「先连流再发问」，反过来写夹具会让自检永远等不到增量。
 */
function startMockDedicated(token) {
  const requests = [];
  const state = {
    mode: "ok",
    text: "专属正文：这台 server 跑它自己的工具集。",
    reasoning: "专属思考链：我不进群。",
    sessions: 0,
    promptSeen: null,
    held: null,
    stallText: "静默前两句",
  };
  const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const path = new URL(req.url, "http://mock").pathname;
      const method = req.method;
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = { bad_json: true }; }
      requests.push({ method, path, body });
      res.on("error", () => {});
      const send = (payload) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
      const deny = (status, error) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error })); };
      if (req.headers.authorization !== `Bearer ${token}`) return deny(401, "stream_unauthorized");
      if (method === "GET" && path === "/stream-server/v1") {
        return send(specDescriptor({ profiles: ["dedicated"], models: ["ded-model"], label: "smoke dedicated" }));
      }
      if (method === "POST" && path === "/stream-server/v1/sessions") {
        state.sessions += 1;
        return send({ session_id: `sess_ded_${state.sessions}` });
      }
      if (method === "GET" && /^\/stream-server\/v1\/sessions\/sess_ded_[0-9]+\/events\/stream$/.test(path)) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        // node 只 writeHead 不发头：客户端要先看到响应头才会去 POST events，头卡在缓冲区里两边就互相等到超时。
        // 真实的专属执行器同理——规范里这条是硬要求，不是实现细节。
        res.flushHeaders();
        state.held = res;
        if (state.mode === "stall") {
          res.write(frame({ type: "event_delta", delta: { content: { type: "text", text: state.stallText } } }));
        }
        return;
      }
      const eventsPath = path.match(/^\/stream-server\/v1\/sessions\/(sess_ded_[0-9]+)\/events$/);
      if (method === "POST" && eventsPath) {
        const prompt = body?.events?.[0]?.content?.[0]?.text;
        if (typeof prompt !== "string") return deny(400, "stream_bad_request");
        state.promptSeen = { prompt, hasTools: body?.tools !== undefined, sessionId: eventsPath[1] };
        if (state.mode === "ok" && state.held && !state.held.writableEnded) {
          const held = state.held;
          state.held = null;
          held.write(frame({ type: "event_delta", delta: { content: { type: "text", text: state.text.slice(0, 4) } } }));
          held.write(frame({ type: "event_delta", delta: { content: { type: "text", text: state.text.slice(4) } } }));
          // 思考链与正文混在同一个 content 数组：只有 text 块允许进群（与云端那一档同口径）。
          held.write(frame({
            type: "agent.message",
            id: "evt_a_1",
            content: [{ type: "thinking", thinking: state.reasoning }, { type: "text", text: state.text }],
          }));
          held.end();
        }
        return send({ data: [{ id: "evt_u_1", type: "user.message" }] });
      }
      if (method === "POST" && /^\/stream-server\/v1\/sessions\/sess_ded_[0-9]+\/interrupt$/.test(path)) return send({ ok: true });
      // 路径在表里而方法不对：回 405 而不是 404。夹具要是把两者塌成一个码，考卷（dev/cts.mjs）量它时
      // 就会把「夹具的偷懒」记成「规范允许 404」，而供应商照夹具写实现就在真实世界里丢这条区分。
      const KNOWN_DEDICATED = [
        "/stream-server/v1/sessions",
        /^\/stream-server\/v1\/sessions\/sess_ded_[0-9]+\/events$/,
        /^\/stream-server\/v1\/sessions\/sess_ded_[0-9]+\/events\/stream$/,
        /^\/stream-server\/v1\/sessions\/sess_ded_[0-9]+\/interrupt$/,
      ];
      if (KNOWN_DEDICATED.some((entry) => (typeof entry === "string" ? path === entry : entry.test(path)))) {
        return deny(405, "stream_method_not_allowed");
      }
      return deny(404, "stream_endpoint_missing");
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

/**
 * 「断流」夹具：流只写一条增量就干净收尾——既没有 turn.done 也没有 [DONE]——但这一轮在服务器侧
 * 其实已经写完，GET 能取回权威结果。客户端的恢复路径（fetchTurn）认的是这份契约，
 * 不是我们参考实现的内部实现，所以这里单独造一台，不复用 functions/streamserver.mjs。
 */
function startCutServer(token, { withGet = true } = {}) {
  const FULL = "断流之后才取回的权威正文。";
  const turns = new Map();
  const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const path = new URL(req.url, "http://mock").pathname;
      const method = req.method;
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      res.on("error", () => {});
      const deny = (status, error, detail) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(detail === undefined ? { error } : { error, detail }));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return deny(401, "stream_unauthorized");
      if (method === "GET" && path === "/stream-server/v1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(specDescriptor({ profiles: ["shared"], models: ["cut-model"] })));
        return;
      }
      if (method === "POST" && path === "/stream-server/v1/turns") {
        const id = String(body?.turn_id ?? "");
        turns.set(id, {
          turn_id: id, state: "done", content: FULL, reasoning: "", tool_calls: [],
          usage: null, finish_reason: "stop", first_token_ms: 1,
        });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(frame({ type: "turn.delta", content: "半截连接", reasoning: "" }));
        res.end();
        return;
      }
      const get = path.match(/^\/stream-server\/v1\/turns\/([^/]+)$/);
      if (method === "GET" && get) {
        const entry = withGet ? turns.get(get[1]) : null;
        if (!entry) return deny(404, "stream_turn_not_found", get[1]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(entry));
        return;
      }
      return deny(404, "stream_endpoint_missing", path);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        get origin() { return `http://127.0.0.1:${server.address().port}`; },
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

/** 只认 OpenAI 兼容的 server：发现那条路回 404，客户端该把这个事实记成退回那一档，而不是每轮重猜。 */
function startPlainOpenai() {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const path = new URL(req.url, "http://mock").pathname;
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      requests.push({ method: req.method, path, body });
      res.on("error", () => {});
      if (req.method === "POST" && path === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(`data: ${JSON.stringify({ id: "plain", choices: [{ index: 0, delta: { content: "_plain_endpoint_ok" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "plain", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        get origin() { return `http://127.0.0.1:${server.address().port}`; },
        requests,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

/**
 * 上游收下请求、发了 SSE 响应头，然后一个字都不吐。用来钉「响应头必须立刻可见」：
 * 客户端的 fetch 是在收到响应头时才 resolve 的，执行器把头攒着等第一个字，上游一慢，
 * 客户端连读循环都进不去——叫停问不到，只能干等整轮超时。
 */
function startSilentUpstream() {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, path: new URL(req.url, "http://mock").pathname });
      res.on("error", () => {});
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.flushHeaders();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        get origin() { return `http://127.0.0.1:${server.address().port}`; },
        requests,
        // 挂着的响应永不收尾：不先掐连接，close 会一直等下去。
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}

/** 发现响应撒谎的 server：caps 与 profile 对不上，客户端该整条拒掉并按退回档记，而不是照谎言选路。 */
function startLyingSpec(descriptor) {
  const server = createServer((req, res) => {
    res.on("error", () => {});
    const path = new URL(req.url, "http://mock").pathname;
    if (req.method === "GET" && path === "/stream-server/v1") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(descriptor));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "stream_endpoint_missing", detail: path }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        get origin() { return `http://127.0.0.1:${server.address().port}`; },
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

  // 界面语言：服务端白名单（functions/locales.mjs）和前端清单（src/lib/i18n.ts）各存一份，
  // 因为 Edge Function 打包不了前端 TS；两份的 id 集合由 dev/check-schema.mjs 静态对账，
  // 这里证明的是另一头：后端收哪些值、存得下、读得回、被拒的那次不落库。
  // 循环特意跑满整份清单，包含还没译完的 ar/he —— 界面选不到，但账户里存得下，换到译完的版本就生效。
  for (const lang of LOCALE_IDS) {
    const saved = await call("auth.patch", { token: ana, body: { prefs: { lang } } });
    check(`账户存得下界面语言 ${lang}`, saved.payload.user?.prefs?.lang === lang, saved.payload);
  }
  const langMe = await call("auth.me", { token: ana, method: "GET" });
  check("语言偏好随会话读回（换设备登录后不用再选一次）", langMe.payload.user?.prefs?.lang === LOCALE_IDS[LOCALE_IDS.length - 1], langMe.payload.user);
  const langBad = await call("auth.patch", { token: ana, body: { prefs: { lang: "Klingon" } } });
  check("清单外的语言 id 就地被拒（存进去只会渲染成一句空白）", langBad.status === 400 && langBad.payload.error === "invalid_lang", langBad.payload);
  const langAfterBad = await call("auth.me", { token: ana, method: "GET" });
  check("被拒的那次没有改动已存的语言", langAfterBad.payload.user?.prefs?.lang === langMe.payload.user?.prefs?.lang, langAfterBad.payload.user?.prefs);
  await call("auth.patch", { token: ana, body: { prefs: { dreaming_auto: true } } });
  const langMerge = await call("auth.patch", { token: ana, body: { prefs: { lang: "zh-Hans" } } });
  check("只改语言不会顺手关掉归并开关（prefs 是合并写，不是整块覆盖）",
    langMerge.payload.user?.prefs?.lang === "zh-Hans" && langMerge.payload.user?.prefs?.dreaming_auto === true, langMerge.payload.user?.prefs);
  await call("auth.patch", { token: ana, body: { prefs: { dreaming_auto: false } } });

  step("2. 虚拟员工：独立 Key + OpenAI 兼容地址 + 两级 memory");
  const agent = await call("agents.create", {
    token: ana,
    body: {
      name: "小Q", role: "资料整理", backend: "openai", signature: "资料整理 · 先列清单再动手",
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
  // 凭据只有一个可读口径：掩码尾号。曾经挂过一个写死的 api_key_set: true——UI 没用它，
  // 但它长得像读数，谁都可能拿它当"密钥有效"的证据，所以把它连同恒等的外壳函数一起删了。
  check("员工资料里凭据只有尾号，没有冒充读数的旗标",
    agent.payload.agent?.api_key_tail === `••••${"demo-key-1234".slice(-4)}`
      && !("api_key_set" in (agent.payload.agent ?? {}))
      && !("api_key" in (agent.payload.agent ?? {}))
      && !("api_key_cipher" in (agent.payload.agent ?? {})), agent.payload.agent);
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
    body: { name: "临时", role: "试删", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-9999", model: "demo" },
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
  check("技能块自带出处：谁教的、哪一版，模型看得见也答得出",
    injected.startsWith("### WorkStream 平台技能（内置，随平台一起发）")
      && injected.includes("### 周报与进度同步（平台技能，未标版本）")
      && injected.includes("### 发布检查清单（本地上传，未标版本）"), injected.slice(0, 400));

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

  // 群文件目录树：建多级目录、放进子目录、同名拒绝、外链素材、移动整棵子树、删目录连子树。
  const mkdir = await call("files.mkdir", { token: ana, body: { stream_id: streamId, path: "art/ui" } });
  check("建多级目录（缺失的祖先一起建出来）", mkdir.payload.ok === true && mkdir.payload.path === "art/ui", mkdir.payload);
  const nested = await call("files.upload", {
    token: ana,
    body: { stream_id: streamId, path: "art/ui", name: "hero.png", content_type: "image/png", content: "not-a-real-png" },
  });
  check("文件落在子目录里（path 记父目录）", nested.payload.file?.path === "art/ui", nested.payload.file);
  const dup = await call("files.upload", {
    token: ana,
    body: { stream_id: streamId, path: "art/ui", name: "hero.png", content: "again" },
  });
  check("同一层同名被拒（file_path_exists）", dup.status === 409 && dup.payload.error === "file_path_exists", dup.payload);
  const traversal = await call("files.mkdir", { token: ana, body: { stream_id: streamId, path: "../escape" } });
  check("目录穿越被拒（invalid_file_path）", traversal.status === 400 && traversal.payload?.error === "invalid_file_path", traversal.payload);
  const link = await call("files.link", {
    token: ana,
    body: { stream_id: streamId, path: "art/ui", name: "trailer.mp4", url: "https://cdn.example.com/trailer.mp4", content_type: "video/mp4", size_bytes: 1048576 },
  });
  check("外链素材（视频）只存 URL", link.payload.file?.store === "link" && link.payload.file?.size_bytes === 1048576, link.payload.file);
  const linkGet = await call("files.get", { token: ana, method: "GET", body: { id: link.payload.file.id } });
  check("读外链素材拿到 URL 而不是正文", linkGet.payload.url === "https://cdn.example.com/trailer.mp4", linkGet.payload);
  const artDir = (await call("files.list", { token: ana, method: "GET", body: { stream_id: streamId } })).payload.items.find((row) => row.store === "dir" && row.name === "art");
  const moveDir = await call("files.move", { token: ana, body: { id: artDir.id, name: "assets" } });
  const afterMove = (await call("files.list", { token: ana, method: "GET", body: { stream_id: streamId } })).payload.items;
  check("移动目录把整棵子树的 path 一起改",
    moveDir.payload.ok === true
    && afterMove.some((row) => row.store === "dir" && row.path === "assets" && row.name === "ui")
    && afterMove.some((row) => row.path === "assets/ui" && row.name === "hero.png"),
    { moveDir: moveDir.payload, afterMove: afterMove.map((row) => `${row.path}/${row.name}`) });
  const removedDir = await call("files.delete", { token: ana, body: { id: artDir.id } });
  const afterTreeDelete = (await call("files.list", { token: ana, method: "GET", body: { stream_id: streamId } })).payload.items;
  check("删目录连同子树一起删",
    removedDir.payload.ok === true && !afterTreeDelete.some((row) => row.path === "art" || row.path === "assets" || row.path === "assets/ui"),
    { removedDir: removedDir.payload, afterDelete: afterTreeDelete.map((row) => `${row.path}/${row.name}`) });
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
  check("内置 DevStream 技能覆盖文件、交付与公告工具",
    ["list_files", "read_file", "upload_file", "delete_file", "present", "get_announcement", "set_announcement"]
      .every((name) => String(devSkill.body ?? "").includes(name)), devSkill);
  const skillList = await executeTool(db, scope, "list_skills", {});
  check("内置技能有两个（平台 + DevStream）",
    (skillList.skills ?? []).filter((item) => item.builtin).length === 2, skillList);
  const uploadedSkill = await executeTool(db, scope, "read_skill", { name: "发布检查清单" });
  check("工具回的技能带同一份出处，不跟上下文里的说法分叉",
    skillTool.origin === "内置，随平台一起发" && uploadedSkill.origin === "本地上传，未标版本"
      && (skillList.skills ?? []).every((item) => Boolean(item.origin)),
    { 内置: skillTool.origin, 上传: uploadedSkill.origin, 清单: skillList.skills?.map((item) => item.origin) });
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
      name: "小M", role: "流式联调", backend: "openai", api_base_url: `http://127.0.0.1:${mock.port}/v1`,
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

  // 连续插话：插话重跑有上限，撞上限时这一封和它吞掉的每一条 @ 都要有明确下文，群里没有悬空的未读。
  const sideStreamId = (await call("streams.create", {
    token: ana, body: { name: "隔壁组", agent_ids: [mockAgentId] },
  })).payload.stream?.id;
  const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  // 数落库的回复条数，不数 messages.list 返回的那一页：这一页有上限，多一条新回复可能正好挤掉一条旧的。
  const agentReplyCount = async () => (await db.messages.list(
    [["stream_id", streamId], ["sender_type", "agent"], ["sender_id", mockAgentId]], { columns: "id", limit: 900 },
  )).length;
  const chainSend = (content, to = streamId) => call("messages.send", {
    token: ana, body: { stream_id: to, content, mentions: [{ type: "agent", id: mockAgentId }] },
  });
  const x8bSeenFrom = mock.seen.length;
  const x8bFirst = await chainSend("@小M 慢慢改第一版");
  const x8bTick = call("scheduler.tick", { token: ana, method: "GET" });
  await pause(600);
  const x8bSide = await chainSend("@小M 隔壁群的事", sideStreamId);
  const x8bSecond = await chainSend("@小M 慢慢改第二版");
  await pause(700);
  const x8bThird = await chainSend("@小M 慢慢改第三版");
  await pause(700);
  const x8bFourth = await chainSend("@小M 慢慢改第四版");
  const x8bRan = await x8bTick;

  check("插话只掐本群：别的群里 @ 同一个员工是新任务，不打扰这边正在跑的",
    (x8bSide.payload.interrupted ?? []).length === 0 && (x8bSide.payload.queued ?? []).length === 1, x8bSide.payload);
  check("连着插到第三次不再重排：这一封按 cancelled/interrupted 收尾",
    (x8bRan.payload.ran ?? []).some((r) => r.status === "cancelled" && r.error === "interrupted"), x8bRan.payload);
  const x8bMails = async (messageId) => db.mail.list([["agent_id", mockAgentId], ["message_id", messageId]], {
    columns: "id,status,error,meta", limit: 10,
  });
  const x8bOrigin = await x8bMails(x8bFirst.payload.message?.id);
  check("被插话掐断的那封只有一条任务行，收尾是 cancelled",
    x8bOrigin.length === 1 && x8bOrigin[0].status === "cancelled" && x8bOrigin[0].error === "interrupted", x8bOrigin);
  const x8bAbsorbed = await Promise.all([x8bSecond, x8bThird, x8bFourth]
    .map(async (res) => ({ id: res.payload.message?.id, rows: await x8bMails(res.payload.message?.id) })));
  check("吞掉的每一条插话都补一条 cancelled 回执：群里不会一直显示未读",
    x8bAbsorbed.every(({ rows }) => rows.length === 1 && rows[0].status === "cancelled"
      && rows[0].error === "interrupted" && rows[0].meta?.receipt === "steer" && rows[0].meta?.from_mail === x8bOrigin[0]?.id),
    x8bAbsorbed);
  // 半截正文要能复原：重跑那一轮的系统提示里带着它，这是"模型可见的必须可复原"在插话路径上的落点。
  // 只数这一段窗口里的请求：前面那次单插话测试也留过重跑提示，全量数会把两件事算成一件事。
  const x8bSteerNotes = mock.seen.slice(x8bSeenFrom)
    .map((body) => String(body.messages?.[0]?.content ?? ""))
    .filter((system) => system.includes("上一条回复说到一半被 @ 你的新消息打断了"));
  check("第 3 次插话后不再重排：上游只接到两次带半截正文的重跑请求",
    x8bSteerNotes.length === 2
    && x8bSteerNotes.every((system) => system.includes("已输出的半截是："))
    && x8bSteerNotes.some((system) => system.includes("正在慢慢")),
    x8bSteerNotes.map((system) => system.slice(system.indexOf("上一条回复说到一半"), system.indexOf("请以这条插话为准") + 8)));
  check("掐断的半截正文不落群：这一节里没有一句以它开头的话",
    ((await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } })).payload.items ?? [])
      .filter((m) => m.sender_id === mockAgentId)
      .every((m) => !String(m.content).includes("慢慢改")),
    ((await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } })).payload.items ?? [])
      .filter((m) => m.sender_id === mockAgentId).map((m) => m.content));
  // 排空隔壁组那条新任务：留在队列里会被后面每一节的"最新一封信"看见，把调度顺序的问题伪装成产品缺陷。
  for (let round = 0; round < 6; round += 1) {
    const drained = await db.mail.list([["agent_id", mockAgentId], ["stream_id", sideStreamId]], {
      columns: "id,status", limit: 10,
    });
    if (drained.every((row) => row.status === "done" || row.status === "failed" || row.status === "cancelled")) break;
    await call("scheduler.tick", { token: ana, method: "GET" });
  }
  const x8bSideDone = await db.mail.list([["agent_id", mockAgentId], ["stream_id", sideStreamId]], {
    columns: "id,status,error", limit: 10,
  });
  check("对照：隔壁组那条不受这边掐断的影响，自己跑完了",
    x8bSideDone.length === 1 && x8bSideDone[0].status === "done", x8bSideDone);
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

  step("8c2. 压缩失败不许抬水位线：折不动的那批记录要还能再折");
  // 把预算压到装不下，让每一轮回复都补投一封后台压缩信，好反复触发压缩这一步。
  await call("agents.update", { token: ana, body: { id: mockAgentId, context_chars: 2000 } });
  for (const word of ["积压甲", "积压乙", "积压丙", "积压丁", "积压戊"]) {
    await call("messages.send", { token: ana, body: { stream_id: streamId, content: `凑一批旧记录 ${word}` } });
  }
  const runCompress = async (content, sid = streamId) => {
    await call("messages.send", {
      token: ana, body: { stream_id: sid, content, mentions: [{ type: "agent", id: mockAgentId }] },
    });
    for (let round = 0; round < 8; round += 1) {
      const tick = await call("scheduler.tick", { token: ana, method: "GET" });
      const hit = (tick.payload.ran ?? []).find((row) => row.mode === "compress" && row.stream_id === sid);
      if (hit) return hit;
    }
    return null;
  };
  const failNotes = async () => {
    const mem = await call("agents.memory.list", {
      token: ana, method: "GET", body: { agent_id: mockAgentId, scope: "stream", stream_id: streamId },
    });
    return (mem.payload.items ?? []).filter((row) => String(row.content).startsWith("后台压缩失败"));
  };
  const stuckAt = await readCovers();
  mock.scripts.compress = "boom";
  const boomRun = await runCompress("@小M 上游报错时的压缩");
  check("上游 5xx 折不动摘要：这封后台信如实结成失败", boomRun?.status === "failed", boomRun);
  check("失败不抬水位线：那批记录还留在窗口里，下一轮真能再折", (await readCovers()) === stuckAt, { stuckAt, now: await readCovers() });
  mock.scripts.compress = "empty";
  const emptyRun = await runCompress("@小M 空正文时的压缩");
  check("上游回空正文等于一条都没折：错误码如实报 summary_empty，水位线照旧不动",
    emptyRun?.status === "failed" && emptyRun?.error === "summary_empty" && (await readCovers()) === stuckAt, emptyRun);
  const notes = await failNotes();
  check("可见 note 只留最近一条：连错两轮不把本群记忆刷成错误日志",
    notes.length === 1 && String(notes[0].content).includes("还留在窗口里"), notes.map((row) => row.content));
  mock.scripts.compress = "ok";
  const okRun = await runCompress("@小M 恢复后的压缩");
  const moved = await readCovers();
  check("对照：上游正常后同一批记录真的折动了，水位线从原地推进",
    okRun?.status === "done" && moved > stuckAt, { okRun, stuckAt, moved });
  const okTraj = await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: okRun?.mail_id } });
  const foldDetail = (okTraj.payload.steps ?? []).find((row) => row.kind === "model")?.detail ?? {};
  check("折叠声称覆盖的序号区间进步骤：区间头一条正接上上次没折动的那条",
    Number(foldDetail.covers_from) === stuckAt + 1 && Number(foldDetail.covers_to) === moved, foldDetail);
  const seqs = new Set((await db.messages.list([["stream_id", streamId]], { columns: "seq", limit: 900 }))
    .map((row) => Number(row.seq)));
  const coveredSeqs = [];
  for (let value = Number(foldDetail.covers_from); value <= Number(foldDetail.covers_to); value += 1) coveredSeqs.push(value);
  check("对账：水位线声称吃掉的每一条都真的在群历史里，中间没有洞",
    coveredSeqs.length > 0 && coveredSeqs.every((value) => seqs.has(value)), { coveredSeqs, stuckAt, moved });

  step("8c3. 一条长贴不许饿死折叠：摘要读的是按行宽剪枝后的那一版");
  // 单独开一个群：水位线从 0 起，长贴就是它后面的第一条，正是修之前折不动的那个形状。
  // 入库上限是 8000 字节（中文按 3 字节计），所以夹具用 ASCII 的日志体才真能把一条顶到 7814 字；
  // 最小档预算那一批只有 4000 字——一条长贴就能把整批占满。
  const wide = await call("streams.create", { token: ana, body: { name: "长贴挡路组", agent_ids: [mockAgentId] } });
  const wideStreamId = wide.payload.stream?.id;
  const longBody = `现场日志开头 ${"x".repeat(7800)} 现场日志结尾`;
  const longSend = await call("messages.send", { token: ana, body: { stream_id: wideStreamId, content: longBody } });
  const longSeq = Number(longSend.payload.message?.seq ?? 0);
  check("先钉住夹具本身：一条 7814 字的长贴落得进库，没顶破 8000 字节上限",
    longSeq > 0 && longSend.payload.message?.content?.length === longBody.length,
    { status: longSend.status, error: longSend.payload.error, longSeq });
  for (const word of ["尾随甲", "尾随乙", "尾随丙", "尾随丁"]) {
    await call("messages.send", { token: ana, body: { stream_id: wideStreamId, content: `紧跟长贴 ${word}` } });
  }
  const wideCovers = async () => {
    const mem = await call("agents.memory.list", {
      token: ana, method: "GET", body: { agent_id: mockAgentId, scope: "stream", stream_id: wideStreamId },
    });
    return Number((mem.payload.items ?? []).find((m) => m.kind === "summary")?.covers_through_seq ?? 0);
  };
  const foldTranscripts = () => mock.seen
    .filter((body) => String(body.messages?.[0]?.content ?? "").includes("压成不超过 600 字"))
    .map((body) => String(body.messages?.[1]?.content ?? ""));
  const wideRun = await runCompress("@小M 长贴挡路时的压缩", wideStreamId);
  const wideMoved = await wideCovers();
  check("长贴挡在水位线第一条也不再饿死折叠：这一轮真的折动了",
    wideRun?.status === "done" && wideMoved > 0, { wideRun, wideMoved });
  // 按长贴正文认这一批：序号每群各自排，别的群里也有 #2，只有正文不会撞。
  const foldText = foldTranscripts().find((t) => t.includes("现场日志开头")) ?? "";
  check("摘要读的是剪枝后的那一版：长贴行尾带上写清原文字数与取回序号的标记",
    foldText.includes(`全文按 #${longSeq} 取回`) && foldText.includes("截断"), foldText.slice(0, 160));
  check("剪完按行宽收口：喂给摘要的每一行都不超 1000 字（这批 4000 字均分给最少 4 条）",
    foldText.split("\n").length > 1 && foldText.split("\n").every((line) => line.length <= 1000),
    foldText.split("\n").map((line) => line.length));
  const longRow = await db.messages.byId(longSend.payload.message?.id);
  check("群里的原文一条没少：剪的只是摘要输入，按序号还能取回全文",
    String(longRow?.content ?? "").length === longBody.length, { stored: String(longRow?.content ?? "").length });
  const wideTraj = await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: wideRun?.mail_id } });
  const wideDetail = (wideTraj.payload.steps ?? []).find((row) => row.kind === "model")?.detail ?? {};
  check("折叠那一步如实报剪了几条与行宽：摘要不是全文这件事在轨迹里看得见",
    /条超过 1000 字行宽/.test(String(wideDetail.note ?? "")), wideDetail);
  // 对照：正常长度的一批照常折，不带截断标记——剪枝不是无条件开刀。
  const sinceFold = mock.seen.length;
  for (const word of ["短贴甲", "短贴乙", "短贴丙", "短贴丁", "短贴戊"]) {
    await call("messages.send", { token: ana, body: { stream_id: wideStreamId, content: `正常长度 ${word}` } });
  }
  const ctrlRun = await runCompress("@小M 短贴对照时的压缩", wideStreamId);
  const ctrlTexts = mock.seen.slice(sinceFold)
    .filter((body) => String(body.messages?.[0]?.content ?? "").includes("压成不超过 600 字"))
    .map((body) => String(body.messages?.[1]?.content ?? ""));
  check("对照：正常长度的批次一条都不截",
    ctrlRun?.status === "done" && ctrlTexts.length > 0 && ctrlTexts.every((t) => t.includes("#") && !t.includes("截断")),
    { ctrlRun, sample: ctrlTexts[0]?.slice(0, 160) });
  await call("agents.update", { token: ana, body: { id: mockAgentId, context_chars: 8000 } });

  step("8c4. 后台折叠那一轮不吃插话：@ 照常排队，叫停如实说掐不动");
  // 折叠与归并是一次性提问、一个字不进群，也就从来不看 meta.interrupt。
  // 把落在这类信上的 @ 登记成"已被这轮消化"，这条消息既没有任务行也等不到回执，等于被静静吞掉。
  const foldRunning = async () => (await db.mail.list(
    [["agent_id", mockAgentId], ["stream_id", streamId], ["status", "running"]],
    { columns: "id,meta", limit: 10 },
  )).find((row) => row.meta?.kind === "compress") ?? null;
  await call("agents.update", { token: ana, body: { id: mockAgentId, context_chars: 2000 } });
  const coversBeforeFold = await readCovers();
  const repliesBeforeFold = await agentReplyCount();
  await call("messages.send", {
    token: ana, body: { stream_id: streamId, content: "@小M 先把积压折一下", mentions: [{ type: "agent", id: mockAgentId }] },
  });
  mock.scripts.compress = "slow";
  let foldMail = null;
  for (let round = 0; round < 8 && !foldMail; round += 1) {
    const tick = call("scheduler.tick", { token: ana, method: "GET" });
    await pause(200);
    foldMail = await foldRunning();
    if (foldMail) break;
    await tick;
  }
  check("夹具：这一封后台压缩信确实在跑（摘要正一字一字吐出来）", Boolean(foldMail), foldMail);
  const foldSteer = await call("messages.send", {
    token: ana, body: { stream_id: streamId, content: "@小M 折的时候插一句", mentions: [{ type: "agent", id: mockAgentId }] },
  });
  check("折叠期间一条 @ 不算插话：它照常排成一条新任务，等折叠让出这一群",
    (foldSteer.payload.interrupted ?? []).length === 0 && (foldSteer.payload.queued ?? []).length === 1, foldSteer.payload);
  const foldStop = await call("scheduler.interrupt", { token: ana, body: { stream_id: streamId, agent_id: mockAgentId } });
  check("叫停落在掐不动的那一轮：如实报没在跑，不假装掐断了",
    foldStop.status === 409 && foldStop.payload.error === "nothing_running", foldStop.payload);
  mock.scripts.compress = "ok";
  const foldInsertMailId = foldSteer.payload.queued?.[0]?.mail_id;
  // 紧接着两条断言分别读插话那封和压缩那封，所以两封都得等到终态再 break。
  // 只等插话那封：刚才故意放慢的压缩信可能还在跑，第二条断言就随机翻红（把时序抖动伪装成产品缺陷）。
  const foldTerminal = (s) => s === "done" || s === "failed" || s === "cancelled";
  for (let round = 0; round < 12; round += 1) {
    const insertStatus = (await db.mail.byId(foldInsertMailId, { columns: "id,status" }))?.status;
    const compressStatus = (await db.mail.byId(foldMail?.id, { columns: "id,status" }))?.status;
    if (foldTerminal(insertStatus) && foldTerminal(compressStatus)) break;
    await call("scheduler.tick", { token: ana, method: "GET" });
  }
  const foldInsertMail = await db.mail.byId(foldInsertMailId, { columns: "id,status,error" });
  const foldMailRow = await db.mail.byId(foldMail?.id, { columns: "id,status,error" });
  check("对照：那条 @ 没被折叠轮吞掉，自己排队跑完并回了正文",
    foldInsertMail?.status === "done" && (await agentReplyCount()) > repliesBeforeFold,
    { foldInsertMail, 回复数: [repliesBeforeFold, await agentReplyCount()] });
  check("折叠那一轮不受打扰：压缩信照样跑完，水位线照样往前推",
    foldMailRow?.status === "done" && (await readCovers()) > coversBeforeFold,
    { foldMailRow, coversBeforeFold, now: await readCovers() });
  // 预算压到 2000 才逼得出正在跑的折叠轮，代价是每一轮回复都补投一封压缩信。
  // 不把这份 backlog 排空就交给 8d/§20，那边的"最新一封信"会取到后台压缩信，把调度顺序的问题伪装成产品缺陷。
  await call("agents.update", { token: ana, body: { id: mockAgentId, context_chars: 8000 } });
  for (let round = 0; round < 12; round += 1) {
    const pending = await db.mail.list(
      [["agent_id", mockAgentId], ["status", ["queued", "running"]]],
      { columns: "id", limit: 20 },
    );
    if (pending.length === 0) break;
    await call("scheduler.tick", { token: ana, method: "GET" });
  }

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
    backend: backendFor({ backend: "openai" }),
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
  const clouded = composeSystemPrompt({ ...slotCtx, agent: { ...slotCtx.agent, backend: "qca" }, backend: backendFor({ backend: "qca" }) });
  check("云端通道只多一块云端须知、只换这两处措辞，其余块和它们的顺序照旧",
    clouded.promptSlots.map(([id]) => id).filter((id) => id !== "backend.tools").join(",")
      === composed.promptSlots.map(([id]) => id).join(",")
    && clouded.system.includes("本次由云端 Agent 作答")
    && clouded.system.includes("由 WorkStream 侧补给你")
    && !clouded.system.includes("需要时用 set_signature 更新"),
    { 云端槽位: clouded.promptSlots.map(([id]) => id) });
  check("对照：自建端点那一份仍然是本地措辞（不是所有员工都被当成云端）",
    composed.system.includes("调用 search_history / read_window 工具")
    && composed.system.includes("需要时用 set_signature 更新")
    && !composed.system.includes("本次由云端 Agent 作答"), {});
  step("8d3. 后端清单：这条通道吃不吃工具是字段，不是注释");
  check("五条通道的能力位都在表上，只有不吃工具的那两条带措辞",
    BACKENDS.map((entry) => entry.id).join(",") === "openai,demo,qca,stream,stream-dedicated"
    && BACKENDS.every((entry) => typeof entry.caps.tools === "boolean")
    && BACKENDS.filter((entry) => !entry.caps.tools).map((entry) => entry.id).join(",") === "qca,stream-dedicated"
    && BACKENDS.every((entry) => entry.caps.tools || Boolean(entry.noToolsNotice)),
    BACKENDS.map((entry) => ({ id: entry.id, transport: entry.transport, tools: entry.caps.tools })));
  const badTables = [
    { 坏在哪: "id 重复（后一条会静默覆盖前一条）", entries: [...BACKENDS, { ...BACKENDS[0] }] },
    { 坏在哪: "不吃工具却没给提示词措辞", entries: BACKENDS.map((entry) => (entry.caps.tools ? entry : { ...entry, noToolsNotice: "" })) },
    { 坏在哪: "没声明 caps.tools", entries: BACKENDS.map((entry) => (entry.id === "demo" ? { ...entry, caps: {} } : entry)) },
    { 坏在哪: "backend 列能写的 id 不在表里", entries: BACKENDS.filter((entry) => entry.id !== "openai") },
  ];
  check("坏表就地抛，不留到运行时选错分支",
    badTables.every((item) => {
      try {
        validateBackends(item.entries);
        return false;
      } catch {
        return true;
      }
    }), badTables.map((item) => item.坏在哪));
  check("对照：清单本身过得了同一套校验（不是校验写坏了）", (() => {
    try {
      validateBackends(BACKENDS);
      return true;
    } catch {
      return false;
    }
  })(), BACKEND_IDS);
  // 规范对接那条通道有两副面孔，选哪一副由发现结果（agents.stream_profile）决定、不由地址决定：
  // 分时档吃工具（我们的群工具整个发过去），专属档用它自己的工具集（措辞要说清调不到）。
  const STREAM_ROWS = [
    { backend: "stream", api_base_url: "https://worker.example.com", stream_profile: "shared", expect: "stream", tools: true },
    { backend: "stream", api_base_url: "https://worker.example.com", stream_profile: "openai", expect: "stream", tools: true },
    { backend: "stream", api_base_url: "https://worker.example.com", stream_profile: "dedicated", expect: "stream-dedicated", tools: false },
    // 演示地址在这一档不认：建档/改档就拒了这种组合（stream_needs_real_origin）；
    // 真出现了也按发现结果走，不悄悄退回内置演示模型。
    { backend: "stream", api_base_url: DEMO_BASE_URL, stream_profile: "shared", expect: "stream", tools: true },
  ];
  check("员工档案 → 通道：列分自建/云端/规范对接，演示那条从地址认，规范对接那条再看发现结果；空档按自建算",
    backendFor({}).id === "openai"
    && backendFor({ backend: "openai", api_base_url: "https://api.example.com/v1" }).id === "openai"
    && backendFor({ backend: "openai", api_base_url: DEMO_BASE_URL }).id === "demo"
    && backendFor({ backend: "qca", api_base_url: DEMO_BASE_URL }).id === "qca"
    && backendFor({ backend: "qca", api_base_url: "https://qoder.cn" }).transport === "cloud"
    && STREAM_ROWS.every((row) => backendFor(row).id === row.expect && backendFor(row).caps.tools === row.tools),
    [...[{}, { backend: "openai", api_base_url: "https://api.example.com/v1" }, { backend: "openai", api_base_url: DEMO_BASE_URL }, { backend: "qca", api_base_url: DEMO_BASE_URL }]
      .map((row) => backendFor(row).id), ...STREAM_ROWS.map((row) => `${row.stream_profile}→${backendFor(row).id}`)]);
  // 对照上面那四行放行：档位空着或写着表外的值就地抛。这一格决定提示词措辞与工具注入，
  // 猜错的那一档会让专属员工得到一句"你有这些工具"的措辞，而工具一个也发不出去。
  const profileless = [null, undefined, "shared ", "dedicate", "openai-compatible"].map((profile) => {
    try {
      return backendFor({ backend: "stream", api_base_url: "https://worker.example.com", stream_profile: profile }).id;
    } catch (error) {
      return error.code;
    }
  });
  check("规范对接那一档没问过就上岗（或问出来一个表外的值）就地抛，不静默按某一档拼措辞",
    profileless.every((code) => code === "stream_profile_unknown"), profileless);
  let unknownBackend = null;
  try {
    backendFor({ backend: "claude" });
  } catch (error) {
    unknownBackend = error;
  }
  check("列里出现清单没有的值就地抛，不静默按自建处理", unknownBackend?.code === "unknown_backend", unknownBackend?.code);
  const demoComposed = composeSystemPrompt({ ...slotCtx, backend: backendFor({ backend: "openai", api_base_url: DEMO_BASE_URL }) });
  check("演示通道吃工具：它拿的是本地那一套措辞（能力位不是按地址划的）",
    demoComposed.promptSlots.map(([id]) => id).join(",") === composed.promptSlots.map(([id]) => id).join(",")
    && demoComposed.system.includes("按需调用对应工具") && !demoComposed.system.includes("本次由云端 Agent 作答"),
    demoComposed.promptSlots.map(([id]) => id));
  const ownedSlots = composeSystemPrompt({
    ...slotCtx,
    prepared: { ...slotCtx.prepared, owner: "跨群结论：甲那边数字是 3（哨标DREAMBLOCK）" },
  });
  check("全局记忆落在稳定档：它进的是可复用的前缀，缓存断点不许被它提前",
    ownedSlots.promptSlots.map(([id]) => id).join(",")
      === "identity,signature,guide,announcement,skills,history.access,memory.owner,memory.common,summary,transcript,memory.stream,trigger"
    && PROMPT_SECTIONS.find((section) => section.id === "memory.owner")?.volatile === false
    && CACHE_BREAKPOINT_ID === "memory.common",
    { 槽位: ownedSlots.promptSlots.map(([id]) => id) });
  step("8d4. 转录行：渲染与反解析同源，演示摘录按读者语言重排");
  const transcriptRows = [
    { seq: 3, kind: "message", sender_type: "human", sender_name: "张三", content: "看下这个报错" },
    { seq: 4, kind: "message", sender_type: "agent", sender_name: "小M", content: "收到，我先复现" },
    { seq: 5, kind: "system", sender_type: "system", sender_name: "系统", content: "张三上传了文件" },
    { seq: 6, kind: "message", sender_type: "human", sender_name: "李四", content: "两张截图", attachments: [{}, {}] },
  ];
  const transcriptText = renderTranscript(transcriptRows);
  const parsedRows = parseTranscript(transcriptText);
  check("反解析把行首记号、类型、名字、正文与附图数都无损带回来",
    parsedRows.length === transcriptRows.length
    && parsedRows.every((row, index) => row.marker === (transcriptRows[index].kind === "system" ? "·" : "#")
      && row.seq === transcriptRows[index].seq
      && row.sender === transcriptRows[index].sender_name
      && row.body === transcriptRows[index].content
      && row.images === (transcriptRows[index].attachments?.length ?? 0)),
    parsedRows);
  check("中文重排逐字等于模型看到的那一行（行格式只有一份，不是第二套写法）",
    parsedRows.every((row, index) => demoCopy("zh").line(row) === transcriptText.split("\n")[index]),
    parsedRows.map((row) => demoCopy("zh").line(row)));
  const enLines = parsedRows.map((row) => demoCopy("en").line(row));
  check("英文重排：[human]/[virtual]/[system] 标签与半角冒号，图片数分单复数",
    enLines[0] === "#3 [human] 张三: 看下这个报错"
    && enLines[1] === "#4 [virtual] 小M: 收到，我先复现"
    && enLines[2] === "·5 [system] 系统: 张三上传了文件"
    && enLines[3] === "#6 [human] 李四: 两张截图 (2 images)",
    enLines);
  check("英文重排的格式里不再有中文标签（名字与正文是数据，标签才是要翻的那一层）",
    enLines.every((line) => !/\[(人|虚拟|系统)\]/.test(line)), enLines);
  check("读侧兜底名两种语言各一套，中文那套仍是界面上原有的句子",
    systemCopy("zh").streamDeleted() === "已删除的群" && systemCopy("en").streamDeleted() === "Deleted group"
    && systemCopy("zh").userDeleted() === "已注销用户" && systemCopy("en").userDeleted() === "Deactivated user"
    && systemCopy("zh").agentDeleted() === "已删除的虚拟员工" && systemCopy("en").agentDeleted() === "Deleted virtual employee"
    && systemCopy("zh").vmDeleted() === "已删除的虚拟机" && systemCopy("en").vmDeleted() === "Deleted VM"
    && systemCopy("zh").unknownUploader() === "未知" && systemCopy("en").unknownUploader() === "Unknown",
    { zh: systemCopy("zh").streamDeleted(), en: systemCopy("en").streamDeleted() });
  // 摘录只取窗口里的真人发言：虚拟员工自己的回帖是多行的，里面还引着上一轮摘录的转录行与记忆行。
  // 按正文扫行会把这些二次转述当成新事实（回帖复读上一条回帖），内部提示块也会一起被念进群。
  const demoWindow = [
    { seq: 3, sender_type: "human", sender_name: "张三", content: "看下这个报错" },
    { seq: 4, sender_type: "agent", sender_name: "小审", content: "上一条摘录：\n#9 [人] 赵六：旧结论\n- 旧记忆里的结论" },
    { seq: 5, sender_type: "human", sender_name: "李四", content: "两张截图", attachments: [{}, {}] },
    { seq: 7, sender_type: "human", sender_name: "王五", content: "先看日志" },
  ];
  const demoAgent = { owner_id: "u-demo", name: "小审", backend: "openai", api_base_url: DEMO_BASE_URL, model: "demo" };
  const demoReply = async (lang) => (await completeForAgent({
    db: { users: { byId: async () => ({ id: "u-demo", prefs: { lang } }) } },
    agent: demoAgent,
    messages: [{ role: "user", content: "请按上面的上下文回应这条任务。" }],
    window: demoWindow,
  })).content;
  const zhDemo = await demoReply("zh-Hans");
  check("演示摘录只取窗口里的真人发言：回帖里二次转述的转录行与记忆行不再被当成事实",
    zhDemo.includes("#3 [人] 张三：看下这个报错")
    && zhDemo.includes("#5 [人] 李四：两张截图（附 2 图）")
    && zhDemo.includes("#7 [人] 王五：先看日志")
    && !zhDemo.includes("旧结论") && !zhDemo.includes("旧记忆") && !zhDemo.includes("上一条摘录"),
    zhDemo);
  const enDemo = await demoReply("en");
  check("对照：英文界面下的摘录同样只取真人发言，行内标签全是英文",
    enDemo.includes("#3 [human] 张三: 看下这个报错")
    && enDemo.includes("#5 [human] 李四: 两张截图 (2 images)")
    && !/\[(人|虚拟|系统)\]/.test(enDemo) && !enDemo.includes("旧结论"),
    enDemo);

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
  await call("auth.patch", { token: deeToken, body: { prefs: { lang: "en" } } });
  const x13OrphanEn = await call("streams.invites.mine", { token: deeToken });
  check("对照：同一个兜底名按读者语言给（界面停在 en 时读 Deleted group）", (x13OrphanEn.payload.items ?? [])
    .some((row) => row.stream_name === "Deleted group"), x13OrphanEn.payload);
  await call("auth.patch", { token: deeToken, body: { prefs: { lang: "zh-Hans" } } });

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
  // 终端网关是真人浏览器直连的地址，明文入库：形状错了当场炸，URL 里塞凭据一律拒。
  const x17Gw = await call("vms.update", { token: bToken, body: { id: boVmId, gateway_url: "wss://bo.internal.example:7681/" } });
  check("vms.update：主人能填终端网关地址，尾斜杠归一化", x17Gw.payload.vm?.gateway_url === "wss://bo.internal.example:7681", x17Gw.payload);
  const x17GwCross = await call("vms.update", { token: ana, body: { id: boVmId, gateway_url: "wss://build.internal.example:7681" } });
  check("vms.update：别人改不了我的网关地址", x17GwCross.status === 403 && x17GwCross.payload.error === "vm_not_owned", x17GwCross.payload);
  const x17GwCreate = await call("vms.create", {
    token: bToken,
    body: { label: "带网关的机器", host: "gw.example", port: 22, username: "u", auth_kind: "password", secret: "s3cret-long", gateway_url: "ws://gw.example:7681/" },
  });
  check("vms.create：登记时就能带上网关地址，尾斜杠同样归一化", x17GwCreate.payload.vm?.gateway_url === "ws://gw.example:7681", x17GwCreate.payload);
  await call("vms.delete", { token: bToken, body: { id: x17GwCreate.payload.vm?.id } });
  const x17GwScheme = await call("vms.create", {
    token: bToken,
    body: { label: "x", host: "a.example", port: 22, username: "u", auth_kind: "password", secret: "s3cret-long", gateway_url: "ssh://a.example:7681" },
  });
  check("vms.create：非 ws/wss/http/https 的网关地址被拒", x17GwScheme.status === 400 && x17GwScheme.payload.error === "invalid_gateway_url", x17GwScheme.payload);
  const x17GwUnparse = await call("vms.update", { token: bToken, body: { id: boVmId, gateway_url: "not a url" } });
  check("vms.update：解析不出来的网关地址被拒", x17GwUnparse.status === 400 && x17GwUnparse.payload.error === "invalid_gateway_url", x17GwUnparse.payload);
  const x17GwCred = await call("vms.update", { token: bToken, body: { id: boVmId, gateway_url: "ws://tok:pw@bo.internal.example:7681" } });
  check("vms.update：网关地址带凭据被拒（明文列里不许抄口令）", x17GwCred.status === 400 && x17GwCred.payload.error === "gateway_url_no_credentials", x17GwCred.payload);
  const x17GwQuery = await call("vms.update", { token: bToken, body: { id: boVmId, gateway_url: "ws://bo.internal.example:7681?token=abc" } });
  check("vms.update：网关地址带查询串同样被拒", x17GwQuery.status === 400 && x17GwQuery.payload.error === "gateway_url_no_credentials", x17GwQuery.payload);
  const x17GwUnchanged = await call("vms.update", { token: bToken, body: { id: boVmId, label: "Bo 的构建机" } });
  check("vms.update：不带 gateway_url 时不会把已填的地址抹掉",
    x17GwUnchanged.payload.vm?.gateway_url === "wss://bo.internal.example:7681", x17GwUnchanged.payload);
  const x17ProbeGw = await call("vms.probe", { token: bToken, body: { id: boVmId } });
  check("vms.probe：填了网关的机器把网关单独探一次，探不通也如实说",
    x17ProbeGw.payload.probe?.gateway?.reachable === false && typeof x17ProbeGw.payload.probe.gateway.note === "string", x17ProbeGw.payload);
  // 内网网关在两种形态下的结论必须不同：本机放行私网所以真去探（探不通就说探不通），
  // 生产形态被 SSRF 闸门挡下，这时只能回 null 并说清"服务端不探它"，不能冒充可达也不能冒充坏了。
  const x17GwPrivate = await call("vms.update", { token: bToken, body: { id: boVmId, gateway_url: "ws://10.0.0.9:7681" } });
  check("vms.update：内网网关地址照收（真人浏览器连的就是内网）", x17GwPrivate.payload.vm?.gateway_url === "ws://10.0.0.9:7681", x17GwPrivate.payload);
  const x17ProbePrivate = await call("vms.probe", { token: bToken, body: { id: boVmId }, entry: prodHandler });
  check("vms.probe：生产形态不探内网网关，回 null 并说明原因",
    x17ProbePrivate.payload.probe?.gateway?.reachable === null && typeof x17ProbePrivate.payload.probe.gateway.note === "string", x17ProbePrivate.payload);
  const x17ProbePrivateDev = await call("vms.probe", { token: bToken, body: { id: boVmId } });
  check("vms.probe：本机形态放行私网，同一地址探不到就如实说探不到",
    x17ProbePrivateDev.payload.probe?.gateway?.reachable === false, x17ProbePrivateDev.payload);
  const x17GwClear = await call("vms.update", { token: bToken, body: { id: boVmId, gateway_url: "" } });
  check("vms.update：清空网关地址回到点不开的状态", x17GwClear.payload.vm?.gateway_url === "", x17GwClear.payload);
  const x17ProbeNoGw = await call("vms.probe", { token: bToken, body: { id: boVmId } });
  check("vms.probe：没填网关的机器不附网关结论", x17ProbeNoGw.payload.probe?.gateway === undefined, x17ProbeNoGw.payload);
  await call("vms.update", { token: bToken, body: { id: boVmId, gateway_url: "ws://bo.internal.example:7681" } });
  const x17BoList = await call("vms.list", { token: bToken });
  check("vms.list：只列自己的机器且不返回密文",
    (x17BoList.payload.items ?? []).length === 1 && (x17BoList.payload.items ?? [])[0]?.id === boVmId
    && !JSON.stringify(x17BoList.payload).includes("bo-secret") && !JSON.stringify(x17BoList.payload).includes("s3cret")
    && !("secret_cipher" in ((x17BoList.payload.items ?? [])[0] ?? {})), x17BoList.payload);
  check("vms.list：网关地址要能读回来，否则列表分不出哪台点得开",
    (x17BoList.payload.items ?? [])[0]?.gateway_url === "ws://bo.internal.example:7681", x17BoList.payload);
  const x17AnaList = await call("vms.list", { token: ana });
  check("vms.list：Ana 的授权清单里能看到已授权的机器",
    (x17AnaList.payload.items ?? []).some((row) => row.id === vm.payload.vm?.id
      && (row.granted_to ?? []).some((g) => g.stream_id === streamId)), x17AnaList.payload);
  const x17GrantByBo = await call("streams.vms.grant", { token: bToken, body: { stream_id: streamId, vm_id: boVmId, level: "sudo" } });
  check("streams.vms.grant：管理员把自有机器授权进群", Boolean(x17GrantByBo.payload.grant_id), x17GrantByBo.payload);
  const x17MineBo = await call("streams.mine.vms", { token: bToken, method: "GET", body: { stream_id: streamId } });
  check("streams.mine.vms：成员能看到本群授权并带上级别与机器资料",
    (x17MineBo.payload.items ?? []).some((row) => row.vm_id === boVmId && row.level === "sudo" && row.vm?.label === "Bo 的构建机"), x17MineBo.payload);
  check("streams.mine.vms：机器资料带着网关地址（群设置抽屉据此决定行点不点得开）",
    (x17MineBo.payload.items ?? []).some((row) => row.vm_id === boVmId && row.vm?.gateway_url === "ws://bo.internal.example:7681"), x17MineBo.payload);
  const x17MineStranger = await call("streams.mine.vms", { token: deeToken, method: "GET", body: { stream_id: streamId } });
  check("streams.mine.vms：非成员看不到本群机器", x17MineStranger.status === 403, x17MineStranger.payload);
  const x17DetailGw = await call("streams.get", { token: ana, method: "GET", body: { id: streamId } });
  check("streams.get：群详情的机器行带着网关地址，聊天窗据此决定开不开控制台",
    (x17DetailGw.payload.vms ?? []).some((row) => row.id === boVmId && row.gateway_url === "ws://bo.internal.example:7681"), x17DetailGw.payload.vms);
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
  // 默认位是"建档时自动装"那一侧的开关，所以两个方向都要新建一个员工来看：只验会装、不验会不装，
  // 撤标记写错成 no-op 也照样全绿。
  const x18OnAgent = await call("agents.create", {
    token: ana, body: { name: "默认在岗", role: "对照", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-18", model: "demo" },
  });
  check("默认位开着：主人新建的员工自动装上它",
    (await call("skills.installed", { token: ana, method: "GET", body: { agent_id: x18OnAgent.payload.agent?.id } })).payload.items
      ?.some((row) => row.id === x18DefaultId), x18OnAgent.payload);
  const x18DefaultOff = await call("skills.setDefault", { token: bToken, body: { skill_id: x18DefaultId, is_default: true } });
  check("skills.setDefault：别人改不了你的默认标记", x18DefaultOff.status === 403
    && x18DefaultOff.payload.error === "skill_forbidden", x18DefaultOff.payload);
  const x18DefaultUnset = await call("skills.setDefault", { token: ana, body: { skill_id: x18DefaultId, is_default: false } });
  check("skills.setDefault：主人能把默认取消掉", x18DefaultUnset.payload.skill?.is_default === false, x18DefaultUnset.payload);
  const x18OffAgent = await call("agents.create", {
    token: ana, body: { name: "默认撤位", role: "对照", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-19", model: "demo" },
  });
  check("对照：默认位撤掉后新建的员工不再自动装它（撤标记真的写进了那一行）",
    (await call("skills.installed", { token: ana, method: "GET", body: { agent_id: x18OffAgent.payload.agent?.id } })).payload.items
      ?.every((row) => row.id !== x18DefaultId), x18OffAgent.payload);
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
  check("装完模型上下文里读得到它：技能块真的进了这一轮装配",
    (await skillPrompt(store(supabase), mockAgentId)).includes("Ana 的私有手册"),
    (await skillPrompt(store(supabase), mockAgentId)).slice(0, 400));
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
  // 列表里没有只说明"界面看不见了"；真正要的是模型那一侧也读不到，以及关联行没有留在库里等下一次装配捡回来。
  const x18PromptOff = await skillPrompt(store(supabase), mockAgentId);
  check("卸载后模型上下文里读不到它：技能块不再进任何一轮请求体",
    !x18PromptOff.includes("Ana 的私有手册"), x18PromptOff.slice(0, 400));
  const x18LinkRows = await db.agent_skills.list([["agent_id", mockAgentId], ["skill_id", privSkillId]], {
    columns: "id", limit: 10,
  });
  check("关联行删干净：不留一条指向已卸技能的幽灵行", x18LinkRows.length === 0, x18LinkRows);
  check("卸载只摘关联，技能本体还留在主人的市场里",
    (await call("skills.market", { token: ana, method: "GET" })).payload.items?.some((row) => row.id === privSkillId));
  const x18UninstallAgain = await call("skills.uninstall", { token: ana, body: { agent_id: mockAgentId, skill_id: privSkillId } });
  check("重复卸载给 404 skill_not_installed", x18UninstallAgain.status === 404
    && x18UninstallAgain.payload.error === "skill_not_installed", x18UninstallAgain.payload);
  const x18Reinstall = await call("skills.install", { token: ana, body: { skill_id: privSkillId, agent_id: mockAgentId } });
  check("对照：卸掉的技能重新装回来，上下文又读得到（卸载不是把技能拉黑）",
    x18Reinstall.payload.installed === true
      && (await skillPrompt(store(supabase), mockAgentId)).includes("Ana 的私有手册"), x18Reinstall.payload);
  await call("skills.uninstall", { token: ana, body: { agent_id: mockAgentId, skill_id: privSkillId } });
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
  check("员工回路里没命中的工具名报 connector_tool_unmatched", x19Unknown.error === "connector_tool_unmatched", x19Unknown);

  const x19FreshAgent = await call("agents.create", {
    token: ana,
    body: { name: "小N", role: "外接", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-n", model: "demo" },
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
    body: { name: "Bo的助理", role: "外接", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-bo", model: "demo" },
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
  // 一次 tick 不一定就跑到这封：前面可能还压着上一节没排空的信。等到这封落终态为止（最多 8 次），
  // 否则调用方按关键词翻回复会翻到旧的那一条，把调度顺序的问题伪装成产品缺陷。
  const sendFor = async (content) => {
    await call("messages.send", {
      token: ana, body: { stream_id: streamId, content, mentions: [{ type: "agent", id: mockAgentId }] },
    });
    let mailId = null;
    for (let round = 0; round < 8; round += 1) {
      await call("scheduler.tick", { token: ana, method: "GET" });
      mailId = await newestMail();
      const status = mailId ? (await db.mail.byId(mailId, { columns: "id,status" }))?.status : null;
      if (status === "done" || status === "failed" || status === "cancelled") return mailId;
    }
    return mailId;
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
  // 用量口径：拿不到可信的数就留空，不拿 0 冒充"没用 token"——命中率的分子分母只收两个数都算得清的轮。
  const firstStepOf = async (content) => {
    const mailId = await sendFor(content);
    const traj = await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: mailId } });
    return { step: traj.payload.steps?.[0], mailId };
  };
  const { step: bareStep } = await firstStepOf("@小M 用量只报总数（口径样本）");
  check("上游只报总数：命中与思考两列留空而不是 0", Number(bareStep?.input_tokens) === 812
    && Number(bareStep?.output_tokens) === 24 && bareStep?.cached_tokens === null
    && bareStep?.reasoning_tokens === null, bareStep);
  const { step: sketchyStep } = await firstStepOf("@小M 用量子桶越界（口径样本）");
  check("子桶比总数还大就不进账：命中率不会算出 100% 以上", Number(sketchyStep?.input_tokens) === 812
    && Number(sketchyStep?.output_tokens) === 24 && sketchyStep?.cached_tokens === null
    && sketchyStep?.reasoning_tokens === null, sketchyStep);
  const { step: noneStep, mailId: noneMail } = await firstStepOf("@小M 用量完全不回（口径样本）");
  check("上游压根不回用量块：四列全空，这一轮不进命中率分母",
    ["input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens"]
      .every((column) => noneStep?.[column] === null), noneStep);
  check("对照：口径收成空不影响这一轮跑完，正文照样落群",
    (await db.mail.byId(noneMail, { columns: "status" }))?.status === "done"
      && String(noneStep?.detail?.content ?? "").includes("没有用量块"), noneMail);
  // 命中率读数本身：口径住在 src/lib/usageStats.mjs（StreamFlow 显示的就是它），落库这四封正好凑齐四种德性。
  const x20UsageOf = (rows) => {
    const usage = newUsage();
    tallyUsage(usage, rows);
    return usage;
  };
  const x20MixedUsage = x20UsageOf([x20Steps[0], bareStep, sketchyStep, noneStep]);
  check("命中率只收上游两个数都回报的轮：四封里只有一封进分母",
    x20MixedUsage.rounds === 4 && x20MixedUsage.reported === 1
    && x20MixedUsage.input === 812 && x20MixedUsage.cached === 640 && hitRateOf(x20MixedUsage) === "79%", x20MixedUsage);
  const x20NoNumberUsage = x20UsageOf([bareStep, sketchyStep, noneStep]);
  check("整组都没可信用量时读数是不进统计的破折号，不拿 0% 冒充没命中",
    x20NoNumberUsage.rounds === 3 && x20NoNumberUsage.reported === 0 && hitRateOf(x20NoNumberUsage) === "—", x20NoNumberUsage);
  // 加权口径：一轮长一轮短时按 token 加权才是真实省钱比例，按每轮百分比求平均会把长轮次的成本摊薄。
  const x20Weighted = x20UsageOf([
    { kind: "model", input_tokens: 1000, cached_tokens: 900 },
    { kind: "model", input_tokens: 100, cached_tokens: 0 },
  ]);
  check("命中率按 token 加权：长短两轮读的是 82%，不是每轮百分比的平均 45%",
    hitRateOf(x20Weighted) === "82%" && Math.round(((900 / 1000 + 0 / 100) / 2) * 100) === 45, x20Weighted);
  const x20ToolRound = x20UsageOf(x20Steps);
  check("工具步不进模型轮的账：一封带工具的只算两条模型轮，读数按这两条出",
    x20ToolRound.rounds === 2 && x20ToolRound.reported === 2 && hitRateOf(x20ToolRound) === "79%", x20ToolRound);
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
    x20Rejected?.status === "failed" && x20Rejected?.error === "tool_unknown"
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
    && (await connectorToolDefs(db, anaId, INTERNAL_TOOL_NAMES)).defs.every((row) => row.function.name !== "zed_only"), x21Zed.payload);

  const x21Pick = await connectorToolDefs(db, anaId, INTERNAL_TOOL_NAMES);
  const x21Defs = x21Pick.defs;
  check("主人启用中连接器的工具并进员工清单",
    x21Defs.some((row) => row.function.name === "get_weather") && x21Defs.some((row) => row.function.name === "long_text"),
    x21Defs.map((row) => row.function.name));
  check("与内置重名的外部工具让位，不出现两份",
    !x21Defs.some((row) => row.function.name === "search_history"), x21Defs.map((row) => row.function.name));
  // 让位不等于丢弃：被谁挤掉要查得到，否则"接了连接器却用不上"在任何一面都看不出来。
  check("让位的工具如实报进 skipped，并说清被谁挤掉",
    x21Pick.skipped.some((item) => item.name === "search_history" && item.by === "内置工具"), x21Pick.skipped);
  check("对照：没让位的连接器工具不混进 skipped",
    !x21Pick.skipped.some((item) => item.name === "get_weather"), x21Pick.skipped);

  await call("plugins.update", { token: ana, body: { id: x21Id, enabled: false } });
  check("停用后外部声明立刻从清单消失", (await connectorToolDefs(db, anaId, INTERNAL_TOOL_NAMES)).defs.length === 0);
  check("停用中的连接器工具调用被拒：名字不在启用中的清单里",
    (await toolSafe(x21Scope, "get_weather", { city: "杭州" })).error === "connector_tool_unmatched");
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
  check("对外 MCP 那条路（作用域里没有 agentId）碰不到插件工具：报的是不在员工回路里",
    (await toolSafe({ streamId, ownerId: anaId }, "get_weather", { city: "杭州" })).error === "connector_needs_agent_run");

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
  // 这一轮模型确实没拿到那个重名的外部工具，而"为什么没拿到"必须在这一步的轨迹里能读出来。
  check("被内置挤掉的外部工具在这轮模型步的备注里如实说出",
    String(x21Steps[0]?.detail?.note ?? "").includes("search_history（被内置工具挤掉）"), x21Steps[0]?.detail?.note);
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
  check("远端技能块的出处报源的名字与 slug，不报一个谁都查不到的 uuid",
    (await skillPrompt(store(supabase), mockAgentId))
      .includes("### release-check 技能（远端源「社区技能源」的 release-check，快照 1.2.0）"),
    (await skillPrompt(store(supabase), mockAgentId)).slice(0, 400));
  check("快照不进别人的市场", !(await call("skills.market", { token: bToken, method: "GET" })).payload.items?.some((row) => row.id === snapId));
  const x22Again = await call("skills.remoteInstall", { token: ana, body: { registry_id: regId, slug: "release-check", agent_id: mockAgentId } });
  check("重复装同一员工不建第二条快照", x22Again.payload.skill?.id === snapId
    && x22Again.payload.install?.agents?.[0]?.duplicate === true, x22Again.payload);
  check("重复装不加安装数", Number((await call("skills.get", { token: ana, method: "GET", body: { id: snapId } })).payload.skill?.installs) === 1);
  // 远端快照的卸载要单独验一次：它和本地上传的技能在库里是同一张表，但正文是抄来的，
  // 卸完该留的是那份抄来的正文，该走的是员工上下文里的那一块。
  const x22SnapOff = await call("skills.uninstall", { token: ana, body: { agent_id: mockAgentId, skill_id: snapId } });
  check("远端快照卸掉后：上下文读不到这一块，快照行与版本还在",
    x22SnapOff.payload.ok === true
      && !(await skillPrompt(store(supabase), mockAgentId)).includes("### release-check 技能")
      && (await call("skills.get", { token: ana, method: "GET", body: { id: snapId } })).payload.skill?.version === "1.2.0",
    (await skillPrompt(store(supabase), mockAgentId)).slice(0, 400));
  const x22SnapBack = await call("skills.install", { token: ana, body: { skill_id: snapId, agent_id: mockAgentId } });
  check("对照：重新装回来，出处那一行原样回到上下文",
    x22SnapBack.payload.installed === true
      && (await skillPrompt(store(supabase), mockAgentId)).includes("### release-check 技能（远端源「社区技能源」的 release-check，快照 1.2.0）"),
    x22SnapBack.payload);

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
    token: ana, body: { name: "小远", role: "远端技能", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-9", model: "demo" },
  });
  check("主人新建员工自动装上他的默认技能", (await call("skills.installed", { token: ana, method: "GET", body: { agent_id: x22NewAgent.payload.agent?.id } })).payload.items
    ?.some((row) => row.id === snapId), x22NewAgent.payload);
  const x22BoAgent = await call("agents.create", {
    token: bToken, body: { name: "Bo 的员工", role: "对照", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-8", model: "demo" },
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
  const deadSource = await skillPrompt(store(supabase), mockAgentId);
  const blockHeads = (body) => body.split("\n").filter((line) => line.startsWith("### ")).join(" ｜ ");
  // 版本从快照行取而不是写死：这一段前面还排着更新与撤下的剧本，装进来时那一版早已不是当前版。
  const snapVersion = (await call("skills.get", { token: ana, method: "GET", body: { id: snapId } })).payload.skill?.version;
  check("源删掉了技能块照旧在上下文里，出处如实写「已删除的源」而不是冒充内置",
    Boolean(snapVersion)
      && deadSource.includes(`### release-check 技能（远端源「已删除的源」的 release-check，快照 ${snapVersion}）`),
    blockHeads(deadSource));
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

  // 通道由地址与后端列一起决定（functions/backends.mjs 的 backendFor），这一对凑错了就不能跑：
  // 云端后端挂演示地址只会连不上。建档/改档都拒，别留到员工上岗后每轮任务都失败在取地址上。
  const qcaDemoUrl = await call("agents.create", {
    token: ana,
    body: { name: "云演示", role: "x", backend: "qca", qca_agent_id: "agent_ok", api_base_url: "demo://local", api_key: PAT },
  });
  check("云端后端 + 演示地址在建档就被拒", qcaDemoUrl.payload.error === "qca_needs_real_origin", qcaDemoUrl.payload);
  check("对照：同一个后端配真实 origin 能建档（拒的是这一对组合，不是云端建档本身）",
    qcaAgent.payload.ok === true && qcaAgent.payload.agent?.backend === "qca", qcaAgent.payload.error);
  const demoStandIn = await call("agents.create", {
    token: ana,
    body: { name: "演示换型", role: "x", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-pair", model: "demo" },
  });
  const demoId = demoStandIn.payload.agent?.id;
  const demoModelSwap = await call("agents.update", { token: ana, body: { id: demoId, model: "gpt-4o" } });
  check("演示地址上的员工改模型名被拒：这个地址只选中内置演示模型",
    demoModelSwap.payload.error === "demo_needs_demo_model", demoModelSwap.payload);
  const demoRoleSwap = await call("agents.update", { token: ana, body: { id: demoId, role: "换个岗位" } });
  check("对照：同一员工改不相干的字段照样放行", demoRoleSwap.payload.ok === true, demoRoleSwap.payload.error);
  await call("agents.delete", { token: ana, body: { id: demoId } });

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
  // 用一个新建的临时员工做换后端，不动 agentId：它是后面几节还在用的在岗员工，
  // 真给他换到云端会把"调度顺序不对"伪装成"产品缺陷"。
  const x23Swap = await call("agents.create", {
    token: ana,
    body: { name: "换后端", role: "x", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-23", model: "demo" },
  });
  const x23SwapId = x23Swap.payload.agent?.id;
  const switchBack = await call("agents.update", {
    token: ana, body: { id: x23SwapId, backend: "qca", qca_agent_id: "agent_abc", api_base_url: qca.origin },
  });
  check("切后端必须同时换令牌（自建端点的 Key 在云上没用）",
    switchBack.payload.error === "agent_key_required_for_backend", switchBack.payload);
  const switchWithKey = await call("agents.update", {
    token: ana,
    body: { id: x23SwapId, backend: "qca", qca_agent_id: "agent_abc", api_base_url: qca.origin, api_key: PAT },
  });
  check("对照：同一处改动带上云端令牌就放行（拦的是缺令牌，不是不许换后端）",
    switchWithKey.payload.ok === true && switchWithKey.payload.agent?.backend === "qca"
      && switchWithKey.payload.agent?.qca_agent_id === "agent_abc", switchWithKey.payload);
  await call("agents.delete", { token: ana, body: { id: x23SwapId } });

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

  const sessionRound1 = await db.qca_sessions.list([["agent_id", qcaId], ["stream_id", streamId]], { columns: "id,session_id", limit: 20 });
  await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "@小C 再补一句", mentions: [{ type: "agent", id: qcaId }] },
  });
  const qcaTick2 = await call("scheduler.tick", { token: ana, method: "GET" });
  check("第二轮也跑完", (qcaTick2.payload.ran ?? []).some((r) => r.status === "done"), qcaTick2.payload);
  // 数落库的那一条，不数 POST /sessions 的次数：压缩那一轮的一次性会话也开新 session，
  // 它不落库、也不算"这条群对话没复用"。
  const sessionRound2 = await db.qca_sessions.list([["agent_id", qcaId], ["stream_id", streamId]], { columns: "id,session_id", limit: 20 });
  check("同群第二轮复用同一条云端 session",
    sessionRound1.length === 1 && sessionRound2.length === 1
    && sessionRound1[0].session_id === sessionRound2[0].session_id, { 第一轮: sessionRound1, 第二轮: sessionRound2 });
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
  // 数的是落库的那两条而不是出网次数：压缩那一轮的一次性会话也走 POST /sessions，
  // 它不该落库，也就不能算进"换群换 session"这笔账。
  check("换群就换云端 session：不同群不会在云上串台",
    qcaSessions2.length === 2
    && new Set(qcaSessions2.map((r) => r.session_id)).size === 2
    && new Set(qcaSessions2.map((r) => r.stream_id)).size === 2, qcaSessions2);

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
      name: "小L", role: "对照", backend: "openai", api_base_url: `http://127.0.0.1:${local.port}/v1`,
      api_key: "mock-key-2", model: "mock", context_chars: 8000,
    },
  });
  const localId = localAgent.payload.agent?.id;
  await call("streams.agents.add", { token: ana, body: { stream_id: qcaRoomId, agent_id: localId } });
  await call("messages.send", {
    token: ana,
    body: { stream_id: qcaRoomId, content: "@小L 对照一句", mentions: [{ type: "agent", id: localId }] },
  });
  // 一次 tick 不一定排到这封新信：前面还压着这一节没排空的旧信，单次切片会把最新那封切掉，
  // localSystem 就成了空串——把调度顺序的问题伪装成"通道被塞了云端须知"的产品缺陷。等到落终态为止。
  for (let round = 0; round < 8; round += 1) {
    await call("scheduler.tick", { token: ana, method: "GET" });
    const localMail = (await db.mail.list([["agent_id", localId]], {
      columns: "id,status", order: ["created_at", { ascending: false }], limit: 1,
    }))[0];
    if (localMail && ["done", "failed", "cancelled"].includes(localMail.status)) break;
  }
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
  // 上面那两枪直连 askCloudAgent，绕过了分流口——分流口漏传一个参数时它们照样是绿的。
  // 压缩那一轮走的是 completeForAgent，这一枪才管得住"一次性提问"经不经得起分流。
  const routedBefore = qca.count("POST", /\/sessions$/);
  const routedRows = (await db.qca_sessions.list([["agent_id", qcaId]], { columns: "id", limit: 20 })).length;
  const routed = await completeForAgent({
    db, agent: qcaRow, streamId: qcaRoomId, key: PAT,
    messages: [{ role: "system", content: "压成不超过 600 字" }, { role: "user", content: "旧对话" }],
    persistSession: false,
  });
  check("经分流口的一次性提问照样开新会话、不落进群里那条（压缩走的就是这条路）",
    routed.mode === "qca" && qca.count("POST", /\/sessions$/) === routedBefore + 1
    && (await db.qca_sessions.list([["agent_id", qcaId]], { columns: "id", limit: 20 })).length === routedRows,
    { 出网次数: qca.count("POST", /\/sessions$/), 落库行数: routedRows });
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
    body: { name: "小L", role: "值班", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-25", model: "demo" },
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
  // 用户位那一条永远是内部包装语（composeAsk 只有一句“请按上面的上下文回应这条任务。”），
  // 复述它等于把提示词念进群，所以要回应谁的话得从转录里取。判别器是后半句：
  // 前半句在摘录里也会出现，只看它会漏掉「照抄包装语」这个回归。
  check("代答复述的是群里那句话，用户位的包装语没进群",
    String(dReply?.content).includes("@林 这个报错你帮我看下")
      && !String(dReply?.content).includes("请按上面的上下文回应这条任务"), dReply?.content);
  check("对照：转录与记忆照旧摘录得出来（演示模型仍能证明上下文进得去）",
    /建档：|韩：@林/.test(String(dReply?.content)), dReply?.content);
  // 演示模型会把触发消息原样摘录进回复，所以这条回复天然又 @ 了主人：正是自我触发的现场。
  const dLoopMail = await db.mail.list([["agent_id", standInId], ["stream_id", dStreamId]], { columns: "id,status,message_id", limit: 10 });
  check("替身的回复里 @ 了主人：不再给自己派活，队列里没有第二封",
    dLoopMail.length === 1, dLoopMail);

  // 演示模型那两句会话体文本跟 owner 的界面语言走：切 en 后回帖起头与轨迹 note 一起换，
  // 切回 zh 又一起换回来——两侧同时断言，「语言没接上、永远回落中文」就过不了。
  const standInReplies = async () => ((await call("messages.list", {
    token: hanToken, method: "GET", body: { stream_id: dStreamId },
  })).payload.items ?? []).filter((m) => m.sender_type === "agent");
  const enBefore = (await standInReplies()).filter((m) => String(m.content).startsWith("(demo model)")).length;
  await call("auth.patch", { token: linToken, body: { prefs: { lang: "en" } } });
  const enSend = await call("messages.send", {
    token: hanToken,
    body: { stream_id: dStreamId, content: "@林 one more line for the record", mentions: [{ type: "human", id: linId }] },
  });
  await call("scheduler.tick", { token: linToken, method: "GET" });
  const enReplies = await standInReplies();
  check("owner 界面切 en：演示回帖起头换英文模板",
    enReplies.filter((m) => String(m.content).startsWith("(demo model)")).length === enBefore + 1,
    enReplies.map((m) => String(m.content).slice(0, 40)));
  const enMail = await db.mail.list([["message_id", enSend.payload.message?.id]], { columns: "id", limit: 1 });
  const enSteps = await db.run_steps.list([["mail_id", enMail[0]?.id]], {
    columns: "kind,detail", order: ["seq", { ascending: true }],
  });
  check("同一轮的轨迹 note 也读英文：两句会话体一起换",
    enSteps.some((s) => s.kind === "model" && String(s.detail?.note ?? "").startsWith("demo model: reports neither")),
    enSteps.map((s) => s.detail?.note));
  await call("auth.patch", { token: linToken, body: { prefs: { lang: "zh-Hans" } } });
  const zhBefore = (await standInReplies()).filter((m) => String(m.content).startsWith("（演示模型）")).length;
  await call("messages.send", {
    token: hanToken,
    body: { stream_id: dStreamId, content: "@林 这条换回中文记", mentions: [{ type: "human", id: linId }] },
  });
  await call("scheduler.tick", { token: linToken, method: "GET" });
  const zhReplies = await standInReplies();
  check("对照：切回 zh 后下一条回帖起头回到中文模板",
    zhReplies.filter((m) => String(m.content).startsWith("（演示模型）")).length === zhBefore + 1,
    zhReplies.map((m) => String(m.content).slice(0, 40)));
  check("切 en 后复述的那句是英文原文：包装语在两种语言下都进不了群",
    String(enReplies.at(-1)?.content).includes("one more line for the record")
      && !String(enReplies.at(-1)?.content).includes("请按上面的上下文回应这条任务"),
    String(enReplies.at(-1)?.content).slice(0, 120));
  check("切 en 后摘录的转录行也换了格式：英文回复里没有 [人]/[虚拟]/[系统]",
    /\[(human|virtual|system)\]/.test(String(enReplies.at(-1)?.content))
      && !/\[(人|虚拟|系统)\]/.test(String(enReplies.at(-1)?.content)),
    String(enReplies.at(-1)?.content).slice(0, 160));

  // 落库的系统行同一条口径：语言在写入那一刻按操作者的界面语言定。同一个人改两次公告，
  // 两侧都断死整句——只断一侧的话，「永远回落中文」和「永远英文」都能蒙过去。
  const lastSystemLine = async () => ((await call("messages.list", {
    token: linToken, method: "GET", body: { stream_id: dStreamId },
  })).payload.items ?? []).filter((m) => m.sender_type === "system").at(-1)?.content ?? "";
  await call("auth.patch", { token: linToken, body: { prefs: { lang: "en" } } });
  await call("streams.announcement", { token: linToken, body: { stream_id: dStreamId, content: "Friday delivery, same basis as last time." } });
  const enSystem = await lastSystemLine();
  check("界面停在 en 时改公告：落库的系统行走英文模板，一个汉字都没有",
    enSystem === "Group announcement updated: Friday delivery, same basis as last time.", enSystem);
  await call("auth.patch", { token: linToken, body: { prefs: { lang: "zh-Hans" } } });
  await call("streams.announcement", { token: linToken, body: { stream_id: dStreamId, content: "周五交付，照上次口径。" } });
  const zhSystem = await lastSystemLine();
  check("对照：切回 zh 后改公告，同一条系统行回到中文模板",
    zhSystem === "群公告已更新：周五交付，照上次口径。", zhSystem);

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
    body: { name: "小M", role: "备份替身", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-26", model: "demo" },
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

  step("\n§26 排程：虚拟员工按自己的时刻表醒来，不等人 @");
  const MINUTE = 60 * 1000;
  const HOURM = 60 * MINUTE;
  const DAYM = 24 * HOURM;
  const isoAt = (ms) => new Date(ms).toISOString();
  // 2026-01-10 是周六：周一 01-12、周五 01-16、下周一 01-19。周几过滤全靠这几个日子对表。
  const SAT = Date.parse("2026-01-10T00:00:00Z");
  const everyRow = (nextRunMs, intervalMinutes = 30) => ({
    kind: "every", interval_minutes: intervalMinutes, at_time: null, weekdays: null,
    tz_offset_minutes: null, next_run_at: isoAt(nextRunMs),
  });
  const dailyRow = (nextRunMs, { atTime = "09:00", weekdays = null, offset = 480 } = {}) => ({
    kind: "daily", interval_minutes: null, at_time: atTime, weekdays, tz_offset_minutes: offset,
    next_run_at: isoAt(nextRunMs),
  });

  // 到时与追补是纯函数：投递路径和界面读同一把尺子，所以先把尺子本身钉死。
  check("还没到点：不追补，也不动时钟", catchUp(everyRow(SAT, 30), SAT - 25 * MINUTE) === null);
  check("时钟写空就是暂停：没有第二个真值源可对，也就不会追补",
    catchUp({ ...everyRow(SAT), next_run_at: null }, SAT + DAYM) === null);
  const onLine = catchUp(everyRow(SAT, 30), SAT);
  check("正好压在界线上算一个对点：到点即醒，不留到下一格",
    onLine?.runs === 1 && onLine.dueAt === SAT && onLine.nextRunAt === SAT + 30 * MINUTE, onLine);
  const owed = catchUp(everyRow(SAT, 30), SAT + 100 * MINUTE);
  check("每半小时、欠了一百分钟：认四个对点，时钟推到将来",
    owed?.runs === 4 && owed.dueAt === SAT + 90 * MINUTE && owed.nextRunAt === SAT + 120 * MINUTE, owed);
  const dailyDue = catchUp(dailyRow(SAT + 2 * DAYM + HOURM), SAT + 4 * DAYM + 5 * HOURM);
  check("每天 09:00（UTC+8）从周一欠到周三早上：三次，下一次落在周四 09:00",
    dailyDue?.runs === 3 && dailyDue.dueAt === Date.parse("2026-01-14T01:00:00Z")
      && dailyDue.nextRunAt === Date.parse("2026-01-15T01:00:00Z"), dailyDue);
  const workdays = catchUp(dailyRow(SAT + 2 * DAYM + HOURM, { weekdays: [1, 5] }), Date.parse("2026-01-18T00:00:00Z"));
  check("只排周一和周五：中间三天跳过，下一次跳到下周一",
    workdays?.runs === 2 && workdays.dueAt === Date.parse("2026-01-16T01:00:00Z")
      && workdays.nextRunAt === Date.parse("2026-01-19T01:00:00Z"), workdays);
  const flooded = catchUp(dailyRow(SAT, { atTime: "00:00", offset: 0 }), SAT + 600 * DAYM);
  check("掉线六百年回来：追补封顶 500 个对点，不无限补历史", flooded?.runs === 500, flooded?.runs);
  check("封顶之后时钟重锚到将来，那一串迟到的旧任务不往群里灌",
    flooded?.nextRunAt > SAT + 600 * DAYM, flooded && new Date(flooded.nextRunAt).toISOString());
  check("时刻不合法当场炸，不悄悄按 00:00 排", (() => {
    try { clockToMs("25:00"); return false; } catch (error) { return error.error === "invalid_at_time"; }
  })());
  check("时刻要两位补零：界面与库共用一种写法", (() => {
    try { clockToMs("9:00"); return false; } catch (error) { return error.error === "invalid_at_time"; }
  })());
  check("等长周期往后推就是一个间隔", nextOccurrence({ kind: "every", intervalMs: 45 * MINUTE }, SAT) === SAT + 45 * MINUTE);
  const previews = upcomingOccurrences(everyRow(SAT + 12 * MINUTE, 30));
  check("界面上的「下一次」按这一行自己的时钟走：每半小时不会被此刻重锚成 :12/:42",
    previews.length === 3 && previews.every((v, i) => Date.parse(v) === SAT + 12 * MINUTE + i * 30 * MINUTE), previews);
  check("暂停的排程读不出「下一次」：界面不该装作它还在跑",
    upcomingOccurrences({ ...everyRow(SAT), next_run_at: null }).length === 0);

  // ---- 入口与权限 ----
  // 8b 那个假上游已经关掉了：这一节自己开一个，断言才落在"对方确实接到了什么"上。
  const cronMock = await startMockUpstream();
  const cronAgent = await call("agents.create", {
    token: ana,
    body: {
      name: "小C", role: "值班巡检", backend: "openai", api_base_url: `http://127.0.0.1:${cronMock.port}/v1`,
      api_key: "mock-key-cron", model: "mock", context_chars: 8000,
    },
  });
  const cronAgentId = cronAgent.payload.agent?.id;
  const cronStream = await call("streams.create", { token: ana, body: { name: "排程值班组", agent_ids: [cronAgentId] } });
  const cronStreamId = cronStream.payload.stream?.id;
  const loneAgent = await call("agents.create", {
    token: ana,
    body: { name: "小N", role: "未入群", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-lone", model: "demo" },
  });
  const loneAgentId = loneAgent.payload.agent?.id;
  const boAgent = await call("agents.create", {
    token: bToken,
    body: { name: "小B", role: "Bo 的员工", backend: "openai", api_base_url: "demo://local", api_key: "demo-key-bob", model: "demo" },
  });
  const boAgentId = boAgent.payload.agent?.id;
  const spec = (over = {}) => ({
    name: "晨间巡检", instruction: "看一眼线上告警，把要紧的报出来",
    agent_id: cronAgentId, stream_id: cronStreamId, kind: "every", interval_minutes: 30, ...over,
  });
  const cronMailsOf = async (scheduleId) => (await db.mail.list(
    [["agent_id", cronAgentId], ["stream_id", cronStreamId]], { columns: "id,meta,status", limit: 200 },
  )).filter((row) => row.meta?.kind === "cron" && String(row.meta?.schedule_id ?? "") === String(scheduleId));

  check("未登录不能排班", (await call("cron.set", { body: spec() })).status === 401);
  const borrow = await call("cron.set", { token: bToken, body: spec() });
  check("借别人的虚拟员工排班被拒：跑的是别人的 Key、烧的是别人的额度",
    borrow.status === 403 && borrow.payload.error === "agent_not_owned", borrow.payload);
  const outsider = await call("cron.set", { token: bToken, body: spec({ agent_id: boAgentId }) });
  check("不是群成员不能在这个群里排班", outsider.status === 403 && outsider.payload.error === "not_stream_member", outsider.payload);
  const loneTry = await call("cron.set", { token: ana, body: spec({ agent_id: loneAgentId }) });
  check("员工不在本群：排程投出去也没人接，就地拒",
    loneTry.status === 400 && loneTry.payload.error === "agent_not_in_stream", loneTry.payload);
  const morning = await call("cron.set", { token: ana, body: spec() });
  const morningId = morning.payload.schedule?.id;
  check("对照：给自己名下的员工、自己所在的群排班放行",
    morning.payload.ok === true && Date.parse(morning.payload.schedule?.next_run_at ?? 0) > Date.now(), morning.payload);
  check("新建的排程没有历史欠款", morning.payload.schedule?.merged_runs === 0 && morning.payload.schedule.last_run_at === null, morning.payload.schedule);
  await call("streams.agents.add", { token: ana, body: { stream_id: cronStreamId, agent_id: loneAgentId } });
  const backup = await call("cron.set", { token: ana, body: spec({ agent_id: loneAgentId, name: "备份巡检" }) });
  const backupId = backup.payload.schedule?.id;
  check("对照：把员工拉进群后，同一条排程就建得成", backup.payload.ok === true, backup.payload);
  const boApply = await call("streams.apply", { token: bToken, body: { stream_uuid: cronStreamId } });
  await call("streams.decide", { token: ana, body: { request_id: boApply.payload.request_id, approve: true } });
  await call("streams.agents.add", { token: bToken, body: { stream_id: cronStreamId, agent_id: boAgentId } });
  const boSchedule = await call("cron.set", {
    token: bToken,
    body: spec({ agent_id: boAgentId, name: "Bo 的日报", instruction: "把 Bo 名下的告警汇总一份" }),
  });
  const boScheduleId = boSchedule.payload.schedule?.id;
  check("对照：入群之后 Bo 能在同一个群里给自己名下的员工排班", boSchedule.payload.ok === true, boSchedule.payload);

  check("间隔小于 1 分钟被拒：排程是主动干活，不是往群里灌消息的定时器",
    (await call("cron.set", { token: ana, body: spec({ interval_minutes: 0 }) })).payload.error === "invalid_interval_minutes");
  check("不认识的 kind 被拒", (await call("cron.set", { token: ana, body: spec({ kind: "cron" }) })).payload.error === "invalid_kind");
  check("每天型不给几点：入库前就炸",
    (await call("cron.set", { token: ana, body: { ...spec(), kind: "daily", interval_minutes: null } })).payload.error === "invalid_at_time");
  check("每天型不按时区：09:00 是谁的 09:00 说不清，不猜",
    (await call("cron.set", {
      token: ana, body: { ...spec(), kind: "daily", at_time: "09:00", interval_minutes: null },
    })).payload.error === "invalid_tz_offset_minutes");
  check("周几越界被拒", (await call("cron.set", {
    token: ana,
    body: { ...spec(), kind: "daily", at_time: "09:00", tz_offset_minutes: 480, weekdays: [8], interval_minutes: null },
  })).payload.error === "invalid_weekdays");
  check("时区偏移越界被拒", (await call("cron.set", {
    token: ana, body: { ...spec(), kind: "daily", at_time: "09:00", tz_offset_minutes: 900, interval_minutes: null },
  })).payload.error === "invalid_tz_offset_minutes");
  const weekly = await call("cron.set", {
    token: ana,
    body: { ...spec(), name: "周一站会", kind: "daily", at_time: "09:30", tz_offset_minutes: 480, weekdays: [1], interval_minutes: null },
  });
  const weeklyId = weekly.payload.schedule?.id;
  const weeklyLocal = new Date(Date.parse(weekly.payload.schedule?.next_run_at ?? 0) + 480 * MINUTE);
  check("每天型填全了就落在填写的墙钟上：周一 09:30（UTC+8）",
    weekly.payload.ok === true && weeklyLocal.getUTCDay() === 1
      && weeklyLocal.getUTCHours() === 9 && weeklyLocal.getUTCMinutes() === 30, weekly.payload.schedule);
  const switchTarget = await call("cron.set", {
    token: ana, body: { ...spec(), id: weeklyId, agent_id: loneAgentId, kind: "daily", at_time: "09:30", tz_offset_minutes: 480 },
  });
  check("改排程时换员工或换群被拒：时钟与历史都挂在原来那个（员工,群）上",
    switchTarget.status === 400 && switchTarget.payload.error === "schedule_target_locked", switchTarget.payload);

  const anaList = await call("cron.list", { token: ana, method: "GET", body: { stream_id: cronStreamId } });
  check("排程列表只回自己名下的：Bo 那条不出现在 Ana 的表里",
    (anaList.payload.items ?? []).length > 0 && anaList.payload.items.every((row) => row.owner_id === anaId)
      && !anaList.payload.items.some((row) => row.id === boScheduleId), anaList.payload.items?.map((r) => r.id));
  check("每条都带往后几个对点，界面上的「下一次」要能自证口径",
    (anaList.payload.items ?? []).every((row) => Array.isArray(row.upcoming) && row.upcoming.length <= 3), anaList.payload.items);
  check("列表把限额一起给出：前端不用把 20 条和 1 分钟抄成两份",
    anaList.payload.limits?.max_per_owner === 20 && anaList.payload.limits.min_interval_minutes === 1, anaList.payload.limits);
  const stealPause = await call("cron.pause", { token: bToken, body: { id: morningId } });
  check("别人停不掉我的排程", stealPause.status === 403 && stealPause.payload.error === "schedule_not_owned", stealPause.payload);
  const stealDelete = await call("cron.delete", { token: bToken, body: { id: morningId } });
  check("别人删不掉我的排程：只比 id 不比主人会永远成立",
    stealDelete.status === 403 && stealDelete.payload.error === "schedule_not_owned", stealDelete.payload);

  // ---- 到时投递与执行 ----
  await db.schedules.patch([["id", morningId]], { next_run_at: isoAt(Date.now() - 100 * MINUTE) });
  check("空闲的 worker 也找得到该醒的主人：没有一封排队信时排程照样有人驱动",
    (await dueOwnerIds(db, { nowMs: Date.now() })).includes(anaId), await dueOwnerIds(db, { nowMs: Date.now() }));
  check("对照：只有将来时钟的主人不在到期名单里",
    !(await dueOwnerIds(db, { nowMs: Date.now() })).includes(boId));
  const fireTick = await call("scheduler.tick", { token: ana, method: "GET" });
  const fired = (fireTick.payload.cron ?? []).find((row) => row.schedule_id === morningId);
  check("到点的排程在这一轮投出信：欠四个对点也只投一封",
    fired?.runs === 4 && Boolean(fired.mail_id), fired);
  const firedMail = await db.mail.byId(fired?.mail_id ?? "00000000-0000-0000-0000-000000000000");
  check("排程信不挂在某条消息上：它不是替谁回话",
    firedMail?.message_id === null && firedMail?.status === "done",
    firedMail && { message_id: firedMail.message_id, status: firedMail.status });
  check("同一轮就把这封信跑掉，模式标成 cron",
    (fireTick.payload.ran ?? []).some((r) => r.mail_id === fired?.mail_id && r.status === "done" && r.mode === "cron"),
    fireTick.payload.ran);
  check("信里带着到点时刻、排程名与合并数：这一轮看到什么，从这封信就能复原",
    firedMail?.meta?.kind === "cron" && firedMail.meta.cron?.merged === 3
      && firedMail.meta.cron.name === "晨间巡检" && String(firedMail.meta.cron.instruction).includes("线上告警"), firedMail?.meta);
  const morningRow = await db.schedules.byId(morningId);
  check("时钟推到最后欠的那个对点之后，并把那个对点记成最近一次",
    Date.parse(morningRow?.next_run_at ?? 0) > Date.now() && morningRow?.last_run_at === firedMail?.meta?.cron?.due_at, morningRow);
  check("合并掉的三个对点全记进合并计数：界面上要能看出这一轮替我少发了几条",
    morningRow?.merged_runs === 3, morningRow?.merged_runs);
  const morningSeen = cronMock.seen.filter((body) => String(body.messages?.[0]?.content ?? "").includes("看一眼线上告警"));
  check("上游确实收到排程块：排程名、合并数与要办的事都进了提示词",
    morningSeen.length === 1 && String(morningSeen[0].messages[0].content).includes("合并了 3 个")
      && String(morningSeen[0].messages[0].content).includes("看一眼线上告警"), morningSeen.length);
  check("排程那一轮没有原始消息，触发块如实说明是谁醒的，不谎称补发任务",
    String(morningSeen[0]?.messages?.[0]?.content ?? "").includes("没有人 @ 你，这一轮是你自己的排程醒的"));
  const patrol = ((await call("messages.list", { token: ana, method: "GET", body: { stream_id: cronStreamId } })).payload.items ?? [])
    .find((m) => m.sender_id === cronAgentId);
  check("巡检结果落进群", String(patrol?.content).includes("排程巡检"), patrol);
  check("群里不念内部指令：排程块与要办的事都留在提示词里",
    !String(patrol?.content).includes("这一轮是你自己的排程") && !String(patrol?.content).includes("要办的事"), patrol?.content);
  const idleTick = await call("scheduler.tick", { token: ana, method: "GET" });
  check("没到点的一轮不再投：时钟已经推到将来",
    (idleTick.payload.cron ?? []).every((row) => row.schedule_id !== morningId), idleTick.payload.cron);

  await db.schedules.patch([["id", morningId]], { next_run_at: isoAt(Date.now() - 31 * MINUTE) });
  const twin = await Promise.all([
    call("scheduler.tick", { token: ana, method: "GET" }),
    call("scheduler.tick", { token: ana, method: "GET" }),
  ]);
  const morningMails = await cronMailsOf(morningId);
  check("两个驱动同时看见同一个到期行：只有一个赢，群里不多念一遍",
    morningMails.length === 2, morningMails.map((m) => m.status));
  check("对照：并发那一轮也真的把活干了", twin.every((t) => t.payload.ok === true), twin.map((t) => t.status));

  const noon = await call("cron.set", { token: ana, body: spec({ name: "午间巡检", instruction: "午间巡检：核对昨天的构建产物" }) });
  const noonId = noon.payload.schedule?.id;
  await db.mail.insert({
    id: crypto.randomUUID(), agent_id: cronAgentId, stream_id: cronStreamId, message_id: null,
    trigger_seq: 0, priority: 1, status: "queued", slice_count: 0, error: null,
    created_at: isoAt(Date.now()), started_at: null, finished_at: null, updated_at: isoAt(Date.now()),
    meta: {
      kind: "cron", schedule_id: noonId,
      cron: { name: "午间巡检", instruction: "午间巡检：核对昨天的构建产物", due_at: isoAt(Date.now()), runs: 1, merged: 0 },
    },
  }, { columns: "id" });
  await db.schedules.patch([["id", noonId]], { next_run_at: isoAt(Date.now() - 95 * MINUTE) });
  const foldTick = await call("scheduler.tick", { token: ana, method: "GET" });
  const foldedRow = (foldTick.payload.cron ?? []).find((row) => row.schedule_id === noonId);
  check("上一轮那封还没跑完：新欠的对点并进它，不另起一封",
    foldedRow?.merged_into_pending === true && foldedRow.runs === 4, foldedRow);
  check("对照：这一轮午间巡检确实只有一封信", (await cronMailsOf(noonId)).length === 1, await cronMailsOf(noonId));
  check("并进旧信的对点全记进合并计数（不减掉那一封自己）",
    (await db.schedules.byId(noonId))?.merged_runs === 4, await db.schedules.byId(noonId));

  // 投递失败这一支只有一处写入能走到，而它决定"欠的那个对点会不会被时钟白白带走"。
  // 换一份 mail.insert 会炸的 db 视图来打这一轮：不改动共享的 db，也不影响后面的用例。
  // db 是 Proxy（属性名即表名），展开它只会得到空对象；用原型链继承、只遮一个 mail。
  const flaky = await call("cron.set", { token: ana, body: spec({ name: "回拨巡检", instruction: "回拨巡检：这一轮投不出去" }) });
  const flakyId = flaky.payload.schedule?.id;
  await db.schedules.patch([["id", flakyId]], { next_run_at: isoAt(Date.now() - 7 * MINUTE) });
  const beforeFlaky = await db.schedules.byId(flakyId);
  const brokenDb = Object.create(db, {
    mail: { value: { ...db.mail, insert: async () => { throw new Error("fixture：邮箱写不进"); } } },
  });
  const flakyOutcome = (await fireDueSchedules(brokenDb, { ownerId: anaId }))
    .find((row) => row.schedule_id === flakyId);
  const afterFlaky = await db.schedules.byId(flakyId);
  check("邮箱写失败：这条排程的错如实报出去，不静默丢",
    flakyOutcome?.error === "cron_mail_write_failed" && !flakyOutcome.mail_id, flakyOutcome);
  check("回拨成自己刚读到的那个值：时钟不白走，欠的对点下一轮重新判到点",
    afterFlaky?.next_run_at === beforeFlaky?.next_run_at
      && afterFlaky?.last_run_at === beforeFlaky?.last_run_at
      && afterFlaky?.merged_runs === beforeFlaky?.merged_runs,
    { before: beforeFlaky?.next_run_at, after: afterFlaky?.next_run_at });
  const flakyTick = await call("scheduler.tick", { token: ana, method: "GET" });
  check("对照：写入恢复后同一个对点照样投出去，一次失败不永久丢掉这条排程",
    (flakyTick.payload.cron ?? []).some((row) => row.schedule_id === flakyId && row.mail_id), flakyTick.payload.cron);

  const night = await call("cron.set", { token: ana, body: spec({ name: "晚间值守", instruction: "晚间值守：核对一下值班表" }) });
  const nightId = night.payload.schedule?.id;
  const waitingCron = await db.mail.insert({
    id: crypto.randomUUID(), agent_id: cronAgentId, stream_id: cronStreamId, message_id: null,
    trigger_seq: 0, priority: 1, status: "queued", slice_count: 0, error: null,
    created_at: isoAt(Date.now() - 2 * MINUTE), started_at: null, finished_at: null, updated_at: isoAt(Date.now() - 2 * MINUTE),
    meta: {
      kind: "cron", schedule_id: nightId,
      cron: { name: "晚间值守", instruction: "晚间值守：核对一下值班表", due_at: isoAt(Date.now() - 2 * MINUTE), runs: 1, merged: 0 },
    },
  }, { columns: "id" });
  const humanSend = await call("messages.send", {
    token: ana,
    body: { stream_id: cronStreamId, content: "@小C 现在有几条告警", mentions: [{ type: "agent", id: cronAgentId }] },
  });
  const humanMailId = humanSend.payload.queued?.[0]?.mail_id;
  const priorityTick = await call("scheduler.tick", { token: ana, method: "GET" });
  check("同事在线等回答时先答人：这一轮跑 @ 的那封，排程留在队列里",
    Boolean(humanMailId) && (priorityTick.payload.ran ?? []).some((r) => r.mail_id === humanMailId)
      && !priorityTick.payload.ran.some((r) => r.mail_id === waitingCron?.id), priorityTick.payload.ran);
  const nextTick = await call("scheduler.tick", { token: ana, method: "GET" });
  check("对照：排程没被吞掉，下一轮照样按时钟跑起来",
    (nextTick.payload.ran ?? []).some((r) => r.mail_id === waitingCron?.id && r.mode === "cron"), nextTick.payload.ran);

  const quiet = await call("cron.set", { token: ana, body: spec({ name: "静默巡检", instruction: "静默巡检：没事就别说话" }) });
  const quietId = quiet.payload.schedule?.id;
  const beforeCount = (await call("messages.list", { token: ana, method: "GET", body: { stream_id: cronStreamId } })).payload.items?.length ?? 0;
  await db.schedules.patch([["id", quietId]], { next_run_at: isoAt(Date.now() - 40 * MINUTE) });
  const quietTick = await call("scheduler.tick", { token: ana, method: "GET" });
  const firedQuiet = (quietTick.payload.cron ?? []).find((row) => row.schedule_id === quietId);
  const quietRan = (quietTick.payload.ran ?? []).find((r) => r.mail_id === firedQuiet?.mail_id);
  check("排程那一轮回空正文算完成，不算失败",
    quietRan?.status === "done" && quietRan.mode === "cron" && quietRan.silent === true, quietRan);
  check("没事就不说话：群里没有多出一条空消息",
    ((await call("messages.list", { token: ana, method: "GET", body: { stream_id: cronStreamId } })).payload.items?.length ?? 0) === beforeCount,
    { beforeCount });
  const blankSend = await call("messages.send", {
    token: ana,
    body: { stream_id: cronStreamId, content: "@小C 空手回话一次", mentions: [{ type: "agent", id: cronAgentId }] },
  });
  const blankRan = (await call("scheduler.tick", { token: ana, method: "GET" })).payload.ran
    ?.find((r) => r.mail_id === blankSend.payload.queued?.[0]?.mail_id);
  check("对照：真人 @ 回空正文仍算失败，同事在等回答不能空手回一句",
    blankRan?.status === "failed" && blankRan.error === "empty_reply", blankRan);

  const doomed = await call("cron.set", { token: ana, body: spec({ name: "临时巡检", instruction: "临时巡检：这条马上被删掉" }) });
  const doomedId = doomed.payload.schedule?.id;
  const doomedMail = await db.mail.insert({
    id: crypto.randomUUID(), agent_id: cronAgentId, stream_id: cronStreamId, message_id: null,
    trigger_seq: 0, priority: 1, status: "queued", slice_count: 0, error: null,
    created_at: isoAt(Date.now()), started_at: null, finished_at: null, updated_at: isoAt(Date.now()),
    meta: {
      kind: "cron", schedule_id: doomedId,
      cron: { name: "临时巡检", instruction: "临时巡检：这条马上被删掉", due_at: isoAt(Date.now()), runs: 1, merged: 0 },
    },
  }, { columns: "id" });
  const colleagueSend = await call("messages.send", {
    token: ana,
    body: { stream_id: cronStreamId, content: "@小C 这条别被删排程牵连", mentions: [{ type: "agent", id: cronAgentId }] },
  });
  const colleagueMailId = colleagueSend.payload.queued?.[0]?.mail_id;
  const removed = await call("cron.delete", { token: ana, body: { id: doomedId } });
  check("删排程：还在队里的那一封一起撤掉，用户删的是排程不是「以后不排、这一下照旧跑」",
    removed.payload.cancelled === 1 && (await db.mail.byId(doomedMail?.id))?.status === "cancelled", removed.payload);
  check("对照：同事刚 @ 出去的那封不受牵连",
    (await db.mail.byId(colleagueMailId))?.status === "queued", await db.mail.byId(colleagueMailId));
  await call("scheduler.tick", { token: ana, method: "GET" });

  const pausedSchedule = await call("cron.pause", { token: ana, body: { id: weeklyId } });
  check("对照：本人停得掉自己的排程：暂停把时钟写空，不删规格",
    pausedSchedule.payload.ok === true && pausedSchedule.payload.next_run_at === null, pausedSchedule.payload);
  check("暂停之后到点也不投：空时钟不进到期扫描",
    ((await call("scheduler.tick", { token: ana, method: "GET" })).payload.cron ?? []).every((row) => row.schedule_id !== weeklyId));
  const resumed = await call("cron.resume", { token: ana, body: { id: weeklyId } });
  check("恢复按原规格重算，从今往后的第一个对点重新开始",
    resumed.payload.ok === true && Date.parse(resumed.payload.next_run_at ?? 0) > Date.now(), resumed.payload);
  check("暂停期间欠掉的不补：恢复之后这一轮不投迟到的旧任务",
    ((await call("scheduler.tick", { token: ana, method: "GET" })).payload.cron ?? []).every((row) => row.schedule_id !== weeklyId));
  const reanchored = await call("cron.set", { token: ana, body: { ...spec(), id: morningId, interval_minutes: 120 } });
  check("改规格就把时钟重锚到新节奏：从 30 分钟改成 2 小时不该继续按旧锚点补历史",
    reanchored.payload.ok === true
      && Date.parse(reanchored.payload.schedule.next_run_at) - Date.now() <= 120 * MINUTE
      && Date.parse(reanchored.payload.schedule.next_run_at) > Date.now(), reanchored.payload.schedule);
  await call("cron.pause", { token: ana, body: { id: weeklyId } });
  const pausedKeep = await call("cron.set", {
    token: ana,
    body: { ...spec(), id: weeklyId, name: "周一站会（改过文案）", kind: "daily", at_time: "09:30", tz_offset_minutes: 480, weekdays: [1] },
  });
  check("改文案不替用户打开他亲手停掉的排程：暂停态在编辑之后仍是暂停",
    pausedKeep.payload.ok === true && pausedKeep.payload.schedule.next_run_at === null, pausedKeep.payload.schedule);

  // 一个主人排到 20 条到顶：扫描按 (owner_id, next_run_at) 走索引，上限让最坏一轮的开销有界。
  const filled = [];
  let overflow = null;
  for (let guard = 0; guard < 24; guard += 1) {
    const made = await call("cron.set", { token: ana, body: spec({ name: `占位${guard}`, instruction: `占位排程第 ${guard} 条` }) });
    if (made.payload.ok) { filled.push(made.payload.schedule.id); continue; }
    overflow = made;
    break;
  }
  check("排到第 21 条被拒：too_many_schedules，不是悄悄排上",
    overflow?.payload.error === "too_many_schedules"
      && (await call("cron.list", { token: ana, method: "GET" })).payload.items?.length === 20,
    { filled: filled.length, error: overflow?.payload?.error });
  for (const id of filled) await call("cron.delete", { token: ana, body: { id } });

  await db.schedules.patch([["id", backupId]], { next_run_at: isoAt(Date.now() - 90 * MINUTE) });
  const dropAgent = await call("agents.delete", { token: ana, body: { id: loneAgentId } });
  check("删员工连带删掉他名下的排程：留着行只会按时投出必定失败的信",
    dropAgent.payload.ok === true && (await db.schedules.list([["agent_id", loneAgentId]], { columns: "id", limit: 10 })).length === 0,
    dropAgent.payload);

  // 群停用走的是另一条连带：排程挂在 (员工,群) 上，行还在的话到点判定会继续为一个不存在的群投信。
  const byeStream = await call("streams.create", { token: ana, body: { name: "排程散场组", agent_ids: [cronAgentId] } });
  const byeStreamId = byeStream.payload.stream?.id;
  const byeSchedule = await call("cron.set", { token: ana, body: spec({ stream_id: byeStreamId, name: "散场前的巡检" }) });
  const dropStream = await call("streams.delete", { token: ana, body: { stream_id: byeStreamId } });
  check("解散群连带删掉这个群里的排程：不给一个不存在的群留一条会醒的时刻表",
    byeSchedule.payload.ok === true && dropStream.payload.ok === true
      && (await db.schedules.list([["stream_id", byeStreamId]], { columns: "id", limit: 10 })).length === 0,
    { schedule: byeSchedule.payload, drop: dropStream.payload });

  const cronMemberRow = await db.members.first(
    [["stream_id", cronStreamId], ["principal_type", "agent"], ["principal_id", cronAgentId]], { columns: "id" },
  );
  await call("streams.members.remove", { token: ana, body: { stream_id: cronStreamId, membership_id: cronMemberRow?.id } });
  await db.schedules.patch([["id", morningId]], { next_run_at: isoAt(Date.now() - 30 * MINUTE) });
  const leaveTick = await call("scheduler.tick", { token: ana, method: "GET" });
  const selfPaused = (leaveTick.payload.cron ?? []).find((row) => row.schedule_id === morningId);
  check("员工已退群：这条排程自己停掉，不再每到一个对点白扫一次",
    selfPaused?.paused === true && selfPaused.reason === "agent_not_in_stream", selfPaused);
  check("自己停掉的排程时钟写空：界面上一条暂停的排程不该装作还在跑",
    (await db.schedules.byId(morningId))?.next_run_at === null, await db.schedules.byId(morningId));

  const withCron = composeSystemPrompt({
    ...slotCtx,
    cron: { name: "晨间巡检", due_at: "2026-01-12T01:00:00.000Z", instruction: "看一眼线上告警", merged: 3 },
  });
  check("排程这一轮单独成一块，位置在本群记忆之后、触发消息之前",
    withCron.promptSlots.map(([id]) => id).join(",")
      === "identity,signature,guide,announcement,skills,history.access,memory.common,summary,transcript,memory.stream,cron,trigger",
    withCron.promptSlots.map(([id]) => id));
  check("这块把合并数与要办的事都写进去，并允许这一轮留空正文",
    withCron.system.includes("合并了 3 个") && withCron.system.includes("看一眼线上告警")
      && withCron.system.includes("正文留空即可"), withCron.system.slice(0, 400));
  check("这块说清正就是那条群消息：不许再补发一条把同一件事念两遍",
    withCron.system.includes("正文会直接进群") && withCron.system.includes("别再补发一条"));
  check("排程块标注为易变：它不该打断员工平时接活的那段前缀",
    PROMPT_SECTIONS.find((section) => section.id === "cron")?.volatile === true);
  check("不是排程的那一轮不落这一块", !composed.promptSlots.some(([id]) => id === "cron"));
  await cronMock.close();

  step("\n§27 交付物：present 工具、消息级卡片与提交点");
  const presentMock = await startMockUpstream();
  await call("agents.update", {
    token: ana, body: { id: mockAgentId, api_base_url: `http://127.0.0.1:${presentMock.port}/v1` },
  });
  const x27Key = (await call("streams.mcpkey.rotate", { token: ana, body: { stream_id: streamId } })).payload.key;
  const x27Ledger = await call("files.upload", {
    token: ana, body: { stream_id: streamId, name: "交付台账.md", content: "# 交付台账\n灰度通过" },
  });
  await call("files.upload", { token: ana, body: { stream_id: streamId, name: "只交的清单.txt", content: "清单" } });
  await call("files.upload", { token: ana, body: { stream_id: streamId, name: "交付后崩的台账.md", content: "崩前交完" } });
  await call("files.upload", { token: ana, body: { stream_id: streamId, name: "排程巡检表.md", content: "巡检" } });
  // 别的群才有的文件：present 只能指向本群的文件行。
  const x27OtherStream = await call("streams.create", { token: ana, body: { name: "交付隔离组" } });
  await call("files.upload", {
    token: ana,
    body: { stream_id: x27OtherStream.payload.stream?.id, name: "别群的秘密.md", content: "只有那个群有" },
  });
  const x27Chats = async () => (await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } })).payload.items ?? [];
  const x27ReplyOf = async (keyword) => (await x27Chats())
    .filter((row) => row.sender_id === mockAgentId).find((row) => String(row.content).includes(keyword));
  const x27CardOf = async (fileName) => (await x27Chats())
    .filter((row) => row.sender_id === mockAgentId).find((row) => (row.presented ?? []).some((item) => item.name === fileName));
  const x27StepsOf = async (mailId) => (await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: mailId } })).payload.steps ?? [];

  const x27Mail = await sendFor("@小M 把交付台账交出去（交付台账）");
  const x27Reply = await x27ReplyOf("台账交出去了");
  check("present 之后回复消息挂上交付卡片：文件名、大小与交付说明都在卡片上",
    x27Reply?.presented?.length === 1 && x27Reply.presented[0].name === "交付台账.md"
      && x27Reply.presented[0].file_id === x27Ledger.payload.file?.id
      && String(x27Reply.presented[0].note).includes("按这份台账验收"), x27Reply?.presented);
  check("卡片只带引用不带原件：正文仍在 app.files，翻页不会拖着文件内容",
    Object.keys(x27Reply?.presented?.[0] ?? {}).sort().join(",") === "content_type,file_id,name,note,size_bytes"
      && !JSON.stringify(x27Reply?.presented ?? []).includes("灰度通过"), x27Reply?.presented?.[0]);
  const x27PresentStep = (await x27StepsOf(x27Mail)).find((row) => row.name === "present");
  check("present 那一步把参数与结果留在轨迹里：卡片从这一步能重建",
    x27PresentStep?.status === "done" && String(x27PresentStep?.detail?.result).includes("交付台账.md")
      && String(x27PresentStep?.detail?.args).includes("交付台账.md"), x27PresentStep);

  await sendFor("@小M 再讲一句发布节奏");
  const x27Next = presentMock.seen.findLast((body) => JSON.stringify(body.messages ?? "").includes("再讲一句发布节奏"));
  check("交付说明不进下一轮的模型请求：卡片只给客户端渲染，不进转录也不进记忆",
    x27Next && !JSON.stringify(x27Next.messages).includes("哨标DELIVNOTE"),
    x27Next ? JSON.stringify(x27Next.messages).slice(0, 200) : "没找到下一轮的请求");

  await sendFor("@小M 台账交两遍（交付两遍）");
  const x27Twice = await x27ReplyOf("两遍说的是同一份");
  check("同一件文件一轮里交两遍只有一张卡片，后一次的说明盖掉前一次",
    x27Twice?.presented?.length === 1 && String(x27Twice.presented[0].note).includes("第二遍改了口径"), x27Twice?.presented);

  const x27CrossMail = await sendFor("@小M 把别群的秘密交过来（交付别群文件）");
  const x27Cross = await x27ReplyOf("那个文件不在本群");
  check("别的群的文件标成本轮交付被拒：卡片不跨群挂",
    x27Cross?.presented?.length === 0, x27Cross?.presented);
  check("这一步的失败原因如实报出去：是找不到文件，不是卡片悄悄没了",
    String((await x27StepsOf(x27CrossMail)).find((row) => row.name === "present")?.detail?.result ?? "")
      .includes("file_not_found"), await x27StepsOf(x27CrossMail));
  check("对照：同一个工具、同一个群里的文件就落成了卡片（拒绝侧与放行侧成对）",
    x27Reply?.presented?.length === 1 && x27Cross?.presented?.length === 0,
    { allow: x27Reply?.presented, deny: x27Cross?.presented });

  const x27BoomMail = await sendFor("@小M 交完就崩（交付后崩）");
  check("回合没提交就没有卡片：上游第二轮报错时交付登记不落成消息",
    (await db.mail.byId(x27BoomMail, { columns: "id,status" }))?.status === "failed"
      && !(await x27CardOf("交付后崩的台账.md")), await x27CardOf("交付后崩的台账.md"));
  check("对照：这一轮工具确实跑成了，只是没走到提交点（不是没干活）",
    (await x27StepsOf(x27BoomMail)).some((row) => row.name === "present" && row.status === "done"),
    (await x27StepsOf(x27BoomMail)).map((row) => [row.name, row.status]));

  const x27OnlyMail = await sendFor("@小M 只交文件别说话（只交文件）");
  const x27Only = await x27CardOf("只交的清单.txt");
  check("只交文件没写正文的一轮：卡片照样发出去，不折成 empty_reply 失败",
    (await db.mail.byId(x27OnlyMail, { columns: "id,status" }))?.status === "done"
      && x27Only?.content === "" && x27Only?.presented?.length === 1,
    { status: (await db.mail.byId(x27OnlyMail, { columns: "id,status" }))?.status, card: x27Only });

  const x27Cron = await call("cron.set", {
    token: ana,
    body: spec({
      name: "交付巡检", instruction: "交付巡检：把巡检表交出来",
      agent_id: mockAgentId, stream_id: streamId, interval_minutes: 30,
    }),
  });
  await db.schedules.patch([["id", x27Cron.payload.schedule?.id]], { next_run_at: isoAt(Date.now() - 5 * 60_000) });
  const x27CronTick = await call("scheduler.tick", { token: ana, method: "GET" });
  const x27CronCard = await x27CardOf("排程巡检表.md");
  check("排程那一轮只交文件不写正文：交付优先于静默，到点干的活要在群里看得见",
    (x27CronTick.payload.ran ?? []).some((row) => row.mode === "delivery" && row.status === "done")
      && x27CronCard?.content === "" && x27CronCard?.presented?.length === 1,
    { ran: x27CronTick.payload.ran?.map((row) => row.mode), card: x27CronCard });

  const x27ToolScope = { agentId: mockAgentId, streamId, ownerId: anaId };
  const x27LongNote = await toolSafe(x27ToolScope, "present", { name: "交付台账.md", note: "字".repeat(80) });
  check("交付说明超上限整条拒绝，不悄悄截短", x27LongNote?.error === "invalid_note", x27LongNote);
  const x27ShortNote = await toolSafe(x27ToolScope, "present", { name: "交付台账.md", note: "限内的一行说明" });
  check("对照：限内的说明登记得成（同一把尺子的放行侧）",
    x27ShortNote?.entry?.note === "限内的一行说明" && x27ShortNote?.entry?.file_id === x27Ledger.payload.file?.id,
    x27ShortNote);
  const x27NoSelector = await toolSafe(x27ToolScope, "present", { note: "没说要交哪个文件" });
  check("既没 id 也没文件名：整条拒绝，不猜要交哪一个",
    x27NoSelector?.error === "file_selector_required", x27NoSelector);

  const x27McpTools = await rawMcp(x27Key, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("对外 MCP 的清单里没有 present：卡片要挂在员工回合上，外部调用不属于任何回合",
    !(x27McpTools.result?.tools ?? []).some((row) => row.name === "present"),
    (x27McpTools.result?.tools ?? []).map((row) => row.name));
  const x27McpCall = await rawMcp(x27Key, {
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "present", arguments: { name: "交付台账.md" } },
  });
  check("外部钥匙硬点 present 被挡在清单外", x27McpCall.error?.message === "tool_not_allowed", x27McpCall);
  const x27McpFiles = await rawMcp(x27Key, {
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_files", arguments: {} },
  });
  check("对照：外部钥匙照常读得到群文件，挡的只是这一件没有回合可挂的工具",
    !x27McpFiles.result?.error && String(x27McpFiles.result?.content?.[0]?.text).includes("交付台账.md"),
    x27McpFiles.result);
  await presentMock.close();

  step("\n§28 上游坏德性：半截与断流不算回复、状态码要有名字，修好后重新 @ 才再来一次");
  const x28Mock = await startMockUpstream();
  await call("agents.update", {
    token: ana, body: { id: mockAgentId, api_base_url: `http://127.0.0.1:${x28Mock.port}/v1` },
  });
  const x28Chats = async () => (await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } })).payload.items ?? [];
  const x28MailOf = async (mailId) => await db.mail.byId(mailId, { columns: "id,status,error" });
  const x28StepsOf = async (mailId) => (await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: mailId } })).payload.steps ?? [];

  x28Mock.scripts.chat = "half";
  const x28HalfMail = await sendFor("@小M 这段说到一半就断");
  const x28Half = await x28MailOf(x28HalfMail);
  check("流走到尽头既没 [DONE] 也没 finish_reason：这轮标失败，不拿半截正文冒充回复",
    x28Half?.status === "failed" && x28Half?.error === "upstream_stream_incomplete", x28Half);
  const x28HalfRoom = (await x28Chats()).filter((row) => String(row.content).includes("这段回复"));
  check("半截正文一个字都没进群：同事看不到一句缺尾巴的话", x28HalfRoom.length === 0, x28HalfRoom);
  // messages.list 回的是按 seq 升序的一页，所以"最新那条"取末尾而不是取头。
  const x28HalfSys = (await x28Chats())
    .filter((row) => row.sender_type === "system" && String(row.content).includes("没能完成")).at(-1);
  check("群里那句失败提示带错误码，并且不再谎称邮箱会自动重试（没有自动重投这条路）",
    String(x28HalfSys?.content).includes("upstream_stream_incomplete")
      && !String(x28HalfSys?.content).includes("可重试"), x28HalfSys?.content);
  const x28HalfStep = (await x28StepsOf(x28HalfMail)).find((row) => row.kind === "model");
  check("模型那一步在轨迹里落同一个码：界面那句为什么失败对得上后台记录",
    x28HalfStep?.status === "failed" && x28HalfStep?.error === "upstream_stream_incomplete", x28HalfStep);
  check("失败的那轮没有未合上的步骤：状态只在提交点发布",
    (await x28StepsOf(x28HalfMail)).every((row) => row.status !== "running"),
    (await x28StepsOf(x28HalfMail)).map((row) => [row.kind, row.status]));

  x28Mock.scripts.chat = "eof";
  const x28EofMail = await sendFor("@小M 一个字节都没吐就挂断");
  const x28Eof = await x28MailOf(x28EofMail);
  check("连着但空着：报的是断流，不塌成一句看不出原因的 empty_reply",
    x28Eof?.status === "failed" && x28Eof?.error === "upstream_stream_incomplete", x28Eof);

  x28Mock.scripts.chat = "500";
  const x28BoomMail = await sendFor("@小M 上游自己崩了");
  const x28Boom = await x28MailOf(x28BoomMail);
  check("上游 5xx 落成有名字的码，不是裸状态串「500」",
    x28Boom?.status === "failed" && x28Boom?.error === "upstream_server_error", x28Boom);

  // 三条坏德性都是开关，不是关键词：拨回 ok 之后同一批人重新 @ 就该正常跑完，
  // 否则前面那几条检查分不清"上游修好了"和"邮箱被上一封锁死了"。
  x28Mock.scripts.chat = "ok";
  const x28BackMail = await sendFor("@小M 上游修好了再来一次");
  const x28Back = await x28MailOf(x28BackMail);
  check("对照：开关拨回正常后重新 @ 的那封跑成并把正文落群（失败不锁邮箱）",
    x28Back?.status === "done"
      && (await x28Chats()).some((row) => row.sender_id === mockAgentId && String(row.content).includes("已按时间排好")),
    { mail: x28Back, newest: (await x28Chats()).filter((row) => row.sender_id === mockAgentId).at(-1)?.content });
  const x28HalfAgain = await x28MailOf(x28HalfMail);
  check("坏掉的那三封仍停在 failed：恢复只认新的一封信，不回头改写旧结局",
    [x28HalfAgain?.status, (await x28MailOf(x28EofMail))?.status, (await x28MailOf(x28BoomMail))?.status]
      .every((status) => status === "failed"), x28HalfAgain);
  await x28Mock.close();

  step("\n§29 dreaming：各群的压缩摘要归并成主人级全局记忆（三个入口、覆盖水位与跨群隐私）");
  // 输入预算放宽到装得下这台机器上攒出来的全部摘要：§8~§28 那些群也有摘要，第一轮归并看得见它们是真实行为，
  // 但这一节要断言的是"两个新群的要点都进了那次请求"，所以先把预算这个旋钮调到不影响判断的地方。
  process.env.WORKSTREAM_DREAM_INPUT_CHARS = "60000";
  const x29Mock = await startMockUpstream();
  const x29Agent = await call("agents.create", {
    token: ana,
    body: {
      name: "小D", role: "归并试验", backend: "openai", api_base_url: `http://127.0.0.1:${x29Mock.port}/v1`,
      api_key: "mock-key-dream", model: "mock", context_chars: 2000,
    },
  });
  const x29Id = x29Agent.payload.agent?.id;
  const roomA = await call("streams.create", { token: ana, body: { name: "归并甲组", agent_ids: [x29Id] } });
  const roomB = await call("streams.create", { token: ana, body: { name: "归并乙组", agent_ids: [x29Id] } });
  const roomAId = roomA.payload.stream?.id;
  const roomBId = roomB.payload.stream?.id;
  const x29Tick = async (wantMode, sid) => {
    for (let round = 0; round < 10; round += 1) {
      const tick = await call("scheduler.tick", { token: ana, method: "GET" });
      const hit = (tick.payload.ran ?? []).find((row) => row.mode === wantMode && row.stream_id === sid);
      if (hit) return hit;
    }
    return null;
  };
  // 小D 的预算只有 2000 字，回复窗口按八折封顶（1600 字）：五条各三百多字才把尾窗撑到字符上限之外
  // （truncated），这一轮才会补投后台压缩信；条数还得过 SUMMARY_MIN_ROWS=4 才真折得动。
  const foldRoom = async (sid, mention = { name: "小D", id: x29Id }) => {
    for (const word of ["素材甲", "素材乙", "素材丙", "素材丁", "素材戊"]) {
      await call("messages.send", {
        token: ana,
        body: { stream_id: sid, content: `攒一段可折的记录 ${word} ${"补一段上下文让窗口装不下".repeat(30)}` },
      });
    }
    await call("messages.send", {
      token: ana,
      body: { stream_id: sid, content: `@${mention.name} 攒一段好折的对话`, mentions: [{ type: "agent", id: mention.id }] },
    });
    return x29Tick("compress", sid);
  };
  const x29State = (token = ana) => call("dreaming.get", { token, method: "GET" });
  // 水位线的键是 (员工, 群)：同一个群里两个员工各折一份摘要，只按群记就会互盖序号（小D 名下就是它自己）。
  const x29Key = (sid) => `${x29Id}:${sid}`;
  // 轨迹的 detail 每个字段落库前都过一遍 asText，数组回来就是 JSON 串——读它按那个口径读。
  const x29List = (value) => {
    if (Array.isArray(value)) return value;
    try { return JSON.parse(String(value ?? "[]")); } catch { return []; }
  };
  /** 归并那封信的模型步 detail：这一节有好几处要问「这一轮到底吃了哪些素材」。 */
  const x29DetailOf = async (mailId) => {
    if (!mailId) return {};
    const steps = (await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: mailId } })).payload.steps ?? [];
    return steps.find((row) => row.kind === "model")?.detail ?? {};
  };
  const x29Reqs = () => x29Mock.seen.filter((body) => String(body.messages?.[0]?.content ?? "").includes("主人全局记忆"));
  const x29Pending = async () => (await db.mail.list([["agent_id", x29Id], ["status", "queued"]], { columns: "meta", limit: 60 }))
    .filter((row) => row.meta?.kind === "dreaming").length;

  check("未登录读不到别人的全局记忆", (await x29State(null)).status === 401);
  const x29Fresh = (await x29State()).payload;
  check("还没归并过：记忆是空的、上一次归并也是空的，界面不该拿 null 装作跑过",
    x29Fresh.ok === true && x29Fresh.memory === null && x29Fresh.last_run === null && x29Fresh.auto === false, x29Fresh);

  const foldA = await foldRoom(roomAId);
  const foldB = await foldRoom(roomBId);
  check("两个群各折出一份压缩摘要：归并的素材是这两段摘要，不是两份转录",
    Boolean(foldA) && Boolean(foldB), { foldA, foldB });
  const x29Summaries = await db.memories.list(
    [["agent_id", x29Id], ["scope", "stream"], ["kind", "summary"]],
    { columns: "stream_id,covers_through_seq", limit: 20 },
  );
  check("两份摘要都带着覆盖水位：归并只看比上次更新的段",
    x29Summaries.length === 2 && x29Summaries.every((row) => Number(row.covers_through_seq) > 0), x29Summaries);

  const borrowDream = await call("dreaming.run", { token: bToken, body: { agent_id: x29Id, stream_id: roomAId } });
  check("别人不能借我的员工归并：那是在烧我的 Key、并我的家底",
    borrowDream.status === 403 && borrowDream.payload.error === "agent_not_owned", borrowDream.payload);
  // 用 §26 那台没进这个群的员工：§26 末尾把「未入群」那台夹具员工删了，这里再拿它的 id 只会撞到 agent_not_found。
  const loneDream = await call("dreaming.run", { token: ana, body: { agent_id: cronAgentId, stream_id: roomAId } });
  check("员工不在那个群：这封信落不进任何邮箱，就地拒",
    loneDream.status === 400 && loneDream.payload.error === "agent_not_in_stream", loneDream.payload);
  // 放行那条要用 Bo 自己的群：dreaming.run 在归属之后还要查群成员，拿 Ana 的群只会撞到「不在群里」。
  const boRoom = await call("streams.create", { token: bToken, body: { name: "Bo 的归并组", agent_ids: [boAgentId] } });
  const boDream = await call("dreaming.run", {
    token: bToken, body: { agent_id: boAgentId, stream_id: boRoom.payload.stream?.id },
  });
  check("对照：Bo 给自己名下的员工、自己的群归并放行（越权那条不是把所有 run 都挡掉）",
    boDream.payload.ok === true && boDream.payload.queued === true, boDream.payload);

  const x29Run = await call("dreaming.run", { token: ana, body: { agent_id: x29Id, stream_id: roomAId } });
  check("手动按钮只投信，不在请求里等模型跑完", x29Run.payload.queued === true && Boolean(x29Run.payload.mail_id), x29Run.payload);
  const x29Twice = await call("dreaming.run", { token: ana, body: { agent_id: x29Id, stream_id: roomBId } });
  check("全局记忆一个主人只有一行：同一主人手上已经有一封没跑完的归并信就不重复投（换个群也一样）",
    x29Twice.payload.queued === false && x29Twice.payload.reason === "already_pending", x29Twice.payload);
  const x29DreamRun = await x29Tick("dreaming", roomAId);
  const x29Mail = await db.mail.byId(x29Run.payload.mail_id, { columns: "id,status,error,message_id,meta" });
  check("归并那一轮跑完且一个字不进群：silent 是这一类的固定德性",
    x29DreamRun?.status === "done" && x29DreamRun.mode === "dreaming"
      && x29DreamRun.dream === "ok" && x29DreamRun.silent === true, x29DreamRun);
  check("这封归并信不挂在某条消息上：它不是替谁回话",
    x29Mail?.message_id === null && x29Mail?.status === "done" && x29Mail?.meta?.reason === "manual", x29Mail);
  const x29RoomMsgs = (await call("messages.list", { token: ana, method: "GET", body: { stream_id: roomAId } })).payload.items ?? [];
  check("归并没有往群里塞话：群里只有同事那条 @ 和员工本人的回复",
    x29RoomMsgs.filter((row) => row.sender_id === x29Id).length === 1, x29RoomMsgs.map((row) => row.content));

  const x29After = (await x29State()).payload;
  check("全局记忆落成主人级那一行：内容是模型回的正文，抬头带哨标才能证明它真出自这次归并",
    String(x29After.memory?.content).includes("哨标DREAMOUT") && x29After.memory !== null, x29After.memory);
  check("覆盖水位按素材记：两个新群各有一份在里面",
    Number(x29After.memory?.covers_streams?.[x29Key(roomAId)]) > 0 && Number(x29After.memory?.covers_streams?.[x29Key(roomBId)]) > 0,
    x29After.memory?.covers_streams);
  const x29Boat = (await x29State(bToken)).payload;
  check("跨群隐私：Bo 读自己那份读到的是空，Ana 的归并结论一个字都不会漏给他",
    x29Boat.memory === null, x29Boat);
  const x29Req = x29Reqs().at(-1);
  check("上游收到的那一轮确实是拿摘要喂的：两个群的摘要抬头都在素材里",
    String(x29Req?.messages?.[1]?.content).includes("【群「归并甲组」摘要")
      && String(x29Req?.messages?.[1]?.content).includes("【群「归并乙组」摘要"), String(x29Req?.messages?.[1]?.content).slice(0, 200));
  check("喂的是摘要不是转录：素材里找不到群里那些原始记录",
    !String(x29Req?.messages?.[1]?.content).includes("攒一段可折的记录"), String(x29Req?.messages?.[1]?.content).slice(0, 160));
  const x29Traj = await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: x29Run.payload.mail_id } });
  const x29Step = (x29Traj.payload.steps ?? []).find((row) => row.kind === "model");
  check("这一轮进了轨迹：并了哪几份素材、各并到哪个水位、有没有被预算挤出去，都写在这一步里",
    x29Step?.status === "done" && x29List(x29Step.detail?.merged_streams).length >= 2,
    { 步骤: x29Step?.status, 归并: x29Step?.detail?.merged_streams });
  check("思考链不进群：它只落在这一步的 detail 里",
    String(x29Step?.detail?.reasoning).length > 0 && !x29RoomMsgs.some((row) => String(row.content).includes("先看上下文")), x29Step?.detail?.reasoning);

  const x29ReqsBefore = x29Reqs().length;
  const x29Noop = await call("dreaming.run", { token: ana, body: { agent_id: x29Id, stream_id: roomAId } });
  const x29NoopRun = await x29Tick("dreaming", roomAId);
  check("没有新要点的那一轮直接算没事：不付那次模型调用，信也照样结掉",
    x29NoopRun?.status === "done" && x29NoopRun.dream === "noop", { 跑: x29NoopRun, 信: x29Noop.payload.mail_id });
  check("对照：noop 这一轮上游一封归并请求都没多出来（只有真并的那一次付了模型调用）",
    x29ReqsBefore === 1 && x29Reqs().length === x29ReqsBefore, x29Reqs().length);

  const x29NextRound = await call("messages.send", {
    token: ana, body: { stream_id: roomBId, content: "@小D 全局记忆进提示词了吗", mentions: [{ type: "agent", id: x29Id }] },
  });
  let x29Carried = null;
  for (let round = 0; round < 5 && !x29Carried; round += 1) {
    await call("scheduler.tick", { token: ana, method: "GET" });
    x29Carried = x29Mock.seen.find((body) => {
      // 认触发块而不是整句：主人显示名在这个群里是别的写法，硬抄上一节的「安娜：」会永远匹配不上。
      const system = String(body.messages?.[0]?.content ?? "");
      return (system.split("\n\n").find((b) => b.startsWith("上一条 @ 你的消息")) ?? "").includes("@小D 全局记忆进提示词了吗");
    });
  }
  check("归并出来的全局记忆下一轮就被装配：模型可见的必须能从这一轮的请求里看见",
    String(x29Carried?.messages?.[0]?.content).includes("我的全局记忆"), {
      触发: x29NextRound.payload.ok,
      块: String(x29Carried?.messages?.[0]?.content).slice(0, 120),
      最近请求: x29Mock.seen.slice(-3).map((body) => String(body.messages?.[0]?.content ?? "").slice(-90)),
    });

  // 坏德性两条（空正文 / 5xx）都不许抬覆盖水位：并不动的素材要还能被下一轮看见。
  await foldRoom(roomAId);
  const x29WaterBefore = Number((await x29State()).payload.memory?.covers_streams?.[x29Key(roomAId)] ?? 0);
  x29Mock.scripts.dream = "empty";
  const x29EmptyRun = await call("dreaming.run", { token: ana, body: { agent_id: x29Id, stream_id: roomAId } });
  const x29Empty = await x29Tick("dreaming", roomAId);
  check("上游回空正文等于一个群都没并进去：这封如实结成 dream_failed 家的 dream_empty",
    x29Empty?.status === "failed" && x29Empty?.error === "dream_empty", x29Empty);
  check("失败不抬水位线：那几段摘要下一轮还是新素材",
    Number((await x29State()).payload.memory?.covers_streams?.[x29Key(roomAId)] ?? 0) === x29WaterBefore, await x29State());
  x29Mock.scripts.dream = "boom";
  const x29BoomRun = await call("dreaming.run", { token: ana, body: { agent_id: x29Id, stream_id: roomAId } });
  const x29Boom = await x29Tick("dreaming", roomAId);
  check("上游自己崩了落成有名字的码，不是裸状态串",
    x29Boom?.status === "failed" && x29Boom?.error === "upstream_server_error", x29Boom);
  x29Mock.scripts.dream = "ok";
  await call("dreaming.run", { token: ana, body: { agent_id: x29Id, stream_id: roomAId } });
  const x29Back = await x29Tick("dreaming", roomAId);
  check("对照：开关拨回正常后重新归并跑得成，水位线从原地推进（失败不锁信）",
    x29Back?.status === "done" && x29Back.dream === "ok"
      && Number((await x29State()).payload.memory?.covers_streams?.[x29Key(roomAId)] ?? 0) > x29WaterBefore, x29Back);
  const x29EmptyAgain = await db.mail.byId(x29EmptyRun.payload.mail_id, { columns: "id,status,error" });
  const x29BoomAgain = await db.mail.byId(x29BoomRun.payload.mail_id, { columns: "id,status,error" });
  check("坏掉的那两封仍停在 failed 并带着各自的码：恢复只认新的一封信，不回头改写旧结局",
    x29EmptyAgain?.status === "failed" && x29EmptyAgain?.error === "dream_empty"
      && x29BoomAgain?.status === "failed" && x29BoomAgain?.error === "upstream_server_error",
    { 空正文: x29EmptyAgain, 上游崩: x29BoomAgain });

  // 输出预算收在能看见最终正文的那一处：模型回得再长，落库与每轮提示词里的那份都不许超。
  process.env.WORKSTREAM_DREAM_OUTPUT_CHARS = "10";
  await foldRoom(roomBId);
  await call("dreaming.run", { token: ana, body: { agent_id: x29Id, stream_id: roomBId } });
  const x29Capped = await x29Tick("dreaming", roomBId);
  const x29CappedText = String((await x29State()).payload.memory?.content ?? "");
  check("正文超预算时按完整结果收口：落库那份被截到预算内并留省略号",
    x29Capped?.dream === "ok" && x29CappedText.length === 11 && x29CappedText.endsWith("…"), x29CappedText);
  delete process.env.WORKSTREAM_DREAM_OUTPUT_CHARS;

  const x29Cleared = await call("dreaming.clear", { token: ana, body: {} });
  check("清空全局记忆：删的是主人级那一行，连同每群的覆盖水位",
    x29Cleared.payload.ok === true && (await x29State()).payload.memory === null, x29Cleared.payload);
  await call("dreaming.run", { token: ana, body: { agent_id: x29Id, stream_id: roomAId } });
  const x29Redo = await x29Tick("dreaming", roomAId);
  check("对照：清掉水位之后同一批摘要算新素材，再归并一次照样并得出来",
    x29Redo?.dream === "ok" && Object.keys((await x29State()).payload.memory?.covers_streams ?? {}).length >= 2, await x29State());

  // 预算装不下全部素材时：被挤出去的那份不算"已归并"，水位不推，留到下一次。
  // 输入预算压不下去（INPUT_CHARS_MIN=2000），所以素材得真攒到那么长：再开两个群，并让摘要一次折满
  // 引擎那一侧的 600 字上限——四份各 600 字的摘要，一口气就装不进 2000 字。
  const roomCId = (await call("streams.create", { token: ana, body: { name: "归并丙组", agent_ids: [x29Id] } })).payload.stream?.id;
  const roomDId = (await call("streams.create", { token: ana, body: { name: "归并丁组", agent_ids: [x29Id] } })).payload.stream?.id;
  x29Mock.scripts.compress = "long";
  const x29LongFolds = [];
  for (const sid of [roomAId, roomBId, roomCId, roomDId]) x29LongFolds.push(await foldRoom(sid));
  x29Mock.scripts.compress = "ok";
  check("四个群各折出一份摘要：预算那一条要撞得动，先把素材摆够",
    x29LongFolds.every(Boolean), x29LongFolds);
  process.env.WORKSTREAM_DREAM_INPUT_CHARS = "2000";
  await call("dreaming.clear", { token: ana, body: {} });
  const x29TightRun = await call("dreaming.run", { token: ana, body: { agent_id: x29Id, stream_id: roomAId } });
  const x29Tight = await x29Tick("dreaming", roomAId);
  const x29TightCovers = Object.keys((await x29State()).payload.memory?.covers_streams ?? {}).length;
  const x29TightSteps = (await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: x29TightRun.payload.mail_id } })).payload.steps ?? [];
  const x29TightDetail = x29TightSteps.find((row) => row.kind === "model")?.detail ?? {};
  const x29TightMerged = x29List(x29TightDetail.merged_streams);
  check("四份长摘要装不进 2000 字预算：只并得下前几份，水位线如实停在这儿而不是全抬上去",
    x29Tight?.dream === "ok" && x29TightMerged.length > 0
      && x29TightCovers === x29TightMerged.length && x29TightCovers < 4,
    { 并了: x29TightMerged.length, 水位: x29TightCovers, 清单: x29TightDetail.merged_streams });
  check("被预算挤出去的那份如实记进 skipped_streams：它的结论没被当成已归并",
    x29List(x29TightDetail.skipped_streams).length > 0, x29TightDetail.skipped_streams);
  delete process.env.WORKSTREAM_DREAM_INPUT_CHARS;
  const x29LooseRun = await call("dreaming.run", { token: ana, body: { agent_id: x29Id, stream_id: roomAId } });
  const x29Loose = await x29Tick("dreaming", roomAId);
  const x29LooseSteps = (await call("agents.trajectory", { token: ana, method: "GET", body: { mail_id: x29LooseRun.payload.mail_id } })).payload.steps ?? [];
  const x29LooseDetail = x29LooseSteps.find((row) => row.kind === "model")?.detail ?? {};
  const x29LooseCovers = Object.keys((await x29State()).payload.memory?.covers_streams ?? {}).length;
  const x29LooseMerged = x29List(x29LooseDetail.merged_streams);
  const x29LooseKeys = new Set(x29LooseMerged.map((row) => `${row.agent_id}:${row.stream_id}`));
  // 这一轮是增量归并：水位是历次累计的，所以它等于「这轮并了几份」只在清空过一次后才成立。
  // 放开预算真正要证明的是上一轮被挤出去的那几份这一次全补上了，于是逐个点名，不数总数。
  const x29TightSkipped = x29List(x29TightDetail.skipped_streams);
  check("对照：预算放开后上一轮欠着的那几份全并进来了，这一步没有素材再被挤出去",
    x29Loose?.dream === "ok" && x29LooseCovers > x29TightCovers
      && x29List(x29LooseDetail.skipped_streams).length === 0
      && x29TightSkipped.every((row) => x29LooseKeys.has(`${row.agent_id}:${row.stream_id}`)),
    { 之前: x29TightCovers, 之后: x29LooseCovers, 这轮并了: x29LooseMerged.length, 上轮欠的: x29TightSkipped.length });

  // 同一个群里两个员工：各自折出自己那一份摘要，两份素材的覆盖序号互不相干。
  // 水位键只按群记时后写的那条会把前一条盖掉——被盖掉的要么每轮重并（白付调用），要么被当成已归并而永久漏掉，
  // 两种都不会报错，所以这条要单独钉住，不能只靠注释。
  const x29Peer = await call("agents.create", {
    token: ana,
    body: {
      name: "小F", role: "归并同群", backend: "openai", api_base_url: `http://127.0.0.1:${x29Mock.port}/v1`,
      api_key: "mock-key-peer", model: "mock", context_chars: 2000,
    },
  });
  const x29PeerId = x29Peer.payload.agent?.id;
  const roomEId = (await call("streams.create", {
    token: ana, body: { name: "归并戊组", agent_ids: [x29Id, x29PeerId] },
  })).payload.stream?.id;
  const x29PeerFolds = [];
  for (const id of [x29Id, x29PeerId]) x29PeerFolds.push(await foldRoom(roomEId, { name: id === x29Id ? "小D" : "小F", id }));
  check("同一个群里两位员工各折出一份摘要：先把两份素材摆出来，键少一个维度就撞不上",
    x29PeerFolds.every(Boolean), x29PeerFolds);
  const x29PairRun = await call("dreaming.run", { token: ana, body: { agent_id: x29Id, stream_id: roomEId } });
  const x29Pair = await x29Tick("dreaming", roomEId);
  const x29PairCovers = (await x29State()).payload.memory?.covers_streams ?? {};
  check("归并的键带得上员工：同一个群里两份摘要各记各的水位，谁也不盖谁的序号",
    x29Pair?.dream === "ok" && x29PairRun.payload.queued === true
      && Number(x29PairCovers[`${x29Id}:${roomEId}`] ?? 0) > 0
      && Number(x29PairCovers[`${x29PeerId}:${roomEId}`] ?? 0) > 0, x29PairCovers);
  await call("dreaming.run", { token: ana, body: { agent_id: x29Id, stream_id: roomEId } });
  const x29PairAgain = await x29Tick("dreaming", roomEId);
  // 这一轮允许再并，但只能并「这之后新折出来的素材」：同一条素材带着同一个水位再进一次请求体，
  // 就是水位键少了一个维度时那种每轮重并（每轮白付一次调用）的样子。
  const x29PairPaid = new Set(x29List((await x29DetailOf(x29PairRun.payload.mail_id)).merged_streams)
    .map((row) => `${row.agent_id}:${row.stream_id}:${row.covers}`));
  const x29AgainPaid = x29List((await x29DetailOf(x29PairAgain?.mail_id)).merged_streams);
  check("对照：戊组那两份不并第二遍——水位认得出它们已经并过，盖掉序号的那种错账在这里露出来",
    ["ok", "noop"].includes(x29PairAgain?.dream)
      && x29AgainPaid.every((row) => !x29PairPaid.has(`${row.agent_id}:${row.stream_id}:${row.covers}`)),
    { 这轮并的: x29AgainPaid, 上轮并的: [...x29PairPaid] });

  // 入口二：群一折叠历史就顺手归并，开关挂在主人身上而不是员工身上。
  const x29AutoOn = await call("auth.patch", { token: ana, body: { prefs: { dreaming_auto: true } } });
  check("开关只有一个写入口：主人改掉之后 dreaming.get 读到的就是新的",
    x29AutoOn.payload.ok === true && (await x29State()).payload.auto === true, (await x29State()).payload);
  const x29BeforeAuto = await x29Pending();
  // foldRoom 自己就把这一轮的折叠跑完了（它就是靠找 compress 那行返回的），归并信正是在那一步里补投的：
  // 这里再 tick 一次等的是一份不会来的第二封，那一轮的结局要读的是 foldRoom 的返回值。
  const x29AutoCompress = await foldRoom(roomAId);
  check("摘要真推进了才谈得上归并：这一轮确实折动了", x29AutoCompress?.status === "done", x29AutoCompress);
  const x29AutoRun = await x29Tick("dreaming", roomAId);
  check("开了开关：群一折叠完就自动补一封归并信，并且如实记下是折叠叫醒的",
    x29AutoRun?.status === "done" && x29AutoRun.dream === "ok", x29AutoRun);
  const x29AutoMail = await db.mail.byId(x29AutoRun?.mail_id ?? "00000000-0000-0000-0000-000000000000", { columns: "id,meta" });
  check("这封信的 reason 是 auto：界面上的「上一次归并」要能分清三个入口",
    x29AutoMail?.meta?.kind === "dreaming" && x29AutoMail?.meta?.reason === "auto", x29AutoMail);
  await call("auth.patch", { token: ana, body: { prefs: { dreaming_auto: false } } });
  const x29OffBefore = await x29Pending();
  const x29OffCompress = await foldRoom(roomBId);
  check("对照：关了开关折叠照旧跑——关的只是归并那一步，不是把压缩一起停了",
    x29OffCompress?.status === "done", x29OffCompress);
  check("对照：关了开关之后同一次折叠不再补归并信（开关不是摆设，也不是无条件开刀）",
    (await x29Pending()) === x29OffBefore && x29OffBefore === x29BeforeAuto,
    { 开之前: x29BeforeAuto, 关之后: await x29Pending() });

  // 入口三：定时归并复用排程那一个时钟，只差投出去的信是哪一种。
  const x29BadPurpose = await call("cron.set", { token: ana, body: { ...spec(), purpose: "nightly" } });
  check("不认识的 purpose 就地拒：宁可少一种排程，也不留一个没人认领的种类",
    x29BadPurpose.status === 400 && x29BadPurpose.payload.error === "invalid_purpose", x29BadPurpose.payload);
  const x29DreamSpec = await call("cron.set", {
    token: ana,
    body: {
      name: "晚间归并", instruction: "只并待办和数字", agent_id: x29Id, stream_id: roomAId,
      kind: "every", interval_minutes: 60, purpose: "dreaming",
    },
  });
  const x29DreamScheduleId = x29DreamSpec.payload.schedule?.id;
  check("做梦排程建得成：正文是额外交代，不是必填（干活那类仍然必填）",
    x29DreamSpec.payload.ok === true && x29DreamSpec.payload.schedule?.purpose === "dreaming", x29DreamSpec.payload);
  const x29DreamNoText = await call("cron.set", {
    token: ana,
    body: { name: "晚间归并二", instruction: "", agent_id: x29Id, stream_id: roomAId, kind: "every", interval_minutes: 60, purpose: "dreaming" },
  });
  check("对照：归并这一类允许留空正文，落库是空串而不是悄悄补一句默认话术",
    x29DreamNoText.payload.ok === true && x29DreamNoText.payload.schedule?.instruction === "", x29DreamNoText.payload);
  const x29DreamWork = await call("cron.set", {
    token: ana, body: { name: "干活也要空正文", instruction: "", agent_id: x29Id, stream_id: roomAId, kind: "every", interval_minutes: 60 },
  });
  check("干活那一类留空正文仍然被拒：空正文等于让模型在群里没话说",
    x29DreamWork.status === 400 && x29DreamWork.payload.error === "invalid_instruction", x29DreamWork.payload);
  const x29SwitchPurpose = await call("cron.set", {
    token: ana, body: { id: x29DreamScheduleId, name: "晚间归并", instruction: "只并待办和数字", agent_id: x29Id, stream_id: roomAId, kind: "every", interval_minutes: 60 },
  });
  check("同一条排程不许从归并改成干活：换 purpose 和换员工一样是换了语义，要改就删了重建",
    x29SwitchPurpose.status === 400 && x29SwitchPurpose.payload.error === "schedule_target_locked", x29SwitchPurpose.payload);
  const x29KeepPurpose = await call("cron.set", {
    token: ana, body: { id: x29DreamScheduleId, name: "晚间归并改个名", instruction: "只并待办和数字", agent_id: x29Id, stream_id: roomAId, kind: "every", interval_minutes: 120, purpose: "dreaming" },
  });
  check("对照：同 purpose 内改节奏和名字放行（锁的只是那三样目标）", x29KeepPurpose.payload.ok === true, x29KeepPurpose.payload);

  await foldRoom(roomAId);
  await db.schedules.patch([["id", x29DreamScheduleId]], { next_run_at: isoAt(Date.now() - 5 * MINUTE) });
  const x29CronTick = await call("scheduler.tick", { token: ana, method: "GET" });
  const x29CronFired = (x29CronTick.payload.cron ?? []).find((row) => row.schedule_id === x29DreamScheduleId);
  check("到点的归并排程投出的是归并信：种类写在 meta 里，不是回查排程行",
    Boolean(x29CronFired?.mail_id) && (await db.mail.byId(x29CronFired.mail_id, { columns: "id,meta" })).meta?.kind === "dreaming",
    x29CronFired);
  const x29CronMail = await db.mail.byId(x29CronFired?.mail_id ?? "00000000-0000-0000-0000-000000000000", { columns: "id,status,error,meta" });
  check("这一轮跑成，并如实记下是排程叫醒的；主人额外交代那句话进了这封信",
    x29CronMail?.meta?.reason === "cron" && String(x29CronMail?.meta?.dreaming?.instruction).includes("只并待办和数字"), x29CronMail);
  const x29CronReq = x29Reqs().at(-1);
  check("额外交代进了模型看到的正文：指令进了请求体就得能从这一步复原",
    String(x29CronReq?.messages?.[0]?.content).includes("主人这次额外交代：只并待办和数字"), String(x29CronReq?.messages?.[0]?.content).slice(-160));
  const x29CronRan = (x29CronTick.payload.ran ?? []).find((row) => row.mail_id === x29CronFired?.mail_id);
  check("定时那一轮同样不进群：模式标 dreaming、silent 恒真",
    x29CronRan?.mode === "dreaming" && x29CronRan?.silent === true, x29CronRan);

  // 删排程要把还没跑的那封归并信一起撤回：用户删的是排程，不是"以后不排、这一下照旧跑"。
  const x29QueuedMail = await db.mail.insert({
    id: newId(), agent_id: x29Id, stream_id: roomAId, message_id: null, trigger_seq: 0,
    priority: 1, status: "queued", slice_count: 0, error: null,
    created_at: new Date().toISOString(), started_at: null, finished_at: null, updated_at: new Date().toISOString(),
    meta: { kind: "dreaming", schedule_id: x29DreamScheduleId, dreaming: { name: "晚间归并改个名", instruction: "只并待办和数字" } },
  }, { columns: "id" });
  const x29Delete = await call("cron.delete", { token: ana, body: { id: x29DreamScheduleId } });
  check("删掉归并排程时那封还没跑的信一并撤回：种类不同不代表可以留下",
    x29Delete.payload.cancelled >= 1
      && (await db.mail.byId(x29QueuedMail?.id ?? "00000000-0000-0000-0000-000000000000", { columns: "id,status" }))?.status === "cancelled",
    x29Delete.payload);
  await call("dreaming.clear", { token: ana, body: {} });
  delete process.env.WORKSTREAM_DREAM_INPUT_CHARS;
  delete process.env.WORKSTREAM_DREAM_OUTPUT_CHARS;
  await x29Mock.close();

  step("\n§30 接龙：员工回复里的 @ 交给下一位，跳数有上限、只认本群在岗成员");
  // 员工 @ 员工走的是 fanout：回复落群时把 @ 到的员工投成一封新任务，跳数记在 meta.hops 上。
  // 上限存在的理由是「两个模型互相 @ 可以永远说下去」，所以这一节既验接得起来，也验停得下来。
  const x30Mock = await startMockUpstream();
  const x30Url = `http://127.0.0.1:${x30Mock.port}/v1`;
  const x30Make = (name) => call("agents.create", {
    token: ana,
    body: { name, role: "接龙", backend: "openai", api_base_url: x30Url, api_key: "mock-key-30", model: "mock", context_chars: 8000 },
  });
  const x30JiaId = (await x30Make("甲一")).payload.agent?.id;
  const x30YiId = (await x30Make("乙二")).payload.agent?.id;
  const x30WaiId = (await x30Make("丙三")).payload.agent?.id;
  const x30Room = await call("streams.create", { token: ana, body: { name: "接龙组", agent_ids: [x30JiaId, x30YiId] } });
  const x30RoomId = x30Room.payload.stream?.id;
  x30Mock.scripts.chain = ["甲一", "乙二"];
  const x30Ask = (content) => call("messages.send", {
    token: ana, body: { stream_id: x30RoomId, content, mentions: [{ type: "agent", id: x30JiaId }] },
  });
  const x30Replies = () => db.messages.list(
    [["stream_id", x30RoomId], ["sender_type", "agent"]], { columns: "id,seq,sender_id,mentions,content", limit: 200 },
  );
  const x30Mails = (agentId) => db.mail.list([["agent_id", agentId], ["stream_id", x30RoomId]], {
    columns: "id,status,error,meta,message_id", limit: 50,
  });
  const x30MailsFor = (messageId) => db.mail.list([["message_id", messageId]], {
    columns: "id,agent_id,status,meta", limit: 20,
  });
  const x30LastReply = async (needle) => (await x30Replies()).filter((m) => String(m.content).includes(needle)).at(-1);
  // 一次「甲一 回一句 @ 指定名字」的完整来回，返回那条回复和因它投出去的信。
  const x30Handoff = async () => {
    await x30Ask("@甲一 这段接给指定");
    await call("scheduler.tick", { token: ana, method: "GET" });
    const reply = await x30LastReply("请看这段");
    return { reply, mailed: await x30MailsFor(reply?.id) };
  };

  await x30Ask("@甲一 把这段接下去");
  const x30Hop1 = await call("scheduler.tick", { token: ana, method: "GET" });
  check("第一跳由真人起：@ 甲一 这一封先跑完",
    (x30Hop1.payload.ran ?? []).some((r) => r.agent_id === x30JiaId && r.status === "done"), x30Hop1.payload.ran);
  const x30JiaReply = await x30LastReply("这段请接下去");
  check("员工回复里的 @ 被认成本群成员：mentions 记到乙二",
    (x30JiaReply?.mentions ?? []).some((m) => m.type === "agent" && m.id === x30YiId), x30JiaReply);
  const x30HopMail = (await x30Mails(x30YiId)).find((row) => row.message_id === x30JiaReply?.id);
  check("接出来的那封如实带 hops=1 与 from_agent：跳数是这一轮跑出来的事实，不是事后猜的",
    x30HopMail?.status === "queued" && Number(x30HopMail?.meta?.hops) === 1 && x30HopMail?.meta?.from_agent === x30JiaId,
    x30HopMail);
  const x30Chain = [...(x30Hop1.payload.ran ?? [])];
  for (let round = 0; round < 8; round += 1) {
    const tick = await call("scheduler.tick", { token: ana, method: "GET" });
    x30Chain.push(...(tick.payload.ran ?? []));
    if (x30Chain.some((r) => r.error === "hop_limit")) break;
  }
  check("互相 @ 停在跳数上限：撞上限那一封结成 failed hop_limit",
    x30Chain.some((r) => r.status === "failed" && r.error === "hop_limit"), x30Chain);
  check("上限之内每跳都真的接住了：这一条链一共只回了 3 条，不是无限接龙",
    (await x30Replies()).length === 3, (await x30Replies()).map((m) => m.content));
  const x30StopMail = (await x30Mails(x30YiId)).find((row) => row.error === "hop_limit");
  const x30ByAgent = (await x30Replies()).reduce((acc, m) => ({ ...acc, [m.sender_id]: (acc[m.sender_id] ?? 0) + 1 }), {});
  check("撞上限那一封只结失败、不回帖：乙二 接住第一跳，第二跳被上限挡在门外",
    Number(x30ByAgent[x30JiaId]) === 2 && Number(x30ByAgent[x30YiId]) === 1
      && Number(x30StopMail?.meta?.hops) === 3, { x30ByAgent, x30StopMail });
  await x30Ask("@甲一 重新起一段接下去");
  const x30RestartTick = await call("scheduler.tick", { token: ana, method: "GET" });
  check("对照：真人重新 @ 一次跳数从 0 起，接龙照样跑得动（hop_limit 不是把员工拉黑）",
    (x30RestartTick.payload.ran ?? []).some((r) => r.agent_id === x30JiaId && r.status === "done")
      && (await x30Mails(x30YiId)).some((row) => Number(row.meta?.hops) === 1 && row.status === "queued"),
    x30RestartTick.payload.ran);
  // 排空重起的那条链：本节结束时队列要干净，否则下一节的 tick 会接到上一节的接龙信。
  for (let round = 0; round < 8; round += 1) {
    const pending = await db.mail.list(
      [["stream_id", x30RoomId], ["status", ["queued", "running"]]], { columns: "id", limit: 20 },
    );
    if (!pending.length) break;
    await call("scheduler.tick", { token: ana, method: "GET" });
  }

  await x30Ask("@甲一 这段接给自己");
  await call("scheduler.tick", { token: ana, method: "GET" });
  const x30SelfReply = await x30LastReply("我自己接");
  check("员工 @ 自己：那条 @ 记在 mentions 里读得出，但不给自己投新任务",
    (x30SelfReply?.mentions ?? []).some((m) => m.id === x30JiaId)
      && (await x30MailsFor(x30SelfReply?.id)).length === 0,
    { mentions: x30SelfReply?.mentions, 投出去的信: await x30MailsFor(x30SelfReply?.id) });

  x30Mock.scripts.chainPick = "Ana";
  const x30Human = await x30Handoff();
  const x30HumanNotes = await db.outbox.list([["stream_id", x30RoomId], ["user_id", anaId]], {
    columns: "id,kind,subject", limit: 20,
  });
  check("员工 @ 真人：那条 @ 进真人的虚拟邮箱，不落成任务",
    x30HumanNotes.some((row) => row.kind === "mention" && String(row.subject).includes("虚拟员工 甲一"))
      && x30Human.mailed.length === 0,
    { 通知: x30HumanNotes, 投出去的信: x30Human.mailed });

  x30Mock.scripts.chainPick = "丙三";
  const x30Outsider = await x30Handoff();
  check("员工 @ 一个不在本群的员工：名字对不上成员，mentions 为空也不投信",
    (x30Outsider.reply?.mentions ?? []).length === 0 && x30Outsider.mailed.length === 0, x30Outsider);
  x30Mock.scripts.chainPick = "乙二";
  const x30InRoom = await x30Handoff();
  check("对照：同一个位置换成群里的乙二就接得住（拒的是「不在本群」，不是接龙本身）",
    x30InRoom.mailed.length === 1 && x30InRoom.mailed[0].agent_id === x30YiId
      && Number(x30InRoom.mailed[0].meta?.hops) === 1, x30InRoom);
  await call("agents.update", { token: ana, body: { id: x30YiId, status: "paused" } });
  const x30Paused = await x30Handoff();
  check("员工 @ 一个已停用的员工：不投信，那条 @ 留在回复正文里看得见",
    x30Paused.mailed.length === 0 && String(x30Paused.reply?.content ?? "").includes("@乙二"), x30Paused);
  await call("agents.update", { token: ana, body: { id: x30YiId, status: "active" } });
  const x30Active = await x30Handoff();
  check("对照：拨回在岗后同一句 @ 照样接出去（拦的是状态，不是这个员工本身）",
    x30Active.mailed.length === 1 && x30Active.mailed[0].status === "queued", x30Active);
  for (let round = 0; round < 8; round += 1) {
    const pending = await db.mail.list(
      [["stream_id", x30RoomId], ["status", ["queued", "running"]]], { columns: "id", limit: 20 },
    );
    if (!pending.length) break;
    await call("scheduler.tick", { token: ana, method: "GET" });
  }
  await x30Mock.close();

  step("\n§31 分布式执行：多台 worker 对着同一个库认领，控制面升级不中断在跑的回合");
  // 回合循环可以跑在独立 worker 进程里（分布在多台 server），控制面只读写库。这一节验五件事：
  // 认领的 CAS 跨进程只放一个赢；worker 模式盖 worker_id、内嵌模式不盖；远程模式下控制面空转、
  // worker 照常跑完且控制面"重启"掐不断在跑的回合；心跳停摆的信被回收并把插话转成待办；调度台透出 worker。
  const x31Mock = await startMockUpstream();
  const x31Url = `http://127.0.0.1:${x31Mock.port}/v1`;
  const x31AgentId = (await call("agents.create", {
    token: ana, body: { name: "分布员工", role: "分布式执行", backend: "openai", api_base_url: x31Url, api_key: "mock-key-31", model: "mock", context_chars: 8000 },
  })).payload.agent?.id;
  const x31RoomId = (await call("streams.create", { token: ana, body: { name: "分布式组", agent_ids: [x31AgentId] } })).payload.stream?.id;
  const x31Env = (name) => process.env[name];
  // 直接调 action 带上 worker 上下文，正是 worker.mjs 驱动 tick 的形状；call() 那条不带 worker，模拟控制面/前端轮询。
  const x31Tick = (worker) => actions["scheduler.tick"]({ db, env: x31Env, params: new URLSearchParams(), user: { id: anaId }, worker }).then((r) => r.json());
  const x31Hook = (id) => ({ id, track() {}, untrack() {} });
  const x31Replies = () => db.messages.list([["stream_id", x31RoomId], ["sender_type", "agent"]], { columns: "id,content", limit: 200 });
  const x31Ask = async (content) => {
    await call("messages.send", { token: ana, body: { stream_id: x31RoomId, content, mentions: [{ type: "agent", id: x31AgentId }] } });
    return (await db.mail.first([["stream_id", x31RoomId], ["status", "queued"]], { columns: "id", order: ["created_at", { ascending: false }] }))?.id;
  };

  // A. 两台 worker 同时抢同一封：CAS 只放一个赢，群里只落一条回复（赢的跑完 / 输的跳过，本身就是一对）。
  const x31Ha = x31Hook(newId());
  const x31Hb = x31Hook(newId());
  const x31MailA = await x31Ask("@分布员工 这一封谁来跑");
  const [x31Ra, x31Rb] = await Promise.all([x31Tick(x31Ha), x31Tick(x31Hb)]);
  const x31RanA = [...(x31Ra.ran ?? []), ...(x31Rb.ran ?? [])].filter((r) => r.stream_id === x31RoomId);
  check("两台 worker 抢同一封：只有一台真的跑完", x31RanA.length === 1 && x31RanA[0].status === "done", x31RanA);
  const x31MailAEnd = await db.mail.byId(x31MailA);
  check("赢的那台把自己的 worker_id 盖在信上", x31MailAEnd.status === "done" && [x31Ha.id, x31Hb.id].includes(x31MailAEnd.worker_id), x31MailAEnd);
  check("群里只落一条回复：认领的 CAS 挡住了重复执行", (await x31Replies()).length === 1, await x31Replies());

  // B. 单行 CAS 原语本身并发安全：不靠 tick 的调度顺序，直接同时认领同一封，只返回一个 id。
  const x31MailB = await x31Ask("@分布员工 直接验认领原语");
  const [x31C1, x31C2] = await Promise.all([
    db.mail.claim([["id", x31MailB], ["status", "queued"]], { status: "running", started_at: now(), worker_id: x31Ha.id, heartbeat_at: now() }),
    db.mail.claim([["id", x31MailB], ["status", "queued"]], { status: "running", started_at: now(), worker_id: x31Hb.id, heartbeat_at: now() }),
  ]);
  check("同一封同时认领只返回一个 id（另一个被抢先拿 null）", Boolean(x31C1) !== Boolean(x31C2), { c1: x31C1, c2: x31C2 });
  await db.mail.remove([["id", x31MailB]]);

  // C. 内嵌模式不盖 worker_id（回收退回 started_at）；worker 模式盖上——一对放行/缺省对照。
  const x31MailC1 = await x31Ask("@分布员工 内嵌模式跑一封");
  await x31Tick(undefined);
  const x31Embedded = await db.mail.byId(x31MailC1);
  check("内嵌模式（无 worker）认领不写 worker_id", x31Embedded.status === "done" && x31Embedded.worker_id == null, x31Embedded);
  const x31Hc = x31Hook(newId());
  const x31MailC2 = await x31Ask("@分布员工 worker 模式跑一封");
  await x31Tick(x31Hc);
  const x31Stamped = await db.mail.byId(x31MailC2);
  check("对照：worker 模式认领盖上自己的 worker_id", x31Stamped.status === "done" && x31Stamped.worker_id === x31Hc.id, x31Stamped);

  // D. 远程模式：控制面空转不认领，worker 照常跑完；worker 正跑着时控制面"重启"再 tick，掐不断那封 running 信。
  process.env.WORKSTREAM_EXECUTION = "worker";
  try {
    const x31MailD1 = await x31Ask("@分布员工 远程模式控制面别动手");
    const x31Control = await call("scheduler.tick", { token: ana, method: "GET" });
    check("远程模式控制面空转：只回报 execution=worker，不认领", x31Control.payload.execution === "worker" && (x31Control.payload.ran ?? []).length === 0, x31Control.payload);
    const x31StillQueued = await db.mail.byId(x31MailD1);
    check("控制面这次调用没动那封信：它还排队等 worker", x31StillQueued.status === "queued", x31StillQueued);
    const x31Hw = x31Hook(newId());
    const x31WorkerRan = await x31Tick(x31Hw);
    check("远程模式 worker 照常跑完并落群（控制面空转不影响执行）", (x31WorkerRan.ran ?? []).some((r) => r.mail_id === x31MailD1 && r.status === "done"), x31WorkerRan.ran);

    // 升级存活：worker 已认领、回合正跑着，控制面这时"重启"再 tick 一次——远程闸在 reapStale 之前就返回，碰都不碰它。
    const x31MailD2 = await x31Ask("@分布员工 这封正跑着控制面重启");
    const x31Hw2 = x31Hook(newId());
    await db.mail.claim([["id", x31MailD2], ["status", "queued"]], { status: "running", started_at: now(), worker_id: x31Hw2.id, heartbeat_at: now() });
    const x31Restart = await call("scheduler.tick", { token: ana, method: "GET" });
    const x31Survived = await db.mail.byId(x31MailD2);
    check("控制面重启掐不断在跑的回合：信仍 running、worker_id 不变", x31Restart.payload.execution === "worker" && x31Survived.status === "running" && x31Survived.worker_id === x31Hw2.id, x31Survived);
    const x31Before = (await x31Replies()).length;
    await runTask({ db, env: x31Env, mailId: x31MailD2 });
    const x31Committed = await db.mail.byId(x31MailD2);
    check("worker 把回合跑到提交点：控制面重启后回复照样落群", x31Committed.status === "done" && (await x31Replies()).length === x31Before + 1, x31Committed);
  } finally {
    delete process.env.WORKSTREAM_EXECUTION;
  }

  // E. 回收：心跳停摆的僵尸信回收成 failed 并把插话转成待办；心跳新鲜的长任务不误杀。
  const x31Iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
  const x31MailMsg = newId();
  const x31RunningMail = async ({ heartbeatAt, meta = {}, workerId = newId() }) => {
    const id = newId();
    await db.mail.insert({
      id, agent_id: x31AgentId, stream_id: x31RoomId, message_id: x31MailMsg,
      trigger_seq: 1, priority: 1, status: "running", slice_count: 1, error: null,
      created_at: x31Iso(-600000), started_at: x31Iso(-600000), finished_at: null,
      updated_at: x31Iso(-600000), meta, worker_id: workerId, heartbeat_at: heartbeatAt,
    }, { columns: "id" });
    return id;
  };
  // E1. 精确边界：冻结时钟，心跳恰好等于 cutoff 的放过（>=），早 1ms 的回收——边界可重跑，不靠墙钟运气。
  const x31RealNow = Date.now;
  const x31Frozen = x31RealNow();
  Date.now = () => x31Frozen;
  try {
    const x31Threshold = 60000;
    const x31ReapEnv = (n) => (n === "WORKSTREAM_REAP_MS" ? String(x31Threshold) : undefined);
    const x31AtId = await x31RunningMail({ heartbeatAt: new Date(x31Frozen - x31Threshold).toISOString() });
    const x31OverId = await x31RunningMail({ heartbeatAt: new Date(x31Frozen - x31Threshold - 1).toISOString() });
    await reapStale(db, x31ReapEnv);
    const x31At = await db.mail.byId(x31AtId);
    const x31Over = await db.mail.byId(x31OverId);
    check("心跳恰好落在回收阈值上：放过（>= cutoff 不回收）", x31At.status === "running", x31At);
    check("心跳比阈值早 1ms：回收成 failed slice_interrupted", x31Over.status === "failed" && x31Over.error === "slice_interrupted", x31Over);
    await db.mail.remove([["id", x31AtId]]);
    await db.mail.remove([["id", x31OverId]]);
  } finally {
    Date.now = x31RealNow;
  }
  // E2. 死 worker 的信被回收、插话转成待办；活 worker 的信 spared（一对回收/放行）。
  const x31InterruptMsg = newId();
  const x31DeadId = await x31RunningMail({ heartbeatAt: x31Iso(-600000), meta: { interrupt: { message_id: x31InterruptMsg, seq: 7 } } });
  const x31LiveId = await x31RunningMail({ heartbeatAt: x31Iso(0) });
  await reapStale(db, () => undefined);
  const x31Dead = await db.mail.byId(x31DeadId);
  const x31Live = await db.mail.byId(x31LiveId);
  check("心跳停摆的僵尸信被回收成 failed slice_interrupted", x31Dead.status === "failed" && x31Dead.error === "slice_interrupted", x31Dead);
  check("对照：心跳新鲜的长任务不被误杀（仍 running）", x31Live.status === "running", x31Live);
  const x31Requeued = await db.mail.list([["stream_id", x31RoomId], ["status", "queued"], ["message_id", x31InterruptMsg]], { columns: "id,meta,message_id", limit: 10 });
  check("回收时把待办插话转成一封新排队信，不丢", x31Requeued.length === 1 && x31Requeued[0].meta?.follow_up === "interrupt", x31Requeued);
  await db.mail.remove([["id", x31DeadId]]);
  await db.mail.remove([["id", x31LiveId]]);
  for (const row of x31Requeued) await db.mail.remove([["id", row.id]]);

  // F. 回收阈值走配置：默认 5 分钟，越界退回默认，上下限本身收得下。
  check("回收阈值默认 5 分钟", reapThreshold(() => undefined) === 300000);
  check("阈值低于下限退回默认", reapThreshold((n) => (n === "WORKSTREAM_REAP_MS" ? "9999" : undefined)) === 300000);
  check("阈值高于上限退回默认", reapThreshold((n) => (n === "WORKSTREAM_REAP_MS" ? "3600001" : undefined)) === 300000);
  check("合法阈值照配置生效", reapThreshold((n) => (n === "WORKSTREAM_REAP_MS" ? "60000" : undefined)) === 60000);
  check("阈值上下限本身收得下", reapThreshold((n) => (n === "WORKSTREAM_REAP_MS" ? "10000" : undefined)) === 10000
    && reapThreshold((n) => (n === "WORKSTREAM_REAP_MS" ? "3600000" : undefined)) === 3600000);

  // G. startWorker 真实生命周期（隔离空库，不依赖有没有活儿）：上线注册 active、心跳持续刷新、优雅退出落 stopped。
  const x31Sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const x31LifeDb = store(createFixtureClient(join(dir, "x31-worker-lifecycle.json")));
  const x31Worker = startWorker({ supabase: x31LifeDb.client, env: () => undefined, tickMs: 25, heartbeatMs: 25, label: "lifecycle-node", version: "test", log: () => {} });
  let x31LifeRow = null;
  for (let i = 0; i < 80 && !x31LifeRow; i += 1) { await x31Sleep(10); x31LifeRow = await x31LifeDb.workers.first([["label", "lifecycle-node"]]); }
  check("worker 上线即注册一行 active 心跳（空库也注册）", x31LifeRow?.status === "active" && x31LifeRow?.label === "lifecycle-node", x31LifeRow);
  const x31Beat0 = x31LifeRow?.last_heartbeat_at;
  await x31Sleep(80);
  const x31BeatRow = await x31LifeDb.workers.first([["label", "lifecycle-node"]]);
  check("心跳定时器持续刷新 last_heartbeat_at", x31BeatRow?.last_heartbeat_at > x31Beat0, { before: x31Beat0, after: x31BeatRow?.last_heartbeat_at });
  check("空闲 worker 的 inflight 如实报 0", x31BeatRow?.inflight === 0, x31BeatRow);
  await x31Worker.stop();
  const x31Stopped = await x31LifeDb.workers.first([["label", "lifecycle-node"]]);
  check("优雅退出落 stopped、inflight 归零（先 draining 排空再停）", x31Stopped?.status === "stopped" && x31Stopped?.inflight === 0, x31Stopped);

  // H. 调度台透出：全局 active worker 心跳列表 + 每个群此刻在哪些 worker 上跑（done 信的 worker_id 不冒充正在跑）。
  const x31BoardNode = newId();
  await db.workers.upsert({ id: x31BoardNode, label: "board-node", version: "v1", status: "active", inflight: 1, last_heartbeat_at: now(), created_at: now(), updated_at: now() }, { onConflict: "id" });
  const x31Board0 = await call("scheduler.board", { token: ana, method: "GET" });
  const x31Slice0 = x31Board0.payload.boards.flatMap((b) => b.streams).find((s) => s.stream_id === x31RoomId);
  check("群里没有在跑的信时 workers 列为空（done 信的 worker_id 不冒充正在跑）", Array.isArray(x31Slice0?.workers) && x31Slice0.workers.length === 0, x31Slice0);
  check("调度台透出全局 active worker 心跳列表", x31Board0.payload.workers.some((w) => w.id === x31BoardNode && w.status === "active" && w.inflight === 1), x31Board0.payload.workers);
  const x31BoardMail = newId();
  await db.mail.insert({
    id: x31BoardMail, agent_id: x31AgentId, stream_id: x31RoomId, message_id: x31MailMsg,
    trigger_seq: 1, priority: 1, status: "running", slice_count: 1, error: null,
    created_at: now(), started_at: now(), finished_at: null, updated_at: now(), meta: {}, worker_id: x31BoardNode, heartbeat_at: now(),
  }, { columns: "id" });
  const x31Board1 = await call("scheduler.board", { token: ana, method: "GET" });
  const x31Slice1 = x31Board1.payload.boards.flatMap((b) => b.streams).find((s) => s.stream_id === x31RoomId);
  check("每个群透出此刻在哪些 worker 上跑", x31Slice1?.workers?.includes(x31BoardNode), x31Slice1);
  await db.mail.remove([["id", x31BoardMail]]);
  await db.workers.remove([["id", x31BoardNode]]);
  await x31Mock.close();

  step("\n§32 Stream Server 规范 v1.0.0：发现、两档与 worker HTTP 最小集");
  const x32Sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  /** 规范表的错必须在加载时就炸，所以这里认的是"炸没炸"与那句理由，不是错误类型。 */
  const x32Throw = (fn) => {
    try { fn(); return null; } catch (error) { return String(error?.message ?? error); }
  };
  const x32Raw = (origin, token, method, path, body) => fetch(new URL(path, origin).href, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const x32Json = async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) });
  /** 读一条 SSE 流。`[DONE]` 也当一帧收进来（值就是那个字符串）：它是"对方干净收尾"的证据，
   *  客户端正是靠有没有它分清 no_reply 与 turn_incomplete。 */
  const x32Sse = (response) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const frames = [];
    let buffer = "";
    const found = (pred) => {
      const at = frames.findIndex(pred);
      return at < 0 ? null : frames.slice(0, at + 1);
    };
    return {
      frames,
      until: async (pred, deadlineMs = 15000) => {
        const deadline = Date.now() + deadlineMs;
        for (;;) {
          const hit = found(pred);
          if (hit) return hit;
          const left = deadline - Date.now();
          if (left <= 0) return null;
          let timer;
          const outcome = await Promise.race([
            reader.read(),
            new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), left); }),
          ]).finally(() => clearTimeout(timer));
          if (outcome.timeout) return found(pred);
          if (outcome.done) return found(pred);
          buffer += decoder.decode(outcome.value, { stream: true });
          const parts = buffer.split(/\r?\n\r?\n/);
          buffer = parts.pop() ?? "";
          for (const raw of parts) {
            const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim()).join("\n");
            if (!data) continue;
            if (data === "[DONE]") { frames.push("[DONE]"); continue; }
            try { frames.push(JSON.parse(data)); } catch { /* 解不开的帧丢掉，与客户端同口径 */ }
          }
        }
      },
      drop: async () => {
        await reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch { /* 已经放开 */ }
      },
    };
  };

  // A. 规范表本身：发现响应的正文由表算出来，表的错在加载时就炸（用一份坏表打这一枪，真表崩了会连累整套）。
  const x32Descriptor = specDescriptor({ profiles: [SHARED_PROFILE], models: ["m"], label: "L" });
  check("发现响应的正文由表算出来：spec、档位、这一档的 caps 默认值都在",
    x32Descriptor.spec === SPEC_ID && x32Descriptor.profiles.length === 1
      && x32Descriptor.profiles[0].id === SHARED_PROFILE && x32Descriptor.profiles[0].caps.tools === true
      && x32Descriptor.profiles[0].caps.interrupt === true && x32Descriptor.models[0] === "m"
      && x32Descriptor.label === "L", x32Descriptor);
  const x32Bare = specDescriptor({ profiles: ["dedicated"] });
  check("没给的可选格不出现在正文里（对方读到 undefined 会当成声明了一件事）",
    !("models" in x32Bare) && !("label" in x32Bare)
      && x32Bare.profiles[0].caps.tools === false && x32Bare.profiles[0].caps.interrupt === false, x32Bare);
  check("空档位清单当场拒", Boolean(x32Throw(() => specDescriptor({ profiles: [] }))), x32Throw(() => specDescriptor({ profiles: [] })));
  check("声明规范里没有的一档当场拒（客户端会照它选路，然后每轮都失败在调不到路由上）",
    Boolean(x32Throw(() => specDescriptor({ profiles: ["quantum"] }))), x32Throw(() => specDescriptor({ profiles: ["quantum"] })));
  check("同一档声明两次当场拒", Boolean(x32Throw(() => specDescriptor({ profiles: ["shared", "shared"] }))),
    x32Throw(() => specDescriptor({ profiles: ["shared", "shared"] })));

  const x32GoodProfiles = [
    { id: "shared", stateless: true, caps: { tools: true, interrupt: true, usage: true, reasoning: true } },
    { id: "dedicated", stateless: false, caps: { tools: false, interrupt: false, usage: false, reasoning: false } },
  ];
  const x32DiscoveryEntry = { name: "discovery", profile: "any", method: "GET", path: "/" };
  const x32BothRequired = [
    x32DiscoveryEntry,
    { name: "createTurn", profile: "shared", method: "POST", path: "/turns" },
    { name: "createSession", profile: "dedicated", method: "POST", path: "/sessions" },
  ];
  check("真表自洽：validateSpec 放行", validateSpec() === true);
  check("profile id 重复当场拒（后一条会悄悄盖掉前一条）",
    Boolean(x32Throw(() => validateSpec({ profiles: [x32GoodProfiles[0], { ...x32GoodProfiles[0], stateless: false }] }))),
    x32Throw(() => validateSpec({ profiles: [x32GoodProfiles[0], { ...x32GoodProfiles[0], stateless: false }] })));
  check("caps 里多一个规范没定义的键当场拒",
    Boolean(x32Throw(() => validateSpec({ profiles: [{ ...x32GoodProfiles[0], caps: { tools: true, teleport: true } }, x32GoodProfiles[1]] }))),
    x32Throw(() => validateSpec({ profiles: [{ ...x32GoodProfiles[0], caps: { tools: true, teleport: true } }, x32GoodProfiles[1]] })));
  check("endpoint 名重复当场拒",
    Boolean(x32Throw(() => validateSpec({ endpoints: [x32DiscoveryEntry, { ...x32DiscoveryEntry }] }))),
    x32Throw(() => validateSpec({ endpoints: [x32DiscoveryEntry, { ...x32DiscoveryEntry }] })));
  check("endpoint 挂在规范里没有的 profile 上当场拒",
    Boolean(x32Throw(() => validateSpec({ endpoints: [x32DiscoveryEntry, { name: "ghost", profile: "quantum", method: "GET", path: "/ghost" }] }))),
    x32Throw(() => validateSpec({ endpoints: [x32DiscoveryEntry, { name: "ghost", profile: "quantum", method: "GET", path: "/ghost" }] })));
  check("方法不在白名单当场拒",
    Boolean(x32Throw(() => validateSpec({ endpoints: [x32DiscoveryEntry, { name: "createTurn", profile: "shared", method: "DELETE", path: "/turns" }] }))),
    x32Throw(() => validateSpec({ endpoints: [x32DiscoveryEntry, { name: "createTurn", profile: "shared", method: "DELETE", path: "/turns" }] })));
  check("路径不以 / 开头当场拒",
    Boolean(x32Throw(() => validateSpec({ endpoints: [x32DiscoveryEntry, { name: "createTurn", profile: "shared", method: "POST", path: "turns" }] }))),
    x32Throw(() => validateSpec({ endpoints: [x32DiscoveryEntry, { name: "createTurn", profile: "shared", method: "POST", path: "turns" }] })));
  check("路径参数没闭合当场拒（等于把用户输入直接拼进路由）",
    Boolean(x32Throw(() => validateSpec({ endpoints: [x32DiscoveryEntry, { name: "createTurn", profile: "shared", method: "POST", path: "/turns/{turn_id" }] }))),
    x32Throw(() => validateSpec({ endpoints: [x32DiscoveryEntry, { name: "createTurn", profile: "shared", method: "POST", path: "/turns/{turn_id" }] })));
  check("某一档一条必需 endpoint 都没有当场拒（只剩 optional 的那条等于这一档没实现）",
    Boolean(x32Throw(() => validateSpec({
      endpoints: [x32DiscoveryEntry, { name: "createTurn", profile: "shared", method: "POST", path: "/turns" },
        { name: "interruptSession", profile: "dedicated", method: "POST", path: "/sessions/{session_id}/interrupt", optional: true }],
    }))),
    x32Throw(() => validateSpec({
      endpoints: [x32DiscoveryEntry, { name: "createTurn", profile: "shared", method: "POST", path: "/turns" },
        { name: "interruptSession", profile: "dedicated", method: "POST", path: "/sessions/{session_id}/interrupt", optional: true }],
    })));
  check("没有发现 endpoint 当场拒（客户端就无从知道对方认哪一档）",
    Boolean(x32Throw(() => validateSpec({ endpoints: x32BothRequired.slice(1) }))),
    x32Throw(() => validateSpec({ endpoints: x32BothRequired.slice(1) })));
  check("帧词表挂在规范里没有的 profile 上当场拒",
    Boolean(x32Throw(() => validateSpec({ events: { quantum: ["turn.done"] } }))),
    x32Throw(() => validateSpec({ events: { quantum: ["turn.done"] } })));
  check("某一档没声明任何帧当场拒", Boolean(x32Throw(() => validateSpec({ events: { shared: [] } }))),
    x32Throw(() => validateSpec({ events: { shared: [] } })));
  check("错误码不成族当场拒（界面上就分不清是哪条通道坏了）",
    Boolean(x32Throw(() => validateSpec({ codes: { client: ["upstream_failed"], server: [] } }))),
    x32Throw(() => validateSpec({ codes: { client: ["upstream_failed"], server: [] } })));
  check("同一侧错误码重复当场拒", Boolean(x32Throw(() => validateSpec({ codes: { client: ["stream_a", "stream_a"], server: [] } }))),
    x32Throw(() => validateSpec({ codes: { client: ["stream_a", "stream_a"], server: [] } })));

  // B. 路径的两种读法必须是同一张表：客户端拼出去与服务端认回来，表改了只改一边就变成运行时一句 404。
  const x32TurnId = "turn:12_3-x.2";
  const x32Built = endpointPath("getTurn", { turn_id: x32TurnId });
  check("路径参数编码后才拼进路由：`:` 变成 %3A，对方发来的 id 决定不了我们请求哪条路",
    x32Built === "/stream-server/v1/turns/turn%3A12_3-x.2", x32Built);
  const x32Back = matchEndpoint(x32Built);
  check("拼路径的逆运算认得回来，参数解码后逐字相同",
    x32Back?.name === "getTurn" && x32Back.params.turn_id === x32TurnId, x32Back);
  const x32Roundtrip = ENDPOINTS.map((entry) => {
    const params = {};
    for (const key of [...entry.path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1])) params[key] = "id-1";
    const back = matchEndpoint(endpointPath(entry.name, params));
    return { name: entry.name, ok: back?.name === entry.name && JSON.stringify(back?.params) === JSON.stringify(params) };
  });
  check("表里每一条 endpoint 都能拼出去再认回来", x32Roundtrip.every((row) => row.ok), x32Roundtrip.filter((row) => !row.ok));
  check("参数里带 `/` 当场拒", Boolean(x32Throw(() => endpointPath("getTurn", { turn_id: "a/b" }))),
    x32Throw(() => endpointPath("getTurn", { turn_id: "a/b" })));
  check("参数超出 1-128 的界当场拒", Boolean(x32Throw(() => endpointPath("getTurn", { turn_id: "a".repeat(129) }))),
    x32Throw(() => endpointPath("getTurn", { turn_id: "a".repeat(129) })));
  check("表里没有的 endpoint 名当场拒（名字打错是写代码的人的错，不进错误码文案那一套）",
    Boolean(x32Throw(() => endpointPath("teleport", {}))), x32Throw(() => endpointPath("teleport", {})));
  check("认不出的路径回 null，服务器据此回 stream_endpoint_missing",
    matchEndpoint("/stream-server/v1/nope") === null && matchEndpoint("/v1/turns") === null,
    [matchEndpoint("/stream-server/v1/nope"), matchEndpoint("/v1/turns")]);
  check("编码绕过也认不出来：解回来含 `/` 的参数按不合规丢掉",
    matchEndpoint("/stream-server/v1/turns/a%2Fb") === null, matchEndpoint("/stream-server/v1/turns/a%2Fb"));
  check("带路径参数的那条认得出档位与方法",
    matchEndpoint("/stream-server/v1/turns/t1/interrupt")?.name === "interruptTurn"
      && matchEndpoint("/stream-server/v1/sessions/s1/events/stream")?.name === "streamEvents"
      && matchEndpoint("/stream-server/v1/sessions/s1/events")?.name === "postEvents",
    [matchEndpoint("/stream-server/v1/turns/t1/interrupt")?.name, matchEndpoint("/stream-server/v1/sessions/s1/events/stream")?.name]);

  const x32BadBodies = [
    ["not_json", null],
    ["spec_missing", { profiles: [{ id: "shared" }] }],
    ["spec_major_mismatch", { spec: "stream-server/2.0.0", profiles: [{ id: "shared" }] }],
    ["no_profiles", { spec: SPEC_ID }],
    ["unknown_profile", { spec: SPEC_ID, profiles: [{ id: "quantum" }] }],
    ["duplicate_profile", { spec: SPEC_ID, profiles: [{ id: "shared" }, { id: "shared" }] }],
    ["unknown_caps", { spec: SPEC_ID, profiles: [{ id: "shared", caps: { teleport: true } }] }],
    ["caps_not_boolean", { spec: SPEC_ID, profiles: [{ id: "shared", caps: { interrupt: "yes" } }] }],
    ["caps_tools_mismatch", { spec: SPEC_ID, profiles: [{ id: "shared", caps: { tools: false } }] }],
  ];
  for (const [code, body] of x32BadBodies) {
    const parsed = parseDescriptor(body);
    check(`不合规的发现响应整条退回：${code}`, parsed.descriptor === null && parsed.code === code, parsed);
  }
  check("退回理由码的取值域与表逐字一致（多一个少一个都说明客户端与规范页对不上）",
    x32BadBodies.length === DISCOVERY_REASONS.length
      && DISCOVERY_REASONS.every((code) => x32BadBodies.some(([own]) => own === code)),
    { 表: DISCOVERY_REASONS, 打到的: x32BadBodies.map(([code]) => code) });
  const x32Parsed = parseDescriptor(specDescriptor({ profiles: ["dedicated", "shared"], models: [7], label: "x" }));
  check("合规响应：缺的 caps 按这一档默认补齐，tools 那格以规范为准（对方改不动）",
    x32Parsed.descriptor?.profiles.every((entry) => Object.keys(entry.caps).length === CAP_KEYS.length)
      && x32Parsed.descriptor?.profiles.find((entry) => entry.id === "shared").caps.tools === true
      && x32Parsed.descriptor?.profiles.find((entry) => entry.id === "dedicated").caps.tools === false, x32Parsed.descriptor);
  check("models 一律转成字符串：对方发数字也不该让我们后面拼出 NaN",
    x32Parsed.descriptor?.models?.[0] === "7", x32Parsed.descriptor?.models);
  check("两档都声明时优先 shared：只有它带得动我们的群工具",
    pickProfile(x32Parsed.descriptor) === SHARED_PROFILE, pickProfile(x32Parsed.descriptor));
  check("只声明专属档就选专属档（不硬凑 shared）",
    pickProfile(parseDescriptor(specDescriptor({ profiles: ["dedicated"] })).descriptor) === "dedicated",
    pickProfile(parseDescriptor(specDescriptor({ profiles: ["dedicated"] })).descriptor));

  // C. 参考实现 + 建档：档位是发现出来的事实，写进档案；发现失败要分清持久型与临时型。
  const x32Up = await startMockUpstream();
  const x32Token = "st-smoke-shared-1";
  const x32Hits = [];
  const x32Core = createStreamServer({
    upstreamUrl: `http://127.0.0.1:${x32Up.port}/v1`,
    upstreamKey: "up-smoke-key-32",
    upstreamModel: "smoke-shared-model",
    token: x32Token,
    label: "smoke shared",
  });
  // 记一份请求清单：「一轮任务不重新发现」这条断言要落在出网次数上，不能只看档案那一格没变。
  const x32Server = {
    ...x32Core,
    handle: (request) => {
      x32Hits.push(`${request.method} ${new URL(request.url).pathname}`);
      return x32Core.handle(request);
    },
  };
  const x32Srv = await listenStreamServer({ server: x32Server, port: 0 });
  const x32Count = (re) => x32Hits.filter((line) => re.test(line)).length;
  check("参考实现只声明自己真跑得起来的那一档",
    x32Core.descriptor.profiles.map((entry) => entry.id).join() === SHARED_PROFILE
      && x32Core.descriptor.spec === SPEC_ID, x32Core.descriptor);
  check("不配令牌又不许匿名：冷启动就崩，不留一个谁都能调、拿我们的上游 Key 替任何人烧 token 的执行器",
    Boolean(x32Throw(() => createStreamServer({}))), x32Throw(() => createStreamServer({})));

  const x32DemoPair = await call("agents.create", {
    token: ana,
    body: { name: "分时演示", role: "x", backend: "stream", api_base_url: "demo://local", api_key: x32Token, model: "smoke-shared-model" },
  });
  check("规范对接那一档 + 演示地址在建档就被拒（发现请求根本发不出去）",
    x32DemoPair.status === 400 && x32DemoPair.payload.error === "stream_needs_real_origin", x32DemoPair.payload);
  const x32Agent = await call("agents.create", {
    token: ana,
    body: {
      name: "小T", role: "分时执行", backend: "stream", context_chars: 8000,
      api_base_url: `${x32Srv.origin}/stream-server/v1`, api_key: x32Token, model: "smoke-shared-model",
    },
  });
  const x32Id = x32Agent.payload.agent?.id;
  check("对照：真实 origin 上建档成功，发现结果落进档案（shared）",
    x32Agent.payload.ok === true && x32Agent.payload.agent?.backend === "stream"
      && x32Agent.payload.agent?.stream_profile === SHARED_PROFILE, x32Agent.payload);
  // 新建档的默认后端就是规范入口：不传 backend 也走发现，不再静默落到 openai。
  const x32Default = await call("agents.create", {
    token: ana,
    body: {
      name: "小默", role: "默认入口", context_chars: 8000,
      api_base_url: `${x32Srv.origin}/stream-server/v1`, api_key: x32Token, model: "smoke-shared-model",
    },
  });
  const x32DefaultId = x32Default.payload.agent?.id;
  check("不传 backend 默认走规范入口：发现照旧落档（新 agent 统一从 stream 进）",
    x32Default.payload.ok === true && x32Default.payload.agent?.backend === "stream"
      && x32Default.payload.agent?.stream_profile === SHARED_PROFILE, x32Default.payload);
  const x32DefaultDemo = await call("agents.create", {
    token: ana,
    body: { name: "默认演示", role: "x", api_base_url: "demo://local", api_key: x32Token, model: "smoke-shared-model" },
  });
  check("对照：默认档 + 演示地址照样被拒——演示要显式选 openai，不靠默认猜一档",
    x32DefaultDemo.status === 400 && x32DefaultDemo.payload.error === "stream_needs_real_origin", x32DefaultDemo.payload);
  check("建档只回令牌尾号：明文与密文都不在响应里",
    x32Agent.payload.agent?.api_key_tail === `••••${x32Token.slice(-4)}`
      && !JSON.stringify(x32Agent.payload).includes(x32Token)
      && !JSON.stringify(x32Agent.payload).includes("api_key_cipher"), x32Agent.payload);
  const x32BadKey = await call("agents.update", { token: ana, body: { id: x32Id, api_key: "st-wrong-token" } });
  check("改令牌时对方拒了：整个改档失败，不把一次故障钉成对它的永久判决",
    x32BadKey.status === 401 && x32BadKey.payload.error === "stream_unauthorized", x32BadKey.payload);
  const x32AfterBad = await db.agents.byId(x32Id, { columns: "id,api_key_tail,stream_profile" });
  check("改档失败后档案一个字没改（旧地址配旧档位仍然自洽）",
    x32AfterBad.api_key_tail === `••••${x32Token.slice(-4)}` && x32AfterBad.stream_profile === SHARED_PROFILE, x32AfterBad);
  const x32GoodKey = await call("agents.update", { token: ana, body: { id: x32Id, api_key: x32Token } });
  check("对照：同一处改动带上对的令牌就放行，并重新问一次档位",
    x32GoodKey.payload.ok === true && x32GoodKey.payload.agent?.stream_profile === SHARED_PROFILE, x32GoodKey.payload);

  const x32Ping = await call("agents.test", { token: ana, body: { id: x32Id } });
  const x32Facts = x32Ping.payload.result ?? {};
  check("自检如实报出对方声明了什么：spec 版本、档位清单、展示名与模型名",
    x32Facts.reachable === true && x32Facts.speaks_spec === true && x32Facts.profile === SHARED_PROFILE
      && x32Facts.spec === SPEC_ID && String(x32Facts.profiles?.join()) === SHARED_PROFILE
      && String(x32Facts.models?.join()) === "smoke-shared-model" && x32Facts.label === "smoke shared", x32Facts);
  check("自检问出来的档位写回档案：界面报的那一档与员工实际跑的那一档必须是同一个值",
    x32Facts.stored === true && x32Facts.mode === "stream", x32Facts);
  check("shared 档自检照旧跑一轮真对话（专属档只问不跑，不替用户建会话、不动用量）",
    typeof x32Facts.reply === "string" && x32Facts.reply.includes("收到，我按上下文回应。"), x32Facts.reply);

  await call("streams.agents.add", { token: ana, body: { stream_id: streamId, agent_id: x32Id } });
  /** 一次 tick 有片数上限，别的群排在前面的信会先跑：轮到这个员工这一封为止，不拿别的群的成功冒充。 */
  const x32TickUntil = async (roomId, agentId, tries = 6) => {
    let ran = [];
    for (let index = 0; index < tries && ran.length === 0; index += 1) {
      const tick = await call("scheduler.tick", { token: ana, method: "GET" });
      ran = (tick.payload.ran ?? []).filter((row) => row.stream_id === roomId && row.agent_id === agentId);
    }
    return ran;
  };
  const x32DiscBefore = x32Count(/^GET \/stream-server\/v1$/);
  const x32Send = await call("messages.send", {
    token: ana,
    body: { stream_id: streamId, content: "@小T 这一轮走分时执行", mentions: [{ type: "agent", id: x32Id }] },
  });
  check("分时执行器上的员工也能被 @ 派发", x32Send.payload.queued?.length === 1, x32Send.payload);
  const x32Ran = await x32TickUntil(streamId, x32Id);
  check("这一轮跑完（走的是规范那条通道）", x32Ran.length === 1 && x32Ran[0].status === "done", x32Ran);
  const x32History = await call("messages.list", { token: ana, method: "GET", body: { stream_id: streamId } });
  const x32Reply = (x32History.payload.items ?? []).find((m) => m.sender_id === x32Id);
  check("规范那一轮的权威正文落进群聊", String(x32Reply?.content).includes("查到 3 条历史记录"), x32Reply?.content);
  check("shared 档把我们的群工具整个发过去（工具回路是员工干活的手）",
    (x32Up.seen.at(-1)?.tools ?? []).some((tool) => tool?.function?.name === "search_history"),
    (x32Up.seen.at(-1)?.tools ?? []).map((tool) => tool?.function?.name));
  check("一轮任务不重新发现：档位只读档案里那一格（措辞与工具注入都发生在调用之前）",
    x32Count(/^GET \/stream-server\/v1$/) === x32DiscBefore
      && (await db.agents.byId(x32Id, { columns: "stream_profile" })).stream_profile === SHARED_PROFILE,
    { 发现次数: x32Count(/^GET \/stream-server\/v1$/), 派发前: x32DiscBefore });

  // D. 一轮的权威结果：帧序、增量与权威帧的关系、用量的两种形状（线上是上游形状，落库前才归一化）。
  const x32Row = await db.agents.byId(x32Id, { columns: "id,name,backend,api_base_url,model,stream_profile,context_chars" });
  const x32Direct = await askStreamServer({
    db, agent: x32Row, streamId, key: x32Token,
    messages: [{ role: "user", content: "直接调一轮" }], tools: null, maxTokens: null, timeoutMs: 20000,
  });
  check("直接调用回的形状与另外两条通道一致：正文、mode、profile、turn_id 都在",
    x32Direct.mode === "stream" && x32Direct.profile === SHARED_PROFILE && typeof x32Direct.turn_id === "string"
      && x32Direct.content === "收到，我按上下文回应。" && x32Direct.finish_reason === "stop", x32Direct);
  check("用量按落库口径归一化：上游那套 prompt_tokens 不进我们的列",
    x32Direct.usage?.input === 812 && x32Direct.usage?.output === 24
      && x32Direct.usage?.cached === 640 && x32Direct.usage?.reasoning === 9, x32Direct.usage);
  check("对方没回报首字延迟就用我们自己量到的那个（量不到才留 null，不编数字）",
    Number.isFinite(x32Direct.first_token_ms) && x32Direct.first_token_ms >= 0, x32Direct.first_token_ms);
  const x32Wire = await x32Json(await x32Raw(x32Srv.origin, x32Token, "GET", endpointPath("getTurn", { turn_id: x32Direct.turn_id })));
  check("规范线上跑的是上游用量形状：归一化是客户端落库前的事，不写进协议",
    x32Wire.status === 200 && x32Wire.body.state === "done" && x32Wire.body.usage?.prompt_tokens === 812
      && x32Wire.body.usage?.prompt_tokens_details?.cached_tokens === 640
      && x32Wire.body.content === "收到，我按上下文回应。", x32Wire.body);

  const x32ManualId = `turn_${newId().slice(0, 12)}`;
  const x32Manual = x32Sse(await x32Raw(x32Srv.origin, x32Token, "POST", endpointPath("createTurn"), {
    turn_id: x32ManualId, model: "smoke-shared-model", messages: [{ role: "user", content: "手工一轮" }],
  }));
  const x32Frames = await x32Manual.until((frame) => frame === "[DONE]");
  const { type: _x32FrameType, ...x32DoneBody } = (x32Frames ?? []).find((frame) => frame?.type === "turn.done") ?? {};
  const x32Deltas = (x32Frames ?? []).filter((frame) => frame?.type === "turn.delta").map((frame) => frame.content).join("");
  check("一轮的帧序：增量 → 权威帧 → [DONE]",
    (x32Frames ?? []).some((frame) => frame?.type === "turn.delta") && Boolean(x32DoneBody.content)
      && (x32Frames ?? []).at(-1) === "[DONE]", (x32Frames ?? []).map((frame) => (frame === "[DONE]" ? frame : frame?.type)));
  check("增量累加起来就是权威正文（客户端据此在中断时交出半截）",
    x32Deltas === x32DoneBody.content, { 增量: x32Deltas, 权威: x32DoneBody.content });
  const x32ManualGet = await x32Json(await x32Raw(x32Srv.origin, x32Token, "GET", endpointPath("getTurn", { turn_id: x32ManualId })));
  check("turn.done 与 GET 结果是同一个对象：客户端断流之后才敢拿 GET 的当权威帧用",
    JSON.stringify(x32DoneBody) === JSON.stringify(x32ManualGet.body),
    { 帧: x32DoneBody, 取回: x32ManualGet.body });
  await x32Manual.drop();

  // E. worker HTTP 纪律：鉴权在路由之前，方法与路径的失败各有各的码。
  const x32NoAuth = await x32Json(await x32Raw(x32Srv.origin, null, "GET", "/stream-server/v1"));
  check("没带令牌的调用方在路由之前就被挡下",
    x32NoAuth.status === 401 && x32NoAuth.body.error === "stream_unauthorized", x32NoAuth);
  const x32WrongAuth = await x32Json(await x32Raw(x32Srv.origin, "st-not-the-token", "GET", endpointPath("getTurn", { turn_id: x32ManualId })));
  check("令牌不对时连存在的路也回 401：不许从 404/405 的差别里读出这台 server 实现了哪几条路",
    x32WrongAuth.status === 401 && x32WrongAuth.body.error === "stream_unauthorized", x32WrongAuth);
  const x32RightAuth = await x32Json(await x32Raw(x32Srv.origin, x32Token, "GET", endpointPath("getTurn", { turn_id: x32ManualId })));
  check("对照：带对令牌同一条路就通（拦的是令牌，不是这条路）",
    x32RightAuth.status === 200 && x32RightAuth.body.turn_id === x32ManualId, x32RightAuth);
  const x32Method = await x32Json(await x32Raw(x32Srv.origin, x32Token, "GET", "/stream-server/v1/turns"));
  check("路对方法不对回 405，不塌成 404", x32Method.status === 405 && x32Method.body.error === "stream_method_not_allowed", x32Method);
  const x32GhostPath = await x32Json(await x32Raw(x32Srv.origin, x32Token, "GET", "/stream-server/v1/nope"));
  check("表里没有的路回 stream_endpoint_missing（客户端正是据此退回 OpenAI 兼容那一档）",
    x32GhostPath.status === 404 && x32GhostPath.body.error === "stream_endpoint_missing", x32GhostPath);
  const x32BadTurnId = await x32Json(await x32Raw(x32Srv.origin, x32Token, "POST", "/stream-server/v1/turns", {
    turn_id: "a/b", messages: [{ role: "user", content: "x" }],
  }));
  check("turn_id 不合规回 400 并指名哪一格", x32BadTurnId.status === 400 && x32BadTurnId.body.detail === "turn_id", x32BadTurnId);
  const x32NoMessages = await x32Json(await x32Raw(x32Srv.origin, x32Token, "POST", "/stream-server/v1/turns", {
    turn_id: "turn_no_messages", messages: [],
  }));
  check("没有 messages 的一轮当场拒", x32NoMessages.status === 400 && x32NoMessages.body.detail === "messages", x32NoMessages);
  const x32Reused = await x32Json(await x32Raw(x32Srv.origin, x32Token, "POST", "/stream-server/v1/turns", {
    turn_id: x32ManualId, model: "smoke-shared-model", messages: [{ role: "user", content: "重放" }],
  }));
  check("重放同一个 turn_id 被拒：再起一次上游等于替同一个请求烧两遍 token",
    x32Reused.status === 400 && x32Reused.body.detail === "turn_id_reused", x32Reused);

  // F. 叫停：turn_id 由客户端生成，所以断线也叫得停；被叫停是一轮的正当结局，不是失败。
  const x32StallId = `turn_${newId().slice(0, 12)}`;
  const x32Stall = x32Sse(await x32Raw(x32Srv.origin, x32Token, "POST", "/stream-server/v1/turns", {
    turn_id: x32StallId, model: "smoke-shared-model", messages: [{ role: "user", content: "静默卡住" }],
  }));
  const x32BeforeStop = await x32Stall.until((frame) => frame?.type === "turn.delta" && frame.content === "半截");
  check("上游静默之前先收到过正文增量（这一轮确实起来了；思考链的增量不算）",
    (x32BeforeStop ?? []).some((frame) => frame.content === "半截"), x32BeforeStop);
  const x32Stop = await x32Json(await x32Raw(x32Srv.origin, x32Token, "POST", endpointPath("interruptTurn", { turn_id: x32StallId })));
  check("叫停在跑的那一轮回 200", x32Stop.status === 200 && x32Stop.body.ok === true, x32Stop);
  const x32Stopped = await x32Stall.until((frame) => frame?.type === "turn.done");
  const x32StoppedDone = (x32Stopped ?? []).find((frame) => frame?.type === "turn.done");
  check("被叫停的那一轮交半截正文 + finish_reason=interrupted，不当错误帧发出去",
    x32StoppedDone?.state === "done" && x32StoppedDone?.finish_reason === "interrupted"
      && x32StoppedDone?.content === "半截", x32StoppedDone);
  await x32Stall.drop();
  const x32Restop = await x32Json(await x32Raw(x32Srv.origin, x32Token, "POST", endpointPath("interruptTurn", { turn_id: x32StallId })));
  check("已结的那一轮再叫停不算错（客户端的叫停本来就尽力而为，回 404 会让主人叫停长得像服务器坏了）",
    x32Restop.status === 200, x32Restop);
  const x32GhostStop = await x32Json(await x32Raw(x32Srv.origin, x32Token, "POST", endpointPath("interruptTurn", { turn_id: "turn_ghost" })));
  check("对照：叫停一个不存在的 turn 才回 404",
    x32GhostStop.status === 404 && x32GhostStop.body.error === "stream_turn_not_found", x32GhostStop);

  let x32Asked = 0;
  let x32ClientStop = null;
  try {
    await askStreamServer({
      db, agent: x32Row, streamId, key: x32Token,
      messages: [{ role: "user", content: "静默卡住" }], tools: null, timeoutMs: 20000,
      onInterrupt: async () => { x32Asked += 1; return x32Asked > 1 ? { stopped: true } : null; },
    });
  } catch (error) { x32ClientStop = error; }
  check("上游静默期间客户端也问要不要停：就地放弃这一轮并交出半截，不等整轮超时",
    x32ClientStop instanceof Interrupted && x32ClientStop.payload?.partial === "半截" && x32Asked >= 2,
    { 问了: x32Asked, 半截: x32ClientStop?.payload?.partial, 错: String(x32ClientStop?.message ?? x32ClientStop) });

  // 上游一个字都不吐时也要叫得停：这条钉的是执行器那头的响应头必须立刻发出去（dev/stream-server.mjs 的 flushHeaders）。
  // 头攒着等第一个字节，客户端的 fetch 就一直不 resolve，读循环进不去，onInterrupt 再勤也问不到——只能等整轮超时。
  const x32SilentUp = await startSilentUpstream();
  const x32Silent = createStreamServer({
    upstreamUrl: `http://127.0.0.1:${x32SilentUp.port}/v1`, upstreamKey: "up-smoke-key-32",
    upstreamModel: "smoke-shared-model", token: x32Token, timeoutMs: 8000,
  });
  const x32SilentSrv = await listenStreamServer({ server: x32Silent, port: 0 });
  let x32SilentAsked = 0;
  let x32SilentStop = null;
  const x32SilentStarted = Date.now();
  try {
    await askStreamServer({
      db, agent: { ...x32Row, api_base_url: `${x32SilentSrv.origin}/stream-server/v1` }, streamId, key: x32Token,
      messages: [{ role: "user", content: "一个字都不吐" }], tools: null, timeoutMs: 15000,
      onInterrupt: async () => { x32SilentAsked += 1; return x32SilentAsked > 1 ? { stopped: true } : null; },
    });
  } catch (error) { x32SilentStop = error; }
  const x32SilentMs = Date.now() - x32SilentStarted;
  check("上游迟迟不吐第一个字也叫得停：客户端进得了读循环，不必等整轮 15s 超时",
    x32SilentStop instanceof Interrupted && x32SilentAsked >= 2 && x32SilentMs < 8000,
    { 问了: x32SilentAsked, 毫秒: x32SilentMs, 错: String(x32SilentStop?.streamCode ?? x32SilentStop?.message ?? x32SilentStop) });
  await x32SilentUp.close();
  await x32SilentSrv.close();

  // G. 断流恢复与有界表：一轮结果的权威是客户端读到的 turn.done，这张表只为断线补救与叫停存在。
  const x32CutToken = "st-smoke-cut-1";
  const x32CutRow = {
    id: "agent_x32_cut", name: "断流", backend: "stream", model: "cut-model",
    stream_profile: SHARED_PROFILE, context_chars: 8000,
  };
  const x32Cut = await startCutServer(x32CutToken, { withGet: true });
  const x32Recovered = await askStreamServer({
    db, agent: { ...x32CutRow, api_base_url: `${x32Cut.origin}/stream-server/v1` }, streamId, key: x32CutToken,
    messages: [{ role: "user", content: "断流一轮" }], tools: null, timeoutMs: 20000,
  });
  check("流断了没等到权威帧：先问一次服务器那一轮成没成，取回来就当权威",
    x32Recovered.content === "断流之后才取回的权威正文。" && x32Recovered.finish_reason === "stop", x32Recovered);
  await x32Cut.close();
  const x32CutBlind = await startCutServer(x32CutToken, { withGet: false });
  let x32BlindError = null;
  try {
    await askStreamServer({
      db, agent: { ...x32CutRow, api_base_url: `${x32CutBlind.origin}/stream-server/v1` }, streamId, key: x32CutToken,
      messages: [{ role: "user", content: "断流一轮" }], tools: null, timeoutMs: 20000,
    });
  } catch (error) { x32BlindError = error; }
  check("补救那一发问不到就退回原来的失败：有半截增量叫「说到一半断了」，不拿它冒充回复",
    x32BlindError?.streamCode === "stream_turn_incomplete" && x32BlindError?.status === 502,
    { 码: x32BlindError?.streamCode, 状态: x32BlindError?.status });
  await x32CutBlind.close();

  const x32Small = createStreamServer({
    upstreamUrl: `http://127.0.0.1:${x32Up.port}/v1`, upstreamKey: "up-smoke-key-32",
    upstreamModel: "smoke-shared-model", token: x32Token, turnMax: 2,
  });
  const x32SmallSrv = await listenStreamServer({ server: x32Small, port: 0 });
  const x32SmallIds = [];
  for (let index = 0; index < 3; index += 1) {
    const id = `turn_small_${index}`;
    const stream = x32Sse(await x32Raw(x32SmallSrv.origin, x32Token, "POST", "/stream-server/v1/turns", {
      turn_id: id, model: "smoke-shared-model", messages: [{ role: "user", content: `小表第 ${index} 轮` }],
    }));
    await stream.until((frame) => frame?.type === "turn.done");
    await stream.drop();
    x32SmallIds.push(id);
  }
  check("turn 表有条数上限：满了腾最老的已结条目，一台执行器不因跑得多就自爆",
    x32Small.turnCount() === 2, x32Small.turnCount());
  const x32Evicted = await x32Json(await x32Raw(x32SmallSrv.origin, x32Token, "GET", endpointPath("getTurn", { turn_id: x32SmallIds[0] })));
  check("被腾掉的那条取结果回 404，不回一份空壳",
    x32Evicted.status === 404 && x32Evicted.body.error === "stream_turn_not_found", x32Evicted);
  const x32Kept = await x32Json(await x32Raw(x32SmallSrv.origin, x32Token, "GET", endpointPath("getTurn", { turn_id: x32SmallIds[2] })));
  check("对照：最新那条还在，取结果照旧 200", x32Kept.status === 200 && x32Kept.body.state === "done", x32Kept);
  await x32SmallSrv.close();

  const x32Ttl = createStreamServer({
    upstreamUrl: `http://127.0.0.1:${x32Up.port}/v1`, upstreamKey: "up-smoke-key-32",
    upstreamModel: "smoke-shared-model", token: x32Token, turnTtlMs: 40,
  });
  const x32TtlSrv = await listenStreamServer({ server: x32Ttl, port: 0 });
  const x32TtlStream = x32Sse(await x32Raw(x32TtlSrv.origin, x32Token, "POST", "/stream-server/v1/turns", {
    turn_id: "turn_ttl_1", model: "smoke-shared-model", messages: [{ role: "user", content: "过期一轮" }],
  }));
  await x32TtlStream.until((frame) => frame?.type === "turn.done");
  await x32TtlStream.drop();
  check("刚结掉的那一轮还在表里（TTL 没到就不清）", x32Ttl.turnCount() === 1, x32Ttl.turnCount());
  await x32Sleep(90);
  check("过了 TTL 的已结条目清掉（进程重启即清空，这张表只是断线补救）", x32Ttl.turnCount() === 0, x32Ttl.turnCount());
  const x32TtlGet = await x32Json(await x32Raw(x32TtlSrv.origin, x32Token, "GET", endpointPath("getTurn", { turn_id: "turn_ttl_1" })));
  check("过期之后取结果回 404", x32TtlGet.status === 404, x32TtlGet);
  await x32TtlSrv.close();

  const x32One = createStreamServer({
    upstreamUrl: `http://127.0.0.1:${x32Up.port}/v1`, upstreamKey: "up-smoke-key-32",
    upstreamModel: "smoke-shared-model", token: x32Token, turnMax: 1,
  });
  const x32OneSrv = await listenStreamServer({ server: x32One, port: 0 });
  const x32RunId = "turn_one_running";
  const x32Run = x32Sse(await x32Raw(x32OneSrv.origin, x32Token, "POST", "/stream-server/v1/turns", {
    turn_id: x32RunId, model: "smoke-shared-model", messages: [{ role: "user", content: "静默卡住" }],
  }));
  await x32Run.until((frame) => frame?.type === "turn.delta");
  const x32Full = await x32Json(await x32Raw(x32OneSrv.origin, x32Token, "POST", "/stream-server/v1/turns", {
    turn_id: "turn_one_extra", model: "smoke-shared-model", messages: [{ role: "user", content: "挤不进去" }],
  }));
  check("表满且腾不出已结条目时拒新的（503），不砍在跑的那一轮",
    x32Full.status === 503 && x32Full.body.error === "stream_unavailable" && x32Full.body.detail === "turn_table_full", x32Full);
  await x32Json(await x32Raw(x32OneSrv.origin, x32Token, "POST", endpointPath("interruptTurn", { turn_id: x32RunId })));
  const x32RunDone = await x32Run.until((frame) => frame?.type === "turn.done");
  check("对照：在跑的那一轮照旧结得下来（刚才那次拒绝没伤到它）",
    (x32RunDone ?? []).some((frame) => frame?.finish_reason === "interrupted"), x32RunDone);
  await x32Run.drop();
  await x32OneSrv.close();

  const x32Tiny = createStreamServer({
    upstreamUrl: `http://127.0.0.1:${x32Up.port}/v1`, upstreamKey: "up-smoke-key-32",
    upstreamModel: "smoke-shared-model", token: x32Token, maxRequestBytes: 64,
  });
  const x32TinySrv = await listenStreamServer({ server: x32Tiny, port: 0 });
  const x32TooBig = await x32Json(await x32Raw(x32TinySrv.origin, x32Token, "POST", "/stream-server/v1/turns", {
    turn_id: "turn_big", messages: [{ role: "user", content: "x".repeat(4096) }],
  }));
  check("请求体超限在读满之前就拒（413），不整份进内存",
    x32TooBig.status === 413 && x32TooBig.body.error === "stream_payload_too_large", x32TooBig);
  await x32TinySrv.close();
  const x32NoUp = createStreamServer({ token: x32Token });
  const x32NoUpSrv = await listenStreamServer({ server: x32NoUp, port: 0 });
  const x32Unconfigured = await x32Json(await x32Raw(x32NoUpSrv.origin, x32Token, "POST", "/stream-server/v1/turns", {
    turn_id: "turn_no_upstream", messages: [{ role: "user", content: "x" }],
  }));
  check("没配上游就明说 stream_upstream_unconfigured，不拿一句 500 糊过去",
    x32Unconfigured.status === 503 && x32Unconfigured.body.error === "stream_upstream_unconfigured", x32Unconfigured);
  const x32NoUpDiscovery = await x32Json(await x32Raw(x32NoUpSrv.origin, x32Token, "GET", "/stream-server/v1"));
  check("对照：没配上游也照样回发现响应（声明的是自己认哪一档，不是上游通不通）",
    x32NoUpDiscovery.status === 200 && x32NoUpDiscovery.body.spec === SPEC_ID, x32NoUpDiscovery.body);
  await x32NoUpSrv.close();

  // H. 专属档：会话在对方那侧，帧词表沿用云端那一套，我们的群工具不在这条通道里。
  const x32DedToken = "st-smoke-ded-1";
  const x32Ded = await startMockDedicated(x32DedToken);
  const x32DedAgent = await call("agents.create", {
    token: ana,
    body: {
      name: "小D", role: "专属员工", backend: "stream", context_chars: 8000,
      api_base_url: `${x32Ded.origin}/stream-server/v1`, api_key: x32DedToken, model: "ded-model",
    },
  });
  const x32DedId = x32DedAgent.payload.agent?.id;
  check("同一张表的另一副面孔也认得出来：建档时问清是哪一档",
    x32DedAgent.payload.ok === true && x32DedAgent.payload.agent?.stream_profile === "dedicated", x32DedAgent.payload.agent);
  check("后端清单按档位分成两条目：吃不吃工具由对方声明的 profile 决定，不由地址猜",
    backendFor({ backend: "stream", stream_profile: "dedicated" }).id === "stream-dedicated"
      && backendFor({ backend: "stream", stream_profile: "dedicated" }).caps.tools === false
      && backendFor({ backend: "stream", stream_profile: SHARED_PROFILE }).caps.tools === true
      && backendFor({ backend: "stream", stream_profile: "openai" }).caps.tools === true,
    BACKENDS.filter((entry) => entry.transport === "stream").map((entry) => [entry.id, entry.caps.tools]));
  const x32DedPrompt = composeSystemPrompt({ ...slotCtx, backend: backendFor({ backend: "stream", stream_profile: "dedicated" }) });
  const x32SharedPrompt = composeSystemPrompt({ ...slotCtx, backend: backendFor({ backend: "stream", stream_profile: SHARED_PROFILE }) });
  check("专属档的措辞说清群工具调不到，不叫它照着技能说明假执行",
    x32DedPrompt.system.includes("本次由这台 server 上的专属员工作答")
      && x32DedPrompt.system.includes("请把结论直接写进正文")
      && !x32DedPrompt.system.includes("按需调用对应工具")
      && !x32DedPrompt.system.includes("调用 search_history / read_window 工具"), x32DedPrompt.system.slice(0, 220));
  check("对照：分时那一档照旧带工具说明（抑制只写在不吃工具的那一档上）",
    x32SharedPrompt.system.includes("按需调用对应工具")
      && x32SharedPrompt.system.includes("调用 search_history / read_window 工具")
      && !x32SharedPrompt.system.includes("本次由这台 server 上的专属员工作答"), x32SharedPrompt.system.slice(0, 220));

  const x32DedRoom = await call("streams.create", { token: ana, body: { name: "专属隔离组", agent_ids: [x32DedId] } });
  const x32DedRoomId = x32DedRoom.payload.stream?.id;
  await call("messages.send", {
    token: ana,
    body: { stream_id: x32DedRoomId, content: "@小D 这一轮走专属档", mentions: [{ type: "agent", id: x32DedId }] },
  });
  const x32DedRan = await x32TickUntil(x32DedRoomId, x32DedId);
  check("专属档这一轮跑完", x32DedRan.length === 1 && x32DedRan[0].status === "done", x32DedRan);
  const x32DedHistory = await call("messages.list", { token: ana, method: "GET", body: { stream_id: x32DedRoomId } });
  const x32DedReply = (x32DedHistory.payload.items ?? []).find((m) => m.sender_id === x32DedId);
  check("专属档的规范正文落进群聊", String(x32DedReply?.content ?? "").includes("专属正文"),
    x32DedReply?.content ?? (x32DedHistory.payload.items ?? []).map((m) => [m.sender_id, String(m.content).slice(0, 80)]));
  check("专属档的思考链不进群聊（与云端那一档同一条红线）",
    x32DedReply !== undefined && !JSON.stringify(x32DedReply).includes("专属思考链"), x32DedReply);
  check("上下文压成一条正文递过去，我们的群工具不塞给它（它用它自己的工具集）",
    x32Ded.state.promptSeen?.hasTools === false
      && String(x32Ded.state.promptSeen?.prompt).includes("〔设定与技能说明〕")
      && String(x32Ded.state.promptSeen?.prompt).includes("本次由这台 server 上的专属员工作答"),
    String(x32Ded.state.promptSeen?.prompt ?? "").slice(0, 220));
  const x32Sess1 = await db.stream_sessions.list([["agent_id", x32DedId]], { columns: "id,stream_id,session_id", limit: 20 });
  await call("messages.send", {
    token: ana,
    body: { stream_id: x32DedRoomId, content: "@小D 再补一句", mentions: [{ type: "agent", id: x32DedId }] },
  });
  const x32DedRan2 = await x32TickUntil(x32DedRoomId, x32DedId);
  check("专属档同群第二轮也跑完（不然下面那条“复用”是空转出来的假通过）",
    x32DedRan2.length === 1 && x32DedRan2[0].status === "done", x32DedRan2);
  const x32Sess2 = await db.stream_sessions.list([["agent_id", x32DedId]], { columns: "id,stream_id,session_id", limit: 20 });
  check("同群第二轮复用对方那侧的同一条 session（转录每轮重发，session 只是它的对话缓存）",
    x32Sess1.length === 1 && x32Sess2.length === 1 && x32Sess1[0].session_id === x32Sess2[0].session_id
      && x32Ded.state.sessions === 1, { 落库: x32Sess2, 对方建了几次: x32Ded.state.sessions });

  x32Ded.state.mode = "stall";
  const x32DedRow = await db.agents.byId(x32DedId, { columns: "id,name,backend,api_base_url,model,stream_profile,context_chars" });
  let x32DedAsked = 0;
  let x32DedStop = null;
  try {
    await askStreamServer({
      db, agent: x32DedRow, streamId: x32DedRoomId, key: x32DedToken,
      messages: [{ role: "user", content: "静默卡住" }], tools: null, timeoutMs: 20000,
      onInterrupt: async () => { x32DedAsked += 1; return x32DedAsked > 1 ? { stopped: true } : null; },
    });
  } catch (error) { x32DedStop = error; }
  check("专属档静默时也问要不要停：就地放弃这一轮并交出半截",
    x32DedStop instanceof Interrupted && x32DedStop.payload?.partial === x32Ded.state.stallText && x32DedAsked >= 2,
    { 问了: x32DedAsked, 半截: x32DedStop?.payload?.partial, 错: String(x32DedStop?.message ?? x32DedStop) });
  check("专属档 caps.interrupt 为假：客户端只掐自己的读循环，不打对方那条可选路",
    x32Ded.count("POST", /\/interrupt$/) === 0, x32Ded.requests.map((r) => `${r.method} ${r.path}`));
  x32Ded.state.mode = "ok";

  const x32SwapDed = await call("agents.create", {
    token: ana,
    body: {
      name: "小换", role: "换后端", backend: "stream", context_chars: 8000,
      api_base_url: `${x32Ded.origin}/stream-server/v1`, api_key: x32DedToken, model: "ded-model",
    },
  });
  const x32SwapDedId = x32SwapDed.payload.agent?.id;
  await db.stream_sessions.insert({
    id: newId(), agent_id: x32SwapDedId, stream_id: x32DedRoomId, session_id: "sess_ded_cached",
    created_at: now(), updated_at: now(),
  }, { columns: "id" });
  const x32Swapped = await call("agents.update", {
    token: ana,
    body: {
      id: x32SwapDedId, backend: "openai", api_base_url: `http://127.0.0.1:${x32Up.port}/v1`,
      api_key: "up-smoke-key-32", model: "smoke-shared-model",
    },
  });
  check("换到别的后端就把档位那一格清空（留着旧值等于按错的那一档拼措辞）",
    x32Swapped.payload.ok === true && x32Swapped.payload.agent?.stream_profile === null, x32Swapped.payload.agent);
  check("对方那侧的会话缓存跟着作废：它围着 (地址, 令牌, 档位) 建的",
    (await db.stream_sessions.list([["agent_id", x32SwapDedId]], { columns: "id", limit: 20 })).length === 0);

  // I. 撒谎的发现响应与退回档：退回不是猜，它是这台服务器的事实，可以当结论存下来。
  const x32Lie = await startLyingSpec({ spec: SPEC_ID, profiles: [{ id: "shared", caps: { tools: false } }] });
  const x32LieToken = "st-smoke-lie-1";
  const x32LieAgent = await call("agents.create", {
    token: ana,
    body: {
      name: "小谎", role: "撒谎的发现响应", backend: "stream", context_chars: 8000,
      api_base_url: `${x32Lie.origin}/stream-server/v1`, api_key: x32LieToken, model: "lie-model",
    },
  });
  const x32LieId = x32LieAgent.payload.agent?.id;
  check("caps.tools 与档位说反了：整条退回，不照谎言选路",
    x32LieAgent.payload.ok === true && x32LieAgent.payload.agent?.stream_profile === "openai", x32LieAgent.payload.agent);
  const x32LieAccess = await checkStreamAccess({ baseUrl: `${x32Lie.origin}/stream-server/v1`, token: x32LieToken });
  check("自检如实报出退回的理由码与当时读到的值（回码不回句子，数据原样带上）",
    x32LieAccess.speaks_spec === false && x32LieAccess.code === "caps_tools_mismatch"
      && String(x32LieAccess.detail).startsWith("shared") && x32LieAccess.storable === true
      && x32LieAccess.profile === "openai", x32LieAccess);
  const x32LiePing = await call("agents.test", { token: ana, body: { id: x32LieId } });
  check("退回那一档之后自检就照那一档跑：这台 server 没有 /chat/completions，如实报 404",
    x32LiePing.payload.result?.reachable === false && x32LiePing.payload.result?.error === "upstream_not_found",
    x32LiePing.payload.result);
  await x32Lie.close();

  const x32Plain = await startPlainOpenai();
  const x32PlainAgent = await call("agents.create", {
    token: ana,
    body: {
      name: "小P", role: "只认 OpenAI 兼容", backend: "stream", context_chars: 8000,
      api_base_url: `${x32Plain.origin}/v1`, api_key: "st-smoke-plain-1", model: "plain-model",
    },
  });
  const x32PlainId = x32PlainAgent.payload.agent?.id;
  check("发现那条路回 404：把「这台 server 只认 OpenAI 兼容」存成结论，不每轮重猜",
    x32PlainAgent.payload.ok === true && x32PlainAgent.payload.agent?.stream_profile === "openai", x32PlainAgent.payload.agent);
  const x32PlainPing = await call("agents.test", { token: ana, body: { id: x32PlainId } });
  check("退回档也能自检：报出理由码，并照 OpenAI 兼容跑通一轮",
    x32PlainPing.payload.result?.reachable === true && x32PlainPing.payload.result?.speaks_spec === false
      && x32PlainPing.payload.result?.code === "stream_endpoint_missing"
      && x32PlainPing.payload.result?.stored === true
      && String(x32PlainPing.payload.result?.reply).includes("_plain_endpoint_ok"), x32PlainPing.payload.result);
  check("退回那一档真的打在对面的 /chat/completions 上（地址里那段路径没被 originOf 吃掉）",
    x32Plain.requests.some((r) => r.path === "/v1/chat/completions"),
    x32Plain.requests.map((r) => `${r.method} ${r.path}`));
  // 自检跑通不等于干活跑通：整轮 @ 派发走的是引擎那条路（措辞、工具注入、落库都在里面），
  // 退回档必须在这条路上也结得下来，不然「统一走 stream 入口」对这台 server 就是句空话。
  const x32PlainRoom = await call("streams.create", { token: ana, body: { name: "退回档执行组", agent_ids: [x32PlainId] } });
  const x32PlainRoomId = x32PlainRoom.payload.stream?.id;
  const x32PlainDisc = () => x32Plain.requests.filter((r) => r.method === "GET" && r.path === "/stream-server/v1").length;
  const x32PlainDiscBefore = x32PlainDisc();
  await call("messages.send", {
    token: ana,
    body: { stream_id: x32PlainRoomId, content: "@小P 这一轮走退回档", mentions: [{ type: "agent", id: x32PlainId }] },
  });
  const x32PlainRan = await x32TickUntil(x32PlainRoomId, x32PlainId);
  check("退回档的员工也能被 @ 派发并跑完一整轮（与自检共用同一个派发点）",
    x32PlainRan.length === 1 && x32PlainRan[0].status === "done", x32PlainRan);
  const x32PlainHistory = await call("messages.list", { token: ana, method: "GET", body: { stream_id: x32PlainRoomId } });
  const x32PlainReply = (x32PlainHistory.payload.items ?? []).find((m) => m.sender_id === x32PlainId);
  check("退回那一轮的正文落进群聊", String(x32PlainReply?.content ?? "").includes("_plain_endpoint_ok"),
    x32PlainReply?.content ?? (x32PlainHistory.payload.items ?? []).map((m) => [m.sender_id, String(m.content).slice(0, 80)]));
  check("退回档一轮任务也不重新发现：档位读档案，干活的那条路是 /chat/completions",
    x32PlainDisc() === x32PlainDiscBefore
      && x32Plain.requests.filter((r) => r.method === "POST" && r.path === "/v1/chat/completions").length >= 2,
    x32Plain.requests.map((r) => `${r.method} ${r.path}`));
  await x32Plain.close();

  // J. 档位那一格空着或写着表外的值：两处都拒，不静默按某一档跑（那就是群里那次假执行）。
  const x32Unknown = (profile) => {
    try { return backendFor({ backend: "stream", stream_profile: profile }) ? null : null; } catch (error) { return error?.code; }
  };
  check("档案里那一格空着或写着表外的值：backendFor 当场抛 stream_profile_unknown",
    x32Unknown(null) === "stream_profile_unknown" && x32Unknown("quantum") === "stream_profile_unknown",
    { 空: x32Unknown(null), 表外: x32Unknown("quantum") });
  let x32RouteError = null;
  try {
    await askStreamServer({
      db, agent: { id: "x32", name: "x", backend: "stream", api_base_url: x32Srv.origin, model: "m", stream_profile: null },
      streamId, key: x32Token, messages: [{ role: "user", content: "x" }], tools: null, timeoutMs: 5000,
    });
  } catch (error) { x32RouteError = error; }
  check("调用面同样拒：这一格决定措辞与工具注入，猜一档就是假执行",
    x32RouteError?.streamCode === "stream_profile_unknown", x32RouteError?.streamCode);
  check("档案列的取值域就是两档加退回档",
    STREAM_PROFILE_VALUES.length === 3 && STREAM_PROFILE_VALUES.includes("openai")
      && STREAM_PROFILE_VALUES.includes(SHARED_PROFILE) && STREAM_PROFILE_VALUES.includes("dedicated"), STREAM_PROFILE_VALUES);
  check("发现失败分持久型与临时型：对方答了但答的不是规范才算结论",
    ["stream_endpoint_missing", "stream_bad_response", "stream_response_too_large", "not_json", "spec_major_mismatch", "caps_tools_mismatch"]
      .every((code) => isDurableDiscoveryFailure(code)),
    ["stream_endpoint_missing", "not_json"].map((code) => [code, isDurableDiscoveryFailure(code)]));
  check("对照：压根没答上的是临时型，存下来就是把一次故障钉成对它的永久判决",
    ["stream_unreachable", "stream_timeout", "stream_unauthorized", "stream_redirect_blocked"]
      .every((code) => !isDurableDiscoveryFailure(code)),
    ["stream_unreachable", "stream_timeout"].map((code) => [code, isDurableDiscoveryFailure(code)]));

  // 收尾：员工被移出群与删员工都要清掉对方那侧的会话缓存（只清云端那一条就是漏一段历史）。
  const x32DedMembership = (await call("streams.get", { token: ana, method: "GET", body: { id: x32DedRoomId } })).payload.members
    ?.find((m) => m.type === "agent" && m.agent?.id === x32DedId);
  await call("streams.members.remove", { token: ana, body: { stream_id: x32DedRoomId, membership_id: x32DedMembership?.membership_id } });
  check("员工被移出群时，他在对方那侧那条 session 缓存一起作废",
    (await db.stream_sessions.list([["agent_id", x32DedId]], { columns: "id,stream_id", limit: 20 })).length === 0);
  for (const id of [x32Id, x32DefaultId, x32DedId, x32LieId, x32PlainId, x32SwapDedId]) {
    await call("agents.delete", { token: ana, body: { id } });
  }
  check("删掉的员工不再留在档案里", (await db.agents.byId(x32Id, { columns: "id" })) == null);
  await x32Srv.close();
  await x32Ded.close();
  await x32Up.close();

  step("\n§33 符合性测试套件（CTS）：考卷先考自己的参考实现与夹具");
  // 考官不能是我们自己的客户端：runConformance 判分只认规范表，所以它也能替任何供应商跑（dev/cts.mjs、
  // 官网在线自检页用的是同一份）。这里钉四件事：参考实现 shared 档满分、dedicated 夹具满分、
  // 只认 OpenAI 兼容的那台在发现那条就 fail 且档内检查全 skip、考卷自带的分片器与客户端共用的 dataOf 同字节同结果。
  const x33Up = await startMockUpstream();
  const x33Srv = await listenStreamServer({
    server: createStreamServer({
      upstreamUrl: `http://127.0.0.1:${x33Up.port}/v1`, upstreamKey: "up-smoke-key-33",
      upstreamModel: "cts-shared", token: "cts-smoke-token-33", label: "cts shared",
    }),
    port: 0,
  });
  const x33Shared = await runConformance({ origin: x33Srv.origin, token: "cts-smoke-token-33", timeoutMs: 10000 });
  check("考卷考自己的参考实现（shared 档）：零 fail，且真考到了流与在跑的那一轮被叫停",
    (x33Shared.counts.fail ?? 0) === 0 && x33Shared.profile === SHARED_PROFILE
      && x33Shared.results.find((r) => r.id === "shared.turn.stream")?.verdict === "pass"
      && x33Shared.results.find((r) => r.id === "shared.interrupt.accepted")?.verdict === "pass",
    x33Shared.results.filter((r) => r.verdict !== "pass"));
  check("对照：这一轮里 dedicated 档的检查一条都没跑（档选错就是整轮白考）",
    x33Shared.results.every((r) => !r.id.startsWith("dedicated.")), x33Shared.results.map((r) => r.id));

  const x33Ded = await startMockDedicated("cts-ded-token-33");
  const x33Dedicated = await runConformance({
    origin: x33Ded.origin, token: "cts-ded-token-33", profile: "dedicated", timeoutMs: 10000,
  });
  check("考卷考 dedicated 夹具：零 fail，两轮都读到权威正文",
    (x33Dedicated.counts.fail ?? 0) === 0 && x33Dedicated.profile === "dedicated"
      && x33Dedicated.results.find((r) => r.id === "dedicated.session.turn")?.verdict === "pass"
      && x33Dedicated.results.find((r) => r.id === "dedicated.session.reuse")?.verdict === "pass",
    x33Dedicated.results.filter((r) => r.verdict !== "pass"));
  check("对照：考卷读的正文只是 text 块——字数与夹具的正文对得上，思考链那一段没被算进去",
    x33Dedicated.results.find((r) => r.id === "dedicated.session.turn")?.detail
      === `agent.message ${x33Ded.state.text.length} chars, 3 frames`,
    x33Dedicated.results.find((r) => r.id === "dedicated.session.turn")?.detail);

  const x33Plain = await startPlainOpenai();
  const x33NoSpec = await runConformance({ origin: x33Plain.origin, token: "cts-plain-token-33", timeoutMs: 5000 });
  check("只认 OpenAI 兼容的那台：发现那条 fail，档内检查全 skip（不拿猜测当考分）",
    x33NoSpec.results.find((r) => r.id === "discovery.descriptor")?.verdict === "fail"
      && x33NoSpec.results.filter((r) => r.id.startsWith("shared.")).every((r) => r.verdict === "skip")
      && (x33NoSpec.counts.fail ?? 0) >= 1,
    x33NoSpec.counts);

  // 分片器那份重复的钉子：浏览器里跑的是 payloadOf 这份复制品，客户端跑的是 dataOf；同字节必须同结果。
  const x33Corpus = [
    'data: {"type":"turn.delta","content":"a"}',
    "data: [DONE]",
    ': comment\ndata: {"type":"agent.message"}',
    "data: line1\ndata: line2",
    "event: ping",
    "",
  ];
  check("考卷的分片器与客户端共用的 dataOf 同字节同结果（含注释行、多行 data 与空块）",
    x33Corpus.every((block) => payloadOf(block) === dataOf(block)),
    x33Corpus.map((block) => [payloadOf(block), dataOf(block)]));

  await x33Srv.close();
  await x33Ded.close();
  await x33Plain.close();
  await x33Up.close();

  step("\n§34 官网在线自检的入口闸：同一个地址两次起跑必须隔开，同一地址同时只跑一轮");
  // 闸是公开入口的纪律，不是考卷的判分项：时钟注入进来，窗口边界才钉得死（「超过 10 秒」不是「满 10 秒」）。
  let x34Clock = 1_000_000;
  const x34Gate = createCtsGate({ now: () => x34Clock });
  check("第一次起跑放行", x34Gate.admit("203.0.113.7").ok === true);
  x34Gate.release("203.0.113.7");
  const x34Soon = x34Gate.admit("203.0.113.7");
  check("同一地址 10 秒内再点就被挡，并如实报出还要等多久（要等满 10.001 秒）",
    x34Soon.ok === false && x34Soon.reason === "too_soon" && x34Soon.retryAfterMs === 10_001,
    x34Soon);
  check("对照：另一个发起方地址不受牵连（限的是来访地址，不是被考的那台）",
    x34Gate.admit("203.0.113.8").ok === true);
  x34Gate.release("203.0.113.8");
  x34Clock += 10_000;
  const x34Exact = x34Gate.admit("203.0.113.7");
  check("恰好 10.000 秒仍挡：规则写的是「超过 10 秒」", x34Exact.ok === false && x34Exact.retryAfterMs === 1, x34Exact);
  x34Clock += 1;
  check("10.001 秒放行", x34Gate.admit("203.0.113.7").ok === true);
  const x34Busy = x34Gate.admit("203.0.113.7");
  check("上一轮还没回来：间隔已过也不许并发（同一个地址同时只跑一轮）",
    x34Busy.ok === false && x34Busy.reason === "run_in_flight", x34Busy);
  x34Gate.release("203.0.113.7");
  const x34Settled = x34Gate.admit("203.0.113.7");
  check("那一轮跑完了但仍在窗口里：照样挡（跑完不等于没跑过）",
    x34Settled.ok === false && x34Settled.reason === "too_soon", x34Settled);

  let x34Clock2 = 0;
  const x34Gate2 = createCtsGate({ now: () => x34Clock2 });
  x34Gate2.admit("198.51.100.4");
  x34Gate2.release("198.51.100.4");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    x34Clock2 += 2_000;
    x34Gate2.admit("198.51.100.4");
  }
  const x34Spam = x34Gate2.admit("198.51.100.4");
  check("被挡下的重试不续期：连点五次后窗口仍从第一次起跑算（10.000 秒时还挡，只剩 1ms）",
    x34Spam.ok === false && x34Spam.retryAfterMs === 1, x34Spam);
  x34Clock2 += 1;
  check("……到 10.001 秒照常放行（连点没有把自己越锁越久）", x34Gate2.admit("198.51.100.4").ok === true);

  /* ---------- 35. 迁移工具：只搬执行器，不猜 ---------- */
  // ssh 那一段只能由真机验证，但「什么地址算数、什么版本能跑、什么配置不生成」是现代码层面的
  // 决定，错了要么把员工指到连不上的地址，要么让远端带着半份配置上岗——先把这些钉住。
  {
    const migration = await import("../scripts/migrate.mjs");
    const rejectedWith = async (run) => {
      try {
        await run();
        return null;
      } catch (error) {
        return error?.code ?? error?.error ?? "thrown";
      }
    };
    check("Node 版本闸：22.12 与 22.20 都在范围内",
      migration.assertNodeVersion("v22.12.0").minor === 12 && migration.assertNodeVersion("22.20.1").minor === 20);
    check("对照：22.11 与 24 被拒（下界是版本号，不是印象）",
      (await rejectedWith(() => migration.assertNodeVersion("22.11.0"))) === "node_version"
      && (await rejectedWith(() => migration.assertNodeVersion("24.16.0"))) === "node_version");
    check("公开地址走服务端同一套规则：https 原样放行",
      migration.normalizeEndpoint("https://box.example.com").url === "https://box.example.com");
    check("对照：http 与内网默认被拒，显式 --allow-http 才放行",
      (await rejectedWith(() => migration.normalizeEndpoint("http://box.example.com"))) === "insecure_api_base_url"
      && (await rejectedWith(() => migration.normalizeEndpoint("http://127.0.0.1:8300"))) === "insecure_api_base_url"
      && migration.normalizeEndpoint("http://127.0.0.1:8300", { allowHttp: true }).url === "http://127.0.0.1:8300");
    check("演示端点不能当远端地址（另一台机器上没有 demo://local）",
      (await rejectedWith(() => migration.normalizeEndpoint("demo://local"))) === "demo_endpoint");
    check("配置不完整就拒绝生成：令牌不足 32 字符、没有上游都不行",
      (await rejectedWith(() => migration.buildExecutorConfig({ token: "short", upstreamUrl: "https://api.example.com/v1" }))) === "bad_token"
      && (await rejectedWith(() => migration.buildExecutorConfig({ token: "x".repeat(40) }))) === "upstream_missing");
    check("端口是 1-65535 的整数，越界不生成配置",
      (await rejectedWith(() => migration.buildExecutorConfig({ port: 70000, token: "x".repeat(40), upstreamUrl: "https://api.example.com/v1" }))) === "bad_port");
    check("--revert 等价于 --to local；--public-url= 的内联写法也认",
      migration.parseArgs(["--revert"]).to === "local"
      && migration.parseArgs(["--public-url=https://a.example.com"]).publicUrl === "https://a.example.com");
    check("远端目录是相对路径且不含空格（ssh/scp 不经过任何引号）",
      !migration.remoteDirFor("1d4f088f-bc41-4fd0-acb5-97fd6ba77da6").includes(" ")
      && migration.remoteDirFor("abc").startsWith("workstream-executor/"));
    check("ssh 用 -p、scp 用 -P：共用一份选项就会静默连到 22 端口",
      migration.sshCommon({ sshPort: 2222 }).join(" ").includes("-p 2222")
      && migration.scpCommon({ sshPort: 2222 }).join(" ").includes("-P 2222"));
    check("user@host:8022 解析成 sshPort（非 22 端口的机器按这个拨号）",
      migration.parseTarget("u0_a123@192.0.2.50:8022").sshPort === 8022
      && migration.parseTarget("u0_a123@192.0.2.50:8022").target === "u0_a123@192.0.2.50"
      && migration.parseTarget("root@box.example.com").sshPort === null);
    check("A -> B：同机同目录算同一个执行器（launcher 自己会重启），换目录/换机器才停来源",
      migration.shouldStopSource({ previous: { target: "local", dir: "a" }, target: "local", dir: "a" }) === false
      && migration.shouldStopSource({ previous: { target: "local", dir: "a" }, target: "local", dir: "b" }) === true
      && migration.shouldStopSource({ previous: { target: "root@a", dir: "d" }, target: "root@b", dir: "d" }) === true);
    check("对照：--keep-source 或没有上一次记录时不动来源",
      migration.shouldStopSource({ previous: { target: "local", dir: "a" }, target: "local", dir: "b", keepSource: true }) === false
      && migration.shouldStopSource({ previous: null, target: "local", dir: "b" }) === false);
  }

  /* ---------- 36. 部署 server：登记、复制给员工、删掉不牵连 ---------- */
  {
    const box = createStreamServer({
      upstreamUrl: "http://127.0.0.1:9/v1", upstreamKey: "k", upstreamModel: "m", token: "smoke-server-token",
    });
    const boxSrv = await listenStreamServer({ server: box, port: 0 });
    const reg = await call("auth.register", { body: { email: "srv@example.com", password: "passw0rd-31", display_name: "Srv" } });
    const verifyToken = decodeURIComponent((reg.payload.verify_link ?? "").split("token=")[1] ?? "");
    await call("auth.verify", { body: { token: verifyToken } });
    const owner = (await call("auth.login", { body: { email: "srv@example.com", password: "passw0rd-31" } })).payload.token;

    const created = await call("servers.create", {
      token: owner,
      body: { name: "构建机", base_url: boxSrv.origin, token: "smoke-server-token" },
    });
    check("登记 server 时当场问出档位", created.payload.ok === true && created.payload.server.stream_profile === "shared", created.payload);
    check("响应里只有令牌尾号，没有密文或原文",
      !("token_cipher" in (created.payload.server ?? {})) && String(created.payload.server?.token_tail).endsWith("oken"),
      created.payload.server);
    const serverId = created.payload.server.id;

    const agent = await call("agents.create", {
      token: owner,
      body: { name: "部署审", role: "验收", server_id: serverId, model: "m" },
    });
    check("用 server_id 建员工：地址与档位整份复制过来",
      agent.payload.ok === true
      && agent.payload.agent.api_base_url === boxSrv.origin
      && agent.payload.agent.stream_profile === "shared",
      agent.payload);
    check("新建员工默认压缩水位 95", agent.payload.agent?.compact_at === 95, agent.payload.agent);
    const compactLow = await call("agents.update", { token: owner, body: { id: agent.payload.agent.id, compact_at: 5 } });
    check("压缩水位低于 10 被拒（invalid_compact_at）", compactLow.payload.error === "invalid_compact_at", compactLow.payload);
    const compactSet = await call("agents.update", { token: owner, body: { id: agent.payload.agent.id, compact_at: 60 } });
    check("压缩水位 60 写回档案", compactSet.payload.agent?.compact_at === 60, compactSet.payload.agent);
    const thinkSet = await call("agents.update", { token: owner, body: { id: agent.payload.agent.id, think_effort: "high" } });
    check("思考档位写入档案", thinkSet.payload.agent?.think_effort === "high", thinkSet.payload.agent);
    const thinkBad = await call("agents.update", { token: owner, body: { id: agent.payload.agent.id, think_effort: "turbo" } });
    check("思考档位非法被拒（invalid_think_effort）",
      thinkBad.status === 400 && thinkBad.payload.error === "invalid_think_effort", thinkBad.payload);
    const usage = await call("agents.usage", { token: owner, method: "GET", body: { id: agent.payload.agent.id } });
    check("用量聚合：三个窗口都在，且命中率与花费可算",
      usage.status === 200 && ["5m", "1h", "all"].every((name) => usage.payload.windows?.[name]),
      usage.payload);

    const stranger = await call("auth.register", { body: { email: "stranger@example.com", password: "passw0rd-32", display_name: "St" } });
    const strangerVerify = decodeURIComponent((stranger.payload.verify_link ?? "").split("token=")[1] ?? "");
    await call("auth.verify", { body: { token: strangerVerify } });
    const other = (await call("auth.login", { body: { email: "stranger@example.com", password: "passw0rd-32" } })).payload.token;
    const usageStranger = await call("agents.usage", { token: other, method: "GET", body: { id: agent.payload.agent.id } });
    check("用量聚合：别人的员工看不了", usageStranger.status === 403, usageStranger.payload);
    check("对照：别人的列表里看不见这台 server", (await call("servers.list", { token: other })).payload.items?.length === 0);
    check("对照：拿别人的 server id 建员工被拒",
      (await call("agents.create", { token: other, body: { name: "偷", role: "x", server_id: serverId, model: "m" } })).payload.error === "server_not_found");

    // AI 替身：一键开、隐藏、覆盖你在的群、一键关。
    const standinGroup = await call("streams.create", {
      token: owner, body: { name: "替身验收群", join_policy: "request", agent_ids: [], vm_ids: [] },
    });
    const standinOn = await call("standin.enable", { token: owner, body: { server_id: serverId } });
    check("一键开替身：建隐藏员工并加入你在的群",
      standinOn.payload.enabled === true && (standinOn.payload.joined ?? []).includes(standinGroup.payload.stream.id),
      standinOn.payload);
    const listedAfter = await call("agents.list", { token: owner });
    check("替身不出现在员工列表里",
      !(listedAfter.payload.items ?? []).some((row) => row.kind === "standin"),
      (listedAfter.payload.items ?? []).map((row) => row.kind ?? null));
    const standinState = await call("standin.get", { token: owner });
    check("替身状态指向那条隐藏员工", standinState.payload.enabled === true && Boolean(standinState.payload.agent?.id), standinState.payload);
    const standinOff = await call("standin.disable", { token: owner });
    check("一键关：替身停用", standinOff.payload.enabled === false
      && (await call("standin.get", { token: owner })).payload.enabled === false, standinOff.payload);

    await call("servers.remove", { token: owner, body: { id: serverId } });
    const after = await call("agents.list", { token: owner });
    check("删掉 server 不牵连已经建在上面的员工（副本仍在）",
      after.payload.items?.find((item) => item.id === agent.payload.agent.id)?.api_base_url === boxSrv.origin);
    await boxSrv.close();
  }

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
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    // 半路崩了就没走到那些 .close()：假上游的监听还挂着，事件循环永远不空，
    // npm run qa 会一直挂着而不报失败。等 stdout 排空再退，失败行不会被截掉。
    if (process.exitCode) process.stdout.write("", () => process.exit(process.exitCode));
  });
