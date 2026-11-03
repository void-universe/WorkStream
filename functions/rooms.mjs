// 群（stream）：UUID 申请进群、邀请、成员角色、公告、群文件、消息与 @ 派发。
import { deliver } from "./accounts.mjs";
import { AGENT_COLUMNS, publicAgent } from "./agents.mjs";
import { STREAM_COLUMNS, humanMembership, requireMembership, requireRole } from "./perm.mjs";
import { Halt, CONTEXT_CHARS_DEFAULT, CONTEXT_CHARS_MAX, email as emailOf, int, json, newId, now, oneOf, text, uuid } from "./util.mjs";

const MESSAGE_COLUMNS =
  "id,stream_id,seq,sender_type,sender_id,sender_name,content,mentions,reply_to,kind,error,attachments,created_at";
const FILE_COLUMNS = "id,stream_id,name,size_bytes,content_type,store,uploaded_by,created_at";
export const MAX_FILE_BYTES = 400_000;

/** 群文件写入统一走这里：UI 上传与 MCP 工具共用同一套命名/大小规则。 */
export async function createGroupFile(db, { streamId, userId, userName, name, contentType, content }) {
  const cleanName = text(name, { max: 120, name: "name" });
  if (cleanName.includes("/") || cleanName.includes("\\") || cleanName.startsWith(".")) {
    throw new Halt("invalid_file_name", 400);
  }
  const type = text(contentType || "text/plain", { max: 80, name: "content_type" });
  const raw = text(content, { max: MAX_FILE_BYTES, name: "content" });
  const size = new TextEncoder().encode(raw).length;
  const created = await db.files.insert({
    id: newId(),
    stream_id: streamId,
    name: cleanName,
    object_path: null,
    size_bytes: size,
    content_type: type,
    store: "db",
    content: raw,
    uploaded_by: userId,
    created_at: now(),
  }, { columns: FILE_COLUMNS });
  if (!created) throw new Halt("file_write_failed", 503);
  await insertMessage(db, {
    streamId, senderType: "system", senderId: userId, senderName: "系统",
    content: `${userName} 上传了群文件「${cleanName}」（${size} 字节）。`,
  });
  return created;
}

/** 上传者本人、群主或管理员可删。 */
export async function deleteGroupFile(db, { file, userId, role }) {
  if (file.uploaded_by !== userId && role !== "owner" && role !== "admin") {
    throw new Halt("permission_denied", 403);
  }
  if (file.store === "storage") await removeStorage(file.object_path);
  const removed = await db.files.remove([["id", file.id]]);
  if (!removed) throw new Halt("file_delete_failed", 503);
  return removed;
}

async function memberDirectory(db, streamId) {
  const rows = await db.members.list([["stream_id", streamId]], {
    columns: "id,principal_type,principal_id,role,joined_at", limit: 300,
  });
  const humans = rows.filter((r) => r.principal_type === "human");
  const agents = rows.filter((r) => r.principal_type === "agent");
  const humanIds = humans.map((r) => r.principal_id);
  const agentIds = agents.map((r) => r.principal_id);
  const humanRows = humanIds.length
    ? await db.users.list([["id", humanIds]], { columns: "id,display_name,email,avatar", limit: 300 })
    : [];
  const agentRows = agentIds.length
    ? await db.agents.list([["id", agentIds]], { columns: AGENT_COLUMNS, limit: 300 })
    : [];
  const byHuman = new Map(humanRows.map((r) => [r.id, r]));
  const byAgent = new Map(agentRows.map((r) => [r.id, r]));
  return {
    memberships: rows,
    humans: humans.map((m) => ({
      membership_id: m.id,
      type: "human",
      id: m.principal_id,
      role: m.role,
      joined_at: m.joined_at,
      display_name: byHuman.get(m.principal_id)?.display_name ?? "已注销员工",
      email: byHuman.get(m.principal_id)?.email ?? "",
      avatar: byHuman.get(m.principal_id)?.avatar ?? null,
    })),
    agents: agents.map((m) => ({
      membership_id: m.id,
      type: "agent",
      role: m.role,
      joined_at: m.joined_at,
      agent: publicAgent(byAgent.get(m.principal_id) ?? { id: m.principal_id, name: "已删除的虚拟员工", owner_id: "" }),
    })),
  };
}

