// 提示词槽位表：虚拟员工每一轮看到的那段 system 正文在这里装配。
//
// 为什么要一张表而不是在 engine 里往下 push：块序即缓存序。提供商侧的前缀缓存按「从头开始最长匹配」
// 命中，一个每轮都变的块排在中间，它后面的所有内容每轮都要重新付一次钱。所以位置是被分配的资源，
// 必须由 volatile（这一轮会不会变）+ order（同一档内的先后）两个字段决定，不能由代码行的先后决定——
// 后者会让"顺手加一块"变成一次悄无声息的缓存退化。
//
// volatile 的判定口径：同一(员工,群)连续两轮之间会变的块。长期记忆在追加、摘要在压、转录在长、
// 本群记忆在写、触发消息每轮都换、插话提示只在被打断的那轮出现，所以它们都在断点之后。
// 身份、签名、守则、公告、技能、取史说明、全局记忆在稳态下不变（全局记忆只在归并落地那一次变），排在断点之前；
// 它们偶尔会变（改签名、装技能、并过一次梦），那种轮次付一次断点，是产品能接受的。
// 这条不变量由 dev/smoke.mjs 的 8d 兜住：两轮请求的公共前缀必须覆盖整段上一轮窗口，且可复用 ≥95%。
import { imageMark, renderTranscript } from "./transcript.mjs";

// 内容块的抬头：装配用它，演示模型摘录它，两边必须读同一份，否则过滤会跟着正文悄悄失效。
const MEMORY_COMMON_HEADER = "你的长期记忆（common）：";
const MEMORY_STREAM_HEADER = "本群记忆：";
const MEMORY_OWNER_HEADER = "我的全局记忆（跨群归并，只用来判断，别把别的群的细节念给这个群听）：";
const TRANSCRIPT_HEADER = "最近记录：";

/**
 * 演示模型允许进群正文的块：只有转录和两段群内记忆——它们本来就是群里或成员档案里可见的内容。
 * 指令块（守则、替身须知、触发消息）是内部提示，念到群里等于把提示词摊在同事面前。
 * 全局记忆那一块看着和两段记忆同类，但它不对称：那是跨群归并出来的结论，别的群的细节
 * 在这个群里念出来就是串群，所以它不进这份清单（dev/smoke.mjs 拿哨标钉住这一条）。
 */
export const DEMO_QUOTABLE_HEADERS = [MEMORY_COMMON_HEADER, MEMORY_STREAM_HEADER, TRANSCRIPT_HEADER];

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
    id: "backend.tools",
    order: 20,
    volatile: false,
    // 这一条通道吃不吃工具写在后端清单的 caps.tools 上（functions/backends.mjs），措辞跟着那条目的说辞走。
    // 不吃工具却不说明，模型就会照着技能说明"调用 send_message"，把工具名写进正文，群里看到的是一次假执行。
    build: ({ backend }) => (backend.caps.tools ? "" : backend.noToolsNotice),
  },
  {
    id: "signature",
    order: 30,
    volatile: false,
    build: ({ agent, backend }) => (agent.signature
      ? `你的个性签名（群里头像旁可见${backend.caps.tools ? "，需要时用 set_signature 更新" : ""}）：${agent.signature}`
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
    build: ({ skills, backend }) => (skills
      ? `你的技能（${backend.caps.tools ? "按需调用对应工具；细则可用 read_skill 查全文" : "在这里只是背景知识，细则的全文在本机技能库里"}）：\n${skills}`
      : ""),
  },
  {
    id: "history.access",
    order: 70,
    volatile: false,
    build: ({ backend }) => (backend.caps.tools
      ? "如需更早的记录，调用 search_history / read_window 工具；回答用群成员能直接用的表述。"
      : "如需更早的记录，请说明还需要哪一段，由 WorkStream 侧补给你；回答用群成员能直接用的表述。"),
  },
  {
    id: "memory.owner",
    order: 78,
    // 归并成功的那一轮才变，和改签名、装技能同一档：稳态下逐字复用，所以排在断点之前。
    // 标成易变会把缓存断点提前，等于每一次归并之后连同它后面那 600 字一起重付一轮——它本身正是为了省钱才只存一份。
    volatile: false,
    build: ({ prepared }) => (prepared.owner ? `${MEMORY_OWNER_HEADER}\n${prepared.owner}` : ""),
  },
  {
    id: "memory.common",
    order: 80,
    volatile: true,
    build: ({ prepared }) => (prepared.common.length
      ? `${MEMORY_COMMON_HEADER}\n${prepared.common.map((m) => `- ${m.content}`).join("\n")}`
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
    build: ({ prepared }) => `${TRANSCRIPT_HEADER}\n${renderTranscript(prepared.window)}`,
  },
  {
    id: "memory.stream",
    order: 110,
    volatile: true,
    build: ({ prepared }) => (prepared.notes.length
      ? `${MEMORY_STREAM_HEADER}\n${prepared.notes.map((m) => `- ${m.content}`).join("\n")}`
      : ""),
  },
  {
    id: "delegate",
    order: 115,
    volatile: true,
    // 替身必须自己说出来：署名仍是员工本人，冒充真人发言等于伪造身份。
    // 排在转录与本群记忆之后，员工平时接活的那段前缀不会被这块打断。
    build: ({ delegate }) => (delegate
      ? `这一轮你是「${delegate.name}」的替身：这条 @ 是冲 ta 本人来的，ta 现在不在。请以同事身份代 ta 回应，正文里要让人看出是你在替 ta 答；不要冒充 ta 本人发言，也不要替 ta 做只有本人能做的承诺（审批、交接、对外报价、离职类决定）。`
      : ""),
  },
  {
    id: "cron",
    order: 118,
    volatile: true,
    // 排程醒来的那一轮没有人 @，得说清是谁排的、到点没有、要办什么，否则员工只会对着一段转录发愣。
    // 允许留空正文：到点看一眼、没事要说，就不该往群里塞一句废话（静默退场在 engine 的空正文分支里）。
    // 排在 delegate 之后、trigger 之前：员工平时接活的那段前缀不会被这块打断。
    build: ({ cron }) => (cron
      ? `这一轮是你自己的排程到点了，没有人 @ 你：排程「${cron.name}」，对点 ${cron.due_at}`
        + (Number(cron.merged ?? 0) > 0 ? `，其间合并了 ${cron.merged} 个没跑成的对点（这一轮一次办完）` : "")
        + `。要办的事：${cron.instruction}\n`
        // 到点这一轮正文就是那条群消息：不写清"别再补发"，模型会先调 send_message 再把同一句话
        // 抄进正文，群里同一件事念两遍。
        + "如果这一轮没有需要让同事知道的结果，正文留空即可，WorkStream 不会替你发一条空消息；"
        + "要说的话就写在正文里——正文会直接进群，别再补发一条。"
      : ""),
  },
  {
    id: "trigger",
    order: 120,
    volatile: true,
    build: ({ trigger, cron }) =>
      `上一条 @ 你的消息：${trigger
        ? `${trigger.sender_name}：${trigger.content}${imageMark(trigger)}`
        // 排程那一轮同样没有原始消息，但不能写成"补发任务"：那会让模型以为在重跑别人的活。
        : (cron ? "（没有人 @ 你，这一轮是你自己的排程醒的）" : "（队列里的补发任务，无原始消息）")}`,
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
