// 调度与虚拟员工执行引擎：邮箱 FIFO + 按权重的时间片、上下文压缩、MCP 工具回路。
import { AGENT_COLUMNS, AGENT_SECRET_COLUMNS, completeForAgent, publicAgent } from "./agents.mjs";
import { armInterrupt, disarmInterrupt, fireInterrupt } from "./bus.mjs";
import { shapeMessage, streamWeight } from "./chat.mjs";
import { queueDelegateMail } from "./delegate.mjs";
import { executeTool, INTERNAL_TOOL_NAMES, toolDefinitions } from "./mcp.mjs";
import { connectorToolDefs } from "./plugins.mjs";
import { composeAsk, composeSystemPrompt, isCloudBackend } from "./prompt.mjs";
import { open } from "./sec.mjs";
import { insertMessage, nextSeq } from "./rooms.mjs";
import { requireMembership } from "./perm.mjs";
import { skillPrompt } from "./skills.mjs";
import { closeOrphanSteps, createStepWriter } from "./steps.mjs";
import { renderTranscript, rowChars } from "./transcript.mjs";
import { CONTEXT_CHARS_DEFAULT, Halt, Interrupted, json, newId, now, text, truncate, uuid } from "./util.mjs";

const TOOL_DEFINITIONS = toolDefinitions();

