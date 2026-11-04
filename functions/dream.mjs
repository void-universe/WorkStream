// dreaming：把一名主人名下各个群的压缩摘要，归并成一份「主人级」的全局记忆。
//
// 为什么喂给模型的输入是各群的摘要而不是原始消息：摘要自己已经带了「覆盖到哪个序号」的水位线，
// 一次归并只需要看水位线比上次归并点更新的那几段——把全部群的转录重喂一遍既贵又没必要，
// 而且那些记录早就被摘过一轮，再摘一次只是重复付费。
//
// 为什么一个主人只有一行（scope=owner、kind=dream）而不是每次追加：这一行会被装配进每一轮提示词，
// 追加会让它没有上限地长下去，而"该忘掉哪一条"没有任何口径可依据。覆盖写 + 一份逐素材的水位
// （covers_streams = {员工 id:群 id: 已归并到的序号}），和群里那份摘要用的是同一个手法。
//
// 为什么水位按 (员工, 群) 而不是只按群：同一个群里可以有两个员工，各自折出自己那一份摘要，
// 两条素材的覆盖序号互不相干。只按群记的话后写的那条会把前一条的序号盖掉——那条摘要要么被反复
// 重并（每轮白付一次模型调用），要么被当成已归并而永久漏掉，两种都是静默错账。
//
// 为什么读的时候按 agent.owner_id 而不是 stream.owner_id：别人的员工进了你的群时，
// 读群主人的全局记忆等于把你的跨群结论交给别人家的模型；读自己主人的才只可能 leak 自己的。
import { completeForAgent, upstreamCode } from "./agents.mjs";
import { requireMembership } from "./perm.mjs";
import { Halt, json, newId, now, truncate, uuid } from "./util.mjs";

/** 全局记忆那一行的读法：列清单在这里给全，界面与装配都读它，别在两处各拼一遍。 */
export const DREAM_COLUMNS =
  "id,agent_id,owner_id,scope,stream_id,kind,content,covers_streams,covers_through_seq,source,created_at,updated_at";

/** 一次归并最多看多少个群：水位扫描要有界，一屏也摆不下几百个群名。 */
const MAX_STREAMS = 50;
/** 摘要输入的字符上限：一次归并喂太多要点，模型只会把要点又糊成一团。 */
const INPUT_CHARS_DEFAULT = 12_000;
/** 归并结果的长度上限（字符）：这一份每轮都要进提示词，太长就是在为每一轮交税。 */
const OUTPUT_CHARS_DEFAULT = 600;
/**
 * 输入预算的下限。群摘要本身最长就是压缩那一轮的尾巴上限（600 字起步），
 * 低于这个数的预算会让"一个群都装不下"，于是这一轮什么归并不了、水位一步不动，
 * 每轮醒来都白付一次模型调用。
 */
const INPUT_CHARS_MIN = 2_000;
const DREAM_TIMEOUT_MS = 30_000;

const dreamBudgets = (env) => ({
  inputChars: Math.max(
    INPUT_CHARS_MIN,
    Number(env?.("WORKSTREAM_DREAM_INPUT_CHARS") ?? INPUT_CHARS_DEFAULT),
  ),
  outputChars: Number(env?.("WORKSTREAM_DREAM_OUTPUT_CHARS") ?? OUTPUT_CHARS_DEFAULT),
});

/** 主人级那一行（一个主人最多一行，读最新一条兜住竞态留下的旧行）。 */
export async function ownerDream(db, ownerId) {
  const rows = await db.memories.list(
    [["owner_id", ownerId], ["scope", "owner"], ["kind", "dream"]],
    { columns: DREAM_COLUMNS, order: ["updated_at", { ascending: false }], limit: 1 },
  );
  return rows[0] ?? null;
}

/** 一份素材在水位表里的键：员工和群两个都要，只按群会把同群里另一个员工的序号盖掉。 */
const sourceKey = (row) => `${row.agent_id}:${row.stream_id}`;

/** 轨迹里一份素材的署名：光有群 id 对不回是同群里哪一个员工折的那一份。 */
const dreamStamp = (row) => ({
  agent_id: row.agent_id, stream_id: row.stream_id, stream_name: row.stream_name, covers: row.covers,
});

