// 调度压测：单员工多群突发、抢占延迟、吞吐、多员工接力、权重公平、并发驱动、僵尸回收、规范 API 分段延迟。
// 用法：npm run bench（每个场景一套全新本机数据库，互不干扰；上游是带时序记录的假 SSE 服务）
// 不挂进 npm run qa：这里的断言带时序阈值，CI 机器抖动会误报；qa 只跑正确性自检（dev/smoke.mjs）。
// 绝对值受本机 fixture 影响（每次写库都全量落盘 JSON），看相对比例与不变量更有意义。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { makeHandler } from "../functions/handler.mjs";
import { store } from "../functions/store.mjs";
import { startWorker } from "../functions/worker.mjs";
import { reapStale } from "../functions/engine.mjs";
import { chatCompletion } from "../functions/agents.mjs";
import { createStreamServer } from "../functions/streamserver.mjs";
import { discoverStreamServer, askStreamServer } from "../functions/stream.mjs";
import { SHARED_PROFILE, endpointPath } from "../functions/streamspec.mjs";
import { newId } from "../functions/util.mjs";
import { createFixtureClient } from "./fixture-supabase.mjs";
import { listenStreamServer } from "./stream-server.mjs";

process.env.WORKSTREAM_DEV = "1";

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const iso = (ms) => new Date(ms).toISOString();
const at = (value) => new Date(value).getTime();
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

