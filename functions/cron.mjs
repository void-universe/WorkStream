// 排程：虚拟员工按时刻表自己醒来干活，不等人 @。
//
// 为什么把时钟只记在 next_run_at 一列：到点判定要么"到点翻牌"（需要一个常驻进程保证那次写入发生，
// 没有它就会出现"停不掉"的状态），要么"每次现算"。这里选现算——扫到期时读出 next_run_at，
// 跟当前时刻一比就知道欠了几个对点，欠几个也只投一封。没有第二个真值源就没有能对不上的地方。
//
// 为什么投递要带 CAS：同一个到期行会被多个驱动同时看见（浏览器每 5 秒轮询、常驻 worker、
// 多实例的 Function），推进时钟的条件写成"我读到的那个值还没被人动过"，就只能有一个赢；
// 输的那个直接跳过，不"退而求其次"去投第二封——否则群里同一件事会被念好几遍。
import { requireMembership } from "./perm.mjs";
import { streamWeight } from "./chat.mjs";
import { DREAM_PURPOSE, dreamingPending, normalizePurpose } from "./dream.mjs";
import { Halt, int, json, newId, now, oneOf, text, uuid } from "./util.mjs";

const KINDS = ["every", "daily"];
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** 最短间隔 1 分钟：排程是"主动干活"，不是往群里灌消息的定时器。 */
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
/** 墙钟偏移范围：UTC-12 到 UTC+14，覆盖现实里有人在用的那一段。 */
const MIN_TZ_OFFSET = -12 * 60;
const MAX_TZ_OFFSET = 14 * 60;
/** 一个主人最多挂 20 条排程：扫描按 (owner_id, next_run_at) 走索引，上限让最坏一轮的开销有界。 */
const MAX_PER_OWNER = 20;
/**
 * 追补步数上限：等长周期用算术一次算完，带周几过滤的每天型只能一步步走。
 * 走到上限就把时钟重新锚到"现在之后的第一个对点"，更早的不补——刚上线就连着几轮全在补历史，
 * 群里的同事看到的是一串迟到的旧任务，比丢掉一段没人看的排程更糟。
 */
const MAX_CATCHUP = 500;

export const SCHEDULE_COLUMNS = "id,owner_id,agent_id,stream_id,name,instruction,kind,purpose,"
  + "interval_minutes,at_time,weekdays,tz_offset_minutes,next_run_at,last_run_at,merged_runs,created_at,updated_at";

/* ---------- 到时计算：全部是纯函数，入口校验过，这里只信已入库的形状 ---------- */

/** 把规格列折成计算用的形状。atMs 是"每天几点"在那一天的偏移毫秒数，只有 daily 用得上。 */
function specOf(row) {
  const daily = row.kind === "daily";
  return {
    kind: row.kind,
    intervalMs: daily ? 0 : Number(row.interval_minutes ?? 0) * MINUTE_MS,
    atMs: daily ? clockToMs(row.at_time) : 0,
    weekdays: daily && Array.isArray(row.weekdays) && row.weekdays.length
      ? new Set(row.weekdays.map(Number))
      : null,
    offsetMs: daily ? Number(row.tz_offset_minutes ?? 0) * MINUTE_MS : 0,
  };
}

/** "HH:MM" → 当天零点起的毫秒；格式不对当场炸，不让它算出一个悄悄错两小时的排程。 */
export function clockToMs(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) throw new Halt("invalid_at_time", 400);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Halt("invalid_at_time", 400);
  return (hour * 60 + minute) * MINUTE_MS;
}

/** ISO 周几（周一=1 … 周日=7）：把"当地墙钟毫秒"当成 UTC 读，偏移已经在上一步加过了。 */
const isoDay = (localMs) => {
  const dow = new Date(localMs).getUTCDay();
  return dow === 0 ? 7 : dow;
};

/** 严格晚于 givenMs 的下一个对点。 */
export function nextOccurrence(spec, givenMs) {
  if (spec.kind === "every") return givenMs + spec.intervalMs;
  const localNow = givenMs + spec.offsetMs;
  const midnight = Math.floor(localNow / DAY_MS) * DAY_MS;
  // 从今天起最多再数 8 天一定落进允许的周几（weekdays 非空且 ≤7，入口保证）。
  for (let day = 0; day <= 7; day += 1) {
    const local = midnight + spec.atMs + day * DAY_MS;
    if (spec.weekdays && !spec.weekdays.has(isoDay(local))) continue;
    if (local > localNow) return local - spec.offsetMs;
  }
  throw new Halt("daily_schedule_unreachable", 500);
}