export const actions = {
  /**
   * 时间片推进：一次 tick 给每个有活儿的虚拟员工分配若干任务槽，
   * 槽位按该员工在各群里的权重（默认均分）用最大余数法分配，群内按 FIFO 取件。
   * 站点 Function 不能常驻后台，因此由前端轮询驱动；任务一旦开始仍会被插话/叫停抢占：
   * 同进程走 interrupt 总线即时点火，跨进程由 400ms 的邮箱轮询兜底。
   */
  async "scheduler.tick"({ db, user, env, params }) {
    const since = Number(params.get("since") ?? 0);
    const mine = await db.members.list([
      ["principal_type", "human"], ["principal_id", user.id],
    ], { columns: "stream_id", limit: 300 });
    const streamIds = mine.map((m) => m.stream_id);
    if (!streamIds.length) return json({ ok: true, ran: [], queued: 0, since });
    const myAgents = await db.agents.list([["owner_id", user.id]], { columns: "id,name", limit: 60 });
    const agentIds = myAgents.map((a) => a.id);
    if (!agentIds.length) return json({ ok: true, ran: [], queued: 0, since });

    const queuedAll = await db.mail.list([
      ["agent_id", agentIds], ["stream_id", streamIds], ["status", "queued"],
    ], {
      columns: "id,agent_id,stream_id,message_id,trigger_seq,priority,created_at,status,priority,slice_count,meta",
      order: ["created_at", { ascending: true }], limit: 200,
    });
    await reapStale(db);
    if (!queuedAll.length) return json({ ok: true, ran: [], queued: 0, since });

    // 同一个 (员工, 群) 一轮只放最早的一封：并发跑两封，后一封的上下文里就没有前一封的回复，落群顺序还会倒置。
    // 认领是 queued→running 的单行 CAS，两轮同时看上同一封时只有一轮赢；输的那轮直接跳过、不退而求其次，
    // 所以这条规则连跨进程（多个 Function 实例、前端轮询与 worker 并行）的并发一起挡住。
    const running = await db.mail.list([["status", "running"]], {
      columns: "agent_id,stream_id", limit: 100,
    });
    const taken = new Set(running.map((row) => `${row.agent_id}:${row.stream_id}`));
    const queued = [];
    const background = [];
    for (const item of queuedAll) {
      const key = `${item.agent_id}:${item.stream_id}`;
      if (taken.has(key)) continue;
      // 后台压缩信让位给真人触发的那封，否则压缩排在前面时每次回复都要多等一轮。
      if (item.meta?.kind === "compress") {
        background.push(item);
        continue;
      }
      taken.add(key);
      queued.push(item);
    }
    for (const item of background) {
      const key = `${item.agent_id}:${item.stream_id}`;
      if (taken.has(key)) continue;
      taken.add(key);
      queued.push(item);
    }
    if (!queued.length) return json({ ok: true, ran: [], queued: queuedAll.length, since });

    const budget = sliceBudget(env);
    const byAgent = new Map();
    for (const item of queued) {
      const list = byAgent.get(item.agent_id) ?? [];
      list.push(item);
      byAgent.set(item.agent_id, list);
    }
    const plan = [];
    for (const [agentId, items] of byAgent) {
      const perStream = new Map();
      for (const item of items) {
        const group = perStream.get(item.stream_id) ?? [];
        group.push(item);
        perStream.set(item.stream_id, group);
      }
      const shares = allocate(budget, [...perStream.entries()].map(([streamId, group]) => ({
        streamId,
        weight: itemWeight(group[0]),
        count: group.length,
      })));
      for (const share of shares) {
        const group = perStream.get(share.streamId) ?? [];
        plan.push(...group.slice(0, share.slots));
      }
    }

    const ran = [];
    await Promise.all(plan.slice(0, budget * Math.min(byAgent.size, 6)).map(async (mail) => {
      const claimed = await db.mail.claim([["id", mail.id], ["status", "queued"]], {
        status: "running", started_at: now(), slice_count: Number(mail.slice_count ?? 0) + 1,
      });
      if (!claimed) return;
      const outcome = await runTask({ db, env, mailId: mail.id }).catch(async (error) => {
        const code = String(error?.error ?? "task_failed");
        // runTask 自己抛出来时邮箱还停在 running：不落 failed 并合上步骤，时间线会一直闪"处理中"，
        // 这封信也要等 5 分钟才被 reapStale 回收。
        await finish(db, mail.id, "failed", code);
        return { status: "failed", error: code };
      });
      ran.push({ mail_id: mail.id, agent_id: mail.agent_id, stream_id: mail.stream_id, ...outcome });
    }));
    const left = await db.mail.list([
      ["agent_id", agentIds], ["stream_id", streamIds], ["status", "queued"],
    ], { columns: "id", limit: 200 });
    return json({ ok: true, ran, queued: left.length, budget, since: Date.now() });
  },

  async "scheduler.board"({ db, user }) {
    const agents = await db.agents.list([["owner_id", user.id]], { columns: AGENT_COLUMNS, limit: 60 });
    const rows = [];
    for (const agent of agents) {
      const memberships = await db.members.list([
        ["principal_type", "agent"], ["principal_id", agent.id],
      ], { columns: "stream_id", limit: 60 });
      const ids = memberships.map((m) => m.stream_id);
      if (!ids.length) continue;
      const streams = await db.streams.list([["id", ids]], { columns: "id,name", limit: 60 });
      const mail = await db.mail.list([["agent_id", agent.id]], {
        columns: "id,stream_id,status,priority,created_at,started_at,finished_at,error,slice_count",
        order: ["created_at", { ascending: false }], limit: 200,
      });
      const weights = await db.slice_prefs.list([["agent_id", agent.id]], {
        columns: "stream_id,weight", limit: 60,
      });
      const weightOf = new Map(weights.map((w) => [w.stream_id, w.weight]));
      const total = ids.reduce((sum, id) => sum + (weightOf.get(id) ?? 1), 0);
      rows.push({
        agent: publicAgent(agent),
        streams: streams.map((s) => {
          const weight = weightOf.get(s.id) ?? 1;
          const mine = mail.filter((m) => m.stream_id === s.id);
          return {
            stream_id: s.id,
            name: s.name,
            weight,
            share: Math.round((weight / total) * 1000) / 10,
            queued: mine.filter((m) => m.status === "queued").length,
            running: mine.filter((m) => m.status === "running").length,
            done: mine.filter((m) => m.status === "done").length,
            failed: mine.filter((m) => m.status === "failed").length,
            slices: mine.reduce((sum, m) => sum + Number(m.slice_count ?? 0), 0),
            last_error: mine.find((m) => m.error)?.error ?? null,
          };
        }),
      });
    }
    return json({ ok: true, boards: rows, budget: sliceBudget() });
  },

  /** 领导（群主/管理员）确认某个虚拟员工在本群的优先级权重；默认不设置即均分。 */
  async "scheduler.weight"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const agentId = uuid(body.agent_id, "agent_id");
    await requireMembership(db, streamId, user.id);
    const agent = await db.agents.byId(agentId, { columns: "id,name,owner_id" });
    if (!agent) throw new Halt("agent_not_found", 404);
    if (agent.owner_id !== user.id) throw new Halt("agent_not_owned", 403);
    const { role } = await requireMembership(db, streamId, user.id);
    const isLeader = role === "owner" || role === "admin";
    const weight = Number(body.weight ?? 1);
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > 20) throw new Halt("invalid_weight", 400);
    if (!isLeader && weight !== 1) throw new Halt("leader_only", 403);
    const existing = await db.slice_prefs.first([["agent_id", agentId], ["stream_id", streamId]]);
    if (existing) {
      await db.slice_prefs.patch([["id", existing.id]], { weight, set_by: user.id, updated_at: now() });
    } else {
      await db.slice_prefs.insert({
        id: newId(), agent_id: agentId, stream_id: streamId, weight,
        set_by: user.id, created_at: now(), updated_at: now(),
      }, { columns: "id" });
    }
    await db.mail.patch([["agent_id", agentId], ["stream_id", streamId], ["status", "queued"]], {
      priority: weight, updated_at: now(),
    });
    return json({ ok: true, weight });
  },

  /**
   * 插话或停止：只能对自己名下的虚拟员工下手。
   * 带 message_id 就掐断当前生成并按那条消息重答；不带即纯停止，不再产出回复。
   */
  async "scheduler.interrupt"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const agentId = uuid(body.agent_id, "agent_id");
    await requireMembership(db, streamId, user.id);
    const agent = await db.agents.byId(agentId, { columns: "id,name,owner_id" });
    if (!agent) throw new Halt("agent_not_found", 404);
    if (agent.owner_id !== user.id) throw new Halt("agent_not_owned", 403);
    const stop = body.message_id === undefined || body.message_id === null;
    const message = stop ? null : await db.messages.byId(uuid(body.message_id, "message_id"));
    if (!stop && (!message || message.stream_id !== streamId || message.sender_id !== user.id)) {
      throw new Halt("interrupt_message_invalid", 400);
    }
    const mail = await db.mail.first(
      [["agent_id", agentId], ["stream_id", streamId], ["status", "running"]],
      { columns: "id,trigger_seq,meta", order: ["started_at", { ascending: true }] },
    );
    if (!mail) throw new Halt("nothing_running", 409);
    const handled = Math.max(Number(mail.trigger_seq ?? 0), Number(mail.meta?.interrupt?.seq ?? 0));
    const meta = stop
      ? { ...(mail.meta ?? {}), stop_requested: true }
      : {
        ...(mail.meta ?? {}),
        interrupt: { message_id: message.id, seq: Math.max(Number(message.seq), handled + 1), at: now() },
      };
    const claimed = await db.mail.claim([["id", mail.id], ["status", "running"]], { meta });
    if (!claimed) throw new Halt("nothing_running", 409);
    fireInterrupt(mail.id);
    return json({ ok: true, mail_id: mail.id, mode: stop ? "stop" : "steer" });
  },

  async "mail.list"({ db, user, params }) {
    const agentId = params.get("agent_id") ? uuid(params.get("agent_id"), "agent_id") : null;
    const owned = agentId
      ? await db.agents.byId(agentId, { columns: "id,owner_id" })
      : null;
    if (agentId && (!owned || owned.owner_id !== user.id)) throw new Halt("agent_not_owned", 403);
    const pairs = agentId ? [["agent_id", agentId]] : [["agent_id", (await db.agents.list([["owner_id", user.id]], { columns: "id", limit: 60 })).map((a) => a.id)]];
    if (!pairs[0][1].length) return json({ ok: true, items: [] });
    const rows = await db.mail.list(pairs, {
      columns: "id,agent_id,stream_id,message_id,trigger_seq,status,priority,created_at,started_at,finished_at,error,slice_count,meta",
      order: ["created_at", { ascending: false }], limit: 100,
    });
    return json({ ok: true, items: rows });
  },
};

