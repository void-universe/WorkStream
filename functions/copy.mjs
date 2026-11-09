// 服务端生成、用户在界面上读到的句子：演示模型的会话体文本，和落进群里的系统行。
// 语言在写入那一刻按操作者账号的界面语言定（prefs.lang）；只有中英两套模板，显式选了别的语言的账号
// 读得懂英文的概率远高于读得懂中文，所以一律回落英文，没设过语言的回落中文。
// 代价是群成员语言不一致时，系统行显示的是操作者那一种；彻底的做法是存结构化事件、
// 由前端按各自 locale 渲染，那要给 messages 加列并回填历史行，所以现在按写入者定。
// 轨迹 Context 页签里的原始提示词不在这张表：那是服务端内部文本，口径另记，不跟会话文本混一张表。
const DEMO = {
  zh: {
    ack: (prompt) => `（演示模型）收到，我把这条任务记进队列了：${prompt}`,
    factsLead: "我当前掌握的要点：",
    summaryEmpty: "（演示压缩：本段没有可摘录的发言。）",
    note: "演示模型：不回报思考链与用量",
  },
  en: {
    ack: (prompt) => `(demo model) Noted, I have queued this task: ${prompt}`,
    factsLead: "What I hold right now:",
    summaryEmpty: "(demo compression: nothing quotable in this window.)",
    note: "demo model: reports neither reasoning nor usage",
  },
};

const SYSTEM = {
  zh: {
    fileUploaded: ({ who, name, size }) => `${who} 上传了群文件「${name}」（${size} 字节）。`,
    streamCreated: ({ who, name, id }) => `${who} 创建了群「${name}」。群 UUID：${id}`,
    streamCreatedBySkill: ({ who, name, id }) => `${who} 通过 WorkStream 技能创建了群「${name}」。群 UUID：${id}`,
    announcementSet: ({ content }) => `群公告已更新：${content}`,
    announcementCleared: () => "群公告已清空。",
    ownerTransferred: () => "群主已移交。",
    memberJoined: ({ who }) => `${who ?? "新成员"} 已加入群。`,
    joinRejected: ({ who }) => `${who ?? "申请"} 的进群申请被拒绝。`,
    agentAdded: ({ who, agent }) => `${who} 把虚拟员工「${agent}」拉进了群。`,
    agentAddedByTool: ({ agent }) => `虚拟员工「${agent}」被拉进了群。`,
    promotedAdmin: () => "成员已被提升为管理员。",
    demotedMember: () => "管理员已被降为普通成员。",
    agentRemoved: () => "虚拟员工已被移出群。",
    memberRemoved: () => "成员已被移出群。",
    vmRegistered: ({ label }) => `虚拟机「${label}」已登记并授权给本群。`,
    // 授权有两条路：界面上那条知道是谁点的（带 who），工具回路那条只有员工的主人身份，不带。
    vmGranted: ({ who, label, level }) =>
      `${who ? `${who} 把` : ""}虚拟机「${label}」授权给本群（级别：${level === "sudo" ? "可用 sudo" : "普通用户"}）。`,
    runFailed: ({ agent, code }) => `虚拟员工「${agent}」这次没能完成：${code}。要再试请重新 @ 他。`,
  },
  en: {
    fileUploaded: ({ who, name, size }) => `${who} uploaded the group file “${name}” (${size} bytes).`,
    streamCreated: ({ who, name, id }) => `${who} created the group “${name}”. Group UUID: ${id}`,
    streamCreatedBySkill: ({ who, name, id }) => `${who} created the group “${name}” through the WorkStream skill. Group UUID: ${id}`,
    announcementSet: ({ content }) => `Group announcement updated: ${content}`,
    announcementCleared: () => "Group announcement cleared.",
    ownerTransferred: () => "Group ownership transferred.",
    memberJoined: ({ who }) => `${who ?? "A new member"} joined the group.`,
    joinRejected: ({ who }) => `The join request from ${who ?? "the applicant"} was rejected.`,
    agentAdded: ({ who, agent }) => `${who} added the virtual employee “${agent}” to the group.`,
    agentAddedByTool: ({ agent }) => `The virtual employee “${agent}” was added to the group.`,
    promotedAdmin: () => "The member was promoted to admin.",
    demotedMember: () => "The admin was demoted to member.",
    agentRemoved: () => "The virtual employee was removed from the group.",
    memberRemoved: () => "The member was removed from the group.",
    vmRegistered: ({ label }) => `The VM “${label}” was registered and granted to this group.`,
    vmGranted: ({ who, label, level }) =>
      `${who ? `${who} granted` : "Granted"} the VM “${label}” to this group (level: ${level === "sudo" ? "sudo" : "member"}).`,
    runFailed: ({ agent, code }) => `The virtual employee “${agent}” could not finish this run: ${code}. @ them again to retry.`,
  },
};

export const demoCopy = (lang) => (lang === "en" ? DEMO.en : DEMO.zh);
export const systemCopy = (lang) => (lang === "en" ? SYSTEM.en : SYSTEM.zh);

export const langOf = (prefs) => {
  const lang = prefs?.lang;
  if (!lang || String(lang).startsWith("zh")) return "zh";
  return "en";
};

/** 工具回路与技能那几条路只有 ownerId 在手，没有 user 行：这一次读只为定语言。 */
export async function ownerLang(db, ownerId) {
  const owner = await db.users.byId(ownerId, { columns: "id,prefs" });
  return langOf(owner?.prefs);
}

/** 演示员工说哪种语言：看建它的账号把界面停在哪种语言。 */
export const demoLang = (db, agent) => ownerLang(db, agent.owner_id);
