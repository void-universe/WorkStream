// 技能市场：内置 WorkStream 技能 + 公共默认技能 + 用户上传，安装记录写到 agent_skills。
// 内置技能不入库，始终注入到每个虚拟员工的上下文；默认公共技能在员工建档时自动安装。
import { Halt, json, newId, now, text, truncate, uuid } from "./util.mjs";

export const SKILL_COLUMNS =
  "id,owner_id,name,summary,category,source,is_public,is_default,always_on,downloads,installs,created_at,updated_at";
const SKILL_FULL_COLUMNS = `${SKILL_COLUMNS},body`;
const MAX_BODY = 20000;

/** 内置平台技能：固定 id，永远可用、不可卸载、不占市场表。 */
export const PLATFORM_SKILL = {
  id: "00000000-0000-4000-8000-00000000a001",
  owner_id: null,
  name: "WorkStream 平台技能",
  summary: "建群、拉员工、邀请真人、登记与授权虚拟机、发消息、写个性签名；含内部工具与对外 MCP 的完整用法。",
  category: "平台",
  source: "builtin",
  is_public: true,
  is_default: true,
  always_on: true,
  downloads: 0,
  installs: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  body: [
    "# WorkStream 平台技能",
    "",
    "你在 WorkStream 群里工作。需要建群、拉人、登记或授权虚拟机、发消息时，直接调用下面的工具，不要声称已经完成；工具返回的错误码说明参数或权限问题。",
    "",
    "## 读",
    "- get_context：本群公告、成员、已授权虚拟机、本群记忆。",
    "- get_announcement：只取本群公告与更新时间，比 get_context 省上下文。",
    "- search_history {query, limit?, before_seq?}：检索群历史（被压缩的旧记录也查得到）。",
    "- read_window {from_seq, to_seq}：读一段完整消息。",
    "- list_files / read_file {name 或 id}：群文件。",
    "- list_skills / read_skill {name}：查看已安装技能全文。",
    "- list_my_resources：主人名下的其他虚拟员工、虚拟机与所在群；建群、拉人、授权前先用它取 id。",
    "",
    "## 写（以虚拟员工主人的身份执行，权限按主人在群里的角色判定）",
    "- send_message {content}：在本群补一条消息，正文里的 @名字 会触发对应成员。",
    "- create_stream {name, announcement?, agent_ids?, vm_ids?}：新建群，并把指定员工/虚拟机放进去；当前员工会自动加入。id 取自 list_my_resources。",
    "- add_agent_to_stream {agent_id, stream_id?}：把主人名下的员工拉进群（默认本群）。",
    "- invite_member {email, stream_id?}：邀请真实员工，对方登录后在待办里接受。",
    "- set_announcement {content, stream_id?}：更新群公告（群主/管理员）。",
    "- set_signature {signature}：更新你自己的个性签名（群里头像旁的一行小字，最多 120 字）；开工、收尾或换状态时顺手写一句。",
    "- register_vm {label, host, port, username, auth_kind, secret, workdir?, grant_stream_id?}：登记主人名下虚拟机；给了 grant_stream_id 就同时授权给那个群。",
    "- grant_vm {vm_id, stream_id?, level?}：把主人的虚拟机授权给群，level 为 member 或 sudo（群主/管理员）。",
    "",
    "群文件的在线预览、上传、下载、删除与公告读写的完整用法见内置技能「DevStream 群文件与公告」。",
    "",
    "## 边界",
    "- 不能读取、回显任何 API Key、口令或密文；虚拟机凭据只在服务端加密保存。",
    "- 建群、登记虚拟机、授权虚拟机只对主人名下的资源生效；别人的员工和机器会被拒绝。",
    "- 拿不准时先 get_context / list_my_resources，再执行写操作。",
    "",
    "## 对外 MCP",
    "群主可在群设置里生成 MCP key，外部客户端用：",
    "POST /functions/v1/app?action=mcp",
    "headers: content-type: application/json, x-workstream-mcp-key: <key>",
    "body: {\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}",
    "外部端点只作用于该群，可用的写工具是 send_message / invite_member / set_announcement / upload_file / delete_file；建群、登记与授权虚拟机需要在员工的工具回路里完成。",
  ].join("\n"),
};

