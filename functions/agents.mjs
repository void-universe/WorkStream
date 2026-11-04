// 虚拟员工：独立 API Key + OpenAI 兼容地址，两级 memory（common 与 per-stream）。
import { open, seal } from "./sec.mjs";
import { agentPresence } from "./presence.mjs";
import { askCloudAgent, checkCloudAccess, parseAgentId } from "./qca.mjs";
import { BACKENDS, BACKEND_IDS, DEMO_BASE_URL, backendFor } from "./backends.mjs";
import { DEMO_QUOTABLE_HEADERS } from "./prompt.mjs";
import { installDefaultSkillsFor, skillsForAgent } from "./skills.mjs";
import { Halt, CONTEXT_CHARS_DEFAULT, CONTEXT_CHARS_MAX, Interrupted, avatarData, int, json, maskKey, newId, now, oneOf, safeApiBaseUrl, text, truncate, uuid } from "./util.mjs";

export const AGENT_COLUMNS =
  "id,owner_id,name,role,signature,avatar,api_base_url,api_key_tail,model,system_prompt,context_chars,key_source,color,status,backend,qca_agent_id,qca_environment_id,created_at,updated_at";

/** 只有服务端自用：密文列永不出现在任何响应里。 */
export const AGENT_SECRET_COLUMNS = "id,owner_id,api_key_cipher";

const COLORS = ["#0f7b6c", "#8e51ff", "#f54900", "#009689", "#104e64", "#ffb900", "#fe9a00", "#ad46ff"];

async function ownedAgent(db, user, id) {
  const agent = await db.agents.byId(uuid(id, "agent_id"), { columns: AGENT_COLUMNS });
  if (!agent) throw new Halt("agent_not_found", 404);
  if (agent.owner_id !== user.id) throw new Halt("agent_not_owned", 403);
  return agent;
}