/**
 * 到点判定与追补：这个排程在 nowMs 之前欠了几个对点。
 * 欠几个都只投一封（合并语义）：掉线三天回来，群里要的是一次"这三天有什么要紧事"，不是三千封补投。
 * 返回的 dueAt 是最后一个真正欠着的对点，nextRunAt 是推上去之后的时钟。
 */
export function catchUp(row, nowMs) {
  const target = Date.parse(row.next_run_at ?? "");
  if (!Number.isFinite(target) || target > nowMs) return null;
  const spec = specOf(row);
  if (spec.kind === "every") {
    const runs = 1 + Math.floor((nowMs - target) / spec.intervalMs);
    const lastBoundary = target + (runs - 1) * spec.intervalMs;
    return { runs, dueAt: lastBoundary, nextRunAt: lastBoundary + spec.intervalMs };
  }
  let last = target;
  let runs = 0;
  for (;;) {
    runs += 1;
    const following = nextOccurrence(spec, last);
    if (following > nowMs) return { runs, dueAt: last, nextRunAt: following };
    if (runs >= MAX_CATCHUP) return { runs, dueAt: last, nextRunAt: nextOccurrence(spec, nowMs) };
    last = following;
  }
}

/* ---------- 扫描与投递 ---------- */

/**
 * 往后几个对点：从这一行自己的时钟一步步走，不拿"现在"重锚。
 * 按现在重锚会把每半小时那条说成 10:37、11:07，而它真实会醒在 10:30、11:00——
 * 界面上的"下一次"差一分钟都不该差，差了就没人再信这个表。
 */
export function upcomingOccurrences(row, count = 3) {
  if (!row.next_run_at) return [];
  const spec = specOf(row);
  const out = [];
  let cursor = Date.parse(row.next_run_at);
  for (let step = 0; step < count && Number.isFinite(cursor); step += 1) {
    out.push(new Date(cursor).toISOString());
    cursor = nextOccurrence(spec, cursor);
  }
  return out;
}

/** 到期行：next_run_at 已经落在 nowMs 之前。走 (owner_id, next_run_at) 索引，不给无界扫留入口。 */
async function dueSchedules(db, { ownerId, nowMs, limit }) {
  let query = db.client.from("schedules").select(SCHEDULE_COLUMNS)
    .lte("next_run_at", new Date(nowMs).toISOString());
  if (ownerId) query = query.eq("owner_id", ownerId);
  const result = await query.order("next_run_at", { ascending: true }).limit(limit);
  if (result.error) throw new Halt("schedules_request_failed", 503, { code: result.error.code });
  return Array.isArray(result.data) ? result.data : [];
}