/** 归并的输入：这名主人名下所有员工、所有群的摘要，各自带着自己那条水位线。 */
async function dreamInputs(db, ownerId) {
  const agents = await db.agents.list([["owner_id", ownerId]], { columns: "id,name", limit: MAX_STREAMS });
  if (!agents.length) return [];
  const rows = await db.memories.list(
    [["agent_id", agents.map((agent) => agent.id)], ["scope", "stream"], ["kind", "summary"]],
    {
      columns: "id,agent_id,stream_id,content,covers_through_seq",
      order: ["updated_at", { ascending: false }],
      limit: MAX_STREAMS,
    },
  );
  const streamIds = [...new Set(rows.map((row) => row.stream_id).filter(Boolean))];
  if (!streamIds.length) return [];
  const streams = await db.streams.list([["id", streamIds]], { columns: "id,name", limit: MAX_STREAMS });
  const nameOf = new Map(streams.map((stream) => [stream.id, stream.name]));
  // 顺序要稳定：同一批素材两次跑出来的输入必须逐字一致，否则前缀缓存和归并结果都没法复现。
  return rows
    .map((row) => ({
      agent_id: row.agent_id,
      stream_id: row.stream_id,
      stream_name: nameOf.get(row.stream_id) ?? "（该群已解散）",
      content: String(row.content ?? ""),
      covers: Number(row.covers_through_seq ?? 0),
    }))
    .sort((left, right) => `${left.stream_name}${left.agent_id}`.localeCompare(`${right.stream_name}${right.agent_id}`, "zh-CN"));
}

/**
 * 这名主人名下是否已经有一封还没跑完的归并信（排队或在跑）。
 * 去重按「主人」而不是按 (员工, 群)：全局记忆一个主人只有一行，两个员工同时做梦就是两条写同一行的流水账，
 * 后写的会把先写的盖掉。手动按钮与排程投递读的是同一个口径，否则两处会各判各的。
 */
export async function dreamingPending(db, ownerId) {
  const agents = await db.agents.list([["owner_id", ownerId]], { columns: "id", limit: MAX_STREAMS });
  if (!agents.length) return false;
  const pending = await db.mail.list(
    [["agent_id", agents.map((agent) => agent.id)], ["status", ["queued", "running"]]],
    { columns: "meta", limit: 200 },
  );
  return pending.some((row) => row.meta?.kind === "dreaming");
}

/** 投一封做梦信：队里已经有一封就不重复投。 */
export async function queueDreaming(db, { ownerId, agentId, streamId, reason = "manual" }) {
  const agents = await db.agents.list([["owner_id", ownerId]], { columns: "id", limit: MAX_STREAMS });
  if (!agents.length) return { queued: false, reason: "no_agent" };
  if (await dreamingPending(db, ownerId)) return { queued: false, reason: "already_pending" };
  const created = await db.mail.insert({
    id: newId(), agent_id: agentId, stream_id: streamId, message_id: null,
    trigger_seq: 0, priority: 1, status: "queued", slice_count: 0, error: null,
    created_at: now(), started_at: null, finished_at: null, updated_at: now(),
    meta: { kind: "dreaming", reason, owner_id: ownerId },
  }, { columns: "id" });
  return { queued: Boolean(created), mail_id: created?.id ?? null };
}

/**
 * 跑一次归并。返回的 status 是给邮箱和轨迹读的：
 * noop 是没活（所有群的水位线都没往前走，不付那次模型调用）、superseded 是别的主人自己的
 * 另一封做梦信先写成了这一行（本次结果不覆盖它），这两种都不算失败。
 */