export const actions = {
  async "agents.list"({ db, user }) {
    const rows = await db.agents.list([["owner_id", user.id]], {
      columns: AGENT_COLUMNS, order: ["created_at", { ascending: true }],
    });
    return json({ ok: true, items: rows });
  },

  async "agents.get"({ db, user, params }) {
    const agent = await ownedAgent(db, user, params.get("id"));
    const memories = await db.memories.list([["agent_id", agent.id], ["scope", "common"]], {
      columns: "id,kind,content,covers_through_seq,created_at,updated_at,source",
      order: ["created_at", { ascending: false }], limit: 100,
    });
    const streams = await db.members.list([["principal_type", "agent"], ["principal_id", agent.id]], {
      columns: "stream_id,role,joined_at", limit: 100,
    });
    const presence = await agentPresence(db, agent.id);
    return json({
      ok: true,
      agent,
      common_memory: memories,
      skills: await skillsForAgent(db, agent.id),
      streams,
      queue: presence?.queue ?? [],
      current: presence?.current ?? null,
      key_source: agent.key_source,
    });
  },

  /** 员工现场：主人或同群成员可看；只回资料、所在群与邮箱状态，不含 Key、提示词与记忆。 */
  async "agents.presence"({ db, user, params }) {
    const agentId = uuid(params.get("agent_id"), "agent_id");
    const agent = await db.agents.byId(agentId, { columns: "id,owner_id" });
    if (!agent) throw new Halt("agent_not_found", 404);
    const isOwner = agent.owner_id === user.id;
    let shared = null;
    if (!isOwner) {
      const [mine, theirs] = await Promise.all([
        db.members.list([["principal_type", "human"], ["principal_id", user.id]], {
          columns: "stream_id", limit: 300,
        }),
        db.members.list([["principal_type", "agent"], ["principal_id", agentId]], {
          columns: "stream_id", limit: 60,
        }),
      ]);
      const mineSet = new Set(mine.map((row) => row.stream_id));
      shared = [...new Set(theirs.filter((row) => mineSet.has(row.stream_id)).map((row) => row.stream_id))];
      if (!shared.length) throw new Halt("agent_profile_forbidden", 403);
    }
    const detail = await agentPresence(db, agentId, { streamIds: shared });
    if (!detail) throw new Halt("agent_not_found", 404);
    return json({ ok: true, is_owner: isOwner, ...detail });
  },

  async "agents.create"({ db, user, body, env }) {
    const name = text(body.name, { max: 48, name: "name" });
    const role = text(body.role, { max: 400, name: "role" });
    const backend = oneOf(body.backend ?? "openai", BACKEND_IDS, "backend");
    const target = safeApiBaseUrl(body.api_base_url, { allowPrivate: privateAllowed(env) });
    const apiKey = text(body.api_key, { max: 400, name: "api_key" });
    // 云端 Agent 的模型由云上那份定义决定，本地只留一个展示名。
    const model = backend === "qca"
      ? text(body.model ?? "云端 Agent", { max: 120, name: "model" })
      : text(body.model, { max: 120, name: "model" });
    const qcaAgentId = backend === "qca" ? parseAgentId(body.qca_agent_id) : null;
    const systemPrompt = text(body.system_prompt ?? "", { max: 4000, required: false });
    const signature = text(body.signature ?? "", { max: 120, required: false });
    const avatar = avatarData(body.avatar);
    const contextChars = int(body.context_chars, {
      min: 2000, max: CONTEXT_CHARS_MAX, name: "context_chars", fallback: CONTEXT_CHARS_DEFAULT,
    });
    assertBackendPair(backend, target.url, model);
    const sealed = await seal(apiKey, { supabase: db.client, env });
    const id = newId();
    const created = await db.agents.insert({
      id,
      owner_id: user.id,
      name,
      role,
      api_base_url: target.url,
      api_key_cipher: sealed.cipher,
      api_key_tail: maskKey(apiKey),
      model,
      system_prompt: systemPrompt,
      signature,
      avatar,
      context_chars: contextChars,
      key_source: sealed.key_source,
      backend,
      qca_agent_id: qcaAgentId,
      qca_environment_id: null,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      status: "active",
      created_at: now(),
      updated_at: now(),
    }, { columns: AGENT_COLUMNS });
    if (!created) throw new Halt("agent_create_failed", 503);
    await db.memories.insert({
      id: newId(),
      agent_id: id,
      scope: "common",
      stream_id: null,
      kind: "note",
      content: `建档：${role}`,
      covers_through_seq: null,
      source: "owner",
      created_at: now(),
      updated_at: now(),
    }, { columns: "id" });
    await installDefaultSkillsFor(db, id, user.id);
    return json({ ok: true, agent: created });
  },

  async "agents.update"({ db, user, body, env }) {
    const agent = await ownedAgent(db, user, body.id);
    const values = { updated_at: now() };
    if (body.name !== undefined) values.name = text(body.name, { max: 48, name: "name" });
    if (body.role !== undefined) values.role = text(body.role, { max: 400, name: "role" });
    if (body.model !== undefined) values.model = text(body.model, { max: 120, name: "model" });
    if (body.system_prompt !== undefined) values.system_prompt = text(body.system_prompt, { max: 4000, required: false });
    if (body.signature !== undefined) values.signature = text(body.signature, { max: 120, required: false });
    if (body.avatar !== undefined) values.avatar = avatarData(body.avatar);
    if (body.context_chars !== undefined) {
      values.context_chars = int(body.context_chars, { min: 2000, max: CONTEXT_CHARS_MAX, name: "context_chars" });
    }
    if (body.status !== undefined) values.status = oneOf(body.status, ["active", "paused"], "status");
    if (body.backend !== undefined) {
      const next = oneOf(body.backend, BACKEND_IDS, "backend");
      // 换后端等于换一类凭据（sk- 的 Key 和 pt- 的 PAT 不能混用），没给新凭据就挡住，
      // 别让员工带着错凭据上岗、每轮任务都失败在云端鉴权上。
      if (next !== (agent.backend ?? "openai") && !body.api_key) throw new Halt("agent_key_required_for_backend", 400);
      values.backend = next;
      if (next === "qca") {
        // 换到云端后端：必须一起有 agent id（没给就沿用已存的），origin 由 api_base_url 那一路校验。
        values.qca_agent_id = parseAgentId(body.qca_agent_id ?? agent.qca_agent_id);
      } else {
        values.qca_agent_id = null;
        values.qca_environment_id = null;
      }
    } else if (body.qca_agent_id !== undefined && (agent.backend ?? "openai") === "qca") {
      values.qca_agent_id = parseAgentId(body.qca_agent_id);
      // 改挂另一个云端 agent：environment 与 session 缓存都是围着旧 agent 建的，一起作废。
      values.qca_environment_id = null;
    }
    if (body.api_base_url !== undefined) {
      const target = safeApiBaseUrl(body.api_base_url, { allowPrivate: privateAllowed(env) });
      values.api_base_url = target.url;
      // 换了 API 地址等于换了云端账号所在的那套服务，缓存的 environment/session 都不再适用。
      if ((agent.backend ?? "openai") === "qca") values.qca_environment_id = null;
    }
    if (body.api_key) {
      const apiKey = text(body.api_key, { max: 400, name: "api_key" });
      const sealed = await seal(apiKey, { supabase: db.client, env });
      values.api_key_cipher = sealed.cipher;
      values.api_key_tail = maskKey(apiKey);
      values.key_source = sealed.key_source;
      // PAT 换了，云端那侧的 session 归属可能就变了；缓存一律作废，下一轮重新建。
      if ((agent.backend ?? "openai") === "qca") values.qca_environment_id = null;
    }
    // 改档也要成对：只改地址或只改模型名都可能凑出"云端后端 + 演示地址"这种跑不通的组合。
    assertBackendPair(values.backend ?? agent.backend ?? "openai",
      values.api_base_url ?? agent.api_base_url, values.model ?? agent.model);
    const updated = await db.agents.claim([["id", agent.id], ["owner_id", user.id]], values);
    if (!updated) throw new Halt("agent_update_failed", 503);
    const cleared = values.backend === "openai" || values.qca_agent_id !== undefined
      || values.api_base_url !== undefined || values.api_key_cipher !== undefined;
    if ((agent.backend ?? "openai") === "qca" && cleared) {
      await db.qca_sessions.removeAll([["agent_id", agent.id]]);
    }
    const row = await db.agents.byId(agent.id, { columns: AGENT_COLUMNS });
    return json({ ok: true, agent: row });
  },

  async "agents.delete"({ db, user, body }) {
    const agent = await ownedAgent(db, user, body.id);
    await db.mail.patch([["agent_id", agent.id], ["status", ["queued", "running"]]], {
      status: "cancelled", error: "agent_deleted", updated_at: now(),
    });
    await db.memories.patch([["agent_id", agent.id]], { content: "[已删除虚拟员工]", updated_at: now() });
    await db.slice_prefs.patch([["agent_id", agent.id]], { weight: 1, updated_at: now() });
    const links = await db.agent_skills.list([["agent_id", agent.id]], { columns: "id", limit: 100 });
    for (const link of links) await db.agent_skills.remove([["id", link.id]]);
    // 云端 session 是按 (员工,群) 缓存的对话上下文：员工没了留着只会让下一个同 id 档案串台。
    await db.qca_sessions.removeAll([["agent_id", agent.id]]);
    // 排程也是挂在"这个员工还会干活"这个前提上的：留着行，时钟照旧一格少走，每次到点投一封注定失败的信。
    await db.schedules.removeAll([["agent_id", agent.id]]);
    const removed = await db.agents.remove([["id", agent.id], ["owner_id", user.id]]);
    if (!removed) throw new Halt("agent_delete_failed", 503);
    return json({ ok: true, id: agent.id });
  },

  /** 连接自检：云端 Agent 只验 PAT 与地址成对（不建 session，不动用量），其余通道走同一派发口发一条极短对话。 */
  async "agents.test"({ db, user, body, env }) {
    const agent = await ownedAgent(db, user, body.id);
    const secret = await db.agents.byId(agent.id, { columns: AGENT_SECRET_COLUMNS });
    const key = await open(secret?.api_key_cipher, { supabase: db.client, env });
    const backend = backendFor(agent);
    const started = Date.now();
    try {
      if (backend.transport === "cloud") {
        const check = await checkCloudAccess({ origin: agent.api_base_url, pat: key });
        return json({
          ok: true,
          result: { reachable: true, ms: Date.now() - started, mode: backend.id, note: `云端可达，可见模型 ${check.models} 个。` },
        });
      }
      const result = await completeForAgent({
        db,
        agent,
        key,
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 8,
        timeoutMs: 20000,
      });
      return json({
        ok: true,
        result: { reachable: true, ms: Date.now() - started, reply: truncate(result.content ?? "", 80), mode: result.mode },
      });
    } catch (error) {
      return json({
        ok: true,
        result: { reachable: false, ms: Date.now() - started, error: upstreamCode(error), note: backend.testNote },
      });
    }
  },

  async "agents.memory.list"({ db, user, params }) {
    const agent = await ownedAgent(db, user, params.get("agent_id"));
    const scope = params.get("scope") ?? null;
    const streamId = params.get("stream_id") ?? null;
    const pairs = [["agent_id", agent.id]];
    // 不认识的值当场拒，不塌成 "stream"：全局记忆那一层是另一个主人键（dreaming.get 读它），
    // 悄悄当成 stream 查会回一堆不相干的行，问的人还以为那一层是空的。
    if (scope) pairs.push(["scope", oneOf(scope, ["common", "stream"], "scope")]);
    if (streamId) pairs.push(["stream_id", uuid(streamId, "stream_id")]);
    const rows = await db.memories.list(pairs, {
      columns: "id,scope,stream_id,kind,content,covers_through_seq,created_at,updated_at,source",
      order: ["created_at", { ascending: false }], limit: 200,
    });
    return json({ ok: true, agent, items: rows });
  },

  async "agents.memory.put"({ db, user, body }) {
    const agent = await ownedAgent(db, user, body.agent_id);
    const content = text(body.content, { max: 4000, name: "content" });
    const scope = oneOf(body.scope ?? "common", ["common", "stream"], "scope");
    const streamId = scope === "stream" ? uuid(body.stream_id, "stream_id") : null;
    const kind = oneOf(body.kind ?? "note", ["note", "fact", "summary"], "kind");
    if (body.id) {
      const updated = await db.memories.claim(
        [["id", uuid(body.id, "id")], ["agent_id", agent.id]],
        { content, updated_at: now() },
      );
      if (!updated) throw new Halt("memory_write_failed", 503);
      return json({ ok: true, id: updated });
    }
    const created = await db.memories.insert({
      id: newId(),
      agent_id: agent.id,
      scope,
      stream_id: streamId,
      kind,
      content,
      covers_through_seq: body.covers_through_seq ?? null,
      source: "owner",
      created_at: now(),
      updated_at: now(),
    }, { columns: "id" });
    if (!created) throw new Halt("memory_write_failed", 503);
    return json({ ok: true, id: created.id });
  },

  async "agents.memory.delete"({ db, user, body }) {
    const agent = await ownedAgent(db, user, body.agent_id);
    const removed = await db.memories.remove([["id", uuid(body.id, "id")], ["agent_id", agent.id]]);
    if (!removed) throw new Halt("memory_missing", 404);
    return json({ ok: true, id: removed });
  },
};

