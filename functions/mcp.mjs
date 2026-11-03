// MCP 层：既是虚拟员工回复时调用的内部工具，也对外暴露标准 JSON-RPC 端点。
// 内部：executeTool(db, scope, name, args, env)，作用域锁死在某个 (虚拟员工, 群) 与员工主人。
// 外部：POST /functions/v1/app?action=mcp，用群主颁发的 stream MCP key 认证，
//       只作用于该群：读工具 + 发消息 / 邀请真人 / 改公告。
import { deliver } from "./accounts.mjs";
import { streamWeight } from "./chat.mjs";
import { createGroupFile, deleteGroupFile, insertMessage } from "./rooms.mjs";
import { createPipeline } from "./pipeline.mjs";
import { callConnectorTool, resolveConnectorTool } from "./plugins.mjs";
import { runStepsTrace } from "./steps.mjs";
import { seal } from "./sec.mjs";
import { BUILTIN_SKILLS, installedSkillRows } from "./skills.mjs";
import { CONTEXT_CHARS_DEFAULT, email as emailOf, json, newId, now, oneOf, sha256Hex, text, truncate, uuid } from "./util.mjs";

const shape = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
});

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "search_history",
      description: "按关键词检索本群历史消息（含压缩摘要覆盖之前的全部记录）。",
      parameters: shape({
        query: { type: "string", description: "检索词" },
        limit: { type: "integer", description: "最多返回条数，1-20" },
        before_seq: { type: "integer", description: "只看这个序号之前的消息" },
      }, ["query"]),
    },
  },
  {
    type: "function",
    function: {
      name: "read_window",
      description: "读取本群指定序号区间的完整消息。",
      parameters: shape({ from_seq: { type: "integer" }, to_seq: { type: "integer" } }, ["from_seq", "to_seq"]),
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出本群群文件的名称、大小与类型。",
      parameters: shape(),
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取一个群文件的文本内容（按名称或 id）。",
      parameters: shape({ name: { type: "string" }, id: { type: "string" } }),
    },
  },
  {
    type: "function",
    function: {
      name: "upload_file",
      description: "往本群上传一个文本文件（纪要、清单、脚本片段）。同名会新建一条，不会覆盖；上限 400KB。",
      parameters: shape({
        name: { type: "string", description: "文件名，不能含 / \\，不能以 . 开头" },
        content: { type: "string", description: "文件的完整文本内容" },
        content_type: { type: "string", description: "MIME 类型，默认 text/plain" },
      }, ["name", "content"]),
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "删除本群的一个文件（按名称或 id）；只有上传者本人、群主或管理员能删。",
      parameters: shape({ name: { type: "string" }, id: { type: "string" } }),
    },
  },
  {
    type: "function",
    function: {
      name: "get_announcement",
      description: "读取本群当前公告与更新时间。",
      parameters: shape(),
    },
  },
  {
    type: "function",
    function: {
      name: "get_context",
      description: "取回群公告、成员名单、已授权虚拟机与本群长期记忆。",
      parameters: shape(),
    },
  },
  {
    type: "function",
    function: {
      name: "list_skills",
      description: "列出内置平台技能与该员工已安装的技能。",
      parameters: shape(),
    },
  },
  {
    type: "function",
    function: {
      name: "read_skill",
      description: "读取一个技能（内置或已安装）的完整说明。",
      parameters: shape({ name: { type: "string", description: "技能名称" } }, ["name"]),
    },
  },
  {
    type: "function",
    function: {
      name: "list_my_resources",
      description: "列出虚拟员工主人名下的其他员工、虚拟机与所在群，用于建群、拉人和授权。",
      parameters: shape(),
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description: "在本群补发一条消息；正文里的 @名字 会触发对应成员。",
      parameters: shape({ content: { type: "string", description: "消息内容，最多 8000 字" } }, ["content"]),
    },
  },
  {
    type: "function",
    function: {
      name: "create_stream",
      description: "以主人身份新建一个群，并自动加入当前员工；可同时放入主人的其他员工与虚拟机。",
      parameters: shape({
        name: { type: "string", description: "群名，最多 60 字" },
        announcement: { type: "string", description: "群公告，可选" },
        agent_ids: { type: "array", items: { type: "string" }, description: "要放进群的员工 id，可选" },
        vm_ids: { type: "array", items: { type: "string" }, description: "要授权给群的虚拟机 id，可选" },
      }, ["name"]),
    },
  },
  {
    type: "function",
    function: {
      name: "add_agent_to_stream",
      description: "把主人名下的一个虚拟员工拉进群（默认当前群）。",
      parameters: shape({
        agent_id: { type: "string" },
        stream_id: { type: "string", description: "目标群，默认当前群" },
      }, ["agent_id"]),
    },
  },
  {
    type: "function",
    function: {
      name: "invite_member",
      description: "按邮箱邀请真实员工进群；对方登录后在待办里接受。",
      parameters: shape({
        email: { type: "string" },
        stream_id: { type: "string", description: "目标群，默认当前群" },
      }, ["email"]),
    },
  },
  {
    type: "function",
    function: {
      name: "set_signature",
      description: "更新你自己的个性签名（群里头像旁的一行小字），最多 120 字；空字符串表示清空。",
      parameters: shape({
        signature: { type: "string", description: "新的签名，最多 120 字" },
      }, ["signature"]),
    },
  },
  {
    type: "function",
    function: {
      name: "set_announcement",
      description: "更新群公告（需要群主或管理员）。",
      parameters: shape({
        content: { type: "string", description: "新公告，最多 4000 字；空字符串表示清空" },
        stream_id: { type: "string", description: "目标群，默认当前群" },
      }, ["content"]),
    },
  },
  {
    type: "function",
    function: {
      name: "register_vm",
      description: "登记主人名下的一台办公虚拟机，凭据在服务端加密保存；可顺手授权给某个群。",
      parameters: shape({
        label: { type: "string" },
        host: { type: "string" },
        port: { type: "integer", description: "默认 22" },
        username: { type: "string" },
        auth_kind: { type: "string", description: "password 或 key" },
        secret: { type: "string", description: "口令或私钥，只落密文" },
        workdir: { type: "string" },
        grant_stream_id: { type: "string", description: "登记后授权给这个群，可选" },
      }, ["label", "host", "username", "auth_kind", "secret"]),
    },
  },
  {
    type: "function",
    function: {
      name: "grant_vm",
      description: "把主人的虚拟机授权给群（需要群主或管理员）。",
      parameters: shape({
        vm_id: { type: "string" },
        stream_id: { type: "string", description: "目标群，默认当前群" },
        level: { type: "string", description: "member 或 sudo" },
      }, ["vm_id"]),
    },
  },
];