function sliceBudget(env) {
  const raw = Number(env?.("WORKSTREAM_SLICE_BUDGET") ?? 2);
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= 8 ? raw : 2;
}

const itemWeight = (item) => {
  const value = Number(item?.priority ?? 1);
  return Number.isSafeInteger(value) && value >= 1 && value <= 20 ? value : 1;
};

/** 最大余数法：把 budget 个槽位按权重分给各 stream，且不超过该 stream 的排队数。 */
export function allocate(budget, groups) {
  const totalWeight = groups.reduce((sum, g) => sum + g.weight, 0) || 1;
  const exact = groups.map((g) => ({ ...g, raw: (budget * g.weight) / totalWeight }));
  let used = 0;
  const result = exact.map((g) => {
    const base = Math.floor(g.raw);
    used += base;
    return { ...g, slots: Math.min(base, g.count) };
  });
  let left = budget - result.reduce((sum, g) => sum + g.slots, 0);
  const ordered = [...exact].sort((a, b) => (b.raw - Math.floor(b.raw)) - (a.raw - Math.floor(a.raw)));
  for (const candidate of ordered) {
    if (left <= 0) break;
    const row = result.find((r) => r.streamId === candidate.streamId);
    if (row.slots < row.count) {
      row.slots += 1;
      left -= 1;
    }
  }
  return result.filter((r) => r.slots > 0);
}

/** 超过 5 分钟仍处于 running 的任务视为上一次调用中断，回收为失败；期间收到的插话转成待办，不丢。
 *  导出给 worker：空闲（没有排队）时也要有人回收，否则崩溃留下的 running 会永远卡住那个员工。 */
export async function reapStale(db) {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const stale = await db.mail.list([["status", "running"]], {
    columns: "id,agent_id,stream_id,started_at,meta,priority", limit: 50,
  });
  for (const row of stale) {
    if (String(row.started_at ?? "") >= cutoff) continue;
    const claimed = await db.mail.claim([["id", row.id], ["status", "running"]], {
      status: "failed", error: "slice_interrupted", finished_at: now(),
    });
    if (claimed) await closeOrphanSteps(db, row.id, { error: "slice_interrupted" });
    const pending = row.meta?.interrupt;
    if (claimed && pending?.message_id) {
      await db.mail.insert({
        id: newId(), agent_id: row.agent_id, stream_id: row.stream_id, message_id: pending.message_id,
        trigger_seq: Number(pending.seq ?? 0), priority: Number(row.priority ?? 1),
        status: "queued", slice_count: 0, error: null,
        created_at: now(), started_at: null, finished_at: null, updated_at: now(),
        meta: { follow_up: "interrupt" },
      }, { columns: "id" });
    }
  }
}

