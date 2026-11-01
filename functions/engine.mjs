// 调度与虚拟员工执行引擎：邮箱 FIFO + 按权重的时间片、上下文压缩、MCP 工具回路。
import { AGENT_COLUMNS, AGENT_SECRET_COLUMNS, chatCompletion, publicAgent } from "./agents.mjs";
import { shapeMessage, streamWeight } from "./chat.mjs";
import { executeTool, INTERNAL_TOOL_NAMES, toolDefinitions } from "./mcp.mjs";
import { open } from "./sec.mjs";
import { insertMessage, nextSeq } from "./rooms.mjs";
import { requireMembership } from "./perm.mjs";
import { skillPrompt } from "./skills.mjs";
import { Halt, json, newId, now, text, truncate, uuid } from "./util.mjs";

const TOOL_DEFINITIONS = toolDefinitions();

export const actions = {
  /**
   * 时间片推进：一次 tick 给每个有活儿的虚拟员工分配若干任务槽，
   * 槽位按该员工在各群里的权重（默认均分）用最大余数法分配，群内按 FIFO 取件。
   * 站点 Function 不能常驻后台，因此由前端轮询驱动；一个任务一旦开始就跑完，不做实时抢占。
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

    const budget = sliceBudget(env);
    const byAgent = new Map();
    for (const item of queuedAll) {
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
      const outcome = await runTask({ db, env, mailId: mail.id }).catch((error) => ({
        status: "failed", error: error?.error ?? "task_failed",
      }));
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

/** 超过 5 分钟仍处于 running 的任务视为上一次调用中断，回收为失败。 */
async function reapStale(db) {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const stale = await db.mail.list([["status", "running"]], {
    columns: "id,started_at", limit: 50,
  });
  for (const row of stale) {
    if (String(row.started_at ?? "") >= cutoff) continue;
    await db.mail.claim([["id", row.id], ["status", "running"]], {
      status: "failed", error: "slice_interrupted", finished_at: now(),
    });
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
  const secret = await db.agents.byId(mail.agent_id, { columns: AGENT_SECRET_COLUMNS });
  if (!secret?.api_key_cipher) {
    await finish(db, mailId, "failed", "agent_key_missing");
    return { status: "failed", error: "agent_key_missing" };
  }
  const key = await open(secret.api_key_cipher, { supabase: db.client, env });

  const prepared = await assemble({ db, agent, stream, trigger });
  const skills = await skillPrompt(db, agent.id);
  let messages = buildMessages({ agent, stream, prepared, trigger, skills });
  let used = size(messages);

  if (used > streamBudget(stream, agent)) {
    const compressed = await compress({ db, env, agent, stream, prepared, key });
    prepared.summary = compressed.summary;
    prepared.windowStart = compressed.windowStart;
    messages = buildMessages({ agent, stream, prepared, trigger, skills });
    used = size(messages);
  }

  const maxHops = Number(mail.meta?.hops ?? 0) >= 3;
  if (maxHops) {
    await finish(db, mailId, "failed", "hop_limit");
    return { status: "failed", error: "hop_limit" };
  }

  let reply;
  try {
    reply = await withTools({
      db, env, agent, stream, key, messages, maxChars: streamBudget(stream, agent) - used,
    });
  } catch (error) {
    const code = error?.name === "TimeoutError" ? "upstream_timeout" : error?.code ?? error?.status ?? "upstream_unreachable";
    await finish(db, mailId, "failed", String(code));
    await insertMessage(db, {
      streamId: stream.id, senderType: "system", senderId: agent.owner_id, senderName: "系统",
      content: `虚拟员工「${agent.name}」这次没能完成：${code}。任务保留在邮箱里可重试。`,
    });
    return { status: "failed", error: String(code) };
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
  });
  await db.memories.insert({
    id: newId(), agent_id: agent.id, scope: "stream", stream_id: stream.id, kind: "note",
    content: `#${message.seq} 回应：${truncate(content, 200)}`, covers_through_seq: null,
    source: "agent", created_at: now(), updated_at: now(),
  }, { columns: "id" });
  await fanout({ db, env, stream, message, mentions, hops: Number(mail.meta?.hops ?? 0) + 1, agentId: agent.id });
  await finish(db, mailId, "done", null);
  return { status: "done", seq: message.seq, mode: reply.mode, ms: reply.ms };
}

function streamBudget(stream, agent) {
  return Math.min(Number(stream.context_chars ?? 12000), Number(agent.context_chars ?? 12000));
}

const size = (messages) => messages.reduce((sum, m) => sum + String(m.content ?? "").length, 0);

async function finish(db, mailId, status, error) {
  await db.mail.claim([["id", mailId]], { status, error, finished_at: now() }, { stamp: false });
}

/** 上下文组成：common memory + 本群记忆 + 摘要 + 摘要之后的窗口。 */
async function assemble({ db, agent, stream, trigger }) {
  const common = await db.memories.list([["agent_id", agent.id], ["scope", "common"]], {
    columns: "id,kind,content,created_at", order: ["created_at", { ascending: false }], limit: 20,
  });
  const streamMemory = await db.memories.list([["agent_id", agent.id], ["scope", "stream"], ["stream_id", stream.id]], {
    columns: "id,kind,content,covers_through_seq,created_at", order: ["created_at", { ascending: false }], limit: 30,
  });
  const summary = streamMemory.find((m) => m.kind === "summary");
  const notes = streamMemory.filter((m) => m.kind !== "summary");
  const from = summary?.covers_through_seq ?? 0;
  const window = await history(db, stream.id, { from, to: Number(trigger?.seq ?? 999999), limit: 120 });
  return { common, notes, summary: summary?.content ?? "", windowStart: from, window };
}

async function history(db, streamId, { from, to, limit }) {
  const result = await db.client.from("messages")
    .select("id,seq,sender_type,sender_id,sender_name,content,created_at,kind")
    .eq("stream_id", streamId)
    .gt("seq", from)
    .lte("seq", to)
    .order("seq", { ascending: true })
    .limit(limit);
  if (result.error) throw new Halt("history_request_failed", 503, { code: result.error.code });
  return Array.isArray(result.data) ? result.data : [];
}

function renderTranscript(rows) {
  return rows
    .map((row) => `${row.kind === "system" ? "·" : "#"}${row.seq} [${row.sender_type === "agent" ? "虚拟" : row.sender_type === "human" ? "人" : "系统"}] ${row.sender_name}：${row.content}`)
    .join("\n");
}

function buildMessages({ agent, stream, prepared, trigger, skills }) {
  const head = [
    `你是虚拟员工「${agent.name}」（角色：${agent.role}），正在 WorkStream 群「${stream.name}」里工作。`,
    agent.signature ? `你的个性签名（群里头像旁可见，需要时用 set_signature 更新）：${agent.signature}` : "",
    agent.system_prompt ? `工作守则：${agent.system_prompt}` : "",
    stream.announcement ? `群公告：${stream.announcement}` : "",
    prepared.common.length ? `你的长期记忆（common）：\n${prepared.common.map((m) => `- ${m.content}`).join("\n")}` : "",
    prepared.notes.length ? `本群记忆：\n${prepared.notes.map((m) => `- ${m.content}`).join("\n")}` : "",
    prepared.summary ? `本群较早内容的压缩摘要（序号 1-${prepared.windowStart}）：\n${prepared.summary}` : "",
    skills ? `你的技能（按需调用对应工具；细则可用 read_skill 查全文）：\n${skills}` : "",
    `最近记录：\n${renderTranscript(prepared.window)}`,
    `上一条 @ 你的消息：${trigger ? `${trigger.sender_name}：${trigger.content}` : "（队列里的补发任务，无原始消息）"}`,
    "如需更早的记录，调用 search_history / read_window 工具；回答用群成员能直接用的表述。",
  ].filter(Boolean);
  return [
    { role: "system", content: head.join("\n\n") },
    { role: "user", content: "请按上面的上下文回应这条任务。" },
  ];
}

/** 压缩：把窗口里较老的一半折叠进摘要，写入该 stream 的记忆并记录覆盖到的序号。 */
async function compress({ db, env, agent, stream, prepared, key }) {
  const budget = streamBudget(stream, agent);
  const rows = prepared.window;
  if (rows.length < 4) return { summary: prepared.summary, windowStart: prepared.windowStart };
  const keepFrom = Math.max(0, Math.floor(rows.length / 2));
  const older = rows.slice(0, keepFrom);
  const kept = rows.slice(keepFrom);
  let summary = prepared.summary;
  try {
    const result = await chatCompletion({
      baseUrl: agent.api_base_url,
      apiKey: key,
      model: agent.model,
      messages: [
        { role: "system", content: "把下面这段群聊压成不超过 600 字的中文要点摘要，保留结论、待办、数字与人名。" },
        { role: "user", content: renderTranscript(older) },
      ],
      maxTokens: 400,
      timeoutMs: 30000,
      summary: { lines: older.map((r) => `${r.sender_name}：${r.content}`) },
    });
    if (result.content) summary = `${prepared.summary ? `${prepared.summary}\n` : ""}${result.content}`.slice(-Math.max(600, budget * 0.1));
  } catch {
    summary = `${prepared.summary}\n（${older.length} 条较早记录压缩失败，已折叠出上下文窗口）`.trim();
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

/** 工具回路：最多两轮，工具执行都走内部 MCP 实现，作用域锁死在 (agent, stream, owner)。 */
async function withTools({ db, env, agent, stream, key, messages }) {
  const started = Date.now();
  let working = [...messages];
  let last;
  for (let round = 0; round < 2; round += 1) {
    last = await chatCompletion({
      baseUrl: agent.api_base_url,
      apiKey: key,
      model: agent.model,
      messages: working,
      tools: TOOL_DEFINITIONS,
      timeoutMs: 60000,
    });
    if (!last.tool_calls?.length) break;
    const results = [];
    for (const call of last.tool_calls.slice(0, 4)) {
      const name = String(call?.function?.name ?? "");
      if (!INTERNAL_TOOL_NAMES.includes(name)) {
        results.push({ call_id: call.id, name, output: "tool_not_allowed" });
        continue;
      }
      let args = {};
      try {
        args = JSON.parse(String(call?.function?.arguments ?? "{}"));
      } catch {
        results.push({ call_id: call.id, name, output: "invalid_arguments" });
        continue;
      }
      const scope = { agentId: agent.id, streamId: stream.id, ownerId: agent.owner_id };
      const output = await executeTool(db, scope, name, args, env)
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
    const human = await db.users.byId(mention.id, { columns: "id,email,display_name,at_channel" });
    if (!human) continue;
    await db.outbox.insert({
      id: newId(), recipient_email: human.email, user_id: human.id, kind: "mention",
      subject: `[${truncate(message.content, 24)}] 虚拟员工 ${message.sender_name} 在群里 @ 了你`,
      body: `${message.content}`.slice(0, 1000), link: `#/stream/${stream.id}`,
      stream_id: stream.id, channel: human.at_channel === "real_email" ? "real_email" : "virtual",
      status: "queued", created_at: now(), read_at: null,
    }, { columns: "id" });
    void env;
  }
}

export { shapeMessage };