const READ_TOOL_NAMES = [
  "search_history", "read_window", "list_files", "read_file", "get_announcement", "get_context",
  "list_skills", "read_skill", "list_my_resources",
];
const INTERNAL_ONLY = new Set([
  "list_my_resources", "create_stream", "add_agent_to_stream", "register_vm", "grant_vm", "set_signature",
]);

export const INTERNAL_TOOL_NAMES = TOOL_DEFINITIONS.map((definition) => definition.function.name);
export const EXTERNAL_TOOL_NAMES = INTERNAL_TOOL_NAMES.filter((name) => !INTERNAL_ONLY.has(name));

export const toolDefinitions = () => TOOL_DEFINITIONS;

/** 轨迹检视器的 Schema 页：按名字回工具的入参 JSON Schema，未声明的名字直接过滤掉。 */
export const toolSchemas = (names) => {
  const wanted = new Set(names ?? []);
  return TOOL_DEFINITIONS
    .filter((definition) => wanted.has(definition.function.name))
    .map((definition) => ({ name: definition.function.name, parameters: definition.function.parameters }));
};

const likeEscape = (value) => value.replace(/[%_,]/g, " ").slice(0, 60);

const clampCount = (value, fallback, max) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
};

async function membershipRole(db, streamId, userId) {
  if (!userId) return null;
  const row = await db.members.first([
    ["stream_id", streamId], ["principal_type", "human"], ["principal_id", userId],
  ], { columns: "role" });
  return row?.role ?? null;
}

const idList = (value, name) => [...new Set(
  (Array.isArray(value) ? value : []).slice(0, 20).map((item) => uuid(item, name)),
)];