const privateAllowed = (env) => env?.("WORKSTREAM_DEV") === "1";

/**
 * 后端、地址与模型名三样要成对：demo://local 只在自建通道里有意义（它选中内置演示模型，
 * 模型名跟着固定成 demo）。挂到云端后端会让这一轮注定连不上——建档/改档就拒，
 * 别留到员工带着错组合上岗、每轮任务都失败在取不到地址上。
 */
function assertBackendPair(backendId, url, model) {
  if (url !== DEMO_BASE_URL) return;
  if (backendId === "qca") throw new Halt("qca_needs_real_origin", 400);
  if (model !== "demo") throw new Halt("demo_needs_demo_model", 400);
}

/**
 * 上游那一步到底哪坏了——邮箱、轨迹、界面那句「这次没能完成」都读这一个函数翻出来的码。
 * 上层拿到的是 Error，不认状态码；码必须在源头就长出来，否则落到库里只剩一个裸的 500。
 * fallback 管的是"这看着不像上游的毛病"：压缩那一轮填 compress_failed，别把自家代码的错报成连不上上游。
 */
export function upstreamCode(error, fallback = "upstream_unreachable") {
  const name = error?.name === "TimeoutError" ? "upstream_timeout" : null;
  if (name) return name;
  // 云端 Agent 的失败自带环节（PAT 被拒 / 找不到 agent / 限流），比笼统的 upstream_* 有用。
  if (error?.qcaCode) return String(error.qcaCode);
  if (typeof error?.status === "number") {
    if (error.status === 401 || error.status === 403) return "upstream_unauthorized";
    if (error.status === 404) return "upstream_not_found";
    if (error.status === 429) return "upstream_rate_limited";
    if (error.status >= 500) return "upstream_server_error";
    return "upstream_bad_request";
  }
  return error?.code ?? fallback;
}