export async function runDream({ db, env, agent, stream, key, trace, directive = null }) {
  const ownerId = agent.owner_id;
  const previous = await ownerDream(db, ownerId);
  const cursor = previous?.covers_streams && typeof previous.covers_streams === "object"
    ? previous.covers_streams
    : {};
  const inputs = await dreamInputs(db, ownerId);
  const fresh = inputs.filter((row) => row.covers > Number(cursor[sourceKey(row)] ?? 0));
  if (!fresh.length) {
    return { status: "noop", streams: inputs.length, content: previous?.content ?? "" };
  }

  // 装不下的群不算这次归并的一部分，水位也就不往前推——留到下一次。
  // 不这么处理的话，超出预算的素材会被当成"已归并"跳过，那一段结论永久消失。
  const { inputChars, outputChars } = dreamBudgets(env);
  const picked = [];
  let used = 0;
  for (const row of fresh) {
    const cost = row.content.length + row.stream_name.length + 24;
    if (picked.length && used + cost > inputChars) break;
    picked.push(row);
    used += cost;
  }

  const previousContent = String(previous?.content ?? "");
  const material = picked
    .map((row) => `【群「${row.stream_name}」摘要，已覆盖到 #${row.covers}】\n${row.content}`)
    .join("\n\n");
  // 口径是"份素材"不是"个群"：同一个群里两个员工各折一份摘要，那是两份素材、一个群。
  const note = `归并 ${picked.length} 份群摘要（共 ${fresh.length} 份有新材料），`
    + `输入 ${material.length} 字${previousContent ? `，已有全局记忆 ${previousContent.length} 字` : ""}`
    + (directive ? `，并按主人这次写下的要求` : "");
  // 指令进了请求体就必须能从轨迹复原，所以它同时出现在系统正文和这一步的 detail 里。
  const ask = `把下面这些各个群的要点归并成一份不超过 ${outputChars} 字的主人全局记忆。`
    + "保留跨群都成立的稳定事实、还没办完的待办、人名与数字；同一件事在几个群里重复出现就合并成一条，"
    + "已被后一条推翻的旧结论不要留。只写正文，不要解释你做了什么。"
    + (directive ? `\n主人这次额外交代：${directive}` : "");

  const step = await trace.openDream({ model: agent.model });
  let failure = null;
  let content = "";
  try {
    // 归并是一次性提问：和压缩摘要同一口径，不借用任何群的 session，免得跨群结论混进群对话史。
    const result = await completeForAgent({
      db, agent, streamId: stream.id, key,
      messages: [
        { role: "system", content: ask },
        {
          role: "user",
          content: previousContent
            ? `已有全局记忆：\n${previousContent}\n\n这次要并进去的各群要点：\n${material}`
            : `各群要点：\n${material}`,
        },
      ],
      maxTokens: Math.max(200, Math.ceil(outputChars / 1.5)),
      timeoutMs: DREAM_TIMEOUT_MS,
      summary: { lines: picked.map((row) => `${row.stream_name}：${row.content}`) },
      persistSession: false,
    });
    content = String(result.content ?? "");
    // 预算收在看得见最终正文的那一处：maxTokens 只是请求侧的期望，模型回得再长，
    // 落库和每轮提示词里的那份都不许超过 outputChars——这一份是要每轮都付的。
    const modelChars = Array.from(content).length;
    content = truncate(content, outputChars);
    // 空正文等于一份素材都没并进去：水位线不能推，否则下一轮看到"已归并"就再也不来了。
    if (!content) failure = "dream_empty";
    await trace.close(step, {
      status: failure ? "failed" : "done",
      error: failure,
      detail: {
        reasoning: result.reasoning ?? "",
        content,
        note,
        directive: directive ?? "",
        model_chars: modelChars,
        merged_streams: picked.map(dreamStamp),
        skipped_streams: fresh.slice(picked.length).map(dreamStamp),
      },
      usage: result.usage,
      firstTokenMs: result.first_token_ms,
    });
  } catch (error) {
    failure = String(upstreamCode(error, "dream_failed"));
    await trace.close(step, {
      status: "failed",
      error: failure,
      detail: {
        note,
        directive: directive ?? "",
        merged_streams: [],
        skipped_streams: fresh.map(dreamStamp),
      },
    });
  }
  if (failure) throw Object.assign(new Error(failure), { code: failure });

  const merged = { ...cursor };
  for (const row of picked) merged[sourceKey(row)] = row.covers;
  const stamp = now();
  const saved = previous
    // CAS 写在"我读到的那一行还没被人动过"上：同一主人的另一封做梦信先落成了这一行，
    // 这次就不覆盖它——两份归并结果哪个更新无法判断，留着先写成的那一份才是确定的事。
    ? await db.memories.claim([["id", previous.id], ["updated_at", previous.updated_at]], {
      content,
      covers_streams: merged,
      agent_id: agent.id,
    })
    : await db.memories.insert({
      id: newId(),
      agent_id: agent.id,
      owner_id: ownerId,
      scope: "owner",
      stream_id: null,
      kind: "dream",
      content,
      covers_streams: merged,
      covers_through_seq: null,
      source: "dreaming",
      created_at: stamp,
      updated_at: stamp,
    }, { columns: "id" });
  if (!saved) return { status: "superseded", streams: picked.length, content: previousContent };
  return { status: "ok", streams: picked.length, content, covers: merged };
}