/** 工具内发消息：落一条消息，并把正文里的 @ 名字转成邮件/队列任务。 */
async function postAndFanout(db, { streamId, senderType, senderId, senderName, content }) {
  const members = await db.members.list([["stream_id", streamId]], {
    columns: "principal_type,principal_id", limit: 300,
  });
  const humanIds = members.filter((m) => m.principal_type === "human").map((m) => m.principal_id);
  const agentIds = members.filter((m) => m.principal_type === "agent").map((m) => m.principal_id);
  const humans = humanIds.length
    ? await db.users.list([["id", humanIds]], { columns: "id,display_name,email,at_channel", limit: 300 })
    : [];
  const agents = agentIds.length
    ? await db.agents.list([["id", agentIds]], { columns: "id,name,status", limit: 300 })
    : [];
  const mentions = [];
  for (const human of humans) {
    if (human.display_name && content.includes(`@${human.display_name}`)) mentions.push({ type: "human", id: human.id });
  }
  for (const agent of agents) {
    if (agent.name && content.includes(`@${agent.name}`)) mentions.push({ type: "agent", id: agent.id });
  }
  const message = await insertMessage(db, {
    streamId, senderType, senderId, senderName, content, mentions: mentions.slice(0, 10),
  });
  for (const mention of mentions.slice(0, 10)) {
    if (mention.type === "agent") {
      if (mention.id === senderId) continue;
      const target = agents.find((agent) => agent.id === mention.id);
      if (!target || target.status !== "active") continue;
      await db.mail.insert({
        id: newId(), agent_id: mention.id, stream_id: streamId, message_id: message.id,
        trigger_seq: message.seq, priority: await streamWeight(db, mention.id, streamId),
        status: "queued", slice_count: 0, error: null,
        created_at: now(), started_at: null, finished_at: null, updated_at: now(),
      }, { columns: "id" });
      continue;
    }
    const human = humans.find((row) => row.id === mention.id);
    if (!human || human.id === senderId) continue;
    await db.outbox.insert({
      id: newId(), recipient_email: human.email, user_id: human.id, kind: "mention",
      subject: `[${truncate(content, 24)}] ${senderName} 在群里 @ 了你`,
      body: content.slice(0, 1000), link: `#/stream/${streamId}`,
      stream_id: streamId, channel: human.at_channel === "real_email" ? "real_email" : "virtual",
      status: "queued", created_at: now(), read_at: null,
    }, { columns: "id" });
  }
  return { seq: message.seq, mentions: mentions.slice(0, 10) };
}

async function createStream(db, scope, args) {
  const owner = await db.users.byId(scope.ownerId, { columns: "id,display_name" });
  if (!owner) return { error: "owner_missing" };
  const name = text(args.name, { max: 60, name: "name" });
  const announcement = text(args.announcement ?? "", { max: 4000, required: false });
  const wantedAgents = idList(args.agent_ids, "agent_id");
  const wantedVms = idList(args.vm_ids, "vm_id");
  const ownedAgents = wantedAgents.length
    ? await db.agents.list([["id", wantedAgents], ["owner_id", scope.ownerId]], { columns: "id", limit: 20 })
    : [];
  if (ownedAgents.length !== wantedAgents.length) return { error: "agent_not_owned" };
  const ownedVms = wantedVms.length
    ? await db.vms.list([["id", wantedVms], ["owner_id", scope.ownerId]], { columns: "id,label", limit: 20 })
    : [];
  if (ownedVms.length !== wantedVms.length) return { error: "vm_not_owned" };

  const id = newId();
  const created = await db.streams.insert({
    id,
    name,
    owner_id: scope.ownerId,
    join_policy: "request",
    announcement,
    announcement_at: announcement ? now() : null,
    context_chars: CONTEXT_CHARS_DEFAULT,
    next_seq: 1,
    mcp_key_hash: null,
    created_at: now(),
    updated_at: now(),
  }, { columns: "id" });
  if (!created) return { error: "stream_create_failed" };
  const memberIds = [...new Set([scope.agentId, ...wantedAgents].filter(Boolean))];
  await db.members.insert({
    id: newId(), stream_id: id, principal_type: "human", principal_id: scope.ownerId,
    role: "owner", added_by: scope.ownerId, joined_at: now(),
  }, { columns: "id" });
  if (memberIds.length) {
    await db.members.insertMany(memberIds.map((agentId) => ({
      id: newId(), stream_id: id, principal_type: "agent", principal_id: agentId,
      role: "member", added_by: scope.ownerId, joined_at: now(),
    })), { columns: "id" });
  }
  if (wantedVms.length) {
    await db.stream_vms.insertMany(wantedVms.map((vmId) => ({
      id: newId(), stream_id: id, vm_id: vmId, level: "member", granted_by: scope.ownerId,
      created_at: now(),
    })), { columns: "id" });
  }
  await insertMessage(db, {
    streamId: id, senderType: "system", senderId: scope.ownerId, senderName: "系统",
    content: `${owner.display_name} 通过 WorkStream 技能创建了群「${name}」。群 UUID：${id}`,
  });
  return {
    stream_id: id,
    name,
    members: memberIds,
    vms: ownedVms.map((vm) => ({ id: vm.id, label: vm.label })),
  };
}