/**
 * OpenAI 兼容 /chat/completions 调用。
 * 请求走 SSE 流式：一边收增量一边在分片边界问上层“要不要停”，
 * 这样群里插话能在几百毫秒内掐断正在生成的回复，而不是等它写完。
 * 演示端点不走这里：地址等于 demo://local 的员工由清单解析成 demo 那条通道（见 functions/backends.mjs）。
 */
export async function chatCompletion({
  baseUrl, apiKey, model, messages, tools, maxTokens, timeoutMs = 120000, onInterrupt,
}) {
  const started = Date.now();
  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (maxTokens) body.max_tokens = maxTokens;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.text().catch(() => "");
    const error = new Error("upstream_rejected");
    error.status = response.status;
    // 状态码在这里就翻成有名字的错误码：上层落 mail.error 与轨迹只读 error.code，
    // 只挂 status 的话群里那句「这次没能完成」会写成裸的 500，分不清限流还是上游崩了。
    error.code = upstreamCode(error);
    throw error;
  }
  if (!response.body) {
    const error = new Error("upstream_bad_json");
    error.code = "upstream_bad_json";
    throw error;
  }
  return readUpstreamStream(response.body, { onInterrupt, started });
}

/** 内置演示模型：不联网，基于传入的 memory 与历史做抽取式回应，用来在没有任何真实 Key 时
 *  也能端到端跑通 @ 派发、队列、压缩与插话。没有真实思考链和用量，字段一律留空，
 *  前端据此标注"演示模型不回报"，而不是编一个数字让轨迹看起来像真的。 */