/** 第二个内置技能：群文件与公告的操作手册，覆盖 UI 与对外 MCP 两条路径。 */
export const DEVSTREAM_SKILL = {
  id: "00000000-0000-4000-8000-00000000a004",
  owner_id: null,
  name: "DevStream 群文件与公告",
  summary: "群文件与公告的完整操作面：浏览、在线预览、上传、删除、读写公告；内部工具与对外 MCP 都可用。",
  category: "平台",
  source: "builtin",
  is_public: true,
  is_default: true,
  always_on: true,
  downloads: 0,
  installs: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  body: [
    "# DevStream 群文件与公告",
    "",
    "群文件与群公告是这个群对外可查的资料面。需要交付资料时用工具真写进去，不要只在消息里说“已上传”。",
    "",
    "## 群文件",
    "- list_files：列出文件名、大小、类型与 id。",
    "- read_file {name 或 id}：读文本内容（最多返回 12000 字）；文件在对象存储时返回 binary_file_needs_download，改用下载链接。",
    "- upload_file {name, content, content_type?}：新建一个文本文件，上限 400KB；文件名不能含 / 或 \\，不能以 . 开头；同名会新建一条，不会覆盖旧文件。",
    "- delete_file {name 或 id}：删除文件；只有上传者本人、群主或管理员能删。",
    "- 上传成功会给群里落一条系统消息；成员在群聊右侧「群文件」卡片里可以在线预览、下载、删除。",
    "",
    "## 群公告",
    "- get_announcement：读当前公告与更新时间。",
    "- set_announcement {content}：写入或清空公告（群主/管理员），同时落一条系统消息。",
    "- 长文档放群文件，公告只留一行指引和截止时间；公告会注入每个员工的本群上下文，写太长会挤占预算。",
    "",
    "## 对外 MCP",
    "POST /functions/v1/app?action=mcp",
    "headers: content-type: application/json, x-workstream-mcp-key: <群钥匙>",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"upload_file\",\"arguments\":{\"name\":\"发布清单.md\",\"content\":\"# 发布清单\"}}}",
    "tools/list 会列出 list_files / read_file / upload_file / delete_file / get_announcement / set_announcement；作用域锁死在这一把钥匙对应的群。",
    "",
    "## 边界",
    "- 只收文本文件；图片、PDF、压缩包先转成文本，或让主人用界面下载。",
    "- 不把 API Key、口令、密文写进群文件或公告；这些内容不进群资料面。",
  ].join("\n"),
};

export const BUILTIN_SKILLS = [PLATFORM_SKILL, DEVSTREAM_SKILL];
/** 旧引用保留：平台技能是默认内置技能。 */
export const BUILTIN_SKILL = PLATFORM_SKILL;

const SEED_SKILLS = [
  {
    id: "00000000-0000-4000-8000-00000000a002",
    name: "周报与进度同步",
    summary: "把散落的进展整理成可直接发群的周报：已完成、进行中、风险、下一步。",
    category: "协作",
    body: [
      "# 周报与进度同步",
      "",
      "被要求写周报、日报或进度同步时：",
      "1. 先用 search_history 找本周期内与任务相关的发言，必要时用 read_window 补全上下文。",
      "2. 按「已完成 / 进行中 / 阻塞与风险 / 下一步」四段输出，每条一行，带负责人和序号（如 #42）。",
      "3. 数字、日期、结论必须来自群记录；没有依据的推测标注「待确认」。",
      "4. 结尾给一句可以直接贴进群里的总结。",
    ].join("\n"),
  },
  {
    id: "00000000-0000-4000-8000-00000000a003",
    name: "会议纪要与待办",
    summary: "从群聊提炼决策、待办与待确认问题，输出可执行清单。",
    category: "协作",
    body: [
      "# 会议纪要与待办",
      "",
      "被要求整理纪要或待办时：",
      "1. 用 read_window 读取指定序号区间的消息；跨段时配合 search_history。",
      "2. 输出三段：结论/决策、待办（负责人 + 截止时间，缺失写「待定」）、待确认问题。",
      "3. 每条待办写成动词开头的单句，并用 @名字 标出负责人。",
      "4. 不把闲聊写进纪要；篇幅控制在 400 字以内。",
    ].join("\n"),
  },
];

/** 默认公共技能按固定 id 幂等补齐；并发首用时重复插入会被唯一键挡掉，忽略即可。 */
export async function ensureSeedSkills(db) {
  for (const seed of SEED_SKILLS) {
    const existing = await db.skills.first([["id", seed.id]], { columns: "id" });
    if (existing) continue;
    await db.skills.insert({
      ...seed,
      owner_id: null,
      source: "public",
      is_public: true,
      is_default: true,
      always_on: false,
      downloads: 0,
      installs: 0,
      created_at: now(),
      updated_at: now(),
    }, { columns: "id" }).catch(() => null);
  }
}

