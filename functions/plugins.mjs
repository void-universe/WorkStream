// 插件市场：把外部 MCP 服务接成虚拟员工的工具。一条记录 = 主人接的一个连接器，
// 它带进来的工具并进主人名下所有员工的工具清单，调用照样走 mcp.mjs 的那条管道、落同一条轨迹。
//
// 出网只发生在服务端：地址过 safeApiBaseUrl（挡内网与元数据地址，本机调试才放行私网），
// 令牌 seal() 后存密文，任何读接口只回掩码尾号。
// 工具清单读的是 tools/list 的缓存——模型回路里不现连外部服务，否则外部一慢就把整轮回复拖死。
import { open, seal } from "./sec.mjs";
import { Halt, json, maskKey, newId, now, safeApiBaseUrl, text, uuid } from "./util.mjs";

/** 对外可见的列：auth_cipher 永远不在任何读接口里出现。 */
export const PLUGIN_COLUMNS =
  "id,owner_id,name,endpoint,auth_tail,tools,tools_at,status,last_error,enabled,created_at,updated_at";

const MAX_PER_OWNER = 12;
const MAX_TOOLS_PER_PLUGIN = 24;
const PROBE_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 60000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESULT_CHARS = 6000;
/** OpenAI 的 function name 只收这些字符，外部服务给的名字不合规就直接跳过，不做静默改名。 */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const privateAllowed = (env) => env?.("WORKSTREAM_DEV") === "1";

async function readCapped(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let textBody = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value?.byteLength ?? 0;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Halt("plugin_too_large", 502);
    }
    textBody += decoder.decode(value, { stream: true });
  }
  return textBody;
}

/** MCP 的 HTTP 传输可能回 JSON，也可能把 JSON-RPC 包在 SSE 的 data: 行里，两种都收。 */
function parseEnvelope(textBody, contentType) {
  if (!String(contentType).includes("event-stream")) {
    try {
      return JSON.parse(textBody);
    } catch {
      throw new Halt("plugin_bad_response", 502);
    }
  }
  let found = null;
  for (const line of String(textBody).split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const message = JSON.parse(line.slice(5).trim());
      if (message && (message.result !== undefined || message.error !== undefined)) found = message;
    } catch {
      /* 心跳与半包不是 JSON，跳过 */
    }
  }
  if (!found) throw new Halt("plugin_bad_response", 502);
  return found;
}

async function postRpc({ endpoint, token, method, params, timeoutMs }) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Halt(error?.name === "TimeoutError" ? "plugin_timeout" : "plugin_unreachable", 502);
  }
  if (!response.ok) {
    await response.text().catch(() => "");
    const status = response.status;
    throw new Halt(status === 401 || status === 403 ? "plugin_unauthorized" : "plugin_rejected", 502, { status });
  }
  const envelope = parseEnvelope(await readCapped(response), response.headers.get("content-type") ?? "");
  if (envelope.error) {
    throw new Halt("plugin_rejected", 502, { code: envelope.error.code ?? null });
  }
  return envelope.result ?? {};
}

/** tools/list 的结果 → 我们缓存的形状；不合规与超量的工具记进 skipped，前端如实列出来。 */
function normalizeTools(raw) {
  const tools = [];
  const skipped = [];
  const note = (name, reason) => {
    if (skipped.length < 20) skipped.push({ name, reason });
  };
  for (const item of Array.isArray(raw) ? raw : []) {
    const name = String(item?.name ?? "");
    if (!TOOL_NAME_RE.test(name)) {
      note(name.slice(0, 64), "invalid_name");
      continue;
    }
    if (tools.some((tool) => tool.name === name)) {
      note(name, "duplicate_name");
      continue;
    }
    const parameters = item?.inputSchema ?? item?.parameters;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
      note(name, "no_schema");
      continue;
    }
    if (tools.length >= MAX_TOOLS_PER_PLUGIN) {
      note(name, "over_limit");
      continue;
    }
    tools.push({
      name,
      description: String(item?.description ?? "").slice(0, 600),
      parameters,
    });
  }
  return { tools, skipped };
}

async function probePlugin(db, env, row, token) {
  const endpoint = row.endpoint;
  try {
    await postRpc({
      endpoint, token, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "workstream", version: "0.2.0" },
      },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const listed = await postRpc({ endpoint, token, method: "tools/list", params: {}, timeoutMs: PROBE_TIMEOUT_MS });
    const { tools, skipped } = normalizeTools(listed?.tools);
    const patched = await db.plugins.patch([["id", row.id]], {
      tools, last_error: null, status: "ready", tools_at: now(), updated_at: now(),
    }, { returning: false });
    if (!patched) throw new Halt("plugin_update_failed", 503);
    return { tools, skipped };
  } catch (error) {
    const code = error?.error ?? "plugin_unreachable";
    await db.plugins.patch([["id", row.id]], {
      status: "error", last_error: code, tools_at: now(), updated_at: now(),
    }, { returning: false });
    throw new Halt(code, 502);
  }
}