/** 哪些主人有到期的排程：worker 空闲（一封排队信都没有）时也得有活可干，否则排程永远不醒。 */
export async function dueOwnerIds(db, { nowMs = Date.now(), limit = 50 } = {}) {
  const rows = await dueSchedules(db, { ownerId: null, nowMs, limit });
  return [...new Set(rows.map((row) => String(row.owner_id)).filter(Boolean))];
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * 这个排程是否已经有一封还没跑完的信：有就把新欠的对点并进它，不另起一封。
 * 信的种类跟着排程的 purpose 走（普通排程投 cron 信，做梦排程投归并信），
 * 两边读同一个判定，否则一条做梦排程能在队里堆出好几封归并信。
 */
async function cronMailPending(db, { agentId, streamId, scheduleId, kind = "cron" }) {
  const rows = await db.mail.list([
    ["agent_id", agentId], ["stream_id", streamId], ["status", ["queued", "running"]],
  ], { columns: "id,meta", limit: 60 });
  return rows.some((row) => row.meta?.kind === kind && String(row.meta?.schedule_id ?? "") === String(scheduleId));
}

/**
 * 扫某个主人名下到期的排程并投递。返回每一条的观察结果（投了信、并进了旧信、或因为员工退群而暂停），
 * 全部原样带进 scheduler.tick 的响应——出错时不静默回滚也不静默丢，看的人能一眼对上是哪条排程。
 */
export async function fireDueSchedules(db, { ownerId, nowMs = Date.now(), limit = 20 }) {
  const outcomes = [];
  for (const row of await dueSchedules(db, { ownerId, nowMs, limit })) {
    const plan = catchUp(row, nowMs);
    if (!plan) continue;
    const inStream = await db.members.first(
      [["stream_id", row.stream_id], ["principal_type", "agent"], ["principal_id", row.agent_id]],
      { columns: "id" },
    );
    if (!inStream) {
      // 员工已经不在群里：这条排程不可能再跑成，CAS 把时钟写成"暂停"而不是继续推进，
      // 免得每到一个对点就白扫一次。恢复要由主人重新排——界面上一条自己停掉的排程不该装作还在跑。
      const paused = await db.schedules.claim([["id", row.id], ["next_run_at", row.next_run_at]], {
        next_run_at: null,
      });
      outcomes.push({ schedule_id: row.id, agent_id: row.agent_id, stream_id: row.stream_id, paused: Boolean(paused), reason: "agent_not_in_stream" });
      continue;
    }
    // 做梦排程和普通排程共用这一个时钟，只差投出去的那封信是哪一种：
    // 归并那一轮不看群里的转录、也不往群里说话，所以它必须是独立的一种信。
    const letterKind = row.purpose === DREAM_PURPOSE ? "dreaming" : "cron";
    // 归并那一种按「主人」去重而不是按 (员工, 群, 排程)：全局记忆一个主人只有一行，
    // 同一个主人手上已经有一封没跑完的归并信时，这条排程到点也只是又欠了一个对点。
    const folded = letterKind === "dreaming"
      ? await dreamingPending(db, row.owner_id)
      : await cronMailPending(db, {
        agentId: row.agent_id, streamId: row.stream_id, scheduleId: row.id, kind: letterKind,
      });
    // 已经投出的那封算一次，被并进旧信的对点全记进合并计数：界面上要能看出"这一轮替我少发了几条"。
    // 推进的实参逐字写出：dev/check-schema.mjs 认得出对象字面量的键，传一个变量进去这张表的
    // "NOT NULL 列有没有人写"就对不上账了。
    const advancedNext = iso(plan.nextRunAt);
    const won = await db.schedules.claim([["id", row.id], ["next_run_at", row.next_run_at]], {
      next_run_at: advancedNext,
      last_run_at: iso(plan.dueAt),
      merged_runs: Number(row.merged_runs ?? 0) + (folded ? plan.runs : plan.runs - 1),
      updated_at: now(),
    });
    if (!won) continue; // 另一个驱动抢先推了时钟，这一轮的同一对点不再投第二封。
    if (folded) {
      outcomes.push({ schedule_id: row.id, agent_id: row.agent_id, stream_id: row.stream_id, runs: plan.runs, merged_into_pending: true });
      continue;
    }
    try {
      const mail = await db.mail.insert({
        id: newId(), agent_id: row.agent_id, stream_id: row.stream_id, message_id: null,
        trigger_seq: 0, priority: await streamWeight(db, row.agent_id, row.stream_id),
        status: "queued", slice_count: 0, error: null,
        created_at: now(), started_at: null, finished_at: null, updated_at: now(),
        meta: {
          kind: letterKind,
          schedule_id: row.id,
          // 归并的信要记下是谁叫醒的：界面上「上一次归并」读这个字段，手动和定时得能分开。
          ...(letterKind === "dreaming" ? { reason: "cron" } : {}),
          // 归并那一轮的额外要求要在这封信里就能复原：轨迹读的是 meta，不回查排程行。
          [letterKind === "dreaming" ? "dreaming" : "cron"]: {
            name: row.name,
            instruction: row.instruction,
            // 到点时刻与欠的对点数进了信里，这一轮模型看到什么就能从这封信复原，不用回查排程行。
            due_at: iso(plan.dueAt),
            runs: plan.runs,
            merged: plan.runs - 1,
          },
        },
      }, { columns: "id" });
      outcomes.push({ schedule_id: row.id, agent_id: row.agent_id, stream_id: row.stream_id, runs: plan.runs, mail_id: mail?.id ?? null });
    } catch (error) {
      // 信没投出去，时钟也不能白走：回拨到自己刚读到的那个值，下一轮重新判到点。
      // 回拨的条件是"推进后的那个值还在"，所以不会把别的驱动这一轮刚推的时钟盖掉。
      await db.schedules.claim([["id", row.id], ["next_run_at", advancedNext]], {
        next_run_at: row.next_run_at, last_run_at: row.last_run_at, merged_runs: Number(row.merged_runs ?? 0),
      });
      outcomes.push({ schedule_id: row.id, agent_id: row.agent_id, stream_id: row.stream_id, error: String(error?.error ?? "cron_mail_write_failed") });
    }
  }
  return outcomes;
}

/* ---------- 入参校验 ---------- */

function specFromBody(body) {
  const kind = oneOf(body.kind, KINDS, "kind");
  if (kind === "every") {
    const minutes = int(body.interval_minutes, {
      min: MIN_INTERVAL_MINUTES, max: MAX_INTERVAL_MINUTES, name: "interval_minutes",
    });
    return { kind, interval_minutes: minutes, at_time: null, weekdays: null, tz_offset_minutes: null };
  }
  const atTime = text(body.at_time, { max: 5, name: "at_time" });
  clockToMs(atTime); // 形状已在上面校验，这里只是把不合法的 HH:MM 在入库前炸掉。
  const offset = int(body.tz_offset_minutes, {
    min: MIN_TZ_OFFSET, max: MAX_TZ_OFFSET, name: "tz_offset_minutes",
  });
  let weekdays = null;
  if (Array.isArray(body.weekdays) && body.weekdays.length) {
    const set = new Set();
    for (const value of body.weekdays) {
      set.add(int(value, { min: 1, max: 7, name: "weekdays" }));
    }
    weekdays = [...set].sort((a, b) => a - b);
  }
  return { kind, interval_minutes: null, at_time: atTime, weekdays, tz_offset_minutes: offset };
}

async function ownedSchedule(db, user, id) {
  const row = await db.schedules.byId(uuid(id, "id"), { columns: SCHEDULE_COLUMNS });
  if (!row) throw new Halt("schedule_not_found", 404);
  if (row.owner_id !== user.id) throw new Halt("schedule_not_owned", 403);
  return row;
}

/** 排程只能是主人给自己名下的员工、在自己所在的群里排：借别人的员工排班等于烧别人的 Key。 */
async function assertRunnable(db, user, agentId, streamId) {
  const agent = await db.agents.byId(agentId, { columns: "id,name,owner_id,status" });
  if (!agent) throw new Halt("agent_not_found", 404);
  if (agent.owner_id !== user.id) throw new Halt("agent_not_owned", 403);
  await requireMembership(db, streamId, user.id);
  const inStream = await db.members.first(
    [["stream_id", streamId], ["principal_type", "agent"], ["principal_id", agent.id]],
    { columns: "id" },
  );
  if (!inStream) throw new Halt("agent_not_in_stream", 400);
  return agent;
}

export const actions = {
  /** 主人看自己名下的排程；可按员工或群过滤。每条带上往后三个对点，界面上"下一次"要能自证口径。 */
  async "cron.list"({ db, user, params }) {
    const agentId = params.get("agent_id") ? uuid(params.get("agent_id"), "agent_id") : null;
    const streamId = params.get("stream_id") ? uuid(params.get("stream_id"), "stream_id") : null;
    const pairs = [["owner_id", user.id]];
    if (agentId) pairs.push(["agent_id", agentId]);
    if (streamId) pairs.push(["stream_id", streamId]);
    const rows = await db.schedules.list(pairs, {
      columns: SCHEDULE_COLUMNS, order: ["created_at", { ascending: true }], limit: MAX_PER_OWNER,
    });
    const items = rows.map((row) => ({
      ...row,
      upcoming: upcomingOccurrences(row),
    }));
    return json({ ok: true, items, limits: { max_per_owner: MAX_PER_OWNER, min_interval_minutes: MIN_INTERVAL_MINUTES } });
  },

  /**
   * 建或改一条排程。改规格时把时钟重新锚到"现在之后的第一个对点"：
   * 从 30 分钟改成 2 小时应当立刻按新节奏走，而不是继续沿旧锚点补完剩下的历史。
   */
  async "cron.set"({ db, user, body }) {
    const name = text(body.name, { max: 60, name: "name" });
    // purpose 决定这封信是"干活"还是"归并全局记忆"，和员工/群一样属于排程的目标：
    // 建好之后改它会让同一条排程忽然换一种活法，界面上看不出来——要换就删了重建。
    const purpose = normalizePurpose(body.purpose);
    // 归并那一轮的素材是各群的摘要，不是这句话，所以它只是额外交代，允许留空；
    // 干活的那条仍然必填——空正文等于让模型在群里说没话说。
    const instruction = text(body.instruction, { max: 2000, required: purpose !== DREAM_PURPOSE, name: "instruction" });
    const agentId = uuid(body.agent_id, "agent_id");
    const streamId = uuid(body.stream_id, "stream_id");
    const spec = specFromBody(body);
    await assertRunnable(db, user, agentId, streamId);
    const id = body.id ? uuid(body.id, "id") : null;
    const existing = id ? await ownedSchedule(db, user, id) : null;
    if (id && (existing.agent_id !== agentId || existing.stream_id !== streamId
      || (existing.purpose ?? null) !== purpose)) {
      throw new Halt("schedule_target_locked", 400);
    }
    if (!existing) {
      const count = await db.schedules.total([["owner_id", user.id]], { columns: "id" });
      if (count >= MAX_PER_OWNER) throw new Halt("too_many_schedules", 409);
    }
    // 暂停态在改规格之后仍是暂停：改文本不该替用户把一个他亲手停掉的排程打开。
    const paused = Boolean(existing) && existing.next_run_at === null;
    const nextRunAt = paused ? null : iso(nextOccurrence(specOf(spec), Date.now()));
    // 两处写入的实参全部逐字列出：dev/check-schema.mjs 靠它核对"迁移里 NOT NULL 的列是不是真有写入路径"，
    // 把实参收进一个变量再传进去，这张表的这道门就关掉了。
    const row = existing
      ? await db.schedules.patch([["id", existing.id]], {
        kind: spec.kind,
        purpose,
        interval_minutes: spec.interval_minutes,
        at_time: spec.at_time,
        weekdays: spec.weekdays,
        tz_offset_minutes: spec.tz_offset_minutes,
        name,
        instruction,
        owner_id: user.id,
        agent_id: agentId,
        stream_id: streamId,
        next_run_at: nextRunAt,
        updated_at: now(),
      }, { returning: true })
      : (await db.schedules.insert({
        id: newId(),
        owner_id: user.id,
        agent_id: agentId,
        stream_id: streamId,
        name,
        instruction,
        kind: spec.kind,
        purpose,
        interval_minutes: spec.interval_minutes,
        at_time: spec.at_time,
        weekdays: spec.weekdays,
        tz_offset_minutes: spec.tz_offset_minutes,
        next_run_at: nextRunAt,
        last_run_at: null,
        merged_runs: 0,
        created_at: now(),
        updated_at: now(),
      }, { columns: "id" }))?.id;
    if (!row) throw new Halt("schedule_write_failed", 503);
    const saved = await db.schedules.byId(existing ? existing.id : row, { columns: SCHEDULE_COLUMNS });
    return json({ ok: true, schedule: saved });
  },

  /** 暂停：把时钟写空，不删规格——恢复要按原规格重算，不是拿一份空壳让用户重填。 */
  async "cron.pause"({ db, user, body }) {
    const row = await ownedSchedule(db, user, body.id);
    await db.schedules.claim([["id", row.id], ["next_run_at", row.next_run_at]], {
      next_run_at: null, updated_at: now(),
    });
    return json({ ok: true, id: row.id, next_run_at: null });
  },

  /** 恢复：从"现在之后第一个对点"重新开始，暂停期间欠掉的不补——补一堆迟到的旧任务不是用户想要的。 */
  async "cron.resume"({ db, user, body }) {
    const row = await ownedSchedule(db, user, body.id);
    const nextRunAt = iso(nextOccurrence(specOf(row), Date.now()));
    const claimed = await db.schedules.claim([["id", row.id], ["next_run_at", row.next_run_at]], {
      next_run_at: nextRunAt, updated_at: now(),
    });
    if (!claimed) throw new Halt("schedule_changed", 409);
    return json({ ok: true, id: row.id, next_run_at: nextRunAt });
  },

  async "cron.delete"({ db, user, body }) {
    const row = await ownedSchedule(db, user, body.id);
    const removed = await db.schedules.remove([["id", row.id], ["owner_id", user.id]]);
    if (!removed) throw new Halt("schedule_delete_failed", 503);
    // 已经投出去、还排在队里的那一封一起撤：用户删的是排程，不是"以后不排、这一下照旧跑"。
    // 只按 (员工,群) 撤会把同事刚 @ 出去的任务一起杀掉，所以要挑出 meta 里带着这条排程的逐封撤。
    const pending = await db.mail.list([
      ["agent_id", row.agent_id], ["stream_id", row.stream_id], ["status", "queued"],
    ], { columns: "id,meta", limit: 100 });
    let cancelled = 0;
    for (const mail of pending) {
      // 做梦排程投的是 dreaming 信：删排程同样要撤回它那封还没跑的信，种类不同不代表可以留下。
      const kindOfLetter = mail.meta?.kind === "cron" || mail.meta?.kind === "dreaming";
      if (!kindOfLetter || String(mail.meta?.schedule_id ?? "") !== String(row.id)) continue;
      // 只撤 queued：正在生成的那一封让它跑完，掐断是 scheduler.interrupt 的活，删排程不该越权掐人。
      const claimed = await db.mail.claim([["id", mail.id], ["status", "queued"]], {
        status: "cancelled", error: "schedule_deleted",
      });
      if (claimed) cancelled += 1;
    }
    return json({ ok: true, id: row.id, cancelled });
  },
};
