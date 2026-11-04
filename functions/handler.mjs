// 单一 app Function 的路由：?action=<名称>，应用层会话鉴权 + 分模块处理。
import { actions as accounts } from "./accounts.mjs";
import { actions as agents } from "./agents.mjs";
import { actions as chat } from "./chat.mjs";
import { actions as cron } from "./cron.mjs";
import { actions as delegate } from "./delegate.mjs";
import { actions as dreaming } from "./dream.mjs";
import { actions as engine } from "./engine.mjs";
import { handleMcp } from "./mcp.mjs";
import { actions as plugins } from "./plugins.mjs";
import { actions as registries } from "./registries.mjs";
import { actions as rooms } from "./rooms.mjs";
import { bindEnv, readEnv, smtpEndpoint } from "./runtime.mjs";
import { actions as skills } from "./skills.mjs";
import { store } from "./store.mjs";
import { actions as trajectory } from "./trajectory.mjs";
import { Halt, fail, json, now, sha256Hex, text } from "./util.mjs";
import { actions as vms } from "./vms.mjs";

// auth.resend 要用调用者自己的身份重发验证信，不能当公开路由（公开时 user 为空，直接 500）。
const PUBLIC = new Set([
  "auth.register", "auth.verify", "auth.login", "mcp", "site.meta",
]);

const ROUTES = { ...accounts, ...agents, ...rooms, ...chat, ...cron, ...delegate, ...dreaming, ...engine, ...vms, ...skills, ...registries, ...plugins, ...trajectory };

async function siteMeta({ db, env }) {
  void db;
  void env;
  return json({
    ok: true,
    name: "WorkStream",
    server_time: now(),
    storage_mode: (await storagePresent()) ? "platform" : "database",
    smtp: Boolean(smtpEndpoint()),
    data_key: readEnv("WORKSTREAM_DATA_KEY") ? "secret" : "database",
    local_dev: readEnv("WORKSTREAM_DEV") === "1",
  });
}

ROUTES["site.meta"] = siteMeta;

async function storagePresent() {
  try {
    const module = await import("./_qoder/storage.mjs");
    return Boolean(module.storage);
  } catch {
    return false;
  }
}

export function makeHandler({ env }) {
  bindEnv(env);
  return async function handleApp({ request, supabase }) {
    const url = new URL(request.url);
    const action = text(url.searchParams.get("action") ?? routeFromPath(url.pathname), {
      max: 48, name: "action", required: false,
    });
    const db = store(supabase);
    const context = { request, supabase, db, env, params: url.searchParams, user: null, session: null };

    if (!action) return fail("missing_action", 400);
    if (action === "mcp") {
      try {
        return await handleMcp(context);
      } catch (error) {
        return respond(error);
      }
    }
    if (action === "site.meta") {
      try {
        return await ROUTES["site.meta"](context);
      } catch (error) {
        return respond(error);
      }
    }
    const handler = ROUTES[action];
    if (!handler) return fail("unknown_action", 404);

    const method = request.method;
    const wantsBody = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
    if (!PUBLIC.has(action) && !["GET", "POST"].includes(method)) {
      return fail("method_not_allowed", 405, { allow: "GET, POST" });
    }
    try {
      context.body = wantsBody ? await readBody(request) : {};
      if (!PUBLIC.has(action)) {
        const identity = await resolveSession({ db, request });
        if (!identity) return fail("login_required", 401);
        context.user = identity.user;
        context.session = identity.session;
      }
      return await handler(context);
    } catch (error) {
      return respond(error);
    }
  };
}

function respond(error) {
  if (error instanceof Halt) {
    const extra = error.status >= 500 ? {} : error.detail ?? {};
    return fail(error.error, error.status, extra);
  }
  // 未分类异常统一收敛为稳定错误码，不回显堆栈或上游原文。
  return fail("server_error", 500);
}

// 一条消息最多带 4 张图（每张 base64 上限 800_000 字符），留出 JSON 结构的余量。
const MAX_BODY = 5_242_880;

async function readBody(request) {
  const type = request.headers.get("content-type")?.split(";")[0].trim();
  if (type && type !== "application/json") throw new Halt("invalid_content_type", 415);
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new Halt("body_too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(concat(chunks, size)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Halt("invalid_body", 400);
    return parsed;
  } catch (error) {
    if (error instanceof Halt) throw error;
    throw new Halt("invalid_json", 400);
  }
}

const concat = (chunks, size) => {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

async function resolveSession({ db, request }) {
  // 部署侧的 adapter 会把浏览器带上的 authorization 头剥掉（平台不允许前端凭据进数据库层），
  // 所以会话令牌走自定义头；authorization 只作为本机 harness / 老客户端的兼容路径。
  const custom = request.headers.get("x-workstream-token") ?? "";
  const header = request.headers.get("authorization") ?? "";
  const token = (custom || (header.startsWith("Bearer ") ? header.slice(7) : "")).trim();
  if (!token || token.length > 128) return null;
  const hash = await sha256Hex(token);
  const session = await db.sessions.first([["token_hash", hash]], {
    columns: "id,user_id,expires_at",
  });
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  const user = await db.users.byId(session.user_id);
  if (!user) return null;
  return { user, session };
}

/** 逻辑子路径 /functions/v1/app/<suffix> 也接受：MCP 客户端常写成 /functions/v1/app/mcp。
 *  网关会把函数名那一段替换成物理名，所以只认第三段之后的后缀。 */
function routeFromPath(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 4) return "";
  const suffix = segments.slice(3);
  return suffix.length === 1 ? suffix[0] : "";
}