// 每个工具一个 handler：名字就是 TOOL_DEFINITIONS 里的 function.name，注册表与声明必须一一对上。
const TOOL_HANDLERS = {
  search_history: async ({ db, scope, args, env, streamId }) => {
    const query = text(args.query ?? "", { max: 120, name: "query" });
    const limit = clampCount(args.limit, 10, 20);
    let builder = db.client.from("messages")
      .select("seq,sender_type,sender_name,content,created_at")
      .eq("stream_id", streamId)
      .or(`content.ilike.%${likeEscape(query)}%,sender_name.ilike.%${likeEscape(query)}%`);
    if (args.before_seq !== undefined && args.before_seq !== null) {
      const cursor = Number(args.before_seq);
      if (Number.isSafeInteger(cursor) && cursor >= 0) builder = builder.lt("seq", cursor);
    }
    const result = await builder.order("seq", { ascending: false }).limit(limit);
    if (result.error) return { error: "history_unavailable" };
    return {
      query,
      hits: (result.data ?? []).map((row) => ({
        seq: row.seq, from: `${row.sender_type === "agent" ? "虚拟" : "人"}:${row.sender_name}`,
        at: row.created_at, text: truncate(row.content, 600),
      })),
      note: "检索来自 MCP：群历史在压缩后仍然完整保留，可用 read_window 取全文。",
    };
  },
  read_window: async ({ db, scope, args, env, streamId }) => {
    const from = Number(args.from_seq);
    const to = Number(args.to_seq);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) {
      return { error: "invalid_window" };
    }
    const result = await db.client.from("messages")
      .select("seq,sender_type,sender_name,content,kind")
      .eq("stream_id", streamId)
      .gte("seq", Math.max(1, from))
      .lte("seq", Math.min(to, from + 60))
      .order("seq", { ascending: true })
      .limit(61);
    if (result.error) return { error: "history_unavailable" };
    return { messages: result.data ?? [] };
  },
  list_files: async ({ db, scope, args, env, streamId }) => {
    const rows = await db.files.list([["stream_id", streamId]], {
      columns: "id,name,size_bytes,content_type,store,created_at", limit: 60,
    });
    return { files: rows };
  },
  read_file: async ({ db, scope, args, env, streamId }) => {
    const id = args.id ? String(args.id) : null;
    const wanted = args.name ? text(args.name, { max: 120, name: "name" }) : null;
    const rows = await db.files.list([["stream_id", streamId]], {
      columns: "id,name,size_bytes,content_type,store,content", limit: 100,
    });
    const file = rows.find((row) => (id ? row.id === id : row.name === wanted));
    if (!file) return { error: "file_not_found" };
    if (file.store !== "db") return { error: "binary_file_needs_download", name: file.name };
    return { name: file.name, size_bytes: file.size_bytes, content: truncate(file.content ?? "", 12000) };
  },
  upload_file: async ({ db, scope, args, env, streamId }) => {
    const owner = await db.users.byId(scope.ownerId, { columns: "id,display_name" });
    if (!owner) return { error: "owner_missing" };
    try {
      const file = await createGroupFile(db, {
        streamId,
        userId: scope.ownerId,
        userName: owner.display_name,
        name: args.name,
        contentType: args.content_type,
        content: args.content,
      });
      return {
        ok: true,
        file: { id: file.id, name: file.name, size_bytes: file.size_bytes, content_type: file.content_type },
      };
    } catch (error) {
      return { error: error?.error ?? "file_write_failed" };
    }
  },
  delete_file: async ({ db, scope, args, env, streamId }) => {
    const id = args.id ? uuid(args.id, "id") : null;
    const wanted = args.name ? text(args.name, { max: 120, name: "name" }) : null;
    if (!id && !wanted) return { error: "file_selector_required" };
    const rows = await db.files.list([["stream_id", streamId]], {
      columns: "id,name,store,object_path,uploaded_by", limit: 200,
    });
    const file = rows.find((row) => (id ? row.id === id : row.name === wanted));
    if (!file) return { error: "file_not_found" };
    const role = await membershipRole(db, streamId, scope.ownerId);
    try {
      await deleteGroupFile(db, { file, userId: scope.ownerId, role });
      return { ok: true, id: file.id, name: file.name };
    } catch (error) {
      return { error: error?.error ?? "file_delete_failed" };
    }
  },
  get_announcement: async ({ db, scope, args, env, streamId }) => {
    const stream = await db.streams.byId(streamId, {
      columns: "id,name,announcement,announcement_at",
    });
    if (!stream) return { error: "stream_not_found" };
    return {
      stream_id: stream.id,
      name: stream.name,
      announcement: stream.announcement ?? "",
      updated_at: stream.announcement_at,
    };
  },
  get_context: async ({ db, scope, args, env, streamId }) => {
    const stream = await db.streams.byId(streamId, {
      columns: "id,name,announcement,context_chars,join_policy",
    });
    if (!stream) return { error: "stream_not_found" };
    const memberships = await db.members.list([["stream_id", streamId]], {
      columns: "principal_type,principal_id,role", limit: 200,
    });
    const humanIds = memberships.filter((m) => m.principal_type === "human").map((m) => m.principal_id);
    const agentIds = memberships.filter((m) => m.principal_type === "agent").map((m) => m.principal_id);
    const humans = humanIds.length
      ? await db.users.list([["id", humanIds]], { columns: "id,display_name", limit: 200 }) : [];
    const agents = agentIds.length
      ? await db.agents.list([["id", agentIds]], { columns: "id,name,role", limit: 200 }) : [];
    const grants = await db.stream_vms.list([["stream_id", streamId]], { columns: "vm_id,level", limit: 40 });
    const vmIds = grants.map((g) => g.vm_id);
    const vms = vmIds.length
      ? await db.vms.list([["id", vmIds]], { columns: "id,label,host,port,username,workdir", limit: 40 }) : [];
    const memory = scope.agentId
      ? await db.memories.list([["agent_id", scope.agentId], ["scope", "stream"], ["stream_id", streamId]], {
        columns: "kind,content,covers_through_seq", limit: 20,
      })
      : [];
    return {
      stream: { name: stream.name, uuid: stream.id, announcement: stream.announcement ?? "" },
      members: [
        ...humans.map((human) => ({ type: "human", name: human.display_name })),
        ...agents.map((agent) => ({ type: "agent", name: agent.name, role: agent.role })),
      ],
      vms: vms.map((vm) => ({
        label: vm.label,
        host: `${vm.username}@${vm.host}:${vm.port}`,
        workdir: vm.workdir,
        level: grants.find((grant) => grant.vm_id === vm.id)?.level,
      })),
      stream_memory: memory,
    };
  },
  list_skills: async ({ db, scope, args, env, streamId }) => {
    const installed = scope.agentId ? await installedSkillRows(db, scope.agentId) : [];
    return {
      skills: [
        ...BUILTIN_SKILLS.map((skill) => ({ name: skill.name, summary: skill.summary, builtin: true })),
        ...installed.map((row) => ({
          name: row.name, summary: row.summary, category: row.category, builtin: false,
        })),
      ],
    };
  },
  read_skill: async ({ db, scope, args, env, streamId }) => {
    const wanted = text(args.name ?? "", { max: 120, name: "name" });
    const builtin = BUILTIN_SKILLS.find((skill) => skill.name === wanted);
    if (builtin) return { name: builtin.name, body: builtin.body };
    const installed = scope.agentId ? await installedSkillRows(db, scope.agentId) : [];
    const match = installed.find((row) => row.name === wanted);
    if (!match) return { error: "skill_not_found" };
    const full = await db.skills.byId(match.id, { columns: "body" });
    return { name: match.name, body: truncate(full?.body ?? "", 20000) };
  },
  list_my_resources: async ({ db, scope, args, env, streamId }) => {
    if (!scope.ownerId) return { error: "owner_missing" };
    const [agents, vms, memberships] = await Promise.all([
      db.agents.list([["owner_id", scope.ownerId]], {
        columns: "id,name,model,status", order: ["created_at", { ascending: true }], limit: 60,
      }),
      db.vms.list([["owner_id", scope.ownerId]], { columns: "id,label,host,username", limit: 60 }),
      db.members.list([["principal_type", "human"], ["principal_id", scope.ownerId]], {
        columns: "stream_id,role", limit: 300,
      }),
    ]);
    const streamIds = memberships.map((row) => row.stream_id);
    const streams = streamIds.length
      ? await db.streams.list([["id", streamIds]], { columns: "id,name", limit: 300 }) : [];
    return {
      agents: agents.map((agent) => ({ id: agent.id, name: agent.name, model: agent.model, status: agent.status })),
      vms: vms.map((vm) => ({ id: vm.id, label: vm.label, host: vm.host, username: vm.username })),
      streams: memberships.map((row) => ({
        stream_id: row.stream_id,
        name: streams.find((stream) => stream.id === row.stream_id)?.name ?? "（已删除）",
        role: row.role,
      })),
    };
  },
  send_message: async ({ db, scope, args, env, streamId }) => {
    const content = text(args.content ?? "", { max: 8000, name: "content" });
    if (scope.agentId) {
      const agent = await db.agents.byId(scope.agentId, { columns: "id,name" });
      if (!agent) return { error: "agent_not_found" };
      return postAndFanout(db, {
        streamId, senderType: "agent", senderId: agent.id, senderName: agent.name, content,
      });
    }
    const stream = await db.streams.byId(streamId, { columns: "id,owner_id" });
    if (!stream) return { error: "stream_not_found" };
    return postAndFanout(db, {
      streamId, senderType: "system", senderId: stream.owner_id, senderName: "MCP 客户端", content,
    });
  },
  create_stream: ({ db, scope, args }) => createStream(db, scope, args),
  add_agent_to_stream: async ({ db, scope, args, env, streamId }) => {
    const targetStreamId = args.stream_id ? uuid(args.stream_id, "stream_id") : streamId;
    const role = await membershipRole(db, targetStreamId, scope.ownerId);
    if (!role) return { error: "not_stream_member" };
    const agent = await db.agents.byId(uuid(args.agent_id, "agent_id"), {
      columns: "id,name,owner_id,status",
    });
    if (!agent) return { error: "agent_not_found" };
    if (agent.owner_id !== scope.ownerId) return { error: "agent_not_owned" };
    const existing = await db.members.first([
      ["stream_id", targetStreamId], ["principal_type", "agent"], ["principal_id", agent.id],
    ], { columns: "id" });
    if (existing) return { ok: true, duplicate: true, agent_id: agent.id, stream_id: targetStreamId };
    await db.members.insert({
      id: newId(), stream_id: targetStreamId, principal_type: "agent", principal_id: agent.id,
      role: "member", added_by: scope.ownerId, joined_at: now(),
    }, { columns: "id" });
    await insertMessage(db, {
      streamId: targetStreamId, senderType: "system", senderId: scope.ownerId, senderName: "系统",
      content: `虚拟员工「${agent.name}」被拉进了群。`,
    });
    return { ok: true, agent_id: agent.id, agent_name: agent.name, stream_id: targetStreamId };
  },
  invite_member: async ({ db, scope, args, env, streamId }) => {
    const targetStreamId = args.stream_id ? uuid(args.stream_id, "stream_id") : streamId;
    const role = await membershipRole(db, targetStreamId, scope.ownerId);
    if (role !== "owner" && role !== "admin") return { error: "permission_denied" };
    const invited = emailOf(args.email);
    const existing = await db.requests.first([
      ["stream_id", targetStreamId], ["kind", "invite"], ["applicant_email", invited], ["status", "pending"],
    ], { columns: "id" });
    if (existing) return { ok: true, duplicate: true, email: invited, request_id: existing.id };
    const stream = await db.streams.byId(targetStreamId, { columns: "id,name" });
    if (!stream) return { error: "stream_not_found" };
    const created = await db.requests.insert({
      id: newId(), stream_id: targetStreamId, kind: "invite",
      applicant_user_id: null, applicant_email: invited, applicant_name: null,
      agent_id: null, status: "pending", handled_by: null, handled_at: null,
      created_at: now(), updated_at: now(),
    }, { columns: "id" });
    if (!created) return { error: "invite_failed" };
    const invitee = await db.users.first([["email", invited]], {
      columns: "id,email,display_name,at_channel",
    });
    await deliver({
      db,
      recipientEmail: invited,
      userId: invitee?.id ?? null,
      kind: "invite",
      subject: `你被邀请加入 WorkStream 群「${stream.name}」`,
      body: `群「${stream.name}」邀请你加入，群 UUID：${targetStreamId}。登录后在“待办”里接受即可。`,
      link: `#/stream/${targetStreamId}`,
      streamId: targetStreamId,
    });
    return { ok: true, email: invited, request_id: created.id, stream_id: targetStreamId };
  },
  set_signature: async ({ db, scope, args, env, streamId }) => {
    if (!scope.agentId) return { error: "internal_only" };
    const signature = text(args.signature ?? "", { max: 120, required: false, name: "signature" });
    const updated = await db.agents.claim([["id", scope.agentId]], { signature, updated_at: now() });
    if (!updated) return { error: "signature_update_failed" };
    return { ok: true, signature };
  },
  set_announcement: async ({ db, scope, args, env, streamId }) => {
    const targetStreamId = args.stream_id ? uuid(args.stream_id, "stream_id") : streamId;
    const role = await membershipRole(db, targetStreamId, scope.ownerId);
    if (role !== "owner" && role !== "admin") return { error: "permission_denied" };
    const content = text(args.content ?? "", { max: 4000, required: false, name: "content" });
    await db.streams.patch([["id", targetStreamId]], {
      announcement: content, announcement_at: now(), updated_at: now(),
    });
    await insertMessage(db, {
      streamId: targetStreamId, senderType: "system", senderId: scope.ownerId, senderName: "系统",
      content: content ? `群公告已更新：${content}` : "群公告已清空。",
    });
    return { ok: true, stream_id: targetStreamId, announcement: content };
  },
  register_vm: async ({ db, scope, args, env, streamId }) => {
    const label = text(args.label, { max: 60, name: "label" });
    const host = text(args.host, { max: 200, name: "host" });
    if (!/^[A-Za-z0-9._-]+$/.test(host)) return { error: "invalid_host" };
    const port = Number(args.port ?? 22);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return { error: "invalid_port" };
    const username = text(args.username, { max: 60, name: "username" });
    const authKind = oneOf(args.auth_kind, ["password", "key"], "auth_kind");
    const secret = text(args.secret, { max: 8000, name: "secret" });
    const workdir = text(args.workdir ?? "", { max: 200, required: false });
    const sealed = await seal(secret, { supabase: db.client, env });
    const id = newId();
    const created = await db.vms.insert({
      id, owner_id: scope.ownerId, label, host: host.toLowerCase(), port, username,
      auth_kind: authKind, secret_cipher: sealed.cipher, key_source: sealed.key_source,
      workdir, last_probe: null, created_at: now(), updated_at: now(),
    }, { columns: "id,label" });
    if (!created) return { error: "vm_create_failed" };
    let grantedTo = null;
    if (args.grant_stream_id) {
      const grantStreamId = uuid(args.grant_stream_id, "stream_id");
      const role = await membershipRole(db, grantStreamId, scope.ownerId);
      if (role === "owner" || role === "admin") {
        await db.stream_vms.insert({
          id: newId(), stream_id: grantStreamId, vm_id: id, level: "member",
          granted_by: scope.ownerId, created_at: now(),
        }, { columns: "id" });
        await insertMessage(db, {
          streamId: grantStreamId, senderType: "system", senderId: scope.ownerId, senderName: "系统",
          content: `虚拟机「${label}」已登记并授权给本群。`,
        });
        grantedTo = grantStreamId;
      }
    }
    return { vm_id: id, label, host: host.toLowerCase(), username, granted_to: grantedTo };
  },
  grant_vm: async ({ db, scope, args, env, streamId }) => {
    const vmId = uuid(args.vm_id, "vm_id");
    const targetStreamId = args.stream_id ? uuid(args.stream_id, "stream_id") : streamId;
    const role = await membershipRole(db, targetStreamId, scope.ownerId);
    if (role !== "owner" && role !== "admin") return { error: "permission_denied" };
    const vm = await db.vms.byId(vmId, { columns: "id,owner_id,label" });
    if (!vm) return { error: "vm_not_found" };
    if (vm.owner_id !== scope.ownerId) return { error: "vm_not_owned" };
    const level = oneOf(args.level ?? "member", ["member", "sudo"], "level");
    const existing = await db.stream_vms.first([["stream_id", targetStreamId], ["vm_id", vmId]], {
      columns: "id",
    });
    if (existing) {
      await db.stream_vms.patch([["id", existing.id]], {
        level, granted_by: scope.ownerId, updated_at: now(),
      });
      return { ok: true, grant_id: existing.id, level, stream_id: targetStreamId };
    }
    const created = await db.stream_vms.insert({
      id: newId(), stream_id: targetStreamId, vm_id: vmId, level,
      granted_by: scope.ownerId, created_at: now(),
    }, { columns: "id" });
    if (!created) return { error: "grant_failed" };
    await insertMessage(db, {
      streamId: targetStreamId, senderType: "system", senderId: scope.ownerId, senderName: "系统",
      content: `虚拟机「${vm.label}」授权给本群（级别：${level === "sudo" ? "可用 sudo" : "普通用户"}）。`,
    });
    return { ok: true, grant_id: created.id, level, stream_id: targetStreamId };
  },
};

