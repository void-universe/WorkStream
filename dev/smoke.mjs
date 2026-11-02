// 端到端自检：直接用真实 handler + 本机假数据库跑通全部主流程，不含任何云端凭据。
// 用法：node dev/smoke.mjs（可反复跑，每次从全新数据库开始）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { makeHandler } from "../functions/handler.mjs";
import { serveSite } from "../functions/adapter.mjs";
import { executeTool } from "../functions/mcp.mjs";
import { skillPrompt } from "../functions/skills.mjs";
import { store } from "../functions/store.mjs";
import { createFixtureClient } from "./fixture-supabase.mjs";

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
      const finish = () => {
        if (!alive()) return;
        res.write("data: [DONE]\n\n");
        res.end();
      };
      const say = async (text, gap = 30) => {
        for (const piece of Array.from(text)) {
          if (!alive()) return;
          send({ content: piece });
          await sleep(gap);
        }
        finish();
      };
      // 除“慢慢写”“插话重答”两条剧本外，其余一次写完，免得自检被人为拖慢。
      const sayFast = (text) => {
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
      if (system.includes("慢慢写")) { await say("正在慢慢写这段长正文", 140); return; }
      if (Array.isArray(last?.content) && last.content.some((part) => part.type === "image_url")) {
        sayFast("图里是一块红色的方砖。");
        return;
      }
      if (body.tools?.length && !body.messages.some((m) => m.role === "tool") && system.includes("查历史")) {
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
