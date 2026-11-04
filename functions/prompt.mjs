// 提示词槽位表：虚拟员工每一轮看到的那段 system 正文在这里装配。
//
// 为什么要一张表而不是在 engine 里往下 push：块序即缓存序。提供商侧的前缀缓存按「从头开始最长匹配」
// 命中，一个每轮都变的块排在中间，它后面的所有内容每轮都要重新付一次钱。所以位置是被分配的资源，
// 必须由 volatile（这一轮会不会变）+ order（同一档内的先后）两个字段决定，不能由代码行的先后决定——
// 后者会让"顺手加一块"变成一次悄无声息的缓存退化。
//
// volatile 的判定口径：同一(员工,群)连续两轮之间会变的块。长期记忆在追加、摘要在压、转录在长、
// 本群记忆在写、触发消息每轮都换、插话提示只在被打断的那轮出现，所以它们都在断点之后。
// 身份、签名、守则、公告、技能、取史说明在稳态下不变，排在断点之前；它们偶尔会变（改签名、装技能），
// 那种轮次付一次断点，是产品能接受的。
// 这条不变量由 dev/smoke.mjs 的 8d 兜住：两轮请求的公共前缀必须覆盖整段上一轮窗口，且可复用 ≥95%。
import { imageMark, renderTranscript } from "./transcript.mjs";

/** 云端 Agent 通道：工具不在这一条通道里，两处措辞要跟着换。 */
export const isCloudBackend = (agent) => (agent.backend ?? "openai") === "qca";

/**
 * 一个槽位 = { id, order, volatile, build }。
 * `build(ctx)` 返回这一段正文，空串表示这一轮不落这个块（和过去的 filter(Boolean) 同义）。
 * order 之间留了空档：新增块是从表里领一个号，不是插进某个数组的下标。
 */
export const PROMPT_SECTIONS = [
  {
    id: "identity",
    order: 10,
    volatile: false,
    build: ({ agent, stream }) =>
      `你是虚拟员工「${agent.name}」（角色：${agent.role}），正在 WorkStream 群「${stream.name}」里工作。`,
  },
  {
    id: "backend.cloud",
    order: 20,
    volatile: false,
    // 云端 Agent 用自己的工具集，我们的群工具不在这条通道里；不说清楚它就会照着技能说明
    // "调用 send_message"，把工具名写进正文，群里看到的是一次假执行。
    build: ({ cloud }) => (cloud
      ? "本次由云端 Agent 作答：下面提到的 WorkStream 工具（发消息、群文件、虚拟机、记忆写入等）在这一通道里都调不到，也不要把工具名写进回复。请把结论直接写进正文，需要落地的动作列成待办交给同事。"
      : ""),
  },
  {
    id: "signature",
    order: 30,
    volatile: false,
    build: ({ agent, cloud }) => (agent.signature
      ? `你的个性签名（群里头像旁可见${cloud ? "" : "，需要时用 set_signature 更新"}）：${agent.signature}`
      : ""),
  },
  {
    id: "guide",
    order: 40,
    volatile: false,
    build: ({ agent }) => (agent.system_prompt ? `工作守则：${agent.system_prompt}` : ""),
  },
  {
    id: "announcement",
    order: 50,
    volatile: false,
    build: ({ stream }) => (stream.announcement ? `群公告：${stream.announcement}` : ""),
  },
  {
    id: "skills",
    order: 60,
    volatile: false,
    build: ({ skills, cloud }) => (skills
      ? `你的技能（${cloud ? "在这里只是背景知识，细则的全文在本机技能库里" : "按需调用对应工具；细则可用 read_skill 查全文"}）：\n${skills}`
      : ""),
  },
  {
    id: "history.access",
    order: 70,
    volatile: false,
    build: ({ cloud }) => (cloud
      ? "如需更早的记录，请说明还需要哪一段，由 WorkStream 侧补给你；回答用群成员能直接用的表述。"
      : "如需更早的记录，调用 search_history / read_window 工具；回答用群成员能直接用的表述。"),
  },
  {
    id: "memory.common",
    order: 80,
    volatile: true,
    build: ({ prepared }) => (prepared.common.length
      ? `你的长期记忆（common）：\n${prepared.common.map((m) => `- ${m.content}`).join("\n")}`
      : ""),
  },
  {
    id: "summary",
    order: 90,
    volatile: true,
    build: ({ prepared }) => (prepared.summary
      ? `本群较早内容的压缩摘要（序号 1-${prepared.windowStart}）：\n${prepared.summary}`
      : ""),
  },
  {
    id: "transcript",
    order: 100,
    volatile: true,
    build: ({ prepared }) => `最近记录：\n${renderTranscript(prepared.window)}`,
  },
  {
    id: "memory.stream",
    order: 110,
    volatile: true,
    build: ({ prepared }) => (prepared.notes.length
      ? `本群记忆：\n${prepared.notes.map((m) => `- ${m.content}`).join("\n")}`
      : ""),
  },
  {
    id: "trigger",
    order: 120,
    volatile: true,
    build: ({ trigger }) =>
      `上一条 @ 你的消息：${trigger ? `${trigger.sender_name}：${trigger.content}${imageMark(trigger)}` : "（队列里的补发任务，无原始消息）"}`,
  },
  {
    id: "steer",
    order: 130,
    volatile: true,
    build: ({ steerNote }) => steerNote ?? "",
  },
];

// 冷启动就把表本身的错炸出来：重复 id 会让后一条悄悄覆盖前一条，重复 order 会让顺序取决于插入先后。
{
  const seen = new Set();
  for (const section of PROMPT_SECTIONS) {
    if (seen.has(section.id)) throw new Error(`提示词槽位 id 重复：${section.id}`);
    seen.add(section.id);
    if (!Number.isInteger(section.order)) throw new Error(`提示词槽位缺 order：${section.id}`);
    if (typeof section.build !== "function") throw new Error(`提示词槽位缺 build：${section.id}`);
  }
}

/** 缓存断点：第一个易变块。它之前的一切在稳态下逐字复用，它之后的每轮重写。 */
export const CACHE_BREAKPOINT_ID = PROMPT_SECTIONS
  .slice()
  .sort((a, b) => Number(a.volatile) - Number(b.volatile) || a.order - b.order)
  .find((section) => section.volatile)?.id ?? null;

const ORDERED = PROMPT_SECTIONS
  .slice()
  .sort((a, b) => Number(a.volatile) - Number(b.volatile) || a.order - b.order);

/**
 * 装配 system 正文。返回的 `promptSlots` 是这一步实际落下的块，按发出顺序给出
 * `[槽位 id, 字符数, 是否每轮重写]`——只记口径不记正文（正文里大半是群里本来就能翻的转录），
 * 命中率掉了就靠它对出断点动到了哪一块。
 */
export function composeSystemPrompt(ctx) {
  const blocks = [];
  for (const section of ORDERED) {
    const text = section.build(ctx);
    if (!text) continue;
    blocks.push({ id: section.id, volatile: section.volatile, text });
  }
  return {
    system: blocks.map((block) => block.text).join("\n\n"),
    promptSlots: blocks.map((block) => [block.id, block.text.length, block.volatile]),
  };
}

/** 用户位：带图的那一轮把图直接给模型，正文只多一句说明。 */
export function composeAsk({ images = [] }) {
  if (!images.length) return "请按上面的上下文回应这条任务。";
  return [
    { type: "text", text: "请按上面的上下文回应这条任务。这条消息附有图片，图像内容在下面直接给你，需要时描述或据此行动。" },
    ...images,
  ];
}
