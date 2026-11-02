// 群消息：发送、翻页、@ 解析；@ 虚拟员工入其邮箱队列，@ 真实员工投递到其选定通道。
import { deliver } from "./accounts.mjs";
import { AGENT_COLUMNS } from "./agents.mjs";
import { fireInterrupt } from "./bus.mjs";
import { requireMembership } from "./perm.mjs";
import { streamPresence } from "./presence.mjs";
import { insertMessage } from "./rooms.mjs";
import { Halt, isUuid, json, newId, now, text, truncate, uuid } from "./util.mjs";

export const MESSAGE_COLUMNS =
  "id,stream_id,seq,sender_type,sender_id,sender_name,content,mentions,reply_to,kind,error,attachments,created_at";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 800_000;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** base64 长度换算成真实字节数，用于群里显示大小与入库统计。 */
const b64Bytes = (value) =>
  Math.floor((value.length * 3) / 4) - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);

/**
 * 图片存进群文件表（content 列放纯 base64），消息里只留引用。
 * 这样 messages.list 翻页不会拖着几 MB 的 base64，虚拟员工按需再取原件。
 */
async function storeImages(db, { streamId, userId, items }) {
  if (!Array.isArray(items) || !items.length) return [];
  if (items.length > MAX_IMAGES) throw new Halt("too_many_images", 400);
  const out = [];
  for (const item of items) {
    const type = String(item?.content_type ?? "");
    const data = String(item?.data ?? "");
    if (!IMAGE_TYPES.has(type)) throw new Halt("unsupported_image_type", 400);
    if (!B64_RE.test(data) || data.length > MAX_IMAGE_CHARS) throw new Halt("invalid_image_data", 400);
    const name = text(item?.name ?? "图片", { max: 120, name: "name" });
    if (name.includes("/") || name.includes("\\") || name.startsWith(".")) throw new Halt("invalid_file_name", 400);
    const created = await db.files.insert({
      id: newId(), stream_id: streamId, name, object_path: null,
      size_bytes: b64Bytes(data), content_type: type, store: "db", content: data,
      uploaded_by: userId, created_at: now(),
    }, { columns: "id" });
    if (!created) throw new Halt("image_write_failed", 503);
    out.push({ file_id: created.id, name, content_type: type, size_bytes: b64Bytes(data) });
  }
  return out;
}

/** 自己名下的员工正在这个群里跑任务时，新的 @ 就是插话：
 * 写进那条邮箱的 meta，正在生成的流式回复会在分片边界掐断并按新消息重答。
 */
async function registerInterrupts(db, { user, streamId, message, agents }) {
  const owned = agents.filter((agent) => agent.owner_id === user.id).map((agent) => agent.id);
  if (!owned.length) return [];
  const running = await db.mail.list([["agent_id", owned], ["stream_id", streamId], ["status", "running"]], {
    columns: "id,agent_id,trigger_seq,meta", order: ["started_at", { ascending: true }], limit: 20,
  });
  const out = [];
  for (const mail of running) {
    const handled = Math.max(Number(mail.trigger_seq ?? 0), Number(mail.meta?.interrupt?.seq ?? 0));
    if (Number(message.seq) <= handled) continue;
    const meta = { ...(mail.meta ?? {}), interrupt: { message_id: message.id, seq: Number(message.seq), at: now() } };
    const claimed = await db.mail.claim([["id", mail.id], ["status", "running"]], { meta });
    if (claimed) {
      fireInterrupt(mail.id);
      out.push({ agent_id: mail.agent_id, mail_id: mail.id });
    }
  }
  return out;
}

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
      presence: await streamPresence(db, streamId, user.id),
    });
  },

  async "messages.send"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const membership = await requireMembership(db, streamId, user.id);
    const content = text(body.content ?? "", { max: 8000, required: false });
    const mentions = parseMentions(body.mentions);
    const replyTo = body.reply_to ? uuid(body.reply_to, "reply_to") : null;
    const attachments = await storeImages(db, { streamId, userId: user.id, items: body.attachments });
    if (!content && !attachments.length) throw new Halt("invalid_content", 400);

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
      attachments,
    });

    const interrupted = await registerInterrupts(db, { user, streamId, message, agents });
    const merged = new Set(interrupted.map((row) => row.agent_id));
    const queued = [];
    for (const agent of agents) {
      // 该员工正在本群跑任务且这次 @ 已被登记成插话：不再另起一条任务，避免回两遍。
      if (merged.has(agent.id)) continue;
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

    return json({ ok: true, message, queued, interrupted, notified, my_role: membership.role });
  },

  /** 取一条消息附带的原图：群成员才能取，返回 base64 供前端拼 data URL。 */
  async "messages.attachment"({ db, user, params }) {
    const fileId = uuid(params.get("id"), "id");
    const file = await db.files.byId(fileId, { columns: "id,stream_id,name,content_type,size_bytes,content,store" });
    if (!file) throw new Halt("file_not_found", 404);
    await requireMembership(db, file.stream_id, user.id);
    if (file.store !== "db" || !String(file.content_type).startsWith("image/")) {
      throw new Halt("attachment_not_image", 400);
    }
    return json({
      ok: true,
      attachment: {
        file_id: file.id, name: file.name, content_type: file.content_type,
        size_bytes: file.size_bytes, data: file.content ?? "",
      },
    });
  },
};

export const shapeMessage = (row) => ({
  ...row,
  mentions: Array.isArray(row.mentions) ? row.mentions : [],
  attachments: Array.isArray(row.attachments) ? row.attachments : [],
});

/** 该虚拟员工在这个群里的时间片权重；未设即为均分（权重 1）。 */
export async function streamWeight(db, agentId, streamId) {
  const row = await db.slice_prefs.first([["agent_id", agentId], ["stream_id", streamId]]);
  const weight = Number(row?.weight ?? 1);
  return Number.isSafeInteger(weight) && weight >= 1 && weight <= 20 ? weight : 1;
}
