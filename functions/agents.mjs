// 虚拟员工：独立 API Key + OpenAI 兼容地址，两级 memory（common 与 per-stream）。
import { open, seal } from "./sec.mjs";
import { agentPresence } from "./presence.mjs";
import { installDefaultSkillsFor, skillsForAgent } from "./skills.mjs";
import { Halt, avatarData, json, maskKey, newId, now, oneOf, safeApiBaseUrl, text, truncate, uuid } from "./util.mjs";

export const AGENT_COLUMNS =
  "id,owner_id,name,role,signature,avatar,api_base_url,api_key_tail,model,system_prompt,context_chars,key_source,color,status,created_at,updated_at";

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
    return json({ ok: true, items: rows.map(publicAgent) });
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
      agent: publicAgent(agent),
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
    const target = safeApiBaseUrl(body.api_base_url, { allowPrivate: privateAllowed(env) });
    const apiKey = text(body.api_key, { max: 400, name: "api_key" });
    const model = text(body.model, { max: 120, name: "model" });
    const systemPrompt = text(body.system_prompt ?? "", { max: 4000, required: false });
    const signature = text(body.signature ?? "", { max: 120, required: false });
    const avatar = avatarData(body.avatar);
    const contextChars = Number(body.context_chars ?? 12000);
    if (!Number.isSafeInteger(contextChars) || contextChars < 2000 || contextChars > 200000) {
      throw new Halt("invalid_context_chars", 400);
    }
    if (target.scheme === "demo" && model !== "demo") throw new Halt("demo_needs_demo_model", 400);
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
    return json({ ok: true, agent: publicAgent(created) });
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
      const next = Number(body.context_chars);
      if (!Number.isSafeInteger(next) || next < 2000 || next > 200000) throw new Halt("invalid_context_chars", 400);
      values.context_chars = next;
    }
    if (body.status !== undefined) values.status = oneOf(body.status, ["active", "paused"], "status");
    if (body.api_base_url !== undefined) {
      const target = safeApiBaseUrl(body.api_base_url, { allowPrivate: privateAllowed(env) });
      values.api_base_url = target.url;
    }
    if (body.api_key) {
      const apiKey = text(body.api_key, { max: 400, name: "api_key" });
      const sealed = await seal(apiKey, { supabase: db.client, env });
      values.api_key_cipher = sealed.cipher;
      values.api_key_tail = maskKey(apiKey);
      values.key_source = sealed.key_source;
    }
    const updated = await db.agents.claim([["id", agent.id], ["owner_id", user.id]], values);
    if (!updated) throw new Halt("agent_update_failed", 503);
    const row = await db.agents.byId(agent.id, { columns: AGENT_COLUMNS });
    return json({ ok: true, agent: publicAgent(row) });
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
    const removed = await db.agents.remove([["id", agent.id], ["owner_id", user.id]]);
    if (!removed) throw new Halt("agent_delete_failed", 503);
    return json({ ok: true, id: agent.id });
  },

  /** 连接自检：向所选 OpenAI 兼容端点发一条极短对话，返回状态与耗时。 */
  async "agents.test"({ db, user, body, env }) {
    const agent = await ownedAgent(db, user, body.id);
    const secret = await db.agents.byId(agent.id, { columns: AGENT_SECRET_COLUMNS });
    const key = await open(secret?.api_key_cipher, { supabase: db.client, env });
    const started = Date.now();
    try {
      const result = await chatCompletion({
        baseUrl: agent.api_base_url,
        apiKey: key,
        model: agent.model,
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
        result: {
          reachable: false,
          ms: Date.now() - started,
          error: upstreamCode(error),
          note: "上游未接受该请求；Key、模型名与 base URL 需一致。",
        },
      });
    }
  },

  async "agents.memory.list"({ db, user, params }) {
    const agent = await ownedAgent(db, user, params.get("agent_id"));
    const scope = params.get("scope") ?? null;
    const streamId = params.get("stream_id") ?? null;
    const pairs = [["agent_id", agent.id]];
    if (scope) pairs.push(["scope", scope === "common" ? "common" : "stream"]);
    if (streamId) pairs.push(["stream_id", uuid(streamId, "stream_id")]);
    const rows = await db.memories.list(pairs, {
      columns: "id,scope,stream_id,kind,content,covers_through_seq,created_at,updated_at,source",
      order: ["created_at", { ascending: false }], limit: 200,
    });
    return json({ ok: true, agent: publicAgent(agent), items: rows });
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

export const publicAgent = (row) => ({ ...row, api_key_set: true });

const privateAllowed = (env) => env?.("WORKSTREAM_DEV") === "1";

function upstreamCode(error) {
  const name = error?.name === "TimeoutError" ? "upstream_timeout" : null;
  if (name) return name;
  if (typeof error?.status === "number") {
    if (error.status === 401 || error.status === 403) return "upstream_unauthorized";
    if (error.status === 404) return "upstream_not_found";
    if (error.status === 429) return "upstream_rate_limited";
    if (error.status >= 500) return "upstream_server_error";
    return "upstream_bad_request";
  }
  return error?.code ?? "upstream_unreachable";
}

/**
 * OpenAI 兼容 /chat/completions 调用。
 * `demo://local` 走内置演示模型：不联网，基于传入的 memory 与历史做抽取式回应，
 * 用来在没有任何真实 Key 时也能端到端跑通 @ 派发、队列与压缩。
 */
export async function chatCompletion({ baseUrl, apiKey, model, messages, tools, maxTokens, timeoutMs = 60000, summary }) {
  if (baseUrl === "demo://local") return demoComplete({ messages, tools, summary });
  const body = { model, messages, stream: false };
  if (maxTokens) body.max_tokens = maxTokens;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    const error = new Error("upstream_rejected");
    error.status = response.status;
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    const error = new Error("upstream_bad_json");
    error.code = "upstream_bad_json";
    throw error;
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  return {
    mode: "openai",
    content: typeof choice?.message?.content === "string" ? choice.message.content : "",
    tool_calls: Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [],
    usage: payload.usage ?? null,
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
  const facts = (context.match(/^[^\n]{6,120}$/gm) ?? []).slice(-3).map((line) => truncate(line, 80));
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