/** 主人自己名下最近一次做梦的信：界面上「上一次归并」读它，不另存一份状态。 */
async function lastDreamMail(db, ownerId) {
  const agents = await db.agents.list([["owner_id", ownerId]], { columns: "id", limit: MAX_STREAMS });
  if (!agents.length) return null;
  const rows = await db.mail.list([["agent_id", agents.map((agent) => agent.id)]], {
    columns: "id,agent_id,stream_id,status,error,meta,created_at,finished_at",
    order: ["created_at", { ascending: false }],
    limit: 50,
  });
  return rows.find((row) => row.meta?.kind === "dreaming") ?? null;
}

const dreamView = (mail) => (mail ? {
  mail_id: mail.id,
  agent_id: mail.agent_id,
  stream_id: mail.stream_id,
  status: mail.status,
  error: mail.error,
  reason: mail.meta?.reason ?? null,
  finished_at: mail.finished_at,
} : null);

export const actions = {
  /**
   * 主人看自己的全局记忆：当前内容、覆盖了哪些群的水位、自动开关、上一次归并。
   * 不在这儿带排程列表——那属于 cron.list，一处事实只有一个家，界面要用就在同一屏已经拿到的那份里数。
   */
  async "dreaming.get"({ db, user }) {
    const [memory, last] = await Promise.all([
      ownerDream(db, user.id),
      lastDreamMail(db, user.id),
    ]);
    return json({
      ok: true,
      auto: Boolean(user.prefs?.dreaming_auto),
      memory: memory ? {
        id: memory.id,
        content: memory.content,
        agent_id: memory.agent_id,
        covers_streams: memory.covers_streams ?? {},
        updated_at: memory.updated_at,
      } : null,
      last_run: dreamView(last),
    });
  },

  /**
   * 立刻归并一次：只投信，不在请求里等模型跑完——归并和压缩一样是后台活，
   * 前端按 mail 的状态看这一次成没成。
   */
  async "dreaming.run"({ db, user, body }) {
    const agentId = uuid(body.agent_id, "agent_id");
    const streamId = uuid(body.stream_id, "stream_id");
    const agent = await db.agents.byId(agentId, { columns: "id,name,owner_id,status" });
    if (!agent) throw new Halt("agent_not_found", 404);
    if (agent.owner_id !== user.id) throw new Halt("agent_not_owned", 403);
    await requireMembership(db, streamId, user.id);
    const inStream = await db.members.first(
      [["stream_id", streamId], ["principal_type", "agent"], ["principal_id", agent.id]],
      { columns: "id" },
    );
    if (!inStream) throw new Halt("agent_not_in_stream", 400);
    const queued = await queueDreaming(db, { ownerId: user.id, agentId: agent.id, streamId, reason: "manual" });
    return json({ ok: true, ...queued });
  },

  /**
   * 清掉全局记忆。连同覆盖水位一起清：留着水位就是告诉下一次"各群要点已经并过了"，
   * 用户删掉的这一份就永远没人再并进来。
   */
  async "dreaming.clear"({ db, user }) {
    const removed = await db.memories.removeAll([
      ["owner_id", user.id], ["scope", "owner"], ["kind", "dream"],
    ]);
    return json({ ok: true, cleared: removed });
  },
};

/** 排程那一侧要接受的 purpose 值：只有这一个和"没有"两种形态合法。 */
export const DREAM_PURPOSE = "dreaming";

export function normalizePurpose(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value !== DREAM_PURPOSE) throw new Halt("invalid_purpose", 400);
  return value;
}