const builtinMeta = (skill) => {
  const { body, ...meta } = skill;
  void body;
  return meta;
};

export async function marketSkills(db, user, { q = "" } = {}) {
  await ensureSeedSkills(db);
  const [publicRows, ownRows] = await Promise.all([
    db.skills.list([["is_public", true]], {
      columns: SKILL_COLUMNS, order: ["created_at", { ascending: false }], limit: 200,
    }),
    db.skills.list([["owner_id", user.id]], { columns: SKILL_COLUMNS, limit: 100 }),
  ]);
  const merged = new Map();
  for (const row of [...publicRows, ...ownRows]) merged.set(row.id, row);
  const needle = q.trim().toLowerCase();
  const items = [...merged.values()]
    .filter((row) => !needle || [row.name, row.summary, row.category]
      .some((value) => String(value ?? "").toLowerCase().includes(needle)))
    .sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      return Number(b.installs ?? 0) - Number(a.installs ?? 0)
        || String(b.created_at).localeCompare(String(a.created_at));
    });
  return [...BUILTIN_SKILLS.map(builtinMeta), ...items];
}

export async function installedSkillRows(db, agentId) {
  const links = await db.agent_skills.list([["agent_id", agentId]], {
    columns: "skill_id,created_at", limit: 100,
  });
  const ids = links.map((link) => link.skill_id);
  if (!ids.length) return [];
  const rows = await db.skills.list([["id", ids]], {
    columns: SKILL_COLUMNS, order: ["created_at", { ascending: true }], limit: 100,
  });
  return rows;
}

/** 内置技能 + 已安装技能；用于市场与员工详情。 */
export async function skillsForAgent(db, agentId) {
  return [...BUILTIN_SKILLS.map(builtinMeta), ...(await installedSkillRows(db, agentId))];
}