async function demoRound({ messages, tools, summary }) {
  return { reasoning: "", usage: null, finish_reason: null, first_token_ms: null, ...demoComplete({ messages, tools, summary }) };
}

/**
 * transport → 实现。清单（functions/backends.mjs）声明了某条 transport 而这里缺一条，
 * 冷启动就抛——照 mcp.mjs 扫「声明了但没实现」的形状，不留到运行时静默走成自建的分支。
 * 云端那条的入参里没有 tools：工具在云端 agent 自己那边，我们的群工具不注入。
 */
const TRANSPORT_ROUTES = {
  chat: ({ agent, key, ...rest }) => chatCompletion({
    baseUrl: agent.api_base_url, apiKey: key, model: agent.model, ...rest,
  }),
  demo: ({ messages, tools, summary }) => demoRound({ messages, tools, summary }),
  cloud: ({ db, agent, streamId, key, messages, timeoutMs, onInterrupt, persistSession }) =>
    askCloudAgent({ db, agent, streamId, pat: key, messages, timeoutMs, onInterrupt, persistSession }),
};

{
  const implemented = new Set(Object.keys(TRANSPORT_ROUTES));
  const declared = new Set(BACKENDS.map((entry) => entry.transport));
  const missing = [...declared].filter((name) => !implemented.has(name));
  const orphan = [...implemented].filter((name) => !declared.has(name));
  if (missing.length || orphan.length) {
    throw new Error(`后端路由对不上清单：${[...missing.map((name) => `缺实现 ${name}`), ...orphan.map((name) => `清单里没有 ${name}`)].join("、")}`);
  }
}

