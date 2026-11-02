// 现场状态：邮箱里正在处理哪条、还排着多少、头像旁的个性签名。
// 群聊（messages.list 的 presence）和员工详情页（agents.presence）共用这里的查询。
import { truncate } from "./util.mjs";

const MAIL_COLUMNS =
  "id,agent_id,stream_id,message_id,trigger_seq,status,priority,created_at,started_at,finished_at,error,slice_count";
const MAX_PREVIEW = 120;

const previewOf = (content) => truncate(String(content ?? "").replace(/\s+/g, " ").trim(), MAX_PREVIEW);

async function messageIndex(db, messageIds) {
  const ids = [...new Set(messageIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.messages.list([["id", ids]], { columns: "id,seq,content", limit: 300 });
  return new Map(rows.map((row) => [row.id, { seq: Number(row.seq), preview: previewOf(row.content) }]));
}

async function activeMail(db, agentIds, streamId) {
  if (!agentIds.length) return [];
  const pairs = [["agent_id", agentIds], ["status", ["queued", "running"]]];
  if (streamId) pairs.push(["stream_id", streamId]);
  return db.mail.list(pairs, {
    columns: MAIL_COLUMNS, order: ["created_at", { ascending: true }], limit: 300,
  });
}

/** 同一员工可能并行跑多个任务；头像上的“处理中”取最早开始的那条作为当前焦点。 */
function currentOf(rows, messages) {
  const running = rows
    .filter((row) => row.status === "running")
    .sort((a, b) => String(a.started_at ?? "").localeCompare(String(b.started_at ?? "")));
  const head = running[0];
  if (!head) return null;
  const message = messages.get(head.message_id);
  return {
    mail_id: head.id,
    message_id: head.message_id ?? null,
    seq: Number(message?.seq ?? head.trigger_seq ?? 0),
    preview: message?.preview ?? "",
    started_at: head.started_at ?? null,
  };
}

/** 某个群里所有虚拟员工的现场状态：签名、是否在忙、焦点消息与排队数。
 *  viewerId 用来标记“这位是我雇的员工”——群里只有主人能叫停或插话 ta 的活。 */
export async function streamPresence(db, streamId, viewerId = null) {
  const memberships = await db.members.list([["stream_id", streamId], ["principal_type", "agent"]], {
    columns: "principal_id", limit: 300,
  });
  const agentIds = [...new Set(memberships.map((row) => row.principal_id))];
  if (!agentIds.length) return [];
  const [agents, mail] = await Promise.all([
    db.agents.list([["id", agentIds]], { columns: "id,name,signature,avatar,color,status,owner_id", limit: 300 }),
    activeMail(db, agentIds, streamId),
  ]);
  const messages = await messageIndex(
    db,
    mail.filter((row) => row.status === "running").map((row) => row.message_id),
  );
  return agents.map((agent) => {
    const mine = mail.filter((row) => row.agent_id === agent.id);
    const current = currentOf(mine, messages);
    return {
      agent_id: agent.id,
      name: agent.name,
      signature: agent.signature ?? "",
      avatar: agent.avatar ?? null,
      color: agent.color,
      status: agent.status,
      owned_by_caller: Boolean(viewerId) && agent.owner_id === viewerId,
      working: Boolean(current),
      running: mine.filter((row) => row.status === "running").length,
      queued: mine.filter((row) => row.status === "queued").length,
      current,
    };
  });
}

/** 单个员工的现场：资料（不含 Key/提示词/记忆）、所在群、当前任务与最近邮箱记录。
 *  streamIds 用于非主人视角：只回双方共同所在的群，避免泄露别的群的任务内容。 */
export async function agentPresence(db, agentId, { streamIds = null } = {}) {
  const agent = await db.agents.byId(agentId, {
    columns: "id,owner_id,name,role,signature,avatar,color,status,created_at",
  });
  if (!agent) return null;
  const memberPairs = [["principal_type", "agent"], ["principal_id", agentId]];
  const mailPairs = [["agent_id", agentId]];
  if (streamIds) {
    memberPairs.push(["stream_id", streamIds]);
    mailPairs.push(["stream_id", streamIds]);
  }
  const [owner, memberships, mail, prefs] = await Promise.all([
    db.users.byId(agent.owner_id, { columns: "id,display_name" }),
    db.members.list(memberPairs, {
      columns: "stream_id,role,joined_at", limit: 60,
    }),
    db.mail.list(mailPairs, {
      columns: MAIL_COLUMNS, order: ["created_at", { ascending: false }], limit: 40,
    }),
    db.slice_prefs.list([["agent_id", agentId]], { columns: "stream_id,weight", limit: 60 }),
  ]);
  const weightOf = new Map(prefs.map((row) => [row.stream_id, row.weight]));
  const memberStreamIds = memberships.map((row) => row.stream_id);
  const streams = memberStreamIds.length
    ? await db.streams.list([["id", memberStreamIds]], { columns: "id,name", limit: 60 })
    : [];
  const streamName = new Map(streams.map((row) => [row.id, row.name]));
  const messages = await messageIndex(db, mail.map((row) => row.message_id));
  const active = mail.filter((row) => row.status === "queued" || row.status === "running");
  return {
    profile: agent,
    owner: { id: owner?.id ?? agent.owner_id, display_name: owner?.display_name ?? "已注销用户" },
    streams: memberships.map((row) => {
      const mine = active.filter((item) => item.stream_id === row.stream_id);
      return {
        stream_id: row.stream_id,
        name: streamName.get(row.stream_id) ?? "已删除的群",
        role: row.role,
        weight: weightOf.get(row.stream_id) ?? 1,
        queued: mine.filter((item) => item.status === "queued").length,
        running: mine.filter((item) => item.status === "running").length,
      };
    }),
    current: currentOf(mail, messages),
    queue: mail.map((row) => {
      const message = messages.get(row.message_id);
      return {
        id: row.id,
        stream_id: row.stream_id,
        stream_name: streamName.get(row.stream_id) ?? "已删除的群",
        status: row.status,
        priority: row.priority,
        trigger_seq: row.trigger_seq,
        seq: Number(message?.seq ?? row.trigger_seq ?? 0),
        preview: message?.preview ?? "",
        created_at: row.created_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
        error: row.error,
        slice_count: row.slice_count,
      };
    }),
  };
}