/** 注入上下文：内置技能排第一，按预算截断，保证平台能力永远在。 */
export async function skillPrompt(db, agentId, maxChars = 6000) {
  const installed = await installedSkillRows(db, agentId);
  const ids = installed.map((row) => row.id);
  const bodies = new Map();
  if (ids.length) {
    const rows = await db.skills.list([["id", ids]], { columns: "id,body", limit: 100 });
    for (const row of rows) bodies.set(row.id, row.body);
  }
  const blocks = [
    ...BUILTIN_SKILLS.map((skill) => `### ${skill.name}\n${skill.body}`),
    ...installed.map((row) => `### ${row.name}\n${truncate(bodies.get(row.id) ?? "", MAX_BODY)}`),
  ];
  const parts = [];
  let used = 0;
  for (const block of blocks) {
    const room = maxChars - used;
    if (room < 160) break;
    if (block.length > room) {
      parts.push(truncate(block, room));
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

/** 新员工建档时自动安装所有 is_default 的公共技能。 */
export async function installDefaultSkillsFor(db, agentId, userId) {
  await ensureSeedSkills(db);
  const defaults = await db.skills.list([["is_public", true], ["is_default", true]], {
    columns: "id,installs", limit: 50,
  });
  if (!defaults.length) return;
  await db.agent_skills.insertMany(defaults.map((skill) => ({
    id: newId(),
    agent_id: agentId,
    skill_id: skill.id,
    installed_by: userId,
    created_at: now(),
    updated_at: now(),
  })), { columns: "id" });
  for (const skill of defaults) {
    await db.skills.patch([["id", skill.id]], {
      installs: Number(skill.installs ?? 0) + 1, updated_at: now(),
    });
  }
}

async function ownedAgent(db, userId, agentId) {
  const agent = await db.agents.byId(uuid(agentId, "agent_id"), { columns: "id,owner_id,name" });
  if (!agent) throw new Halt("agent_not_found", 404);
  if (agent.owner_id !== userId) throw new Halt("agent_not_owned", 403);
  return agent;
}

async function visibleSkill(db, user, id) {
  const builtin = BUILTIN_SKILLS.find((skill) => skill.id === id);
  if (builtin) return builtin;
  const row = await db.skills.byId(id, { columns: SKILL_FULL_COLUMNS });
  if (!row) throw new Halt("skill_not_found", 404);
  if (!row.is_public && row.owner_id !== user.id) throw new Halt("skill_forbidden", 403);
  return row;
}

async function linkSkill(db, user, skill, agentId) {
  if (skill.always_on) return { installed: true, always_on: true };
  const agent = await ownedAgent(db, user.id, agentId);
  const existing = await db.agent_skills.first([
    ["agent_id", agent.id], ["skill_id", skill.id],
  ], { columns: "id" });
  if (existing) return { installed: true, duplicate: true, agent_id: agent.id };
  const created = await db.agent_skills.insert({
    id: newId(),
    agent_id: agent.id,
    skill_id: skill.id,
    installed_by: user.id,
    created_at: now(),
    updated_at: now(),
  }, { columns: "id" });
  if (!created) throw new Halt("skill_install_failed", 503);
  await db.skills.patch([["id", skill.id]], {
    installs: Number(skill.installs ?? 0) + 1, updated_at: now(),
  });
  return { installed: true, agent_id: agent.id, agent_name: agent.name };
}

export const actions = {
  async "skills.market"({ db, user, params }) {
    const q = text(params.get("q") ?? "", { max: 60, required: false, name: "q" });
    return json({ ok: true, items: await marketSkills(db, user, { q }) });
  },

  async "skills.get"({ db, user, params }) {
    const skill = await visibleSkill(db, user, uuid(params.get("id"), "id"));
    return json({ ok: true, skill });
  },

  async "skills.download"({ db, user, body }) {
    const skill = await visibleSkill(db, user, uuid(body.id, "id"));
    if (skill.always_on) return json({ ok: true, skill });
    const next = Number(skill.downloads ?? 0) + 1;
    await db.skills.patch([["id", skill.id]], { downloads: next, updated_at: now() });
    return json({ ok: true, skill: { ...skill, downloads: next } });
  },

  async "skills.upload"({ db, user, body }) {
    const name = text(body.name, { max: 60, name: "skill_name" });
    const summary = text(body.summary, { max: 300, name: "skill_summary" });
    const category = text(body.category || "协作", { max: 20, name: "skill_category" });
    const content = text(body.body, { max: MAX_BODY, name: "skill_body" });
    const isPublic = Boolean(body.is_public);
    const isDefault = isPublic && Boolean(body.is_default);
    if (body.is_default && !isPublic) throw new Halt("invalid_skill_flags", 400);
    const created = await db.skills.insert({
      id: newId(),
      owner_id: user.id,
      name,
      summary,
      category,
      body: content,
      source: "upload",
      is_public: isPublic,
      is_default: isDefault,
      always_on: false,
      downloads: 0,
      installs: 0,
      created_at: now(),
      updated_at: now(),
    }, { columns: SKILL_COLUMNS });
    if (!created) throw new Halt("skill_upload_failed", 503);
    const installed = body.agent_id
      ? await linkSkill(db, user, created, body.agent_id)
      : null;
    return json({ ok: true, skill: created, install: installed });
  },

  async "skills.install"({ db, user, body }) {
    const skill = await visibleSkill(db, user, uuid(body.skill_id, "skill_id"));
    const install = await linkSkill(db, user, skill, body.agent_id);
    return json({ ok: true, ...install, skill: { id: skill.id, name: skill.name } });
  },

  async "skills.uninstall"({ db, user, body }) {
    const agentId = uuid(body.agent_id, "agent_id");
    await ownedAgent(db, user.id, agentId);
    const skillId = uuid(body.skill_id, "skill_id");
    if (BUILTIN_SKILLS.some((skill) => skill.id === skillId)) throw new Halt("builtin_skill_locked", 400);
    const link = await db.agent_skills.first([
      ["agent_id", agentId], ["skill_id", skillId],
    ], { columns: "id" });
    if (!link) throw new Halt("skill_not_installed", 404);
    await db.agent_skills.remove([["id", link.id]]);
    const skill = await db.skills.byId(skillId, { columns: "installs" });
    if (skill) {
      await db.skills.patch([["id", skillId]], {
        installs: Math.max(0, Number(skill.installs ?? 1) - 1), updated_at: now(),
      });
    }
    return json({ ok: true });
  },

  async "skills.installed"({ db, user, params }) {
    const agentId = uuid(params.get("agent_id"), "agent_id");
    await ownedAgent(db, user.id, agentId);
    return json({ ok: true, items: await skillsForAgent(db, agentId) });
  },
};