/** 跑一个任务：组装上下文 → 超限先压缩 → MCP 工具回路 → 回复落群。 */
export async function runTask({ db, env, mailId }) {
  const mail = await db.mail.byId(mailId);
  if (!mail || mail.status !== "running") return { status: "skipped" };
  const agent = await db.agents.byId(mail.agent_id, { columns: AGENT_COLUMNS });
  if (!agent || agent.status !== "active") {
    await finish(db, mailId, "failed", agent ? "agent_paused" : "agent_missing");
    return { status: "failed", error: "agent_missing" };
  }
  const stream = await db.streams.byId(mail.stream_id, {
    columns: "id,name,owner_id,announcement,context_chars",
  });
  if (!stream) {
    await finish(db, mailId, "failed", "stream_missing");
    return { status: "failed", error: "stream_missing" };
  }
  const trigger = mail.message_id ? await db.messages.byId(mail.message_id) : null;
  // 替身任务：这封是替某个真人接的 @，模型要看见自己在替谁说话，回复也要带上这个标记。
  const representedId = mail.meta?.on_behalf_of ?? null;
  const represented = representedId
    ? await db.users.byId(representedId, { columns: "id,display_name" })
    : null;
  const delegate = represented ? { name: represented.display_name, id: represented.id } : null;
  const secret = await db.agents.byId(mail.agent_id, { columns: AGENT_SECRET_COLUMNS });
  if (!secret?.api_key_cipher) {
    await finish(db, mailId, "failed", "agent_key_missing");
    return { status: "failed", error: "agent_key_missing" };
  }
  const key = await open(secret.api_key_cipher, { supabase: db.client, env });
  // 一次运行一份写入器：seq 从 1 密排在这封 mail 上，跨运行绝不共享计数器。
  const trace = createStepWriter(db, { mailId, agentId: agent.id, streamId: stream.id });

  let currentTrigger = trigger;

  if (mail.meta?.kind === "compress") {
    // 压缩窗口从水位线往后连续取：covers_through_seq 声称覆盖到哪儿，那段记录就真的被摘要读过，
    // 不会把「窗口没装下的旧记录」当成已覆盖而永久丢掉。每轮只折叠一批，剩下的下一轮接着折，
    // 也避免把十几万字符塞进一次 400 token 的摘要里。
    const prepared = await assemble({
      db, agent, stream, anchor: "head",
      maxChars: Math.max(4000, Math.floor(streamBudget(stream, agent) * 0.12)),
    });
    let folded;
    try {
      folded = await compress({ db, env, agent, stream, prepared, key, trace });
    } catch (error) {
      const code = error?.code ?? error?.status ?? "compress_failed";
      await db.memories.insert({
        id: newId(), agent_id: agent.id, scope: "stream", stream_id: stream.id, kind: "note",
        content: `后台压缩失败：${code}（下一轮会重试）`, covers_through_seq: null,
        source: "compression", created_at: now(), updated_at: now(),
      }, { columns: "id" });
      await finish(db, mailId, "failed", String(code));
      return { status: "failed", error: String(code) };
    }
    await finish(db, mailId, "done", null);
    // 一次只折叠一批；水位线之后还压着记录就续投下一封，积压在后台自己排空，不用等真人再发一条。
    // 只有水位线真被推进了才续投，否则会在同一批记录上反复投递。
    if (prepared.truncated && Number(folded.windowStart) > Number(prepared.windowStart)) {
      await queueCompression(db, { agentId: agent.id, streamId: stream.id });
    }
    return { status: "done", mode: "compress", ms: 0 };
  }

  let prepared = await assemble({ db, agent, stream });
  const skills = await skillPrompt(db, agent.id);
  let built = await buildContext({ db, agent, stream, prepared, trigger, skills, delegate });
  let used = size(built.messages);

  // 超预算不在关键路径里调模型：先按字符预算从窗口头部确定性裁剪（摘要滞后一轮），
  // 压缩交给后台 mail 做，长对话那一轮不再付双倍延迟。
  const budget = streamBudget(stream, agent);
  let needsCompress = false;
  if (used > budget) {
    let dropped = 0;
    let droppedChars = 0;
    while (used - droppedChars > budget && dropped < prepared.window.length - 2) {
      droppedChars += rowChars(prepared.window[dropped]) + 2;
      dropped += 1;
    }
    if (dropped > 0) {
      prepared = { ...prepared, window: prepared.window.slice(dropped) };
      built = await buildContext({ db, agent, stream, prepared, trigger: currentTrigger, skills, delegate });
      used = size(built.messages);
      needsCompress = true;
    }
  }
  // 水位线之后还有记录挤不进窗口：补投后台压缩信把水位线推上去。
  // 不补的话，被挤出去的那段既不在这一轮的上下文里，也永远不会进摘要。
  if (prepared.truncated) needsCompress = true;

  const maxHops = Number(mail.meta?.hops ?? 0) >= 3;
  if (maxHops) {
    await finish(db, mailId, "failed", "hop_limit");
    return { status: "failed", error: "hop_limit" };
  }

  const handledSeq = { current: Number(trigger?.seq ?? mail.trigger_seq ?? 0) };
  const watch = interruptWatcher({ db, mailId, handledSeq });
  const absorbed = [];
  let reply;
  for (let steer = 0; ; steer += 1) {
    try {
      reply = await withTools({
        db, env, agent, stream, key, messages: built.messages, watch, trace,
        // 这一步实际落下的提示词槽位与各自字符数：命中率掉了要对得出是哪一块动了。
        // 单列一个字段而不是塞进 context——那块有 800 字上限，槽位清单不该被它挤掉。
        promptSlots: built.promptSlots,
        contextNote: {
          from: prepared.window[0]?.seq ?? null,
          to: prepared.window.at(-1)?.seq ?? null,
          summary_through: prepared.windowStart,
          blocks: built.messages.length,
        },
      });
      break;
    } catch (error) {
      if (!(error instanceof Interrupted)) {
        const code = error?.name === "TimeoutError" ? "upstream_timeout" : error?.code ?? error?.status ?? "upstream_unreachable";
        await finish(db, mailId, "failed", String(code));
        await insertMessage(db, {
          streamId: stream.id, senderType: "system", senderId: agent.owner_id, senderName: "系统",
          content: `虚拟员工「${agent.name}」这次没能完成：${code}。任务保留在邮箱里可重试。`,
        });
        return { status: "failed", error: String(code) };
      }
      if (error.payload.stopped) {
        await finish(db, mailId, "cancelled", "interrupted");
        return { status: "cancelled", error: "interrupted" };
      }
      const next = error.payload.message_id ? await db.messages.byId(error.payload.message_id) : null;
      if (!next || steer >= 2) {
        await finish(db, mailId, "cancelled", "interrupted");
        return { status: "cancelled", error: "interrupted" };
      }
      // 插话生效后把新消息当成触发消息重跑一次：半截输出留作提示，不静默丢弃。
      currentTrigger = next;
      absorbed.push({ id: next.id, seq: Number(next.seq ?? 0) });
      prepared = await assemble({ db, agent, stream });
      built = await buildContext({
        db, agent, stream, prepared, trigger: next, skills, delegate,
        steerNote: `上一条回复说到一半被 @ 你的新消息打断了。已输出的半截是：${truncate(error.payload.partial ?? "", 400)}。请以这条插话为准，重新给出完整回应。`,
      });
      used = size(built.messages);
    }
  }

  const content = text(reply.content ?? "", { max: 8000, required: false });
  if (!content) {
    await finish(db, mailId, "failed", "empty_reply");
    return { status: "failed", error: "empty_reply" };
  }
  const mentions = await matchMentions(db, stream.id, content);
  const message = await insertMessage(db, {
    streamId: stream.id,
    senderType: "agent",
    senderId: agent.id,
    senderName: agent.name,
    content,
    mentions,
    onBehalfOf: represented?.id ?? null,
  });
  await db.memories.insert({
    id: newId(), agent_id: agent.id, scope: "stream", stream_id: stream.id, kind: "note",
    content: `#${message.seq} 回应：${truncate(content, 200)}`,
    // 记下这条回声对应的群消息序号：装配时序号还落在窗口里的回声就不再单列（转录里已有全文），
    // 省掉一块每轮整体重写的内容，前缀缓存才不会被它打断。
    covers_through_seq: message.seq,
    source: "agent", created_at: now(), updated_at: now(),
  }, { columns: "id" });
  await fanout({ db, env, stream, message, mentions, hops: Number(mail.meta?.hops ?? 0) + 1, agentId: agent.id });
  // 被这次运行消化掉的插话不会另起任务，补一条回执，群里那条消息才不会一直显示“未读”。
  for (const item of absorbed) {
    await db.mail.insert({
      id: newId(), agent_id: agent.id, stream_id: stream.id, message_id: item.id,
      trigger_seq: item.seq, priority: 1, status: "done", slice_count: 0, error: null,
      created_at: now(), started_at: now(), finished_at: now(), updated_at: now(),
      meta: { receipt: "steer", from_mail: mailId },
    }, { columns: "id" });
  }
  // 回完才发现期间有人插过话（流式循环没来得及掐断）：把它转成一条待办任务，插话不会被吞掉。
  const fresh = await db.mail.byId(mailId, { columns: "id,status,meta" });
  const leftover = fresh?.meta?.interrupt ?? null;
  disarmInterrupt(mailId);
  await db.mail.claim([["id", mailId]], {
    status: "done", error: null, finished_at: now(),
    meta: { ...(fresh?.meta ?? {}), interrupt: null },
  }, { stamp: false });
  if (leftover?.message_id) {
    await db.mail.insert({
      id: newId(), agent_id: agent.id, stream_id: stream.id, message_id: leftover.message_id,
      trigger_seq: Number(leftover.seq ?? 0), priority: await streamWeight(db, agent.id, stream.id),
      status: "queued", slice_count: 0, error: null,
      created_at: now(), started_at: null, finished_at: null, updated_at: now(),
      meta: { hops: Number(mail.meta?.hops ?? 0), follow_up: "interrupt" },
    }, { columns: "id" });
  }
  if (needsCompress) await queueCompression(db, { agentId: agent.id, streamId: stream.id });
  return { status: "done", seq: message.seq, mode: reply.mode, ms: reply.ms };
}

