// 替身：真人不在时，冲 ta 来的 @ 由 ta 指定的一个虚拟员工接住并代 ta 回应。
//
// 为什么班表挂在账号、群内只放覆盖：真人离开是全局状态，不是每个群各离开一次；
// 但"这个群要、那个群不要"确实存在，所以覆盖只需要 mode 一个字段。
// 为什么按时钟判定而不是到点翻牌：翻牌需要一个常驻进程保证那次写入发生，
// 没有它，时段结束后的替身会永远停在开启态——派发时算一次，就没有这种状态需要维护。
import { requireMembership } from "./perm.mjs";
import { Halt, json, newId, now, oneOf, text, uuid } from "./util.mjs";

const MODES = ["off", "now", "window"];
const STREAM_MODES = ["inherit", "on", "off"];
/** 班表最远只能排到 90 天后：排到明年这个时候的替身，没人会记得自己开过。 */
const MAX_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;

/** 入参是 ISO 串或空；空按 null 存，非空必须是能解析的时刻。 */
function stamp(value, name) {
  if (value === null || value === undefined || value === "") return null;
  const raw = text(value, { max: 40, name });
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) throw new Halt(`invalid_${name}`, 400, { field: name });
  return new Date(at).toISOString();
}

/**
 * 生效判定：纯函数，好测也好让派发路径和界面用同一把尺子。
 * `scheduled` 是班表上有没有排员工；`mode` 是本群的覆盖；窗口的两端都可以为空。
 * 返回的 reason 在放行时是 null，其余都是能原样说给用户听的原因码。
 */
export function delegateWindow({ mode, scheduled, startAt, endAt, atMs }) {
  if (mode === "off") return { active: false, reason: "stream_off" };
  if (!scheduled && mode !== "on") return { active: false, reason: "not_enabled" };
  const start = Date.parse(startAt ?? "");
  const end = Date.parse(endAt ?? "");
  if (Number.isFinite(start) && atMs < start) return { active: false, reason: "not_started" };
  if (Number.isFinite(end) && atMs >= end) return { active: false, reason: "expired" };
  return { active: true, reason: null };
}

/** 把账号班表 + 本群覆盖合成一次判定，并校验替身员工当下确实能用。 */
export async function resolveDelegate(db, { human, streamId, atMs = Date.now() }) {
  const membership = await db.members.first(
    [["stream_id", streamId], ["principal_type", "human"], ["principal_id", human.id]],
    { columns: "id,delegate_mode,delegate_agent_id" },
  );
  const mode = membership?.delegate_mode ?? "inherit";
  const agentId = membership?.delegate_agent_id ?? human.delegate_agent_id ?? null;
  const base = { mode, agent_id: agentId, override_agent_id: membership?.delegate_agent_id ?? null };
  const scheduled = Boolean(human.delegate_agent_id);
  const window = delegateWindow({
    mode,
    scheduled,
    startAt: human.delegate_start_at,
    endAt: human.delegate_end_at,
    atMs,
  });
  if (!window.active) return { ...base, active: false, reason: window.reason, agent: null };

  if (!agentId) return { ...base, active: false, reason: "no_agent", agent: null };
  const agent = await db.agents.byId(agentId, { columns: "id,name,status,owner_id,backend" });
  if (!agent) return { ...base, active: false, reason: "agent_missing", agent: null };
  // 替身必须是本人名下的员工：借别人的员工代自己说话，等于让第三方读你的群上下文。
  if (agent.owner_id !== human.id) return { ...base, active: false, reason: "agent_not_owned", agent: null };
  if (agent.status !== "active") return { ...base, active: false, reason: "agent_paused", agent: null };
  const inStream = await db.members.first(
    [["stream_id", streamId], ["principal_type", "agent"], ["principal_id", agent.id]],
    { columns: "id" },
  );
  if (!inStream) return { ...base, active: false, reason: "agent_not_in_stream", agent: null };
  return { ...base, active: true, reason: null, agent };
}

/** 群现场要显示的替身状态：本群覆盖、账号班表、当下是否真生效。 */
export async function delegateStatus(db, { human, streamId }) {
  const resolved = await resolveDelegate(db, { human, streamId });
  return {
    mode: resolved.mode,
    agent_id: resolved.agent_id,
    agent_name: resolved.agent?.name ?? null,
    active: resolved.active,
    reason: resolved.reason,
    schedule: {
      agent_id: human.delegate_agent_id ?? null,
      start_at: human.delegate_start_at ?? null,
      end_at: human.delegate_end_at ?? null,
    },
  };
}