/**
 * 一轮模型调用的唯一分流口：按员工档案解析出后端条目，再按它的 transport 派发。
 * 返回值形状一致（content/reasoning/usage/finish_reason/mode），引擎与轨迹不用关心后端。
 * 入参一律原样递给那条通道，各自只取自己要的：过去在这里手写分支时漏传过 persistSession，
 * 压缩那轮"不复用群里 session"的注释就成了假话——加字段只要写进表和签名就不会再丢。
 */
export async function completeForAgent({ db, agent, streamId, key, messages, tools, maxTokens, timeoutMs, summary, onInterrupt, persistSession }) {
  const route = TRANSPORT_ROUTES[backendFor(agent).transport];
  return route({ db, agent, streamId, key, messages, tools, maxTokens, timeoutMs, summary, onInterrupt, persistSession });
}

const IDLE_MS = 800;

/**
 * OpenAI 用量对象 → 我们要落库的四个数；缺字段就留 null，不拿 0 冒充"没用 token"。
 * total 不落：它等于 input + output，没有哪一列需要它。
 */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pick = (...values) => values.find((value) => Number.isFinite(Number(value))) ?? null;
  const input = pick(raw.prompt_tokens);
  const output = pick(raw.completion_tokens);
  // cached/reasoning 是总数的子桶：自建端点各家口径不一，子桶比总数还大就是这份数不可信。
  // 按"不回报"收成 null——界面上的命中率与思考占比才不会算出超过 100%，也不会把它投进分母。
  const subset = (part, whole) => (part === null || whole === null || part > whole ? null : part);
  return {
    input,
    output,
    cached: subset(pick(raw.prompt_tokens_details?.cached_tokens), input),
    reasoning: subset(pick(raw.completion_tokens_details?.reasoning_tokens), output),
  };
}