/** 投一封后台压缩信：同 (员工, 群) 已有排队或在跑的压缩信就不重复投。 */
async function queueCompression(db, { agentId, streamId }) {
  const pending = await db.mail.list([
    ["agent_id", agentId], ["stream_id", streamId], ["status", ["queued", "running"]],
  ], { columns: "meta", limit: 20 });
  if (pending.some((row) => row.meta?.kind === "compress")) return;
  await db.mail.insert({
    id: newId(), agent_id: agentId, stream_id: streamId, message_id: null,
    trigger_seq: 0, priority: 1, status: "queued", slice_count: 0, error: null,
    created_at: now(), started_at: null, finished_at: null, updated_at: now(),
    meta: { kind: "compress" },
  }, { columns: "id" });
}

function streamBudget(stream, agent) {
  return Math.min(
    Number(stream.context_chars ?? CONTEXT_CHARS_DEFAULT),
    Number(agent.context_chars ?? CONTEXT_CHARS_DEFAULT),
  );
}

/** 图片按固定 1500 字折算进上下文预算：真实 token 由上游决定，这里只要别让它悄悄超窗。 */
const IMAGE_BUDGET_CHARS = 1500;

const size = (messages) => messages.reduce((sum, m) => {
  if (Array.isArray(m.content)) {
    return sum + m.content.reduce((part, item) => part + (item.type === "text" ? String(item.text ?? "").length : IMAGE_BUDGET_CHARS), 0);
  }
  return sum + String(m.content ?? "").length;
}, 0);

const WATCH_MS = 400;

/**
 * 插话监听：同进程点火即时生效；否则每 400 毫秒最多读一次邮箱，发现比当前触发消息
 * 更新的插话/停止请求，就把它从 meta 里摘掉（避免重复触发）并交给流式循环掐断上游。
 */
function interruptWatcher({ db, mailId, handledSeq }) {
  let lastCheck = 0;
  let woke = false;
  armInterrupt(mailId, () => { woke = true; });
  return async () => {
    if (!woke) {
      const stamp = Date.now();
      if (stamp - lastCheck < WATCH_MS) return null;
      lastCheck = stamp;
    }
    woke = false;
    const mail = await db.mail.byId(mailId, { columns: "id,status,trigger_seq,meta" });
    if (!mail || mail.status !== "running") return { stopped: true };
    const meta = mail.meta ?? {};
    if (meta.stop_requested) {
      await db.mail.claim([["id", mailId], ["status", "running"]], { meta: { ...meta, stop_requested: false } });
      return { stopped: true };
    }
    const pending = meta.interrupt;
    const seq = Number(pending?.seq ?? 0);
    if (!pending || seq <= handledSeq.current) return null;
    await db.mail.claim([["id", mailId], ["status", "running"]], { meta: { ...meta, interrupt: null } });
    handledSeq.current = seq;
    return { message_id: pending.message_id ?? null, seq };
  };
}