/** 分配群内消息序号：单行比较并写，冲突后最多重试 5 次。 */
export async function nextSeq(db, streamId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const stream = await db.streams.byId(streamId, { columns: "id,next_seq" });
    if (!stream) throw new Halt("stream_not_found", 404);
    const current = Number(stream.next_seq ?? 1);
    const claimed = await db.streams.claim(
      [["id", streamId], ["next_seq", stream.next_seq]],
      { next_seq: current + 1 },
      { stamp: false },
    );
    if (claimed) return current;
  }
  throw new Halt("seq_contention", 503);
}

async function insertMessage(db, { streamId, senderType, senderId, senderName, content, mentions, replyTo, kind, attachments }) {
  const seq = await nextSeq(db, streamId);
  const row = await db.messages.insert({
    id: newId(),
    stream_id: streamId,
    seq,
    sender_type: senderType,
    sender_id: senderId,
    sender_name: senderName,
    content,
    mentions: mentions ?? [],
    reply_to: replyTo ?? null,
    kind: kind ?? (senderType === "system" ? "system" : "chat"),
    error: null,
    attachments: attachments ?? [],
    created_at: now(),
  }, { columns: MESSAGE_COLUMNS });
  if (!row) throw new Halt("message_write_failed", 503);
  return row;
}

export { insertMessage };