// 单一接缝：作用域校验 → pre 钩子（开步骤）→ handler → post 钩子（收步骤）。
// 钩子按声明顺序串行；run_steps 写失败会一路抛出去，这轮任务直接失败并带着真实错误码，不悄悄降级。
const pipeline = createPipeline([runStepsTrace]);

/**
 * @param {{streamId:string, agentId:string|null, ownerId:string|null, trace?: object}} scope
 *        trace 由引擎在一次运行时挂上；外部 MCP 调用没有它，也就不属于任何轨迹。
 * @param {{callId?: string}} meta 上游模型给的 tool_call id，只用于把步骤和调用配对。
 */
export async function executeTool(db, scope, name, args = {}, env = null, meta = {}) {
  const ctx = {
    db, scope, name, args, env,
    streamId: scope.streamId,
    callId: meta.callId ?? null,
    output: null,
    error: null,
    step: null,
  };
  return pipeline.run(ctx, async () => {
    if (INTERNAL_TOOL_NAMES.includes(name)) {
      if (!scope.agentId && INTERNAL_ONLY.has(name)) return { error: "internal_only" };
      const handler = TOOL_HANDLERS[name];
      if (!handler) throw new Error(`工具 ${name} 在 MCP 声明里有、注册表里没有`);
      return handler(ctx);
    }
    // 外部连接器的工具：只有这轮真拿到主人启用中连接器的声明才放行，
    // 且必须发生在员工回路里——对外 MCP 那条路按 EXTERNAL_TOOL_NAMES 白名单走，碰不到这里。
    if (!scope.agentId) return { error: "tool_not_allowed" };
    const target = await resolveConnectorTool(db, env, scope.ownerId, name);
    if (!target) return { error: "tool_not_allowed" };
    return callConnectorTool(target, ctx.args);
  });
}