/** 一条消息附带的图片 → OpenAI 兼容的 image_url 部件（群文件库里存的是纯 base64）。 */
async function imageParts(db, message, limit = 4) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments.slice(0, limit) : [];
  const parts = [];
  for (const item of attachments) {
    const file = await db.files.byId(String(item?.file_id ?? ""), { columns: "id,content_type,content,store" });
    if (!file || file.store !== "db" || !String(file.content_type).startsWith("image/") || !file.content) continue;
    parts.push({ type: "image_url", image_url: { url: `data:${file.content_type};base64,${file.content}` } });
  }
  return parts;
}

/** 一轮请求的上下文：正文由提示词槽位表装配（见 functions/prompt.mjs），这里只补图。
 *  连带的 promptSlots 是这一步真正落下的块与各自字符数，要进步骤轨迹——命中率掉了得能对出是哪一块动的。 */
async function buildContext({ db, agent, stream, prepared, trigger, skills, steerNote, delegate }) {
  const images = await imageParts(db, trigger);
  const { system, promptSlots } = composeSystemPrompt({
    agent, stream, prepared, trigger, skills, steerNote, delegate, cloud: isCloudBackend(agent),
  });
  return {
    promptSlots,
    messages: [
      { role: "system", content: system },
      { role: "user", content: composeAsk({ images }) },
    ],
  };
}

async function finish(db, mailId, status, error) {
  disarmInterrupt(mailId);
  await db.mail.claim([["id", mailId]], { status, error, finished_at: now() }, { stamp: false });
  // 收尾顺带结掉这轮没合上的步骤：正常路径已经没有（模型步/工具步各自合），
  // 剩下的都是崩在中间或掐断时留下的，不结就会在时间线上一直闪"处理中"。
  await closeOrphanSteps(db, mailId, { error: error ?? "step_unfinished" });
}

/** 上下文组成：common memory + 本群记忆 + 摘要 + 摘要之后的窗口。
 *  anchor=tail（回复用）：取水位线之后最新的一段，被挤出去的旧记录靠 search_history / read_window 查。
 *  anchor=head（压缩用）：从水位线往后连续取一段，摘要声称覆盖到哪个序号就真的覆盖到那儿。 */
async function assemble({ db, agent, stream, anchor = "tail", maxChars = null }) {
  const common = await db.memories.list([["agent_id", agent.id], ["scope", "common"]], {
    // 升序拼进上下文：新记忆追加到块尾，旧前缀不被打断（降序会让每条新记忆改写块头）。
    columns: "id,kind,content,created_at", order: ["created_at", { ascending: true }], limit: 20,
  });
  const streamMemory = await db.memories.list([["agent_id", agent.id], ["scope", "stream"], ["stream_id", stream.id]], {
    columns: "id,kind,content,covers_through_seq,created_at", order: ["created_at", { ascending: false }], limit: 30,
  });
  const summary = streamMemory.find((m) => m.kind === "summary");
  const from = summary?.covers_through_seq ?? 0;
  const { rows, truncated } = await history(db, stream.id, {
    from,
    // 窗口按字符封顶，不按条数：条数上限会让长群聊在预算还没用满时先被截断。
    maxChars: maxChars ?? Math.floor(streamBudget(stream, agent) * 0.8),
    anchor,
  });
  const windowHead = Number(rows[0]?.seq ?? 0);
  // 回复回声（「#NN 回应：…」）只在「摘要还没覆盖、窗口又装不下」那一段里才有价值：
  // NN ≤ 水位线的已经折进摘要，NN ≥ 窗口头的转录里就带全文，两头再列一遍纯属重复。
  // 而且这一块每轮都变、又排在转录之后——前缀缓存是一刀切，断点之后哪怕逐字节相同也算 miss。
  const notes = streamMemory
    .filter((m) => m.kind !== "summary")
    .filter((m) => m.covers_through_seq == null
      || (Number(m.covers_through_seq) > from && Number(m.covers_through_seq) < windowHead))
    // 升序渲染，新 note 追加到块尾而不是改写块头；取的时候按降序限 30，拿到的仍是最近 30 条。
    .reverse();
  return { common, notes, summary: summary?.content ?? "", windowStart: from, window: rows, truncated };
}

const HISTORY_PAGE = 200;
const HISTORY_MAX_PAGES = 50;

/** 从水位线那一侧按页取，累计到字符上限为止；truncated=true 说明还有记录没进窗口。
 *  整群历史可能几万条，一页页取而不是一把捞，既不会把 Function 的内存打满，也不会白读用不上的行。
 *  不按触发消息的序号设上界：突发时队列里第 2、3 封的触发消息比群里最新一条老，按它截断就会把
 *  自己刚发出的回复挡在窗口外（那些回复序号更大），员工于是一条条重复作答；触发消息另有专块给全。 */