export const actions = {
  async "streams.mine"({ db, user }) {
    const mine = await db.members.list([
      ["principal_type", "human"],
      ["principal_id", user.id],
    ], { columns: "stream_id,role,joined_at", limit: 300 });
    const ids = mine.map((m) => m.stream_id);
    const rows = ids.length
      ? await db.streams.list([["id", ids]], { columns: STREAM_COLUMNS, limit: 300 })
      : [];
    const roleOf = new Map(mine.map((m) => [m.stream_id, m.role]));
    const agentCount = ids.length
      ? await db.members.list([["stream_id", ids], ["principal_type", "agent"]], {
        columns: "stream_id,principal_id", limit: 600,
      })
      : [];
    const perStream = new Map();
    for (const row of agentCount) {
      perStream.set(row.stream_id, (perStream.get(row.stream_id) ?? 0) + 1);
    }
    return json({
      ok: true,
      items: rows
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map((s) => ({ ...s, my_role: roleOf.get(s.id), agent_count: perStream.get(s.id) ?? 0 })),
    });
  },

  async "streams.create"({ db, user, body }) {
    const name = text(body.name, { max: 60, name: "name" });
    const joinPolicy = oneOf(body.join_policy ?? "request", ["request", "invite_only"], "join_policy");
    const contextChars = int(body.context_chars, {
      min: 2000, max: CONTEXT_CHARS_MAX, name: "context_chars", fallback: CONTEXT_CHARS_DEFAULT,
    });
    const agentIds = Array.isArray(body.agent_ids) ? body.agent_ids.map((v) => uuid(v, "agent_id")).slice(0, 20) : [];
    const vmIds = Array.isArray(body.vm_ids) ? body.vm_ids.map((v) => uuid(v, "vm_id")).slice(0, 20) : [];
    const id = newId();
    const created = await db.streams.insert({
      id,
      name,
      owner_id: user.id,
      join_policy: joinPolicy,
      announcement: text(body.announcement ?? "", { max: 4000, required: false }),
      announcement_at: body.announcement ? now() : null,
      context_chars: contextChars,
      next_seq: 1,
      mcp_key_hash: null,
      created_at: now(),
      updated_at: now(),
    }, { columns: "id" });
    if (!created) throw new Halt("stream_create_failed", 503);
    await db.members.insert({
      id: newId(), stream_id: id, principal_type: "human", principal_id: user.id,
      role: "owner", added_by: user.id, joined_at: now(),
    }, { columns: "id" });
    if (agentIds.length) {
      const owned = await db.agents.list([["id", agentIds], ["owner_id", user.id]], { columns: "id", limit: 20 });
      const allowed = new Set(owned.map((a) => a.id));
      const missing = agentIds.filter((a) => !allowed.has(a));
      if (missing.length) throw new Halt("agent_not_owned", 403, { missing });
      await db.members.insertMany(agentIds.map((agentId) => ({
        id: newId(), stream_id: id, principal_type: "agent", principal_id: agentId,
        role: "member", added_by: user.id, joined_at: now(),
      })), { columns: "id" });
    }
    if (vmIds.length) {
      const owned = await db.vms.list([["id", vmIds], ["owner_id", user.id]], { columns: "id", limit: 20 });
      if (owned.length !== vmIds.length) throw new Halt("vm_not_owned", 403);
      await db.stream_vms.insertMany(vmIds.map((vmId) => ({
        id: newId(), stream_id: id, vm_id: vmId, level: "member", granted_by: user.id, created_at: now(),
      })), { columns: "id" });
    }
    await insertMessage(db, {
      streamId: id, senderType: "system", senderId: user.id, senderName: "系统",
      content: `${user.display_name} 创建了群「${name}」。群 UUID：${id}`,
    });
    return json({ ok: true, stream: await db.streams.byId(id, { columns: STREAM_COLUMNS }) });
  },

  async "streams.get"({ db, user, params }) {
    const streamId = uuid(params.get("id"), "id");
    const stream = await db.streams.byId(streamId, { columns: STREAM_COLUMNS });
    if (!stream) throw new Halt("stream_not_found", 404);
    const membership = await humanMembership(db, streamId, user.id);
    if (!membership) throw new Halt("not_stream_member", 403);
    const directory = await memberDirectory(db, streamId);
    const files = await db.files.list([["stream_id", streamId]], { columns: FILE_COLUMNS, limit: 200 });
    const granted = await db.stream_vms.list([["stream_id", streamId]], { columns: "vm_id,level,id", limit: 50 });
    const vmIds = granted.map((g) => g.vm_id);
    const vmRows = vmIds.length
      ? await db.vms.list([["id", vmIds]], { columns: "id,label,host,port,username,auth_kind,workdir,last_probe,owner_id", limit: 50 })
      : [];
    const open = await db.requests.list(
      [["stream_id", streamId], ["status", "pending"]],
      { columns: "id,kind,applicant_email,applicant_name,applicant_user_id,agent_id,status,created_at", limit: 100 },
    );
    return json({
      ok: true,
      stream,
      my_role: membership.role,
      members: [...directory.humans, ...directory.agents],
      files,
      vms: granted.map((g) => ({
        grant_id: g.id, level: g.level,
        ...(vmRows.find((v) => v.id === g.vm_id) ?? { id: g.vm_id, label: "已删除的虚拟机" }),
      })),
      requests: membership.role === "owner" || membership.role === "admin" ? open : [],
    });
  },

  /** 拿 UUID 申请进群前的预览：只回名字与进群方式，其余一律不外泄。 */
  async "streams.lookup"({ db, user, params }) {
    const streamId = uuid(params.get("id"), "id");
    const stream = await db.streams.byId(streamId, { columns: "id,name,join_policy" });
    if (!stream) throw new Halt("stream_not_found", 404);
    const count = await db.members.total([["stream_id", streamId]]);
    const already = await humanMembership(db, streamId, user.id);
    return json({
      ok: true,
      preview: { uuid: stream.id, name: stream.name, join_policy: stream.join_policy, member_count: count },
      already_member: Boolean(already),
    });
  },

  async "streams.rename"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    await requireRole(db, streamId, user, ["owner", "admin"]);
    const name = text(body.name, { max: 60, name: "name" });
    const updated = await db.streams.claim([["id", streamId]], { name });
    if (!updated) throw new Halt("stream_write_failed", 503);
    return json({ ok: true, name });
  },

  async "streams.announcement"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    await requireRole(db, streamId, user, ["owner", "admin"]);
    const content = text(body.content ?? "", { max: 4000, required: false });
    const updated = await db.streams.claim([["id", streamId]], { announcement: content, announcement_at: now() });
    if (!updated) throw new Halt("stream_write_failed", 503);
    await insertMessage(db, {
      streamId, senderType: "system", senderId: user.id, senderName: "系统",
      content: content ? `群公告已更新：${content}` : "群公告已清空。",
    });
    return json({ ok: true, content });
  },

  async "streams.settings"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const stream = await db.streams.byId(streamId, { columns: "id,owner_id,context_chars" });
    if (!stream) throw new Halt("stream_not_found", 404);
    if (stream.owner_id !== user.id) throw new Halt("owner_only", 403);
    const values = {};
    if (body.context_chars !== undefined) {
      values.context_chars = int(body.context_chars, { min: 2000, max: CONTEXT_CHARS_MAX, name: "context_chars" });
    }
    if (body.join_policy !== undefined) values.join_policy = oneOf(body.join_policy, ["request", "invite_only"], "join_policy");
    if (!Object.keys(values).length) return json({ ok: true, context_chars: stream.context_chars });
    await db.streams.patch([["id", streamId]], { ...values, updated_at: now() });
    return json({ ok: true, ...values });
  },

  async "streams.transfer"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const stream = await db.streams.byId(streamId, { columns: "id,owner_id" });
    if (!stream) throw new Halt("stream_not_found", 404);
    if (stream.owner_id !== user.id) throw new Halt("owner_only", 403);
    const targetId = uuid(body.membership_id, "membership_id");
    // 取回的列必须包含 stream_id：少了它下面的归属校验永远为真，移交会一律假装“成员不存在”。
    const target = await db.members.byId(targetId, { columns: "id,stream_id,principal_type,principal_id,role" });
    if (!target || target.stream_id !== streamId || target.principal_type !== "human") {
      throw new Halt("member_missing", 404);
    }
    await db.members.patch([["id", targetId]], { role: "owner", updated_at: now() });
    await db.members.patch([["stream_id", streamId], ["principal_type", "human"], ["principal_id", user.id]], { role: "admin", updated_at: now() });
    await db.streams.patch([["id", streamId]], { owner_id: target.principal_id, updated_at: now() });
    await insertMessage(db, {
      streamId, senderType: "system", senderId: user.id, senderName: "系统",
      content: "群主已移交。",
    });
    return json({ ok: true });
  },

  /** 拿 UUID 申请进群：任何人都能提交，群主/管理员审批。 */
  async "streams.apply"({ db, user, body }) {
    const streamId = uuid(body.stream_uuid, "stream_uuid");
    const stream = await db.streams.byId(streamId, { columns: "id,name,join_policy" });
    if (!stream) throw new Halt("stream_not_found", 404);
    if (stream.join_policy === "invite_only") throw new Halt("invite_only", 409);
    if (await humanMembership(db, streamId, user.id)) return json({ ok: true, already_member: true });
    const pending = await db.requests.first([
      ["stream_id", streamId], ["kind", "human"], ["applicant_user_id", user.id], ["status", "pending"],
    ]);
    if (pending) return json({ ok: true, request_id: pending.id, status: "pending" });
    const created = await db.requests.insert({
      id: newId(),
      stream_id: streamId,
      kind: "human",
      applicant_user_id: user.id,
      applicant_email: user.email,
      applicant_name: user.display_name,
      agent_id: null,
      status: "pending",
      handled_by: null,
      handled_at: null,
      created_at: now(),
      updated_at: now(),
    }, { columns: "id,status" });
    if (!created) throw new Halt("request_failed", 503);
    return json({ ok: true, request_id: created.id, status: "pending", stream_name: stream.name });
  },

  async "streams.requests"({ db, user, params }) {
    const streamId = uuid(params.get("stream_id"), "stream_id");
    await requireRole(db, streamId, user, ["owner", "admin"]);
    const rows = await db.requests.list([["stream_id", streamId]], {
      columns: "id,kind,applicant_user_id,applicant_email,applicant_name,agent_id,status,created_at,handled_at",
      order: ["created_at", { ascending: false }], limit: 100,
    });
    return json({ ok: true, items: rows });
  },

  async "streams.decide"({ db, user, body }) {
    const requestId = uuid(body.request_id, "request_id");
    const request = await db.requests.byId(requestId);
    if (!request) throw new Halt("request_not_found", 404);
    await requireRole(db, request.stream_id, user, ["owner", "admin"]);
    if (request.status !== "pending") throw new Halt("request_handled", 409);
    const approve = Boolean(body.approve);
    if (request.kind === "human" && approve) {
      await db.members.insert({
        id: newId(), stream_id: request.stream_id, principal_type: "human",
        principal_id: request.applicant_user_id, role: "member", added_by: user.id, joined_at: now(),
      }, { columns: "id" });
    }
    if (request.kind === "agent" && approve) {
      await db.members.insert({
        id: newId(), stream_id: request.stream_id, principal_type: "agent",
        principal_id: request.agent_id, role: "member", added_by: user.id, joined_at: now(),
      }, { columns: "id" });
    }
    await db.requests.claim([["id", requestId], ["status", "pending"]], {
      status: approve ? "approved" : "rejected", handled_by: user.id, handled_at: now(),
    });
    await insertMessage(db, {
      streamId: request.stream_id, senderType: "system", senderId: user.id, senderName: "系统",
      content: approve
        ? `${request.applicant_name ?? "新成员"} 已加入群。`
        : `${request.applicant_name ?? "申请"} 的进群申请被拒绝。`,
    });
    return json({ ok: true, status: approve ? "approved" : "rejected" });
  },

  /** 邀请真实员工：按邮箱落一封含 UUID 的邀请信，对方登录后自行接受。 */
  async "streams.invite"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const stream = await db.streams.byId(streamId, { columns: "id,name" });
    if (!stream) throw new Halt("stream_not_found", 404);
    await requireRole(db, streamId, user, ["owner", "admin"]);
    const invited = emailOf(body.email);
    const existing = await db.requests.first([
      ["stream_id", streamId], ["kind", "invite"], ["applicant_email", invited], ["status", "pending"],
    ]);
    if (existing) return json({ ok: true, duplicate: true });
    const created = await db.requests.insert({
      id: newId(), stream_id: streamId, kind: "invite",
      applicant_user_id: null, applicant_email: invited, applicant_name: null,
      agent_id: null, status: "pending", handled_by: null, handled_at: null,
      created_at: now(), updated_at: now(),
    }, { columns: "id" });
    if (!created) throw new Halt("invite_failed", 503);
    const invitee = await db.users.first([["email", invited]], { columns: "id,email,display_name,at_channel" });
    await deliver({
      db,
      recipientEmail: invited,
      userId: invitee?.id ?? null,
      kind: "invite",
      subject: `你被邀请加入 WorkStream 群「${stream.name}」`,
      body: `${user.display_name} 邀请你加入群「${stream.name}」，群 UUID：${streamId}。登录后在“待办”里接受即可。`,
      link: `#/stream/${streamId}`,
      streamId,
    });
    return json({ ok: true, email: invited });
  },

  async "streams.invites.mine"({ db, user }) {
    const rows = await db.requests.list([["kind", "invite"], ["applicant_email", user.email], ["status", "pending"]], {
      columns: "id,stream_id,created_at", limit: 50,
    });
    const ids = rows.map((r) => r.stream_id);
    const streams = ids.length ? await db.streams.list([["id", ids]], { columns: "id,name,owner_id", limit: 50 }) : [];
    const names = new Map(streams.map((s) => [s.id, s.name]));
    return json({ ok: true, items: rows.map((r) => ({ ...r, stream_name: names.get(r.stream_id) ?? "已删除的群" })) });
  },

  async "streams.invites.accept"({ db, user, body }) {
    const requestId = uuid(body.request_id, "request_id");
    const request = await db.requests.byId(requestId);
    if (!request || request.kind !== "invite" || request.applicant_email !== user.email) {
      throw new Halt("invite_not_found", 404);
    }
    if (request.status !== "pending") throw new Halt("request_handled", 409);
    await db.members.insert({
      id: newId(), stream_id: request.stream_id, principal_type: "human",
      principal_id: user.id, role: "member", added_by: request.handled_by ?? user.id, joined_at: now(),
    }, { columns: "id" });
    await db.requests.claim([["id", requestId], ["status", "pending"]], {
      status: "approved", handled_at: now(),
    });
    return json({ ok: true, stream_id: request.stream_id });
  },

  async "streams.invites.decline"({ db, user, body }) {
    const requestId = uuid(body.request_id, "request_id");
    const request = await db.requests.byId(requestId);
    if (!request || request.kind !== "invite" || request.applicant_email !== user.email) {
      throw new Halt("invite_not_found", 404);
    }
    await db.requests.claim([["id", requestId], ["status", "pending"]], { status: "rejected", handled_at: now() });
    return json({ ok: true });
  },

  /** 把自己的虚拟员工拉进群；别人的员工需要对方本人操作。 */
  async "streams.agents.add"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    await requireMembership(db, streamId, user.id);
    const agent = await db.agents.byId(uuid(body.agent_id, "agent_id"), { columns: AGENT_COLUMNS });
    if (!agent) throw new Halt("agent_not_found", 404);
    if (agent.owner_id !== user.id) throw new Halt("agent_not_owned", 403);
    const exists = await db.members.first([
      ["stream_id", streamId], ["principal_type", "agent"], ["principal_id", agent.id],
    ]);
    if (exists) return json({ ok: true, duplicate: true });
    await db.members.insert({
      id: newId(), stream_id: streamId, principal_type: "agent", principal_id: agent.id,
      role: "member", added_by: user.id, joined_at: now(),
    }, { columns: "id" });
    await insertMessage(db, {
      streamId, senderType: "system", senderId: user.id, senderName: "系统",
      content: `${user.display_name} 把虚拟员工「${agent.name}」拉进了群。`,
    });
    return json({ ok: true, agent: publicAgent(agent) });
  },

  async "streams.members.promote"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const stream = await db.streams.byId(streamId, { columns: "id,owner_id" });
    if (!stream) throw new Halt("stream_not_found", 404);
    if (stream.owner_id !== user.id) throw new Halt("owner_only", 403);
    const membership = await db.members.byId(uuid(body.membership_id, "membership_id"));
    if (!membership || membership.stream_id !== streamId) throw new Halt("member_missing", 404);
    if (membership.principal_type !== "human") throw new Halt("agent_not_promotable", 400);
    const role = oneOf(body.role, ["admin", "member"], "role");
    const updated = await db.members.claim([["id", membership.id]], { role });
    if (!updated) throw new Halt("member_write_failed", 503);
    await insertMessage(db, {
      streamId, senderType: "system", senderId: user.id, senderName: "系统",
      content: role === "admin" ? "成员已被提升为管理员。" : "管理员已被降为普通成员。",
    });
    return json({ ok: true, role });
  },

  async "streams.members.remove"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const { role } = await requireRole(db, streamId, user, ["owner", "admin"]);
    const membership = await db.members.byId(uuid(body.membership_id, "membership_id"));
    if (!membership || membership.stream_id !== streamId) throw new Halt("member_missing", 404);
    if (membership.role === "owner") throw new Halt("owner_immovable", 409);
    if (role === "admin" && (membership.role === "admin" || membership.principal_type === "agent")) {
      throw new Halt("admin_scope", 403);
    }
    if (membership.principal_type === "agent") {
      await db.mail.patch([["stream_id", streamId], ["agent_id", membership.principal_id], ["status", "queued"]], {
        status: "cancelled", error: "member_removed", updated_at: now(),
      });
    }
    await db.members.remove([["id", membership.id]]);
    // 云端 session 是按 (员工,群) 缓存的对话上下文：员工被移出群就把缓存扔掉，
    // 否则他再进群时会带着上一段的云端历史继续聊。
    if (membership.principal_type === "agent") {
      await db.qca_sessions.removeAll([["agent_id", membership.principal_id], ["stream_id", streamId]]);
    }
    await insertMessage(db, {
      streamId, senderType: "system", senderId: user.id, senderName: "系统",
      content: `${membership.principal_type === "agent" ? "虚拟员工" : "成员"}已被移出群。`,
    });
    return json({ ok: true, removed: membership.id });
  },

  async "streams.leave"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const stream = await db.streams.byId(streamId, { columns: "id,owner_id" });
    if (!stream) throw new Halt("stream_not_found", 404);
    if (stream.owner_id === user.id) throw new Halt("owner_must_transfer", 409);
    const membership = await requireMembership(db, streamId, user.id);
    await db.members.remove([["id", membership.id]]);
    return json({ ok: true });
  },

  /**
   * 停用群：把所有入口一次关掉——成员关系、待批的申请与邀请、优先级权重、虚拟机授权、
   * 群记录本身，顺带让这条群钥匙随记录一起失效。
   * 历史消息按保留策略留在库里，但正文先洗掉。
   */
  async "streams.delete"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const stream = await db.streams.byId(streamId, { columns: "id,owner_id" });
    if (!stream) throw new Halt("stream_not_found", 404);
    if (stream.owner_id !== user.id) throw new Halt("owner_only", 403);
    // 排队中的任务先取消，否则群没了、信还在队列里悄悄躺着。
    await db.mail.patch([["stream_id", streamId], ["status", "queued"]], {
      status: "cancelled", error: "stream_closed", updated_at: now(),
    });
    await db.requests.patch([["stream_id", streamId], ["status", "pending"]], {
      status: "rejected", handled_at: now(), updated_at: now(),
    });
    // 读路径按“有没有成员行”放行，所以成员关系必须真删；写 role="removed" 没有读者，等于没停用。
    await db.members.removeAll([["stream_id", streamId]]);
    await db.slice_prefs.removeAll([["stream_id", streamId]]);
    await db.qca_sessions.removeAll([["stream_id", streamId]]);
    await db.stream_vms.removeAll([["stream_id", streamId]]);
    // 正文一律清空：系统提示里也带着文件名与公告正文，按 kind 只清聊天会漏出内容。
    await db.messages.patch([["stream_id", streamId]], {
      content: "[群已删除]", kind: "system", updated_at: now(),
    });
    const removed = await db.streams.remove([["id", streamId], ["owner_id", user.id]]);
    if (!removed) throw new Halt("stream_delete_failed", 503);
    return json({ ok: true, id: removed, note: "群已停用：所有入口关闭，历史消息按保留策略留在库中。" });
  },

  async "files.list"({ db, user, params }) {
    const streamId = uuid(params.get("stream_id"), "stream_id");
    await requireMembership(db, streamId, user.id);
    const rows = await db.files.list([["stream_id", streamId]], { columns: FILE_COLUMNS, order: ["created_at", { ascending: false }], limit: 200 });
    const owners = await db.users.list([["id", rows.map((r) => r.uploaded_by)]], { columns: "id,display_name", limit: 200 });
    const names = new Map(owners.map((o) => [o.id, o.display_name]));
    return json({ ok: true, items: rows.map((r) => ({ ...r, uploaded_name: names.get(r.uploaded_by) ?? "未知" })) });
  },

  async "files.upload"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    await requireMembership(db, streamId, user.id);
    const file = await createGroupFile(db, {
      streamId,
      userId: user.id,
      userName: user.display_name,
      name: body.name,
      contentType: body.content_type ?? "text/plain",
      content: body.content,
    });
    return json({ ok: true, file });
  },

  async "files.get"({ db, user, params }) {
    const id = uuid(params.get("id"), "id");
    const file = await db.files.byId(id);
    if (!file) throw new Halt("file_not_found", 404);
    await requireMembership(db, file.stream_id, user.id);
    if (file.store === "storage") {
      const signed = await signDownload(file.object_path);
      if (signed) return json({ ok: true, name: file.name, content_type: file.content_type, signed_url: signed });
    }
    return json({
      ok: true, name: file.name, content_type: file.content_type,
      size_bytes: file.size_bytes, content: file.content ?? "",
    });
  },

  async "files.delete"({ db, user, body }) {
    const id = uuid(body.id, "id");
    const file = await db.files.byId(id);
    if (!file) throw new Halt("file_not_found", 404);
    const { role } = await requireMembership(db, file.stream_id, user.id);
    const removed = await deleteGroupFile(db, { file, userId: user.id, role });
    return json({ ok: true, id: removed });
  },
};

let storageModule;
async function storage() {
  if (storageModule === undefined) {
    try {
      storageModule = (await import("./_qoder/storage.mjs")).storage ?? null;
    } catch {
      storageModule = null; // 本机没有平台 Storage 注入，群文件走数据库文本列。
    }
  }
  return storageModule;
}

async function signDownload(objectPath) {
  const client = await storage();
  if (!client || !objectPath) return null;
  try {
    const result = await client.createSignedUrl(objectPath, 300);
    return result?.signedUrl ?? null;
  } catch {
    return null;
  }
}

async function removeStorage(objectPath) {
  const client = await storage();
  if (!client || !objectPath) return;
  try {
    await client.remove([objectPath]);
  } catch {
    // 删除失败不阻塞记录移除；孤立对象由后端管理面回收。
  }
}
