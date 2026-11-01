// 群内角色的判定：群主 > 管理员 > 成员；虚拟员工按“其主人在群内的角色”取得授权。
import { Halt } from "./util.mjs";

export const STREAM_COLUMNS =
  "id,name,owner_id,join_policy,announcement,announcement_at,context_chars,next_seq,mcp_key_set,created_at,updated_at";

export async function loadStream(db, id) {
  const row = await db.streams.byId(id);
  if (!row) throw new Halt("stream_not_found", 404);
  return row;
}

export async function humanMembership(db, streamId, userId) {
  return db.members.first([
    ["stream_id", streamId],
    ["principal_type", "human"],
    ["principal_id", userId],
  ]);
}

export async function requireMembership(db, streamId, userId) {
  const membership = await humanMembership(db, streamId, userId);
  if (!membership) throw new Halt("not_stream_member", 403);
  return membership;
}

/** 只有 roles 里列出的角色才放行；群主成员记录 role 即为 owner。 */
export async function requireRole(db, streamId, user, roles) {
  const membership = await requireMembership(db, streamId, user.id);
  if (roles.includes(membership.role)) return { membership, role: membership.role };
  throw new Halt("permission_denied", 403, { need: roles });
}

export async function requireStreamOwner(db, stream, user) {
  if (stream.owner_id !== user.id) throw new Halt("owner_only", 403);
  return { membership: await requireMembership(db, stream.id, user.id), role: "owner" };
}

/** 虚拟员工在群内是否可用：其主人必须是群成员。 */
export async function agentUsable(db, agent, streamId) {
  const membership = await humanMembership(db, streamId, agent.owner_id);
  return Boolean(membership);
}

export const canManageMembers = (role) => role === "owner" || role === "admin";
