// 后端清单：员工挂的那条传输通道能做什么，写在这里而不是散在各处的 if。
//
// 为什么是一张表：这条通道吃不吃工具，过去只活在注释和前端特判里。注释不产生行为——
// 忘了改的那一处会让模型照着技能说明把工具名写进正文，群里看到的是一次假执行。
// 现在它是 caps.tools 一个字段，提示词措辞（functions/prompt.mjs）与工具注入
// （functions/engine.mjs 的 withTools）读同一个字段，不会再各说一套。
//
// 为什么是声明式的表而不是注册表：没有运行时的贡献者，撤销就是改这个文件，不需要 disposer。
// 能力位只留有消费者的那一个。usage/reasoning/流式/插话由上游这一轮实际回了什么决定，
// 轨迹按证据标注"不回报"；拿静态能力位去冒充口径，会掩盖单条端点的失德。
export const DEMO_BASE_URL = "demo://local";

/**
 * 一个后端 = { id, label, transport, caps, ...该通道独有的措辞 }。
 * `transport` 是实现侧的路由名，必须在 functions/agents.mjs 的 TRANSPORT_ROUTES 里有对应实现，
 * 那一边冷启动对账（照 mcp.mjs 扫「声明了但没实现」的形状）；这里只声明。
 */
export const BACKENDS = [
  {
    id: "openai",
    label: "OpenAI 兼容端点",
    transport: "chat",
    caps: { tools: true },
    testNote: "上游未接受该请求；Key、模型名与 base URL 需一致。",
  },
  {
    id: "demo",
    label: "内置演示模型",
    transport: "demo",
    // 演示模型会假装调 search_history：@ 派发、工具回路、压缩在没 Key 时也要能端到端跑通。
    caps: { tools: true },
    testNote: "演示端点不联网，这条自检只跑了内置模型。",
  },
  {
    id: "qca",
    label: "Qoder 云端 Agent",
    transport: "cloud",
    // 云端 agent 用它自己的工具集，我们的群工具不在这条通道里；不说清楚它就会把工具名写进正文。
    // 不吃工具的通道必须自带这句措辞，否则模型不知道自己在这一条通道里调不到东西。
    caps: { tools: false },
    noToolsNotice: "本次由云端 Agent 作答：下面提到的 WorkStream 工具（发消息、群文件、虚拟机、记忆写入等）"
      + "在这一通道里都调不到，也不要把工具名写进回复。请把结论直接写进正文，需要落地的动作列成待办交给同事。",
    testNote: "云端没接受这次自检；检查个人访问令牌是否有效、API 地址是否与你所在区域一致。",
  },
];

/**
 * 能落进 `agents.backend` 列的值。演示端点不是档案上的一个选项：它是 api_base_url 等于
 * demo://local 时从地址认出来的那条通道，所以列里只有"自建/云端"两档。
 */
export const BACKEND_IDS = ["openai", "qca"];

const BY_ID = new Map(BACKENDS.map((entry) => [entry.id, entry]));

/**
 * 员工档案 → 后端条目。列只分自建/云端，演示那条挂在地址上，所以这里三级判定；
 * 云端列优先，因为建档与改档都拦了"云端后端 + 演示地址"这种成不上的组合。
 * 列里出现表没有的值就地抛：静默按自建处理会让那条员工带着错凭据上岗、每轮都失败在鉴权上。
 */
export function backendFor(agent) {
  const id = agent?.backend ?? "openai";
  if (id !== "qca" && agent?.api_base_url === DEMO_BASE_URL) return BY_ID.get("demo");
  const entry = BY_ID.get(id);
  if (!entry) throw Object.assign(new Error(`unknown_backend：${id}`), { code: "unknown_backend" });
  return entry;
}

/**
 * 表本身的错冷启动就炸：重复 id 会让后一条悄悄覆盖前一条；transport 不在清单里等于
 * 声明了一条没人实现的路；不吃工具却不给措辞，就是回到"假执行"那个原始事故。
 * 导出是为了让自检能用一份坏表打这一枪——真表崩了会连累了整个套件。
 */
export function validateBackends(entries) {
  const ids = new Set(entries.map((entry) => entry.id));
  if (ids.size !== entries.length) throw new Error("后端清单 id 重复");
  for (const entry of entries) {
    if (!entry.id || !entry.label) throw new Error(`后端清单缺 id 或 label：${entry.id ?? "?"}`);
    if (typeof entry.caps?.tools !== "boolean") throw new Error(`后端 ${entry.id} 没声明 caps.tools`);
    if (!entry.caps.tools && !entry.noToolsNotice) {
      throw new Error(`后端 ${entry.id} 不吃工具却没给提示词措辞：模型会照着技能说明把工具名写进正文`);
    }
    if (!entry.testNote) throw new Error(`后端 ${entry.id} 缺自检失败时的说明`);
    if (!entry.transport) throw new Error(`后端 ${entry.id} 缺 transport`);
  }
  const orphan = BACKEND_IDS.filter((id) => !ids.has(id));
  if (orphan.length) throw new Error(`backend 列能写但清单里没有：${orphan.join("、")}`);
}

validateBackends(BACKENDS);