async function history(db, streamId, { from, maxChars, anchor }) {
  const head = anchor === "head";
  const rows = [];
  let chars = 0;
  let cursor = null;
  let truncated = false;
  let pages = 0;
  for (; pages < HISTORY_MAX_PAGES && !truncated; pages += 1) {
    let query = db.client.from("messages")
      .select("id,seq,sender_type,sender_id,sender_name,content,created_at,kind,attachments")
      .eq("stream_id", streamId)
      .gt("seq", head ? (cursor ?? from) : from)
      .order("seq", { ascending: head })
      .limit(HISTORY_PAGE);
    // tail 锚从最新一条往回翻页：首页不带上界，之后用已读到的最小序号继续往前。
    if (!head && cursor !== null) query = query.lt("seq", cursor);
    const result = await query;
    if (result.error) throw new Halt("history_request_failed", 503, { code: result.error.code });
    const batch = Array.isArray(result.data) ? result.data : [];
    if (!batch.length) break;
    for (const row of batch) {
      const cost = rowChars(row) + 1;
      // 单条就超上限时也要留一条，否则窗口空了，模型连触发消息之外什么都看不到。
      if (rows.length && chars + cost > maxChars) { truncated = true; break; }
      rows.push(row);
      chars += cost;
    }
    cursor = Number(batch.at(-1).seq);
    if (batch.length < HISTORY_PAGE) break;
  }
  if (pages >= HISTORY_MAX_PAGES) truncated = true;
  // rows 在 head 锚下是从旧到新、tail 锚下是从新到旧，统一按序号升序交给上下文。
  return { rows: head ? rows : rows.reverse(), truncated };
}

/** 压缩：把窗口里较老的一半折叠进摘要，写入该 stream 的记忆并记录覆盖到的序号。
 *  前提：prepared.window 是从水位线往后连续取的那一段（anchor=head），
 *  这样 older 就是水位线之后的一个真前缀，covered 不会把没被读过的记录算成已覆盖。 */
async function compress({ db, env, agent, stream, prepared, key, trace }) {
  const budget = streamBudget(stream, agent);
  const rows = prepared.window;
  if (rows.length < 4) return { summary: prepared.summary, windowStart: prepared.windowStart };
  const keepFrom = Math.max(0, Math.floor(rows.length / 2));
  const older = rows.slice(0, keepFrom);
  const kept = rows.slice(keepFrom);
  let summary = prepared.summary;
  // 压缩也是一轮模型调用：记进步骤，后台信为什么没折动摘要才看得见，而不是只在记忆里留一句话。
  const step = await trace.openCompression({ model: agent.model });
  try {
    // 摘要是一次性提问：云端后端不为它复用群里的 session，免得"帮我摘要"混进群对话史。
    const result = await completeForAgent({
      db, agent, streamId: stream.id, key,
      messages: [
        { role: "system", content: "把下面这段群聊压成不超过 600 字的中文要点摘要，保留结论、待办、数字与人名。" },
        { role: "user", content: renderTranscript(older) },
      ],
      maxTokens: 400,
      timeoutMs: 30000,
      summary: { lines: older.map((r) => `${r.sender_name}：${r.content}`) },
      persistSession: false,
    });
    if (result.content) summary = `${prepared.summary ? `${prepared.summary}\n` : ""}${result.content}`.slice(-Math.max(600, budget * 0.1));
    await trace.close(step, {
      status: "done",
      detail: {
        reasoning: result.reasoning ?? "",
        content: result.content ?? "",
        note: `折叠 ${older.length} 条较早记录`,
      },
      usage: result.usage,
      firstTokenMs: result.first_token_ms,
    });
  } catch (error) {
    const code = error?.name === "TimeoutError" ? "upstream_timeout" : error?.code ?? error?.status ?? "compress_failed";
    await trace.close(step, { status: "failed", error: String(code), detail: { note: `折叠 ${older.length} 条较早记录` } });
    summary = `${prepared.summary}\n（${older.length} 条较早记录压缩失败：${code}，已折叠出上下文窗口）`.trim();
  }
  const covered = Number(older.at(-1)?.seq ?? prepared.windowStart);
  const existing = await db.memories.list([
    ["agent_id", agent.id], ["scope", "stream"], ["stream_id", stream.id], ["kind", "summary"],
  ], { columns: "id", limit: 10 });
  for (const row of existing) await db.memories.remove([["id", row.id]]);
  await db.memories.insert({
    id: newId(), agent_id: agent.id, scope: "stream", stream_id: stream.id, kind: "summary",
    content: summary, covers_through_seq: covered, source: "compression",
    created_at: now(), updated_at: now(),
  }, { columns: "id" });
  return { summary, windowStart: covered, window: kept };
}

/** 工具回路：最多两轮，工具执行都走内部 MCP 实现，作用域锁死在 (agent, stream, owner)。
 *  每一轮模型调用和每一次工具调用都落一条 run_steps，员工详情页的时间线读的就是它。 */