/**
 * 冲某个真人来的 @：照旧给真人投递通知（替身代答不等于替身代收），
 * 班表生效时再给替身落一封任务。skipAgents 用于挡住"同一条消息既 @ 真人又 @ ta 的替身"时的双份。
 */
export async function queueDelegateMail(db, { human, streamId, message, weight, skipAgents, senderId }) {
  if (!human || human.id === senderId) return null;
  const resolved = await resolveDelegate(db, { human, streamId });
  const outcome = (active, reason, agent) => ({
    user_id: human.id,
    user_name: human.display_name,
    active,
    reason,
    agent_id: agent?.id ?? null,
    agent_name: agent?.name ?? null,
  });
  if (!resolved.active) return outcome(false, resolved.reason, null);
  if (skipAgents?.has(resolved.agent.id)) return outcome(false, "already_queued", null);
  await db.mail.insert({
    id: newId(),
    agent_id: resolved.agent.id,
    stream_id: streamId,
    message_id: message.id,
    trigger_seq: message.seq,
    priority: await weight(resolved.agent.id),
    status: "queued",
    slice_count: 0,
    error: null,
    created_at: now(),
    started_at: null,
    finished_at: null,
    updated_at: now(),
    meta: { on_behalf_of: human.id },
  }, { columns: "id" });
  return outcome(true, null, resolved.agent);
}

export const actions = {
  /** 账号级班表：关闭 / 立即 / 时间段。只写自己那一行。 */
  async "delegate.set"({ db, user, body }) {
    const mode = oneOf(body.mode, MODES, "mode");
    let agentId = null;
    let startAt = null;
    let endAt = null;
    if (mode !== "off") {
      agentId = uuid(body.agent_id, "agent_id");
      const agent = await db.agents.byId(agentId, { columns: "id,name,status,owner_id" });
      if (!agent) throw new Halt("agent_not_found", 404);
      if (agent.owner_id !== user.id) throw new Halt("agent_not_owned", 403);
      if (mode === "window") {
        startAt = stamp(body.start_at, "start_at");
        endAt = stamp(body.end_at, "end_at");
        if (!startAt && !endAt) throw new Halt("window_needs_bounds", 400);
        if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) throw new Halt("window_inverted", 400);
        if (startAt && Date.parse(startAt) > Date.now() + MAX_AHEAD_MS) throw new Halt("window_too_far_ahead", 400);
      }
    }
    await db.users.patch([["id", user.id]], {
      delegate_agent_id: agentId,
      delegate_start_at: startAt,
      delegate_end_at: endAt,
      updated_at: now(),
    });
    return json({ ok: true, delegate: { mode, agent_id: agentId, start_at: startAt, end_at: endAt } });
  },

  /** 群内覆盖：跟随全局 / 只在本群开 / 本群关。只改自己那条成员记录，动不了别人的。 */
  async "delegate.stream"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const mode = oneOf(body.mode, STREAM_MODES, "mode");
    const membership = await requireMembership(db, streamId, user.id);
    let agentId = null;
    if (mode === "on" && body.agent_id) {
      agentId = uuid(body.agent_id, "agent_id");
      const agent = await db.agents.byId(agentId, { columns: "id,owner_id" });
      if (!agent) throw new Halt("agent_not_found", 404);
      if (agent.owner_id !== user.id) throw new Halt("agent_not_owned", 403);
    }
    const updated = await db.members.patch(
      [["id", membership.id]],
      { delegate_mode: mode === "inherit" ? null : mode, delegate_agent_id: agentId, updated_at: now() },
      { returning: true },
    );
    if (!updated) throw new Halt("delegate_write_failed", 503);
    const row = await db.users.byId(user.id, {
      columns: "id,delegate_agent_id,delegate_start_at,delegate_end_at",
    });
    const resolved = await resolveDelegate(db, { human: row, streamId });
    return json({
      ok: true,
      mode,
      agent_id: agentId,
      active: resolved.active,
      reason: resolved.reason,
      agent_name: resolved.agent?.name ?? null,
    });
  },
};