/** 解析 `data:` 分片，累加正文与按 index 拼接的工具参数；每次拿到数据或上游静默时检查插话。 */
async function readUpstreamStream(stream, { onInterrupt, started }) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  let finishReason = null;
  let firstTokenMs = null;
  let sawDone = false;
  let inflight = null;
  const ensureRead = () => {
    if (!inflight) inflight = reader.read().then((result) => { inflight = null; return result; });
    return inflight;
  };
  const abort = async () => {
    if (!onInterrupt) return null;
    const signal = await onInterrupt();
    if (!signal) return null;
    await reader.cancel().catch(() => {});
    throw new Interrupted({ ...signal, partial: content });
  };
  const feed = (chunk) => {
    let parsed;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      return;
    }
    if (parsed?.error) {
      const error = new Error("upstream_rejected");
      error.status = Number(parsed.error.code) >= 100 && Number(parsed.error.code) < 600 ? Number(parsed.error.code) : 502;
      error.code = upstreamCode(error);
      throw error;
    }
    const choice = parsed?.choices?.[0];
    const delta = choice?.delta;
    // 首字延迟按“第一个有用增量”算：思考链模型的增量先于正文，正文之前的等待同样是用户等到的延迟。
    const thinking = typeof delta?.reasoning_content === "string"
      ? delta.reasoning_content
      : (typeof delta?.reasoning === "string" ? delta.reasoning : "");
    const token = (typeof delta?.content === "string" ? delta.content.length : 0) + thinking.length;
    if (firstTokenMs === null && token > 0) firstTokenMs = Date.now() - started;
    if (typeof delta?.content === "string") content += delta.content;
    reasoning += thinking;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (parsed?.usage) usage = normalizeUsage(parsed.usage);
    for (const call of delta?.tool_calls ?? []) {
      const index = Number(call?.index ?? 0);
      const slot = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (call?.id) slot.id = call.id;
      if (call?.function?.name) slot.name = call.function.name;
      if (typeof call?.function?.arguments === "string") slot.arguments += call.function.arguments;
      toolCalls.set(index, slot);
    }
  };
  for (;;) {
    let timeout;
    const idle = new Promise((resolve) => { timeout = setTimeout(() => resolve("idle"), IDLE_MS); });
    const outcome = await Promise.race([
      ensureRead().then((result) => ({ result })),
      idle.then(() => "idle"),
    ]).finally(() => clearTimeout(timeout));
    if (outcome === "idle") {
      // 上游静默也要有机会被插话掐断，所以空转时仍然问一次。
      await abort();
      continue;
    }
    if (outcome.result.done) break;
    buffer += decoder.decode(outcome.result.value, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") sawDone = true;
      else if (payload) feed(payload);
    }
    await abort();
  }
  // 走到流的尽头，既没等到 [DONE] 也没等到 finish_reason：这条连接是中途断的，半截正文不是回复。
  // 照云端那条通道的做法如实报错（functions/qca.mjs 的 qca_stream_ended_unfinished），
  // 别把断流当成"这轮说完了"——群里会留下一句永远缺尾巴的话，邮箱还标着 done。
  if (!sawDone && !finishReason) {
    const error = new Error("upstream_stream_incomplete");
    error.code = "upstream_stream_incomplete";
    throw error;
  }
  const calls = [...toolCalls.values()].filter((slot) => slot.name);
  return {
    mode: "openai",
    content,
    reasoning,
    finish_reason: finishReason,
    first_token_ms: firstTokenMs,
    tool_calls: calls.map((slot) => ({
      id: slot.id || `call_${newId().slice(0, 8)}`,
      type: "function",
      function: { name: slot.name, arguments: slot.arguments || "{}" },
    })),
    usage,
  };
}

/** 内置演示模型：有工具请求就先“查询”，否则基于上下文给出可核对的摘要式回复。 */
function demoComplete({ messages, tools, summary }) {
  const last = [...messages].reverse().find((m) => m.role === "user");
  const prompt = String(last?.content ?? "");
  const wantsTool = Boolean(tools?.length) && /查|history|之前|上文|历史|文件/.test(prompt);
  if (wantsTool) {
    const search = tools.find((t) => t.type === "function" && t.function?.name === "search_history");
    if (search) {
      return {
        mode: "demo",
        content: "",
        tool_calls: [{
          id: `call_${newId().slice(0, 8)}`,
          type: "function",
          function: { name: "search_history", arguments: JSON.stringify({ query: prompt.slice(0, 40), limit: 5 }) },
        }],
      };
    }
  }
  if (summary) {
    const lines = summary.lines.slice(0, 6).map((line) => `- ${truncate(line, 90)}`);
    return { mode: "demo", content: lines.join("\n") || "（演示压缩：本段没有可摘录的发言。）", tool_calls: [] };
  }
  const context = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  // 只从转录与两段记忆里摘录：它们本来就是群里可见的内容。指令块（守则、替身须知、触发消息）
  // 是内部提示，演示模型照抄进正文等于把提示词念给全群听。
  const quotable = context
    .split("\n\n")
    .filter((block) => DEMO_QUOTABLE_HEADERS.some((header) => block.startsWith(header)))
    .join("\n");
  const facts = (quotable.match(/^[^\n]{6,120}$/gm) ?? []).slice(-3).map((line) => truncate(line, 80));
  return {
    mode: "demo",
    content: [
      `（演示模型）收到，我把这条任务记进队列了：${truncate(prompt, 120)}`,
      facts.length ? `我当前掌握的要点：\n${facts.join("\n")}` : "",
    ].filter(Boolean).join("\n\n"),
    tool_calls: [],
  };
}

export { open, seal };