async function ownedPlugin(db, userId, id, { columns = PLUGIN_COLUMNS } = {}) {
  const row = await db.plugins.byId(uuid(id, "id"), { columns });
  if (!row) throw new Halt("plugin_not_found", 404);
  if (row.owner_id !== userId) throw new Halt("plugin_not_owned", 403);
  return row;
}

const publicPlugin = (row) => ({
  ...row,
  tools: Array.isArray(row.tools) ? row.tools : [],
  tool_count: Array.isArray(row.tools) ? row.tools.length : 0,
});

/** 主人启用中连接器的工具声明（OpenAI function 形式）。taken 里的名字一律跳过：内置工具优先。 */
export async function connectorToolDefs(db, ownerId, taken = []) {
  if (!ownerId) return [];
  const rows = await db.plugins.list(
    [["owner_id", ownerId], ["enabled", true]],
    { columns: "id,name,tools", order: "created_at", limit: MAX_PER_OWNER },
  );
  const seen = new Set(taken);
  const defs = [];
  for (const row of rows) {
    for (const tool of Array.isArray(row.tools) ? row.tools : []) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      defs.push({
        type: "function",
        function: { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? {} },
      });
    }
  }
  return defs;
}

/** 按工具名找到它属于哪个连接器，并把令牌解出来；没有命中返回 null。 */
export async function resolveConnectorTool(db, env, ownerId, name) {
  if (!ownerId || !name) return null;
  const rows = await db.plugins.list(
    [["owner_id", ownerId], ["enabled", true]],
    { columns: "id,name,endpoint,auth_cipher,tools", order: "created_at", limit: MAX_PER_OWNER },
  );
  for (const row of rows) {
    const tool = (Array.isArray(row.tools) ? row.tools : []).find((item) => item.name === name);
    if (!tool) continue;
    const token = row.auth_cipher
      ? await open(row.auth_cipher, { supabase: db.client, env }).catch(() => {
        throw new Halt("secret_unreadable", 500);
      })
      : "";
    return { row, tool, token };
  }
  return null;
}

/** MCP tools/call 的结果 → 一个可 JSON 化的小对象；外部回什么我们只留文本面。 */
function toOutput(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const textParts = parts.filter((part) => part?.type === "text").map((part) => String(part.text ?? ""));
  const body = textParts.join("\n").slice(0, MAX_RESULT_CHARS);
  if (result?.isError) return { error: "plugin_tool_failed", text: body };
  return { ok: true, text: body || JSON.stringify(result ?? {}).slice(0, MAX_RESULT_CHARS) };
}

export async function callConnectorTool(target, args) {
  const result = await postRpc({
    endpoint: target.row.endpoint,
    token: target.token,
    method: "tools/call",
    params: { name: target.tool.name, arguments: args ?? {} },
    timeoutMs: CALL_TIMEOUT_MS,
  });
  return toOutput(result);
}

/** 轨迹检视器的 Schema 页：外部工具的入参声明来自连接器缓存，形状和 toolSchemas 一致。 */
export async function connectorSchemas(db, ownerId, names) {
  if (!ownerId || !names?.length) return [];
  const wanted = new Set(names);
  const rows = await db.plugins.list(
    [["owner_id", ownerId]],
    { columns: "id,name,tools", limit: MAX_PER_OWNER },
  );
  const out = [];
  for (const row of rows) {
    for (const tool of Array.isArray(row.tools) ? row.tools : []) {
      if (wanted.has(tool.name) && !out.some((item) => item.name === tool.name)) {
        out.push({ name: tool.name, parameters: tool.parameters ?? {} });
      }
    }
  }
  return out;
}