async function withTools({ db, env, agent, stream, key, messages, watch, trace, contextNote, promptSlots }) {
  const started = Date.now();
  // 主人启用中的插件工具并进这一轮的清单；重名时内置优先，插件被挤掉。
  const externalDefs = await connectorToolDefs(db, agent.owner_id, INTERNAL_TOOL_NAMES);
  const externalNames = new Set(externalDefs.map((definition) => definition.function.name));
  const tools = externalDefs.length ? [...TOOL_DEFINITIONS, ...externalDefs] : TOOL_DEFINITIONS;
  let working = [...messages];
  let last;
  for (let round = 0; round < 2; round += 1) {
    const modelStep = await trace.openModel({ model: agent.model });
    // 这一轮喂给模型的东西：只留口径（转录区间、块数、字符数），正文留在群里本来就能翻。
    const context = { ...contextNote, chars: size(working) };
    let answer;
    try {
      answer = await completeForAgent({
        db, agent, streamId: stream.id, key,
        messages: working,
        tools,
        timeoutMs: 180000,
        onInterrupt: watch,
      });
    } catch (error) {
      const preempted = error instanceof Interrupted;
      await trace.close(modelStep, {
        status: preempted ? "cancelled" : "failed",
        error: preempted ? "interrupted" : String(error?.name === "TimeoutError" ? "upstream_timeout" : error?.code ?? error?.status ?? "upstream_unreachable"),
        detail: {
          content: preempted ? (error.payload?.partial ?? "") : "",
          context,
          prompt_slots: promptSlots,
          note: preempted ? "生成到一半被群里的插话掐断" : "",
        },
      });
      throw error;
    }
    await trace.close(modelStep, {
      status: "done",
      detail: {
        reasoning: answer.reasoning ?? "",
        content: answer.content ?? "",
        context,
        prompt_slots: promptSlots,
        tool_names: (answer.tool_calls ?? []).map((call) => call?.function?.name).join(", "),
        note: answer.mode === "demo" ? "演示模型：不回报思考链与用量" : `finish_reason：${answer.finish_reason ?? "—"}`,
      },
      usage: answer.usage,
      firstTokenMs: answer.first_token_ms,
    });
    last = answer;
    if (!last.tool_calls?.length) break;
    const stop = await watch?.();
    if (stop) throw new Interrupted({ ...stop, partial: last.content ?? "" });
    const results = [];
    for (const call of last.tool_calls.slice(0, 4)) {
      const name = String(call?.function?.name ?? "");
      if (!INTERNAL_TOOL_NAMES.includes(name) && !externalNames.has(name)) {
        await trace.recordRejected({ name, callId: call.id, reason: "tool_not_allowed", raw: call?.function?.arguments });
        results.push({ call_id: call.id, name, output: "tool_not_allowed" });
        continue;
      }
      let args = {};
      try {
        args = JSON.parse(String(call?.function?.arguments ?? "{}"));
      } catch {
        await trace.recordRejected({ name, callId: call.id, reason: "invalid_arguments", raw: call?.function?.arguments });
        results.push({ call_id: call.id, name, output: "invalid_arguments" });
        continue;
      }
      const scope = { agentId: agent.id, streamId: stream.id, ownerId: agent.owner_id, trace };
      const output = await executeTool(db, scope, name, args, env, { callId: call.id })
        .catch((error) => ({ error: error?.error ?? "tool_failed" }));
      results.push({ call_id: call.id, name, output });
    }
    working = [
      ...working,
      { role: "assistant", content: last.content ?? "", tool_calls: last.tool_calls },
      ...results.map((r) => ({
        role: "tool",
        tool_call_id: r.call_id,
        content: JSON.stringify(r.output).slice(0, 4000),
      })),
    ];
  }
  return { ...last, ms: Date.now() - started };
}

/** 文本里的 @名字 → 群内成员；用于让虚拟员工也能 @ 真人与其他虚拟员工。 */
export async function matchMentions(db, streamId, content) {
  const memberships = await db.members.list([["stream_id", streamId]], {
    columns: "principal_type,principal_id", limit: 300,
  });
  const humanIds = memberships.filter((m) => m.principal_type === "human").map((m) => m.principal_id);
  const agentIds = memberships.filter((m) => m.principal_type === "agent").map((m) => m.principal_id);
  const humans = humanIds.length
    ? await db.users.list([["id", humanIds]], { columns: "id,display_name", limit: 300 }) : [];
  const agents = agentIds.length
    ? await db.agents.list([["id", agentIds]], { columns: "id,name", limit: 300 }) : [];
  const found = [];
  for (const human of humans) {
    if (human.display_name && content.includes(`@${human.display_name}`)) {
      found.push({ type: "human", id: human.id });
    }
  }
  for (const agent of agents) {
    if (agent.name && content.includes(`@${agent.name}`)) found.push({ type: "agent", id: agent.id });
  }
  return found.slice(0, 10);
}

/** 虚拟员工的回复里 @ 了别人：真人进邮箱通知，其他虚拟员工进任务队列（带跳数上限）。 */
async function fanout({ db, env, stream, message, mentions, hops, agentId }) {
  // 这次 @ 已经直接点名的员工 + 正在说话的这个员工：前者不必再经替身绕一遍，
  // 后者若正好是某个真人的替身，替身再 @ 主人时必须跳过，否则替身会替自己反复接活。
  const skipAgents = new Set([agentId, ...mentions.filter((m) => m.type === "agent").map((m) => m.id)]);
  for (const mention of mentions) {
    if (mention.type === "agent") {
      if (mention.id === agentId) continue;
      const target = await db.agents.byId(mention.id, { columns: "id,status,owner_id" });
      if (!target || target.status !== "active") continue;
      await db.mail.insert({
        id: newId(), agent_id: mention.id, stream_id: stream.id, message_id: message.id,
        trigger_seq: message.seq, priority: await streamWeight(db, mention.id, stream.id),
        status: "queued", slice_count: 0, error: null,
        created_at: now(), started_at: null, finished_at: null, updated_at: now(),
        meta: { hops, from_agent: agentId },
      }, { columns: "id" });
      continue;
    }
    const human = await db.users.byId(mention.id, {
      columns: "id,display_name,email,at_channel,delegate_agent_id,delegate_start_at,delegate_end_at",
    });
    if (!human) continue;
    await db.outbox.insert({
      id: newId(), recipient_email: human.email, user_id: human.id, kind: "mention",
      subject: `[${truncate(message.content, 24)}] 虚拟员工 ${message.sender_name} 在群里 @ 了你`,
      body: `${message.content}`.slice(0, 1000), link: `#/stream/${stream.id}`,
      stream_id: stream.id, channel: human.at_channel === "real_email" ? "real_email" : "virtual",
      status: "queued", created_at: now(), read_at: null,
    }, { columns: "id" });
    await queueDelegateMail(db, {
      human,
      streamId: stream.id,
      message,
      senderId: message.sender_id,
      skipAgents,
      weight: (delegateAgentId) => streamWeight(db, delegateAgentId, stream.id),
    });
    void env;
  }
}

export { shapeMessage };
