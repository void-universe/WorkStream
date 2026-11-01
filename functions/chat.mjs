// 群消息：发送、翻页、@ 解析；@ 虚拟员工入其邮箱队列，@ 真实员工投递到其选定通道。
import { deliver } from "./accounts.mjs";
import { AGENT_COLUMNS } from "./agents.mjs";
import { requireMembership } from "./perm.mjs";
import { streamPresence } from "./presence.mjs";
import { insertMessage } from "./rooms.mjs";
import { Halt, isUuid, json, newId, now, text, truncate, uuid } from "./util.mjs";

export const MESSAGE_COLUMNS =
  "id,stream_id,seq,sender_type,sender_id,sender_name,content,mentions,reply_to,kind,error,created_at";

function parseMentions(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const type = item.type === "agent" ? "agent" : item.type === "human" ? "human" : null;
    if (!type || !isUuid(item.id)) continue;
    const key = `${type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, id: item.id });
  }
  return out;
}

export const actions = {
  async "messages.list"({ db, user, params }) {
    const streamId = uuid(params.get("stream_id"), "stream_id");
    await requireMembership(db, streamId, user.id);
    const limit = Math.min(Number(params.get("limit") ?? 60) || 60, 120);
    let query = db.client.from("messages").select(MESSAGE_COLUMNS).eq("stream_id", streamId);
    const before = params.get("before_seq");
    if (before !== null && before !== "") {
      const cursor = Number(before);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Halt("invalid_before_seq", 400);
      query = query.lt("seq", cursor);
    }
    const result = await query.order("seq", { ascending: false }).limit(limit + 1);
    if (result.error) throw new Halt("messages_request_failed", 503, { code: result.error.code });
    const rows = (Array.isArray(result.data) ? result.data : []).map(shapeMessage);
    const items = rows.slice(0, limit).reverse();
    // 每条 @ 派发消息附上接收员工的读/处理状态；群头像旁的签名与忙碌状态一起带回。
    const ids = items.map((item) => item.id);
    const mail = ids.length
      ? await db.mail.list([["message_id", ids]], {
        columns: "message_id,agent_id,status,started_at,finished_at,error", limit: 500,
      })
      : [];
    const agentIds = [...new Set(mail.map((row) => row.agent_id))];
    const agents = agentIds.length
      ? await db.agents.list([["id", agentIds]], { columns: "id,name", limit: 200 })
      : [];
    const agentNames = new Map(agents.map((row) => [row.id, row.name]));
    const byMessage = new Map();
    for (const row of mail) {
      const list = byMessage.get(row.message_id) ?? [];
      list.push({
        agent_id: row.agent_id,
        agent_name: agentNames.get(row.agent_id) ?? "已删除的虚拟员工",
        status: row.status,
        started_at: row.started_at,
        finished_at: row.finished_at,
        error: row.error,
      });
      byMessage.set(row.message_id, list);
    }
    for (const item of items) item.deliveries = byMessage.get(item.id) ?? [];
    return json({
      ok: true,
      items,
      has_more: rows.length > limit,
      oldest_seq: items[0]?.seq ?? null,
      presence: await streamPresence(db, streamId),
    });
  },

  async "messages.send"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const membership = await requireMembership(db, streamId, user.id);
    const content = text(body.content, { max: 8000, name: "content" });
    const mentions = parseMentions(body.mentions);
    const replyTo = body.reply_to ? uuid(body.reply_to, "reply_to") : null;

    const agentIds = mentions.filter((m) => m.type === "agent").map((m) => m.id);
    const humanIds = mentions.filter((m) => m.type === "human").map((m) => m.id);
    const agents = agentIds.length
      ? await db.agents.list([["id", agentIds]], { columns: AGENT_COLUMNS, limit: 20 })
      : [];
    if (agents.length !== agentIds.length) throw new Halt("mention_agent_missing", 400);
    const humans = humanIds.length
      ? await db.users.list([["id", humanIds]], { columns: "id,display_name,email,at_channel", limit: 20 })
      : [];
    if (humans.length !== humanIds.length) throw new Halt("mention_human_missing", 400);
    // 每个被 @ 的主体都必须已经在这个群里，不能借 @ 向陌生会话投递。
    const inStream = await db.members.list([["stream_id", streamId]], {
      columns: "principal_type,principal_id", limit: 300,
    });
    const members = new Set(inStream.map((m) => `${m.principal_type}:${m.principal_id}`));
    for (const mention of mentions) {
      if (!members.has(`${mention.type}:${mention.id}`)) throw new Halt("mention_not_in_stream", 400);
    }

    const message = await insertMessage(db, {
      streamId,
      senderType: "human",
      senderId: user.id,
      senderName: user.display_name,
      content,
      mentions,
      replyTo,
    });

    const queued = [];
    for (const agent of agents) {
      const mail = await db.mail.insert({
        id: newId(),
        agent_id: agent.id,
        stream_id: streamId,
        message_id: message.id,
        trigger_seq: message.seq,
        priority: await streamWeight(db, agent.id, streamId),
        status: "queued",
        slice_count: 0,
        error: null,
        created_at: now(),
        started_at: null,
        finished_at: null,
        updated_at: now(),
      }, { columns: "id,status,created_at,priority" });
      if (mail) queued.push({ agent_id: agent.id, mail_id: mail.id, priority: mail.priority });
    }

    const notified = [];
    for (const human of humans) {
      if (human.id === user.id) continue;
      const link = `#/stream/${streamId}`;
      await deliver({
        db,
        recipientEmail: human.email,
        userId: human.id,
        kind: "mention",
        subject: `[${truncate(content, 24)}] ${user.display_name} 在群里 @ 了你`,
        body: `${user.display_name}：${truncate(content, 500)}\n打开：${link}`,
        link,
        streamId,
      });
      notified.push({ user_id: human.id, channel: human.at_channel === "real_email" ? "real_email" : "virtual" });
    }

    return json({ ok: true, message, queued, notified, my_role: membership.role });
  },
};

export const shapeMessage = (row) => ({
  ...row,
  mentions: Array.isArray(row.mentions) ? row.mentions : [],
});

/** 该虚拟员工在这个群里的时间片权重；未设即为均分（权重 1）。 */
export async function streamWeight(db, agentId, streamId) {
  const row = await db.slice_prefs.first([["agent_id", agentId], ["stream_id", streamId]]);
  const weight = Number(row?.weight ?? 1);
  return Number.isSafeInteger(weight) && weight >= 1 && weight <= 20 ? weight : 1;
}