export const actions = {
  async "plugins.list"({ db, user }) {
    const rows = await db.plugins.list(
      [["owner_id", user.id]],
      { columns: PLUGIN_COLUMNS, order: ["created_at", { ascending: true }], limit: MAX_PER_OWNER },
    );
    return json({ ok: true, items: rows.map(publicPlugin), limit: MAX_PER_OWNER });
  },

  async "plugins.add"({ db, user, env, body }) {
    const name = text(body.name, { max: 40, name: "plugin_name" });
    const target = safeApiBaseUrl(body.endpoint, { allowPrivate: privateAllowed(env) });
    if (target.scheme === "demo") throw new Halt("invalid_api_base_url", 400);
    const token = text(body.token, { max: 400, name: "plugin_token", required: false });
    const total = await db.plugins.total([["owner_id", user.id]], { columns: "id" });
    if (total >= MAX_PER_OWNER) throw new Halt("too_many_plugins", 400);
    const sealed = token ? await seal(token, { supabase: db.client, env }) : null;
    const created = await db.plugins.insert({
      id: newId(),
      owner_id: user.id,
      name,
      endpoint: target.url,
      auth_cipher: sealed?.cipher ?? null,
      auth_tail: token ? maskKey(token) : "",
      tools: [],
      tools_at: null,
      status: "untested",
      last_error: null,
      enabled: true,
      created_at: now(),
      updated_at: now(),
    }, { columns: PLUGIN_COLUMNS });
    if (!created) throw new Halt("plugin_upload_failed", 503);
    // 探一次：连不上不丢用户填的东西，行留着、状态标 error，界面上能重测。
    let probe = null;
    let probeError = null;
    try {
      probe = await probePlugin(db, env, created, token);
    } catch (error) {
      probeError = error?.error ?? "plugin_unreachable";
    }
    const fresh = await db.plugins.byId(created.id, { columns: PLUGIN_COLUMNS });
    return json({ ok: true, plugin: publicPlugin(fresh ?? created), probe, probe_error: probeError });
  },

  async "plugins.probe"({ db, user, env, body }) {
    const row = await ownedPlugin(db, user.id, body.id, {
      columns: `${PLUGIN_COLUMNS},auth_cipher`,
    });
    const token = row.auth_cipher
      ? await open(row.auth_cipher, { supabase: db.client, env }).catch(() => {
        throw new Halt("secret_unreadable", 500);
      })
      : "";
    const { tools, skipped } = await probePlugin(db, env, row, token);
    const fresh = await db.plugins.byId(row.id, { columns: PLUGIN_COLUMNS });
    return json({ ok: true, plugin: publicPlugin(fresh ?? row), tools, skipped });
  },

  async "plugins.update"({ db, user, env, body }) {
    const row = await ownedPlugin(db, user.id, body.id, {
      columns: `${PLUGIN_COLUMNS},auth_cipher`,
    });
    const values = { updated_at: now() };
    if (body.name !== undefined) values.name = text(body.name, { max: 40, name: "plugin_name" });
    if (body.enabled !== undefined) values.enabled = Boolean(body.enabled);
    let token = null;
    let reprobeNeeded = false;
    if (body.endpoint !== undefined && body.endpoint !== null && body.endpoint !== row.endpoint) {
      const target = safeApiBaseUrl(body.endpoint, { allowPrivate: privateAllowed(env) });
      if (target.scheme === "demo") throw new Halt("invalid_api_base_url", 400);
      values.endpoint = target.url;
      // 换端点后缓存的工具属于旧服务，留着会让清单说谎。
      values.tools = [];
      values.status = "untested";
      values.last_error = null;
      reprobeNeeded = true;
    }
    if (body.token !== undefined && body.token !== null && body.token !== "") {
      token = text(body.token, { max: 400, name: "plugin_token" });
      const sealed = await seal(token, { supabase: db.client, env });
      values.auth_cipher = sealed.cipher;
      values.auth_tail = maskKey(token);
      reprobeNeeded = true;
    }
    const patched = await db.plugins.patch([["id", row.id]], values, { returning: false });
    if (!patched) throw new Halt("plugin_update_failed", 503);
    const fresh = await db.plugins.byId(row.id, { columns: `${PLUGIN_COLUMNS},auth_cipher` });
    let probe = null;
    let probeError = null;
    if (reprobeNeeded) {
      const nextToken = token ?? (fresh.auth_cipher
        ? await open(fresh.auth_cipher, { supabase: db.client, env }).catch(() => "")
        : "");
      try {
        probe = await probePlugin(db, env, fresh, nextToken);
      } catch (error) {
        probeError = error?.error ?? "plugin_unreachable";
      }
    }
    const shown = await db.plugins.byId(row.id, { columns: PLUGIN_COLUMNS });
    return json({ ok: true, plugin: publicPlugin(shown ?? fresh), probe, probe_error: probeError });
  },

  async "plugins.remove"({ db, user, body }) {
    const row = await ownedPlugin(db, user.id, body.id, { columns: "id,owner_id" });
    const removed = await db.plugins.remove([["id", row.id]]);
    if (!removed) throw new Halt("plugin_remove_failed", 503);
    return json({ ok: true });
  },
};
