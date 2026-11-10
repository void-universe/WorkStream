// 一条命令把整条链路跑通的真范例：注册/登录 → 建演示虚拟员工 → 建群并绑虚拟机 →
// 群里 @ 员工 → 推一格时间片 → 打印群 UUID，浏览器打开即可看到回帖。
// 用法：node dev/seed-demo.mjs [base-url]，默认 http://127.0.0.1:8000
const base = process.argv[2] ?? "http://127.0.0.1:8000";
const endpoint = `${base}/functions/v1/app`;
const email = process.env.WS_DEMO_EMAIL ?? `demo.${Date.now().toString(36)}@workstream.dev`;
const password = process.env.WS_DEMO_PASSWORD ?? "workstream-demo";

let token = "";

async function call(action, payload = {}, { query = {} } = {}) {
  const params = new URLSearchParams({ action, ...query });
  const response = await fetch(`${endpoint}?${params.toString()}`, {
    method: Object.keys(payload).length ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      // 与前端一致：部署侧适配层会剥掉 authorization，会话令牌走自定义头。
      ...(token ? { "x-workstream-token": token } : {}),
    },
    body: Object.keys(payload).length ? JSON.stringify(payload) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) {
    throw new Error(`${action} 失败：${JSON.stringify(result)}`);
  }
  return result;
}

const step = (text) => console.log(`\x1b[36m›\x1b[0m ${text}`);

// 1. 账号：先试注册，邮箱已存在就登录。
try {
  const registered = await call("auth.register", { email, password, display_name: "演示员工" });
  step(`注册 ${email}，验证链接 ${registered.verify_link}`);
  await call("auth.verify", { token: new URLSearchParams(registered.verify_link.split("?")[1] ?? "").get("token") });
  step("邮箱已验证（开发态链接直接可见）");
} catch {
  step(`${email} 已存在，改走登录`);
}
const login = await call("auth.login", { email, password });
token = login.token;
step(`登录成功：${login.user.display_name}`);

// 2. 虚拟员工：用内置演示端点，不需要真 Key 也能走完队列。
const agent = await call("agents.create", {
  name: "小审",
  role: "整理验收清单并跟踪回归项",
  backend: "openai",
  api_base_url: "demo://local",
  api_key: "demo",
  model: "demo",
  system_prompt: "回答要短，先给结论再给清单。",
  context_chars: 200000,
});
step(`虚拟员工「${agent.agent.name}」就位，Key 尾号 ${agent.agent.api_key_tail}`);

// 3. 群：建群时就绑一台演示办公虚拟机。
const vm = await call("vms.create", {
  label: "演示构建机",
  host: "127.0.0.1",
  port: 8000,
  username: "ci",
  auth_kind: "password",
  secret: "demo-secret",
  workdir: "/srv/work",
});
step(`登记虚拟机 ${vm.vm.label}`);

const stream = await call("streams.create", {
  name: "交付周会",
  join_policy: "request",
  announcement: "每周五交付；@ 小审 就是派活，别在群里堆未确认的需求。",
  agent_ids: [agent.agent.id],
  vm_ids: [vm.vm.id],
});
step(`群「${stream.stream.name}」已建，UUID ${stream.stream.id}`);

// 4. @ 派活 → 落邮箱 → 推一格时间片 → 群里出现回帖。
const mention = { type: "agent", id: agent.agent.id };
const sent = await call("messages.send", {
  stream_id: stream.stream.id,
  content: `@${agent.agent.name} 把今天的验收清单整理出来，只列三条。`,
  mentions: [mention],
});
step(`消息 #${sent.message.seq} 已发出，队列里 ${sent.queued.length} 封任务`);

let replies = [];
for (let attempt = 1; attempt <= 6 && !replies.length; attempt += 1) {
  const tick = await call("scheduler.tick", {}, { query: { since: 0 } });
  if (tick.ran.length) step(`第 ${attempt} 格推进了 ${tick.ran.length} 个任务`);
  const list = await call("messages.list", {}, { query: { stream_id: stream.stream.id, limit: 60 } });
  replies = list.items.filter((item) => item.sender_type === "agent");
  if (!replies.length) await new Promise((resolve) => setTimeout(resolve, 700));
}
if (!replies.length) throw new Error("时间片推进完了但群里没有虚拟员工回帖");
step(`虚拟员工回帖：${replies[0].content.replace(/\s+/g, " ").slice(0, 80)}…`);

// 5. 记忆：per-stream 一条，common 一条，演示两级 memory 都可写可读。
await call("agents.memory.put", { agent_id: agent.agent.id, content: "交付前必须核对验收清单三条项。", scope: "common", kind: "fact" });
await call("agents.memory.put", {
  agent_id: agent.agent.id,
  content: "本群只认群主确认的优先级。",
  scope: "stream",
  stream_id: stream.stream.id,
  kind: "note",
});
step("两级记忆各写了一条");

const board = await call("scheduler.board");
step(`调度台：${board.boards.length} 位员工在跑，每格预算 ${board.budget}`);

console.log(`\n打开 ${base.replace(":8000", ":5173")}/#/stream/${stream.stream.id} 就能看到这条链路；`);
console.log(`登录邮箱 ${email} / 口令 ${password}`);
