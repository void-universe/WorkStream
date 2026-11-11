// 虚拟员工：独立 API Key + OpenAI 兼容地址，两级 memory（common 与 per-stream）。
import { open, seal } from "./sec.mjs";
import { agentPresence } from "./presence.mjs";
import { askCloudAgent, checkCloudAccess, parseAgentId } from "./qca.mjs";
import { BACKENDS, BACKEND_IDS, DEMO_BASE_URL, backendFor } from "./backends.mjs";
import { demoCopy, demoLang, langOf } from "./copy.mjs";
import { installDefaultSkillsFor, skillsForAgent } from "./skills.mjs";
import { serverById } from "./servers.mjs";
import { askStreamServer, checkStreamAccess, probeStreamProfile } from "./stream.mjs";
import { DEDICATED_PROFILE } from "./streamspec.mjs";
import { normalizeUsage } from "./usage.mjs";
import { Halt, CONTEXT_CHARS_DEFAULT, CONTEXT_CHARS_MAX, Interrupted, avatarData, int, json, maskKey, newId, now, oneOf, safeApiBaseUrl, text, truncate, uuid } from "./util.mjs";

export const AGENT_COLUMNS =
  "id,owner_id,name,role,signature,avatar,api_base_url,api_key_tail,model,system_prompt,context_chars,key_source,color,status,backend,qca_agent_id,qca_environment_id,stream_profile,compact_at,created_at,updated_at";

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
    const presence = await agentPresence(db, agent.id, { lang: langOf(user.prefs) });
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
    const detail = await agentPresence(db, agentId, { streamIds: shared, lang: langOf(user.prefs) });
    if (!detail) throw new Halt("agent_not_found", 404);
    return json({ ok: true, is_owner: isOwner, ...detail });
  },

  async "agents.create"({ db, user, body, env }) {
    const name = text(body.name, { max: 48, name: "name" });
    const role = text(body.role, { max: 400, name: "role" });
    // 新建档默认走规范入口：发现决定 shared/dedicated，只认 OpenAI 兼容的地址自动退回那一档。
    // 演示端点与云端不是"默认猜一档"，要显式选 backend（demo://local 挂 stream 会被 assertBackendPair 拒）。
    const backend = oneOf(body.backend ?? "stream", BACKEND_IDS, "backend");
    // 从已登记的部署 server 建员工：地址、令牌与档位都来自那一行；员工仍存自己的一份副本，
    // 所以以后删掉这台 server 不会把已经跑在上面的员工一起弄坏。
    const server = body.server_id ? await serverById(db, user, body.server_id) : null;
    if (server && backend !== "stream") {
      throw new Halt("server_needs_stream_backend", 400, { backend });
    }
    const target = server ? { url: server.base_url } : safeApiBaseUrl(body.api_base_url, { allowPrivate: privateAllowed(env) });
    const apiKey = server
      ? await open(server.token_cipher, { supabase: db.client, env })
      : text(body.api_key, { max: 400, name: "api_key" });
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
    const compactAt = int(body.compact_at, { min: 10, max: 100, name: "compact_at", fallback: 95 });
    assertBackendPair(backend, target.url, model);
    // 规范对接那一档必须先问清楚再落库：这一格决定提示词措辞与工具注入，两样都发生在调用之前。
    // 问不出结论（连不上/超时/令牌被拒）就整个建档失败——留着一个空档的员工，每轮任务都失败在
    // backendFor 上，而群里那句「这次没能完成」说不清是地址不通还是令牌不对。
    const streamProfile = backend === "stream" ? await probeProfile(target.url, apiKey) : null;
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
      compact_at: compactAt,
      key_source: sealed.key_source,
      backend,
      qca_agent_id: qcaAgentId,
      qca_environment_id: null,
      stream_profile: streamProfile,
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
    // 这一轮请求里给过的明文令牌：改档要拿它去问对方认哪一档，不能再解一次密文。
    let keyGiven = null;
    // 换一台已登记的部署 server：整份复制地址、密封令牌与档位，和手填走同一条发现校验。
    if (body.server_id) {
      const server = await serverById(db, user, body.server_id);
      keyGiven = await open(server.token_cipher, { supabase: db.client, env });
      values.backend = "stream";
      values.api_base_url = server.base_url;
      values.api_key_cipher = server.token_cipher;
      values.api_key_tail = server.token_tail;
      values.key_source = server.key_source;
    }
    if (body.name !== undefined) values.name = text(body.name, { max: 48, name: "name" });
    if (body.role !== undefined) values.role = text(body.role, { max: 400, name: "role" });
    if (body.model !== undefined) values.model = text(body.model, { max: 120, name: "model" });
    if (body.system_prompt !== undefined) values.system_prompt = text(body.system_prompt, { max: 4000, required: false });
    if (body.signature !== undefined) values.signature = text(body.signature, { max: 120, required: false });
    if (body.avatar !== undefined) values.avatar = avatarData(body.avatar);
    if (body.context_chars !== undefined) {
      values.context_chars = int(body.context_chars, { min: 2000, max: CONTEXT_CHARS_MAX, name: "context_chars" });
    }
    if (body.compact_at !== undefined) {
      values.compact_at = int(body.compact_at, { min: 10, max: 100, name: "compact_at" });
    }
    if (body.status !== undefined) values.status = oneOf(body.status, ["active", "paused"], "status");
    if (body.backend !== undefined && !body.server_id) {
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
    if (body.api_base_url !== undefined && !body.server_id) {
      const target = safeApiBaseUrl(body.api_base_url, { allowPrivate: privateAllowed(env) });
      values.api_base_url = target.url;
      // 换了 API 地址等于换了云端账号所在的那套服务，缓存的 environment/session 都不再适用。
      if ((agent.backend ?? "openai") === "qca") values.qca_environment_id = null;
    }
    if (body.api_key && !body.server_id) {
      const apiKey = text(body.api_key, { max: 400, name: "api_key" });
      keyGiven = apiKey;
      const sealed = await seal(apiKey, { supabase: db.client, env });
      values.api_key_cipher = sealed.cipher;
      values.api_key_tail = maskKey(apiKey);
      values.key_source = sealed.key_source;
      // PAT 换了，云端那侧的 session 归属可能就变了；缓存一律作废，下一轮重新建。
      if ((agent.backend ?? "openai") === "qca") values.qca_environment_id = null;
    }
    // 改档也要成对：只改地址或只改模型名都可能凑出"云端后端 + 演示地址"这种跑不通的组合。
    const nextBackend = values.backend ?? agent.backend ?? "openai";
    assertBackendPair(nextBackend, values.api_base_url ?? agent.api_base_url, values.model ?? agent.model);
    // 规范对接那一档：地址、令牌、后端任何一样变了都要重新问一次，问不出结论就整个改档失败，
    // 档案一个字不改（旧地址配旧档位仍然自洽，比新地址配旧档位强）。换到别的后端就把这一格清空。
    if (nextBackend === "stream") {
      if (values.backend !== undefined || values.api_base_url !== undefined || values.api_key_cipher !== undefined) {
        const secret = await db.agents.byId(agent.id, { columns: AGENT_SECRET_COLUMNS });
        const apiKey = keyGiven ?? await open(secret?.api_key_cipher, { supabase: db.client, env });
        values.stream_profile = await probeProfile(values.api_base_url ?? agent.api_base_url, apiKey);
      }
    } else if ((agent.backend ?? "openai") === "stream") {
      values.stream_profile = null;
    }
    const updated = await db.agents.claim([["id", agent.id], ["owner_id", user.id]], values);
    if (!updated) throw new Halt("agent_update_failed", 503);
    const cleared = values.backend === "openai" || values.qca_agent_id !== undefined
      || values.api_base_url !== undefined || values.api_key_cipher !== undefined;
    if ((agent.backend ?? "openai") === "qca" && cleared) {
      await db.qca_sessions.removeAll([["agent_id", agent.id]]);
    }
    // 对方那侧的会话缓存也是围着 (地址, 令牌, 档位) 建的：这三样任何一样变了都一起作废。
    if ((agent.backend ?? "openai") === "stream" && (cleared || values.stream_profile !== undefined)) {
      await db.stream_sessions.removeAll([["agent_id", agent.id]]);
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
    await db.stream_sessions.removeAll([["agent_id", agent.id]]);
    // 排程也是挂在"这个员工还会干活"这个前提上的：留着行，时钟照旧一格少走，每次到点投一封注定失败的信。
    await db.schedules.removeAll([["agent_id", agent.id]]);
    const removed = await db.agents.remove([["id", agent.id], ["owner_id", user.id]]);
    if (!removed) throw new Halt("agent_delete_failed", 503);
    return json({ ok: true, id: agent.id });
  },

  /** 连接自检：云端 Agent 只验 PAT 与地址成对（不建 session，不动用量），规范对接那一档先问档位再跑一轮，
   *  其余通道走同一派发口发一条极短对话。 */
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
      if (backend.transport === "stream") {
        const access = await checkStreamAccess({ baseUrl: agent.api_base_url, token: key });
        // 压根没答上（连不上/超时/令牌被拒）就别再跑那一轮了：跑也是跑在旧档位上，
        // 报出来的失败与真实原因无关。
        if (!access.storable) {
          return json({
            ok: true,
            result: {
              reachable: false, ms: Date.now() - started,
              error: access.code, detail: access.detail, note: backend.testNote,
            },
          });
        }
        // 问出来的档位要写回档案：自检报的那一档与员工实际跑的那一档必须是同一个值，
        // 否则界面上写着"专属员工"、提示词却按分时那一档拼（工具一个也发不出去）。
        const stored = Boolean(await db.agents.claim(
          [["id", agent.id], ["owner_id", user.id]], { stream_profile: access.profile },
        ));
        const row = await db.agents.byId(agent.id, { columns: AGENT_COLUMNS });
        const facts = {
          reachable: true,
          ms: Date.now() - started,
          mode: backendFor(row).id,
          stored,
          speaks_spec: access.speaks_spec,
          profile: access.profile,
          spec: access.spec,
          profiles: access.profiles,
          label: access.label,
          models: access.models,
          code: access.code,
          detail: access.detail,
        };
        // 专属档的会话建在对方那侧，自检不替用户建会话、不动用量——与云端 Agent 那一档同口径。
        if (access.profile === DEDICATED_PROFILE) {
          return json({ ok: true, result: { ...facts, reply: null } });
        }
        const result = await completeForAgent({
          db, agent: row, key, messages: [{ role: "user", content: "ping" }], maxTokens: 8, timeoutMs: 20000,
        });
        return json({ ok: true, result: { ...facts, reply: truncate(result.content ?? "", 80) } });
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
 * 规范对接那一档同理，而且更早一步：发现请求要发到这个地址上，demo://local 根本不是一个能出网的地址。
 */
function assertBackendPair(backendId, url, model) {
  if (url !== DEMO_BASE_URL) return;
  if (backendId === "qca") throw new Halt("qca_needs_real_origin", 400);
  if (backendId === "stream") throw new Halt("stream_needs_real_origin", 400);
  if (model !== "demo") throw new Halt("demo_needs_demo_model", 400);
}

/** 问对方认哪一档，失败翻成 Halt。handler 的 respond 只认 Halt，StreamError 穿过去就只剩一句
 *  server_error——用户分不清是地址不通、令牌被拒还是对方答了一份不合规范的描述符。 */
async function probeProfile(baseUrl, apiKey) {
  try {
    return await probeStreamProfile({ baseUrl, token: apiKey });
  } catch (error) {
    const status = Number(error?.status);
    throw new Halt(
      error?.streamCode ?? "stream_unreachable",
      status >= 400 && status < 600 ? status : 502,
    );
  }
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
  // 规范对接那台 server 同理：一族 stream_* 的码在客户端抛出的那一刻就长好了（functions/stream.mjs）。
  if (error?.streamCode) return String(error.streamCode);
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
 * onDelta 是给规范的参考实现（functions/streamserver.mjs）留的口子：它要把这一路的增量原样转成
 * turn.delta 帧发出去。入参是 { content, reasoning, usage }，usage 只在收到用量块的那一发上有值
 * （那一发正文与思考链都是空的）。只往外交增量、不参与这一轮的结果，不传就与从前一模一样。
 */
export async function chatCompletion({
  baseUrl, apiKey, model, messages, tools, maxTokens, timeoutMs = 120000, onInterrupt, onDelta = null,
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
  return readUpstreamStream(response.body, { onInterrupt, onDelta, started });
}

/** 内置演示模型：不联网，基于传入的 memory 与历史做抽取式回应，用来在没有任何真实 Key 时
 *  也能端到端跑通 @ 派发、队列、压缩与插话。没有真实思考链和用量，字段一律留空，
 *  前端据此标注"演示模型不回报"，而不是编一个数字让轨迹看起来像真的。 */
async function demoRound({ messages, tools, summary, lang, window }) {
  return { reasoning: "", usage: null, finish_reason: null, first_token_ms: null, ...demoComplete({ messages, tools, summary, lang, window }) };
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
  demo: async ({ db, agent, messages, tools, summary, window }) =>
    demoRound({ messages, tools, summary, window, lang: await demoLang(db, agent) }),
  cloud: ({ db, agent, streamId, key, messages, timeoutMs, onInterrupt, persistSession }) =>
    askCloudAgent({ db, agent, streamId, pat: key, messages, timeoutMs, onInterrupt, persistSession }),
  // 规范对接那条：走哪一档由档案里的发现结果决定（functions/stream.mjs）。退回 OpenAI 兼容那一档的
  // 实现是递进去的，不是被它 import 的——本模块已经 import 了 stream.mjs，反过来就成了环。
  stream: (args) => askStreamServer({ ...args, openai: (rest) => TRANSPORT_ROUTES.chat(rest) }),
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
export async function completeForAgent({ db, agent, streamId, key, messages, tools, maxTokens, timeoutMs, summary, window, onInterrupt, persistSession }) {
  const route = TRANSPORT_ROUTES[backendFor(agent).transport];
  return route({ db, agent, streamId, key, messages, tools, maxTokens, timeoutMs, summary, window, onInterrupt, persistSession });
}

const IDLE_MS = 800;

/** 解析 `data:` 分片，累加正文与按 index 拼接的工具参数；每次拿到数据或上游静默时检查插话。 */
async function readUpstreamStream(stream, { onInterrupt, onDelta = null, started }) {
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
    const piece = typeof delta?.content === "string" ? delta.content : "";
    content += piece;
    reasoning += thinking;
    if (onDelta && token > 0) onDelta({ content: piece, reasoning: thinking, usage: null });
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (parsed?.usage) {
      usage = normalizeUsage(parsed.usage);
      // 上游那份用量块原样交出去：规范认的是上游形状（prompt_tokens/...），客户端落库前自己再归一化一次。
      // 归一化后的四个数是我们的内部口径，发出去字段名就没了，参考实现无从照规范填 turn.done 的 usage。
      if (onDelta) onDelta({ content: "", reasoning: "", usage: parsed.usage });
    }
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
function demoComplete({ messages, tools, summary, lang, window }) {
  const copy = demoCopy(lang);
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
    return { mode: "demo", content: lines.join("\n") || copy.summaryEmpty, tool_calls: [] };
  }
  // 摘录只从窗口里的真人发言取，不从拼好的正文里按行扫：虚拟员工自己的回帖是多行的，
  // 正文里还引着上一轮摘录的转录行与记忆行，按行扫会把这些二次转述当成新事实，
  // 于是每一轮回帖都在复读上一条回帖，越绕越远。窗口行是群里的记录本身，也保证内部提示进不来。
  const humans = (window ?? []).filter((row) => row.sender_type === "human");
  // 摘录按读者的语言重排一遍：转录行的格式（[人]、全角冒号）是中文写法，原样贴进英文界面
  // 就是一道中文标签。中文那一套与 transcript.mjs 渲染出的字节相同，所以摘录仍是模型看到的那一行。
  const facts = humans.slice(-3).map((row) => truncate(copy.line({
    marker: "#",
    seq: row.seq,
    kind: "人",
    sender: row.sender_name,
    body: String(row.content ?? "").replace(/\s+/g, " "),
    images: Array.isArray(row.attachments) ? row.attachments.length : 0,
  }), 80));
  // 复述的那一句得是群里真说过的话。用户位那一条是内部包装语（composeAsk 只有一句“按上面回应”），
  // 照抄它等于把提示词念进群，所以要回应谁的话从转录里取；转录里没有人的发言才退回用户位。
  const asked = humans.at(-1)?.content;
  return {
    mode: "demo",
    content: [
      copy.ack(truncate(asked || prompt, 120)),
      facts.length ? `${copy.factsLead}\n${facts.join("\n")}` : "",
    ].filter(Boolean).join("\n\n"),
    tool_calls: [],
  };
}

export { open, seal };