/** 上游调用的峰值并发：把开始/结束拍成事件流扫一遍，同一毫秒先算结束（保守）。 */
function peakConcurrency(calls) {
  const events = [];
  for (const call of calls) {
    events.push([call.at, 1]);
    if (call.endAt) events.push([call.endAt, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

async function waitFor(probe, { timeoutMs, intervalMs = 10, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(intervalMs);
  }
}

let passed = 0;
const failures = [];
const summary = [];

const step = (title) => console.log(`\n${title}`);

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL  ${name}${detail === undefined ? "" : ` → ${JSON.stringify(detail).slice(0, 260)}`}`);
}

const metric = (name, value) => {
  summary.push([name, String(value)]);
  console.log(`  ·     ${name} = ${value}`);
};

const block = (system, prefix) => {
  const found = String(system).split("\n\n").find((part) => part.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
};
const triggerOf = (system) => block(system, "上一条 @ 你的消息：");
const transcriptOf = (system) => block(system, "最近记录：");

/**
 * 假上游（OpenAI 兼容 SSE）：按触发消息里的关键词挑剧本，逐片下发正文，
 * 并记录每次调用的开始/首字节/结束/被提前掐断的时刻，供抢占延迟与并发度取数。
 */
function startUpstream({ chunkMs = 8, pieces = 4, slowChunks = 100, slowChunkMs = 60 } = {}) {
  const calls = [];
  const relay = { 小甲: "小乙", 小乙: "小甲" };
  const markerOf = (text) => /S\d+T\d+/.exec(text)?.[0] ?? "";

  const script = (trigger, agent) => {
    const marker = markerOf(trigger);
    if (trigger.includes("慢写")) {
      return { text: `慢写正文 ${marker} ${"填".repeat(260)}`, pieces: slowChunks, gap: slowChunkMs };
    }
    if (trigger.includes("改口")) return { text: `改口完成 ${marker}`, pieces, gap: chunkMs };
    if (trigger.includes("双发")) return { text: `已双发 ${marker}`, pieces: 8, gap: 40 };
    if (trigger.includes("接力")) {
      const hop = Number(/接力-(\d+)/.exec(trigger)?.[1] ?? 0);
      return { text: `@${relay[agent] ?? "小甲"} 接力-${hop + 1}`, pieces, gap: chunkMs };
    }
    return { text: `已处理 ${marker}`, pieces, gap: chunkMs };
  };

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
      const system = String(body.messages?.[0]?.content ?? "");
      const trigger = triggerOf(system);
      const record = {
        at: Date.now(),
        firstByteAt: 0,
        endAt: 0,
        closedEarly: false,
        agent: /你是虚拟员工「([^」]+)」/.exec(system)?.[1] ?? "",
        stream: /WorkStream 群「([^」]+)」/.exec(system)?.[1] ?? "",
        system,
        trigger,
        marker: markerOf(trigger),
        reply: "",
        sent: 0,
      };
      calls.push(record);
      res.on("error", () => {});
      // 客户端 cancel 掉流式读取时连接关闭：endAt 还没写就说明是被掐断的，不是自然结束。
      res.on("close", () => {
        if (!record.endAt) {
          record.closedEarly = true;
          record.endAt = Date.now();
        }
      });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      record.firstByteAt = Date.now();
      const alive = () => !res.destroyed && !res.writableEnded;
      const send = (delta, finishReason = null) => res.write(
        `data: ${JSON.stringify({ id: "bench", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
      const plan = script(trigger, record.agent);
      record.reply = plan.text;
      const stride = Math.max(1, Math.ceil(plan.text.length / plan.pieces));
      for (let from = 0; from < plan.text.length; from += stride) {
        if (!alive()) return;
        send({ content: plan.text.slice(from, from + stride) });
        record.sent += 1;
        await sleep(plan.gap);
      }
      if (!alive()) return;
      send({}, "stop");
      record.endAt = Date.now();
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        calls,
        inflight: () => calls.filter((call) => !call.endAt).length,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

let worlds = 0;
// 场景抛异常时也要能把定时器收干净，否则进程会挂在 setInterval 上不退。
const liveWorkers = [];

/** 一个场景一套全新数据库：状态小、落盘快，指标不会被上一个场景的存量拖累。 */
async function newWorld({ budget = 2, upstream, tickMs = 50 }) {
  worlds += 1;
  const dir = mkdtempSync(join(tmpdir(), "ws-bench-"));
  const supabase = createFixtureClient(join(dir, "db.json"));
  const db = store(supabase);
  process.env.WORKSTREAM_SLICE_BUDGET = String(budget);
  const env = (name) => process.env[name];
  const handler = makeHandler({ env });
  const logs = [];
  const email = `bench${worlds}@example.com`;

  async function call(action, { body, token, method = "POST" } = {}) {
    const url = new URL(`http://local/functions/v1/app?action=${encodeURIComponent(action)}`);
    if (method === "GET") {
      for (const [key, value] of Object.entries(body ?? {})) url.searchParams.set(key, String(value));
    }
    const request = new Request(url, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    const response = await handler({ request, supabase });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, payload };
  }

  const must = (result, label) => {
    if (result.status !== 200 || !result.payload.ok) {
      throw new Error(`${label} 失败：${result.status} ${JSON.stringify(result.payload).slice(0, 200)}`);
    }
    return result.payload;
  };

  const registered = must(await call("auth.register", {
    body: { email, password: "passw0rd-1", display_name: "压测员" },
  }), "auth.register");
  const verifyToken = decodeURIComponent(String(registered.verify_link ?? "").split("token=")[1] ?? "");
  if (verifyToken) must(await call("auth.verify", { body: { token: verifyToken } }), "auth.verify");
  const token = must(await call("auth.login", { body: { email, password: "passw0rd-1" } }), "auth.login").token;

  return {
    db,
    logs,
    token,
    call,
    must,
    budget,

    async agent(name) {
      const payload = must(await call("agents.create", {
        token,
        body: {
          name, role: "压测执行", backend: "openai", api_base_url: upstream.baseUrl, api_key: "bench-key-0123456",
          model: "bench-model", context_chars: 200_000,
        },
      }), `agents.create ${name}`);
      return payload.agent.id;
    },

    async stream(name, agentIds = []) {
      const payload = must(await call("streams.create", {
        token, body: { name, agent_ids: agentIds, context_chars: 200_000 },
      }), `streams.create ${name}`);
      return { id: payload.stream.id, name };
    },

    async weight(streamId, agentId, weight) {
      must(await call("scheduler.weight", { token, body: { stream_id: streamId, agent_id: agentId, weight } }), "scheduler.weight");
    },

    async send(streamId, content, agentIds = []) {
      return must(await call("messages.send", {
        token, body: { stream_id: streamId, content, mentions: agentIds.map((id) => ({ type: "agent", id })) },
      }), "messages.send");
    },

    async interrupt(streamId, agentId, messageId) {
      return must(await call("scheduler.interrupt", {
        token, body: { stream_id: streamId, agent_id: agentId, ...(messageId ? { message_id: messageId } : {}) },
      }), "scheduler.interrupt");
    },

    async tick() {
      return call("scheduler.tick", { token, method: "GET" });
    },

    /** 常驻调度：走线上同一条 worker 路径，压测的就是实际发货的那套驱动。 */
    worker() {
      const worker = startWorker({ supabase, env, tickMs, log: (line) => logs.push(line) });
      liveWorkers.push(worker);
      return worker;
    },

    async mails(agentIds) {
      const ids = Array.isArray(agentIds) ? agentIds : [agentIds];
      return db.mail.list([["agent_id", ids]], {
        columns: "id,agent_id,stream_id,message_id,trigger_seq,priority,status,error,slice_count,created_at,started_at,finished_at,meta",
        order: ["created_at", { ascending: true }], limit: 500,
      });
    },

    async openMails(agentIds) {
      const ids = Array.isArray(agentIds) ? agentIds : [agentIds];
      return db.mail.list([["agent_id", ids], ["status", ["queued", "running"]]], {
        columns: "id,status", limit: 500,
      });
    },

    async messages(streamId) {
      return db.messages.list([["stream_id", streamId]], {
        columns: "id,seq,sender_type,sender_id,sender_name,content,created_at",
        order: ["seq", { ascending: true }], limit: 500,
      });
    },

    /** 连续三轮看不到排队/在跑的信才算静默：接力与补投会在两封之间短暂清空队列。 */
    async waitQuiescent(agentIds, timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs;
      let quiet = 0;
      while (Date.now() < deadline) {
        quiet = (await this.openMails(agentIds)).length ? 0 : quiet + 1;
        if (quiet >= 3) return true;
        await sleep(40);
      }
      return false;
    },
  };
}

const marker = (index, round) => `S${index}T${String(round).padStart(2, "0")}`;
// worker.mjs 的 MAX_INFLIGHT：定时器不等上一轮结束，所以同时在跑的 tick 最多 3 轮，
// 有效并发上界 = 预算 × 3（而不是预算本身）。改那个常量时这里要跟着改。
const WORKER_INFLIGHT = 3;
// B4 抢槽场景的名次差门槛：实测重权整组先跑完（差距 24 位，满量程 48），
// 这里锁一个远低于实测、远高于"权重被洗平"（0）的下界；调权重语义时它会立刻红。
const RANK_GAP_MIN = 8;
const byStatus = (mails) => mails.reduce((acc, mail) => ({ ...acc, [mail.status]: (acc[mail.status] ?? 0) + 1 }), {});
const driverErrors = (world) => world.logs.filter((line) => line.includes("tick 失败"));

/** B1：一个员工被 N 个群同时轰炸，看正确性（不丢/不重/不串群/群内 FIFO）与吞吐。 */
async function runBurst({ upstream, budget, streamCount, rounds, label }) {
  step(`B1 单员工 × ${streamCount} 群 × ${rounds} 条突发（时间片预算 ${budget}）`);
  const world = await newWorld({ budget, upstream });
  const agentId = await world.agent("小压");
  const streams = [];
  for (let i = 0; i < streamCount; i += 1) streams.push(await world.stream(`压测群${i}`, [agentId]));
  // 发送阶段单独计时：这期间还没有人开跑，信的 created_at 全部早于 t0，
  // 不分开报就会让"起跑延迟"看起来比整个排空还长。
  const sendT0 = Date.now();
  for (let i = 0; i < streamCount; i += 1) {
    for (let round = 1; round <= rounds; round += 1) {
      await world.send(streams[i].id, `请处理 ${marker(i, round)}`, [agentId]);
    }
  }
  const sendMs = Date.now() - sendT0;
  const total = streamCount * rounds;
  const queued = (await world.mails(agentId)).length;
  check(`${label}：${total} 条 @ 全部入队`, queued === total, { queued });

  const from = upstream.calls.length;
  const t0 = Date.now();
  const worker = world.worker();
  const drained = await world.waitQuiescent(agentId);
  const makespan = Date.now() - t0;
  await worker.stop();

  const mails = await world.mails(agentId);
  const calls = upstream.calls.slice(from);
  const real = mails.filter((mail) => mail.meta?.kind !== "compress");
  const receipts = mails.filter((mail) => mail.meta?.receipt);

  check(`${label}：队列排空且全部完成`, drained && real.length === total && real.every((mail) => mail.status === "done"), {
    drained, 状态: byStatus(mails), 错误样例: mails.filter((mail) => mail.error).slice(0, 2).map((mail) => mail.error),
  });
  check(`${label}：没有失败/取消/卡住 running`, !mails.some((mail) => mail.status !== "done"), byStatus(mails));
  check(`${label}：突发没触发后台压缩（窗口按字符封顶，没截断）`, mails.length === total, { mails: mails.length, total });
  check(`${label}：每封只被认领一次`, real.every((mail) => Number(mail.slice_count) === 1),
    real.filter((mail) => Number(mail.slice_count) !== 1).slice(0, 3));
  check(`${label}：上游调用数 == 完成信数（并发驱动下不重复执行）`, calls.length === total && !receipts.length,
    { 调用: calls.length, 完成: total });
  check(`${label}：worker 没有静默吞掉调度异常`, driverErrors(world).length === 0, driverErrors(world).slice(0, 2));

  // 群内 FIFO：第 k 次调用的上下文里必须已经能看到第 k-1 条回复，说明同群是串起来的、没有并发插队。
  const fifoBreaks = [];
  const pairOverlaps = [];
  const leaks = [];
  const orderBreaks = [];
  // 前缀复用口径与 smoke 8d 相同：相邻两轮 system 的公共前缀 ÷ 本轮长度。
  // 这是按前缀缓存语义本地算出来的可复用比例，不是提供商回报的 cached_tokens。
  const prefixRatios = [];
  for (let i = 0; i < streamCount; i += 1) {
    const name = `压测群${i}`;
    const mine = calls.filter((call) => call.stream === name).sort((a, b) => a.at - b.at);
    mine.forEach((call, k) => {
      if (k > 0 && !call.system.includes(`已处理 ${marker(i, k)}`)) fifoBreaks.push({ 群: i, 第几次: k + 1 });
      if (k > 0 && call.at < mine[k - 1].endAt) pairOverlaps.push({ 群: i, 第几次: k + 1 });
      if (k > 0) {
        const prev = mine[k - 1].system;
        let shared = 0;
        while (shared < prev.length && shared < call.system.length && prev[shared] === call.system[shared]) shared += 1;
        prefixRatios.push(shared / call.system.length);
      }
    });
    // 上下文里出现别的群的标记 = 串群（窗口取错群、或装配把两群混在一起）。
    const seen = new Set(mine.flatMap((call) => call.system.match(/S\d+T\d+/g) ?? [])
      .map((mark) => Number(/^S(\d+)/.exec(mark)[1])));
    if ([...seen].some((index) => index !== i)) leaks.push({ 群: i, 混入: [...seen] });
    const texts = (await world.messages(streams[i].id))
      .filter((row) => row.sender_type === "agent").map((row) => row.content);
    const expected = Array.from({ length: rounds }, (_, j) => `已处理 ${marker(i, j + 1)}`);
    if (JSON.stringify(texts) !== JSON.stringify(expected)) orderBreaks.push({ 群: i, 落群: texts });
  }
  check(`${label}：群内严格 FIFO（后一次调用能看到前一次的回复）`, fifoBreaks.length === 0, fifoBreaks.slice(0, 3));
  check(`${label}：同 (员工,群) 不并发执行`, pairOverlaps.length === 0, pairOverlaps.slice(0, 3));
  check(`${label}：上下文不串群（只出现本群标记）`, leaks.length === 0, leaks.slice(0, 2));
  check(`${label}：回复按序落群，不丢不重`, orderBreaks.length === 0, orderBreaks.slice(0, 2));

  const exec = real.map((mail) => at(mail.finished_at) - at(mail.started_at));
  const queue = real.map((mail) => at(mail.started_at) - at(mail.created_at));
  const wait = real.map((mail) => Math.max(0, at(mail.started_at) - t0));
  const perStreamEnd = streams.map((stream) => Math.max(...real
    .filter((mail) => mail.stream_id === stream.id).map((mail) => at(mail.finished_at))));
  // 有效并发的上界是"预算 × worker 并发轮次"，下界是"预算"（排队群数比预算少时按群数封顶）。
  // 预算翻倍但排空没翻倍，就是被这条上界卡住的，不是调度不干活。
  const peak = peakConcurrency(calls);
  const ceiling = Math.min(streamCount, budget * WORKER_INFLIGHT);
  check(`${label}：有效并发落在 [预算, min(群数, 预算×${WORKER_INFLIGHT} 轮)] 区间`,
    peak >= Math.min(streamCount, budget) && peak <= ceiling, { 峰值: peak, 上界: ceiling });
  metric(`${label} 发送阶段（${total} 条 @，未开跑）`, `${sendMs}ms`);
  metric(`${label} 排空 ${total} 封`, `${makespan}ms`);
  metric(`${label} 吞吐`, `${(total / (makespan / 1000)).toFixed(1)} 封/秒`);
  metric(`${label} 单封执行 p50/p95`, `${pct(exec, 50)}/${pct(exec, 95)}ms`);
  metric(`${label} 排队时长（自建信起）p50/p95/max`, `${pct(queue, 50)}/${pct(queue, 95)}/${Math.max(...queue)}ms`);
  metric(`${label} 起跑延迟（自开跑起）p50/p95/max`, `${pct(wait, 50)}/${pct(wait, 95)}/${Math.max(...wait)}ms`);
  metric(`${label} 峰值并发（上游侧）`, `${peak}（上界 ${ceiling}）`);
  metric(`${label} 各群排空时点跨度`, `${Math.max(...perStreamEnd) - Math.min(...perStreamEnd)}ms`);
  metric(`${label} 同群相邻两轮前缀复用率 p50/min（本地按前缀语义计算）`,
    `${(pct(prefixRatios, 50) * 100).toFixed(1)}%/${(Math.min(...prefixRatios) * 100).toFixed(1)}%（${prefixRatios.length} 对）`);
  return { makespan, total, peak, execP50: pct(exec, 50), waitP95: pct(wait, 95) };
}

/** B7：Stream 规范 API 的分段延迟。loopback 参考执行器（shared 档）挂同一个假上游，
 *  与 OpenAI 直连对照：量的是协议这一跳本身的开销，不含模型推理差异。 */
async function streamApiScenario(upstream) {
  step("B7 Stream 规范 API 分段延迟（loopback 参考执行器，shared 档，40 轮）");
  const token = randomBytes(24).toString("hex");
  const executor = await listenStreamServer({
    server: createStreamServer({
      upstreamUrl: upstream.baseUrl, upstreamKey: "bench-key-0123456", upstreamModel: "bench-model",
      token, label: "bench-executor",
    }),
    port: 0,
  });
  const origin = executor.origin;
  const expected = "已处理 S9T01";
  const messages = [
    { role: "system", content: "你是虚拟员工「小测」，正在 WorkStream 群「延迟群」里工作。\n\n上一条 @ 你的消息：安娜：请处理 S9T01" },
    { role: "user", content: "请按上面的上下文回应这条任务。" },
  ];
  const rounds = 40;
  const discovery = [];
  const wireFirst = [];
  const wireDone = [];
  const clientRound = [];
  const directFirst = [];
  const directRound = [];
  const overhead = [];
  let profileOk = 0;
  let wireOk = 0;
  let clientOk = 0;
  let directOk = 0;
  try {
    for (let i = 0; i < rounds; i += 1) {
      let t0 = Date.now();
      const found = await discoverStreamServer({ origin, token });
      discovery.push(Date.now() - t0);
      if (found.descriptor && found.profile === SHARED_PROFILE) profileOk += 1;

      // 规范线上逐帧量：POST → 首个 turn.delta → 权威 turn.done。
      t0 = Date.now();
      const response = await fetch(`${origin}${endpointPath("createTurn")}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ turn_id: newId(), model: "bench-model", messages }),
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstAt = 0;
      let doneAt = 0;
      let doneContent = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (!raw.startsWith("data: ")) continue;
          const data = raw.slice(6);
          if (data === "[DONE]") continue;
          const payload = JSON.parse(data);
          if (payload.type === "turn.delta" && !firstAt) firstAt = Date.now();
          if (payload.type === "turn.done") {
            doneAt = Date.now();
            doneContent = payload.content;
          }
        }
      }
      reader.releaseLock();
      wireFirst.push(firstAt - t0);
      wireDone.push(doneAt - t0);
      if (doneContent === expected) wireOk += 1;

      // 生产客户端整轮（askStreamServer 的 shared 档），与裸 fetch 的差就是客户端装配那一段。
      t0 = Date.now();
      const result = await askStreamServer({
        db: null,
        agent: { api_base_url: `${origin}/stream-server/v1`, model: "bench-model", stream_profile: SHARED_PROFILE },
        streamId: "bench", key: token, messages,
        openai: () => { throw new Error("B7 不该退回 OpenAI 档"); },
      });
      const clientMs = Date.now() - t0;
      clientRound.push(clientMs);
      if (result.content === expected) clientOk += 1;

      // 对照：同一个假上游，OpenAI 直连。
      t0 = Date.now();
      let directFirstAt = 0;
      const direct = await chatCompletion({
        baseUrl: upstream.baseUrl, apiKey: "bench-key-0123456", model: "bench-model", messages,
        onDelta: (delta) => { if (!directFirstAt && (delta.content || delta.reasoning)) directFirstAt = Date.now(); },
      });
      const directMs = Date.now() - t0;
      directFirst.push(directFirstAt - t0);
      directRound.push(directMs);
      if (direct.content === expected) directOk += 1;
      overhead.push(clientMs - directMs);
    }
  } finally {
    await executor.close();
  }
  check("B7：发现 40 次都解析成功且判为 shared 档", profileOk === rounds, { profileOk });
  check("B7：权威帧/客户端/直连三方正文一致（协议没改内容）",
    wireOk === rounds && clientOk === rounds && directOk === rounds, { wireOk, clientOk, directOk });
  check("B7：协议净开销 p95 ≤ 250ms（loopback，同一上游剧本）", pct(overhead, 95) <= 250, { p95: pct(overhead, 95) });
  metric("B7 发现 GET p50/p95", `${pct(discovery, 50)}/${pct(discovery, 95)}ms`);
  metric("B7 POST→首个增量帧 p50/p95", `${pct(wireFirst, 50)}/${pct(wireFirst, 95)}ms`);
  metric("B7 POST→权威帧 p50/p95", `${pct(wireDone, 50)}/${pct(wireDone, 95)}ms`);
  metric("B7 客户端整轮（askStreamServer）p50/p95", `${pct(clientRound, 50)}/${pct(clientRound, 95)}ms`);
  metric("B7 直连对照 首字 p50/p95", `${pct(directFirst, 50)}/${pct(directFirst, 95)}ms`);
  metric("B7 直连对照 整轮 p50/p95", `${pct(directRound, 50)}/${pct(directRound, 95)}ms`);
  metric("B7 规范协议净开销（整轮差）p50/p95", `${pct(overhead, 50)}/${pct(overhead, 95)}ms`);
}

async function main() {
  const upstream = await startUpstream();
  try {
    // B1：默认预算 2 与拉满预算 8 各跑一遍，看时间片预算对突发排空的直接影响。
    const low = await runBurst({ upstream, budget: 2, streamCount: 8, rounds: 3, label: "预算2" });
    const high = await runBurst({ upstream, budget: 8, streamCount: 8, rounds: 3, label: "预算8" });
    metric("B1 预算 2→8 排空提速", `${(low.makespan / high.makespan).toFixed(2)}×（峰值并发 ${low.peak}→${high.peak}）`);
    // 提速不线性不是调度不干活：并发确实开到了上界，但本机 JSON 夹具每次写库都同步全量落盘，
    // 并发越高事件循环越堵，单封执行时间随之膨胀。绝对值不能外推到真库，相对结论（不丢不重不串群）才作数。
    metric("B1 预算 2→8 单封执行膨胀", `${low.execP50}→${high.execP50}ms（本机夹具开销，非调度回归）`);

    await preemptScenario(upstream);
    await relayScenario(upstream);
    await weightScenario(upstream);
    await concurrentDriversScenario(upstream);
    await zombieScenario(upstream);
    await streamApiScenario(upstream);
  } finally {
    await Promise.all(liveWorkers.map((worker) => worker.stop()));
    await upstream.close();
  }

  console.log("\n指标汇总");
  const width = Math.max(...summary.map(([name]) => displayWidth(name)));
  for (const [name, value] of summary) {
    console.log(`  ${name}${" ".repeat(Math.max(2, width - displayWidth(name) + 2))}${value}`);
  }
  console.log(`\n${passed} 项通过，${failures.length} 项失败${failures.length ? `：${failures.join("；")}` : ""}`);
  process.exitCode = failures.length ? 1 : 0;
}

const displayWidth = (text) => [...text].reduce((width, ch) => width + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);

/** B2：多群都在跑慢任务时，插话/叫停多快能掐断上游，以及会不会波及别的群。 */
async function preemptScenario(upstream) {
  step("B2 抢占延迟：5 群慢任务并行时插话 / 叫停");
  const world = await newWorld({ budget: 5, upstream });
  const agentId = await world.agent("小抢");
  const streams = [];
  for (let i = 0; i < 5; i += 1) streams.push({ index: i, ...(await world.stream(`抢占群${i}`, [agentId])) });
  const worker = world.worker();
  for (const stream of streams) await world.send(stream.id, `请慢写 ${marker(stream.index, 1)}`, [agentId]);
  const inflight = await waitFor(() => (upstream.inflight() >= 3 ? upstream.inflight() : null),
    { timeoutMs: 30_000, label: "至少 3 个群同时在跑" });
  metric("B2 抢占时的并行慢任务数", inflight);

  // 慢任务逐个起跑、也会逐个自然结束，所以目标从"此刻真在跑的那几个群"里现挑，不写死序号。
  const live = () => upstream.calls.filter((call) => !call.endAt && call.stream.startsWith("抢占群"));
  const used = new Set();
  const nextLive = () => {
    const call = live().find((item) => !used.has(item.stream));
    return call ? streams.find((stream) => stream.name === call.stream) ?? null : null;
  };

  // 插话：@ 正在跑的员工 → 掐断当前生成并按新消息重答。
  const steerLatency = [];
  const steerEndToEnd = [];
  for (let round = 0; round < 2; round += 1) {
    const stream = await waitFor(() => nextLive(), { timeoutMs: 20_000, intervalMs: 20, label: "有慢任务在跑（插话）" });
    used.add(stream.name);
    const target = live().find((call) => call.stream === stream.name);
    const t0 = Date.now();
    const sent = await world.send(stream.id, `改口 ${marker(stream.index, 1)}：只回一句收到`, [agentId]);
    await waitFor(() => (target.endAt ? true : null), { timeoutMs: 10_000, intervalMs: 5, label: "上游被掐断" });
    steerLatency.push(target.endAt - t0);
    const reply = await waitFor(async () => {
      const rows = (await world.messages(stream.id)).filter((row) => row.sender_type === "agent");
      return rows.length ? rows.at(-1) : null;
    }, { timeoutMs: 20_000, intervalMs: 20, label: "重答落群" });
    steerEndToEnd.push(at(reply.created_at) - t0);
    check(`B2：插话 ${stream.name} 被登记为抢占，不另起一封任务（不会回两遍）`,
      sent.interrupted.length === 1 && sent.queued.length === 0,
      { interrupted: sent.interrupted, queued: sent.queued });
    check(`B2：插话 ${stream.name} 的半截输出没有落群，只有重答那一条`,
      reply.content === `改口完成 ${marker(stream.index, 1)}`
        && (await world.messages(stream.id)).filter((row) => row.sender_type === "agent").length === 1,
      { 落群: reply.content });
    const rerun = upstream.calls.filter((call) => call.stream === stream.name).at(-1);
    check(`B2：插话 ${stream.name} 的重答上下文带着半截输出与新指令`,
      rerun.system.includes("被 @ 你的新消息打断") && rerun.system.includes("慢写正文"),
      { 触发: rerun.trigger });
  }
  check("B2：插话都在 500ms 内掐断上游", Math.max(...steerLatency) < 500, steerLatency);
  metric("B2 插话抢占 发消息→掐断 max", `${Math.max(...steerLatency)}ms（上游分片间隔 60ms）`);
  metric("B2 插话端到端 发消息→重答落群 max", `${Math.max(...steerEndToEnd)}ms`);

  // 叫停：不带 message_id，只要求立刻停下、不再产出回复。
  const stopStream = await waitFor(() => nextLive(), { timeoutMs: 20_000, intervalMs: 20, label: "有慢任务在跑（叫停）" });
  used.add(stopStream.name);
  const stopTarget = live().find((call) => call.stream === stopStream.name);
  const t0 = Date.now();
  const stopped = await world.interrupt(stopStream.id, agentId);
  await waitFor(() => (stopTarget.endAt ? true : null), { timeoutMs: 10_000, intervalMs: 5, label: "叫停后上游被掐断" });
  metric("B2 叫停抢占 调用→掐断", `${stopTarget.endAt - t0}ms`);
  check("B2：叫停在 500ms 内掐断上游", stopTarget.endAt - t0 < 500, { ms: stopTarget.endAt - t0 });
  check("B2：叫停返回的就是正在跑的那封信", stopped.mode === "stop" && Boolean(stopped.mail_id), stopped);
  await waitFor(async () => {
    const mail = (await world.mails(agentId)).find((row) => row.id === stopped.mail_id);
    return mail?.status === "cancelled" ? mail : null;
  }, { timeoutMs: 20_000, intervalMs: 20, label: "叫停的任务落到 cancelled" });
  check("B2：叫停后不再产出回复（群里没有该员工的发言）",
    (await world.messages(stopStream.id)).filter((row) => row.sender_type === "agent").length === 0);

  // 没被碰过的群：此刻仍在自然生成，不能被别的群的抢占波及。
  const bystanders = streams.filter((stream) => !used.has(stream.name));
  const bystanderCalls = bystanders.map((stream) => upstream.calls.filter((call) => call.stream === stream.name).at(-1));
  check("B2：其余群的慢任务不受影响，仍在正常生成",
    bystanderCalls.every((call) => call && !call.closedEarly),
    bystanderCalls.map((call) => ({ 群: call?.stream, 掐断: call?.closedEarly })));

  const settled = await world.waitQuiescent(agentId, 60_000);
  await worker.stop();
  const mails = await world.mails(agentId);
  const receipts = mails.filter((mail) => mail.meta?.receipt === "steer");
  const originals = mails.filter((mail) => !mail.meta?.receipt);
  check("B2：慢任务全部自然跑完，队列静默", settled
    && bystanderCalls.every((call) => !call.closedEarly && call.reply.startsWith("慢写正文")),
    bystanderCalls.map((call) => ({ 群: call.stream, 掐断: call.closedEarly })));
  check("B2：5 封原始任务 = 4 done + 1 cancelled（叫停那封）",
    originals.length === 5 && originals.filter((mail) => mail.status === "done").length === 4
      && originals.filter((mail) => mail.status === "cancelled").length === 1,
    byStatus(originals));
  check("B2：被消化的插话各补一条回执，群里那条不会一直显示未读",
    receipts.length === 2 && receipts.every((mail) => mail.status === "done"), byStatus(receipts));
  metric("B2 慢任务本体时长（未被抢占的群）",
    `${pct(bystanderCalls.map((call) => call.endAt - call.at), 50)}ms`);
}

/** B3：多员工接力——@ 链条、跳数上限、上下文承接，以及一条消息 @ 两个员工时的并行执行。 */
async function relayScenario(upstream) {
  step("B3 多员工接力：@ 链条 / 跳数上限 / 上下文承接 / 双员工并发");
  const world = await newWorld({ budget: 4, upstream });
  const [alpha, beta] = [await world.agent("小甲"), await world.agent("小乙")];
  const chain = await world.stream("接力群", [alpha, beta]);
  const worker = world.worker();

  const from = upstream.calls.length;
  const t0 = Date.now();
  await world.send(chain.id, "@小甲 接力-1", [alpha]);
  const settled = await world.waitQuiescent([alpha, beta], 60_000);
  const relayMs = Date.now() - t0;
  const mails = (await world.mails([alpha, beta])).sort((a, b) => at(a.created_at) - at(b.created_at));
  const calls = upstream.calls.slice(from);
  // 建群时的系统消息不算发言：群里该看到的只有人的指令与员工的结论。
  const chat = (await world.messages(chain.id)).filter((row) => row.sender_type !== "system");

  check("B3：接力跑完并静默", settled, byStatus(mails));
  check("B3：链条共 4 封，跳数依次 0→1→2→3", mails.length === 4
    && mails.map((mail) => Number(mail.meta?.hops ?? 0)).join(",") === "0,1,2,3",
    mails.map((mail) => ({ hops: mail.meta?.hops ?? 0, status: mail.status })));
  check("B3：跳数到上限那封 failed=hop_limit，链条就此终止（不再投新任务）",
    mails.at(-1).status === "failed" && mails.at(-1).error === "hop_limit",
    { 末封: { status: mails.at(-1).status, error: mails.at(-1).error } });
  check("B3：前三棒都成功", mails.slice(0, 3).every((mail) => mail.status === "done"), byStatus(mails));
  check("B3：接力棒在两个员工之间交替", mails.map((mail) => mail.agent_id).join(",")
    === [alpha, beta, alpha, beta].join(","), mails.map((mail) => mail.agent_id));

  const relayCalls = calls.filter((call) => call.trigger.includes("接力")).sort((a, b) => a.at - b.at);
  const missing = relayCalls.filter((call, k) => k > 0
    && !new RegExp(`\\[虚拟\\] .*接力-${k + 1}`).test(transcriptOf(call.system)));
  check("B3：每一棒的上下文里都带着上一棒的回复（承接不断档）",
    relayCalls.length === 3 && missing.length === 0,
    missing.map((call) => ({ 员工: call.agent, 触发: call.trigger })));
  check("B3：群里只留结论性发言，1 条人 + 3 条虚拟，没有失败噪声",
    chat.length === 4 && chat.filter((row) => row.sender_type === "human").length === 1
      && chat.filter((row) => row.sender_type === "agent").length === 3,
    chat.map((row) => `${row.sender_type}:${row.content.slice(0, 20)}`));
  const hopExec = mails.slice(0, 3).map((mail) => at(mail.finished_at) - at(mail.started_at));
  const hopWait = mails.slice(0, 3).map((mail) => at(mail.started_at) - at(mail.created_at));
  metric("B3 接力端到端（3 棒 + 触顶终止）", `${relayMs}ms`);
  metric("B3 单棒执行 p50/max", `${pct(hopExec, 50)}/${Math.max(...hopExec)}ms`);
  metric("B3 单棒排队 p50/max", `${pct(hopWait, 50)}/${Math.max(...hopWait)}ms`);

  // 一条消息同时 @ 两个员工：两封任务应被同一轮放出去并行执行。
  const pair = await world.stream("双发群", [alpha, beta]);
  const before = upstream.calls.length;
  const t1 = Date.now();
  const sent = await world.send(pair.id, `请双发 ${marker(9, 1)}`, [alpha, beta]);
  const pairSettled = await world.waitQuiescent([alpha, beta], 60_000);
  const pairMs = Date.now() - t1;
  const pairCalls = upstream.calls.slice(before).filter((call) => call.stream === "双发群");
  check("B3：一条消息 @ 两个员工 → 两封任务", sent.queued.length === 2, sent.queued);
  check("B3：两个员工都回复且没有互相触发接力", pairSettled && pairCalls.length === 2
    && pairCalls.every((call) => call.reply === `已双发 ${marker(9, 1)}` && !call.closedEarly),
    pairCalls.map((call) => ({ 员工: call.agent, 回复: call.reply })));
  check("B3：两个员工真的并行执行（上游调用区间重叠）", pairCalls.length === 2
    && pairCalls[0].at < pairCalls[1].endAt && pairCalls[1].at < pairCalls[0].endAt,
    pairCalls.map((call) => [call.at - t1, call.endAt - t1]));
  check("B3：双发群里两条回复都在（序号不打架）",
    (await world.messages(pair.id)).filter((row) => row.sender_type === "agent").length === 2);
  metric("B3 双员工并发同发总耗时",
    `${pairMs}ms（单个员工约 ${pairCalls.length ? Math.max(...pairCalls.map((call) => call.endAt - call.at)) : 0}ms）`);
  await worker.stop();
}

/** B4：权重公平。权重只在"槽位不够分"时起作用，所以同一套积压（12 个群：6 个 w=5 + 6 个 w=1，各 4 封）跑两遍：
 *  预算 2 → 有效并发上界 2×3=6 槽 < 12 个群，真抢不到，重权应当明显靠前；
 *  预算 8 → 上界 24 槽 > 12 个群，人人有槽，权重根本无从生效。
 *  两条一起才说明白语义边界：w=5 买到的是"缺槽时的优先权"，不是"永远压住别人"。 */
async function weightScenario(upstream) {
  const contended = await weightPass({ upstream, budget: 2, mode: "抢槽" });
  const slack = await weightPass({ upstream, budget: 8, mode: "富余" });
  metric("B4 权重生效边界", `槽位 ${contended.slots}<12 群：名次差 ${contended.gap.toFixed(1)}；`
    + `槽位 ${slack.slots}>12 群：名次差 ${slack.gap.toFixed(1)}（权重无从生效）`);
}

async function weightPass({ upstream, budget, mode }) {
  const heavyCount = 6;
  const lightCount = 6;
  const rounds = 4;
  const slots = budget * WORKER_INFLIGHT;
  const label = `B4 ${mode}（预算 ${budget}，${slots} 槽 vs ${heavyCount + lightCount} 群）`;
  step(`${label}：${heavyCount} 个重权群(w=5) + ${lightCount} 个轻权群(w=1)，各积压 ${rounds} 封`);
  const world = await newWorld({ budget, upstream });
  const agentId = await world.agent("小权");
  const heavy = [];
  const light = [];
  for (let i = 0; i < heavyCount; i += 1) heavy.push(await world.stream(`重权群${i}`, [agentId]));
  for (let i = 0; i < lightCount; i += 1) light.push(await world.stream(`轻权群${i}`, [agentId]));
  const order = [...heavy, ...light];
  const heavyIds = new Set(heavy.map((stream) => stream.id));
  for (const stream of heavy) await world.weight(stream.id, agentId, 5);
  const sendT0 = Date.now();
  for (let i = 0; i < order.length; i += 1) {
    for (let round = 1; round <= rounds; round += 1) {
      await world.send(order[i].id, `请处理 ${marker(i, round)}`, [agentId]);
    }
  }
  const sendMs = Date.now() - sendT0;
  const total = order.length * rounds;
  const backlog = await world.mails(agentId);
  check(`${label}：${total} 封入队时优先级已按权重落库`, backlog.length === total
    && backlog.every((mail) => Number(mail.priority) === (heavyIds.has(mail.stream_id) ? 5 : 1)),
    { 入队: backlog.length, 优先级: [...new Set(backlog.map((mail) => mail.priority))] });

  const t0 = Date.now();
  const worker = world.worker();
  const settled = await world.waitQuiescent(agentId, 180_000);
  const makespan = Date.now() - t0;
  await worker.stop();

  const mails = await world.mails(agentId);
  const ofHeavy = mails.filter((mail) => heavyIds.has(mail.stream_id));
  const ofLight = mails.filter((mail) => !heavyIds.has(mail.stream_id));
  check(`${label}：${total} 封全部完成，没有失败/取消/卡住`, settled && mails.length === total
    && mails.every((mail) => mail.status === "done"), { settled, 状态: byStatus(mails) });
  check(`${label}：轻权群没有被饿死（${lightCount * rounds} 封也都跑完）`,
    ofLight.length === lightCount * rounds && ofLight.every((mail) => mail.status === "done"),
    { 轻权: byStatus(ofLight) });
  check(`${label}：worker 没有静默吞掉调度异常`, driverErrors(world).length === 0, driverErrors(world).slice(0, 2));

  // 完成名次：全部信按 finished_at 排序后取平均。没有权重时两组都应为 (total+1)/2。
  const ranked = [...mails].sort((a, b) => at(a.finished_at) - at(b.finished_at));
  const rank = new Map(ranked.map((mail, index) => [mail.id, index + 1]));
  const mean = (rows) => rows.reduce((sum, mail) => sum + rank.get(mail.id), 0) / (rows.length || 1);
  const heavyRank = mean(ofHeavy);
  const lightRank = mean(ofLight);
  const gap = lightRank - heavyRank;
  const fair = (total + 1) / 2;

  // 抢不到槽时才谈优先：重权平均名次显著靠前、且整组先排空。
  // 人人有槽时权重无从生效，反过来断言"轻权不用等重权排空就开始跑"，把这条边界钉住。
  if (slots < order.length) {
    check(`${label}：重权群买到优先（平均名次靠前 ${gap.toFixed(1)} 位，阈值 ${RANK_GAP_MIN}）`,
      heavyRank < fair && gap >= RANK_GAP_MIN,
      { 重权平均名次: heavyRank.toFixed(1), 轻权平均名次: lightRank.toFixed(1), 无权重时应为: fair });
    check(`${label}：重权群整体先排空`,
      Math.max(...ofHeavy.map((mail) => at(mail.finished_at))) < Math.max(...ofLight.map((mail) => at(mail.finished_at))),
      { 重权排空: Math.max(...ofHeavy.map((mail) => at(mail.finished_at))) - t0,
        轻权排空: Math.max(...ofLight.map((mail) => at(mail.finished_at))) - t0 });
  } else {
    check(`${label}：槽位富余时不构成严格优先（轻权与重权同期起跑）`,
      Math.min(...ofLight.map((mail) => at(mail.started_at))) < Math.max(...ofHeavy.map((mail) => at(mail.finished_at))),
      { 轻权起跑: Math.min(...ofLight.map((mail) => at(mail.started_at))) - t0,
        重权排空: Math.max(...ofHeavy.map((mail) => at(mail.finished_at))) - t0 });
  }

  // 无论抢不抢得到槽，正确性不许让步：每群 4 条回复按序落群，不串群、不重复。
  const orderBreaks = [];
  for (let i = 0; i < order.length; i += 1) {
    const texts = (await world.messages(order[i].id))
      .filter((row) => row.sender_type === "agent").map((row) => row.content);
    const expected = Array.from({ length: rounds }, (_, j) => `已处理 ${marker(i, j + 1)}`);
    if (JSON.stringify(texts) !== JSON.stringify(expected)) orderBreaks.push({ 群: order[i].name, 落群: texts });
  }
  check(`${label}：每群回复仍按序落群，不串群不重复`, orderBreaks.length === 0, orderBreaks.slice(0, 2));

  const heavyEnd = Math.max(...ofHeavy.map((mail) => at(mail.finished_at)));
  const lightEnd = Math.max(...ofLight.map((mail) => at(mail.finished_at)));
  const queue = (rows) => rows.map((mail) => at(mail.started_at) - at(mail.created_at));
  metric(`${label} 发送阶段（${total} 条 @，未开跑）`, `${sendMs}ms`);
  metric(`${label} 排空 ${total} 封`, `${makespan}ms`);
  metric(`${label} 重权/轻权排空耗时`, `${heavyEnd - t0}ms / ${lightEnd - t0}ms`);
  metric(`${label} 平均完成名次 重权/轻权`, `${heavyRank.toFixed(1)} / ${lightRank.toFixed(1)}（无权重时都是 ${fair}）`);
  metric(`${label} 排队时长 p50/p95 重权`, `${pct(queue(ofHeavy), 50)}/${pct(queue(ofHeavy), 95)}ms`);
  metric(`${label} 排队时长 p50/p95 轻权`, `${pct(queue(ofLight), 50)}/${pct(queue(ofLight), 95)}ms`);
  return { makespan, heavyRank, lightRank, gap, slots };
}

/** B5：多个驱动者（前端轮询 + worker + 手工 tick）同时抢同一批信，认领必须是单行 CAS。 */
async function concurrentDriversScenario(upstream) {
  step("B5 并发驱动者：6 个 tick 同时抢 12 封排队信");
  const world = await newWorld({ budget: 2, upstream });
  const agentId = await world.agent("小并");
  const streams = [];
  for (let i = 0; i < 3; i += 1) streams.push(await world.stream(`并发群${i}`, [agentId]));
  for (let i = 0; i < streams.length; i += 1) {
    for (let round = 1; round <= 4; round += 1) await world.send(streams[i].id, `请处理 ${marker(i, round)}`, [agentId]);
  }
  const total = 12;
  const from = upstream.calls.length;
  const ranIds = [];
  let rounds = 0;
  for (; rounds < 30; rounds += 1) {
    if (!(await world.openMails(agentId)).length) break;
    const results = await Promise.all(Array.from({ length: 6 }, () => world.tick()));
    for (const result of results) {
      if (result.status !== 200 || !result.payload.ok) throw new Error(`tick 失败：${JSON.stringify(result.payload).slice(0, 160)}`);
      ranIds.push(...(result.payload.ran ?? []).map((item) => item.mail_id));
    }
  }
  const calls = upstream.calls.slice(from);
  const mails = await world.mails(agentId);
  check("B5：6 路并发 tick 下 12 封全部完成", mails.length === total && mails.every((mail) => mail.status === "done"),
    { 轮次: rounds, 状态: byStatus(mails) });
  check("B5：并发 tick 的 ran 列表互不重叠（认领是单行 CAS）", new Set(ranIds).size === ranIds.length,
    { ran: ranIds.length, 去重: new Set(ranIds).size });
  check("B5：上游调用数 == 信数，没有重复执行", calls.length === total, { 调用: calls.length });
  check("B5：每封只被认领一次（slice_count=1）", mails.every((mail) => Number(mail.slice_count) === 1),
    mails.filter((mail) => Number(mail.slice_count) !== 1).slice(0, 3));
  const dupeStreams = [];
  for (let i = 0; i < streams.length; i += 1) {
    const texts = (await world.messages(streams[i].id))
      .filter((row) => row.sender_type === "agent").map((row) => row.content);
    if (texts.length !== 4 || new Set(texts).size !== 4) dupeStreams.push({ 群: i, 落群: texts });
  }
  check("B5：每群 4 条回复，一条不多一条不少", dupeStreams.length === 0, dupeStreams.slice(0, 2));
  metric("B5 并发驱动下的重复执行次数", calls.length - mails.filter((mail) => mail.status === "done").length);
  metric("B5 峰值并发（上游侧）", peakConcurrency(calls));
}

/** B6：进程被杀留下的 running 僵尸信要能回收，且回收时把期间收到的插话转成待办，不能丢。 */
async function zombieScenario(upstream) {
  step("B6 僵尸回收：running 超 5 分钟 + 期间的插话不丢");
  const world = await newWorld({ budget: 2, upstream });
  const agentId = await world.agent("小僵");
  const staleStream = await world.stream("僵尸群", [agentId]);
  const freshStream = await world.stream("僵尸群B", [agentId]);
  const first = await world.send(staleStream.id, `请处理 ${marker(0, 1)}`, [agentId]);
  const steer = await world.send(staleStream.id, `改口 ${marker(0, 1)}：只回一句收到`, []);
  const fresh = await world.send(freshStream.id, `请处理 ${marker(1, 1)}`, [agentId]);
  const mails = await world.mails(agentId);
  const staleMail = mails.find((mail) => mail.message_id === first.message.id);
  const freshMail = mails.find((mail) => mail.message_id === fresh.message.id);
  // 伪造上一次进程被杀的现场：一封 6 分钟前就 running 的信，meta 里还压着没处理的插话。
  await world.db.mail.claim([["id", staleMail.id]], {
    status: "running", started_at: iso(Date.now() - 6 * 60_000), slice_count: 1,
    meta: { interrupt: { message_id: steer.message.id, seq: steer.message.seq, at: iso(Date.now() - 5 * 60_000) } },
  }, { stamp: false });
  await world.db.mail.claim([["id", freshMail.id]], {
    status: "running", started_at: iso(Date.now() - 30_000), slice_count: 1, meta: {},
  }, { stamp: false });

  await reapStale(world.db);
  const after = await world.mails(agentId);
  const reaped = after.find((mail) => mail.id === staleMail.id);
  const followUp = after.find((mail) => mail.meta?.follow_up === "interrupt");
  check("B6：超时 running 被回收为 failed=slice_interrupted",
    reaped.status === "failed" && reaped.error === "slice_interrupted", { status: reaped.status, error: reaped.error });
  check("B6：没超时的 running 不被误杀",
    after.find((mail) => mail.id === freshMail.id).status === "running");
  check("B6：僵尸期间的插话转成了待办信，没被丢掉", Boolean(followUp)
    && followUp.status === "queued" && followUp.message_id === steer.message.id
    && Number(followUp.trigger_seq) === Number(steer.message.seq), followUp ?? null);

  await reapStale(world.db);
  check("B6：回收可重复执行，不会重复补投插话",
    (await world.mails(agentId)).filter((mail) => mail.meta?.follow_up === "interrupt").length === 1);

  // 补投的那封要真的能跑完：插话最终得有回应落到群里。
  await world.db.mail.claim([["id", freshMail.id]], { status: "done", finished_at: iso(Date.now()) }, { stamp: false });
  const t0 = Date.now();
  const worker = world.worker();
  const settled = await world.waitQuiescent(agentId, 30_000);
  await worker.stop();
  const replies = (await world.messages(staleStream.id)).filter((row) => row.sender_type === "agent");
  check("B6：补投的插话任务跑完并把重答落群", settled && replies.length === 1
    && replies[0].content === `改口完成 ${marker(0, 1)}`, replies.map((row) => row.content));
  check("B6：被回收的僵尸信不会被顺手执行（只补投插话那封）",
    !upstream.calls.some((call) => call.stream === "僵尸群" && call.trigger.includes("请处理")),
    upstream.calls.filter((call) => call.stream === "僵尸群").map((call) => call.trigger));
  metric("B6 回收阈值", "running 超 5 分钟判死；30 秒的 running 保留");
  metric("B6 回收后补投任务落群", `${(replies[0] ? at(replies[0].created_at) : Date.now()) - t0}ms`);
}

await main();