// 冷启动就把“声明了但没实现”炸出来：否则它会在运行时变成一句 tool_not_allowed，谁也看不出是漏写。
const missingHandlers = INTERNAL_TOOL_NAMES.filter((toolName) => !TOOL_HANDLERS[toolName]);
if (missingHandlers.length) throw new Error(`工具缺少实现：${missingHandlers.join(", ")}`);

const PROTOCOL_VERSION = "2024-11-05";

const mcpTool = (definition) => ({
  name: definition.function.name,
  description: definition.function.description,
  inputSchema: definition.function.parameters,
});

/** 对外 MCP：initialize / tools/list / tools/call，按 stream MCP key 认证。 */
export async function handleMcp({ db, request, env }) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  const presented = text(
    request.headers.get("x-workstream-mcp-key")
      ?? bearer(request.headers.get("authorization"))
      ?? "",
    { max: 200, name: "mcp_key", required: false },
  );
  if (!presented) return json({ error: "mcp_key_required" }, 401);
  const hash = await sha256Hex(presented);
  const stream = await db.streams.first([["mcp_key_hash", hash]], {
    columns: "id,name,owner_id,mcp_key_set",
  });
  if (!stream) return json({ error: "mcp_key_invalid" }, 403);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const method = String(payload?.method ?? "");
  const id = payload?.id ?? null;
  const scope = { streamId: stream.id, agentId: null, ownerId: stream.owner_id };
  if (method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `workstream-stream-${stream.name}`, version: "0.2.0" },
      },
    });
  }
  if (method === "tools/list") {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOL_DEFINITIONS
          .filter((definition) => EXTERNAL_TOOL_NAMES.includes(definition.function.name))
          .map(mcpTool),
      },
    });
  }
  if (method === "tools/call") {
    const name = String(payload?.params?.name ?? "");
    if (!EXTERNAL_TOOL_NAMES.includes(name)) {
      return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "tool_not_allowed" } });
    }
    let output;
    try {
      output = await executeTool(db, scope, name, payload?.params?.arguments ?? {}, env);
    } catch (error) {
      output = { error: error?.error ?? "tool_failed" };
    }
    return json({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(output) }], isError: Boolean(output?.error) },
    });
  }
  return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "method_not_found" } });
}

const bearer = (value) => (String(value ?? "").startsWith("Bearer ") ? String(value).slice(7).trim() : "");
