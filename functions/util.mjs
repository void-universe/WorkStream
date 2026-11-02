// WorkStream Function 公共工具：响应封装、请求体限额、输入校验、时间与随机数。
// 所有相对导入都带显式扩展名，Edge 运行时不做路径别名解析。

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const json = (body, status = 200, extra = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...extra } });

export const fail = (error, status = 400, extra = {}) =>
  json({ ok: false, error, ...extra }, status);

export class Halt extends Error {
  constructor(error, status = 400, detail = {}) {
    super(error);
    this.name = "Halt";
    this.error = error;
    this.status = status;
    this.detail = detail;
  }
}

export const newId = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const later = (seconds) =>
  new Date(Date.now() + seconds * 1000).toISOString();

export const randomHex = (bytes) => {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const bytesToB64 = (bytes) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

export const b64ToBytes = (value) => {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const isUuid = (value) => typeof value === "string" && UUID_RE.test(value);

export function text(value, { max = 2000, min = 1, required = true, name = "field" }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Halt(`invalid_${name}`, 400);
    return "";
  }
  if (typeof value !== "string") throw new Halt(`invalid_${name}`, 400);
  const trimmed = value.trim();
  const size = new TextEncoder().encode(trimmed).length;
  if (size < min || size > max) throw new Halt(`invalid_${name}`, 400);
  return trimmed;
}

export function uuid(value, name = "id") {
  if (!isUuid(value)) throw new Halt(`invalid_${name}`, 400);
  return value;
}

export function int(value, { min = 0, max = 1_000_000_000, name = "number", fallback }) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Halt(`invalid_${name}`, 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Halt(`invalid_${name}`, 400);
  }
  return parsed;
}

// 上下文预算按字符计：中文约 1 字≈1 token、英文约 4 字符≈1 token。
// 默认 20 万字符够 256K token 窗口的模型用掉一半，上限留给百万窗口的模型。
export const CONTEXT_CHARS_DEFAULT = 200_000;
export const CONTEXT_CHARS_MAX = 2_000_000;

export function oneOf(value, allowed, name = "field", fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new Halt(`invalid_${name}`, 400);
  }
  if (!allowed.includes(value)) throw new Halt(`invalid_${name}`, 400);
  return value;
}

// 头像由浏览器裁到 128×128 后再上传，库里只存 data URL；空串表示清除。
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function avatarData(value, name = "avatar") {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 200_000 || !AVATAR_RE.test(value)) {
    throw new Halt(`invalid_${name}`, 400);
  }
  return value;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function email(value, name = "email") {
  const raw = text(value, { max: 254, name });
  const lower = raw.toLowerCase();
  if (!EMAIL_RE.test(lower)) throw new Halt(`invalid_${name}`, 400);
  return lower;
}

/** 有界读取请求体：不信任客户端声明的 Content-Length。 */
export async function readJson(request, maxBytes = 262_144) {
  const type = request.headers.get("content-type")?.split(";")[0].trim();
  if (type && type !== "application/json") throw new Halt("invalid_content_type", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new Halt("empty_body", 400);
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Halt("body_too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Halt("invalid_body", 400);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Halt) throw error;
    throw new Halt("invalid_json", 400);
  }
}

/**
 * 校验 OpenAI 兼容 base URL。默认拒绝环回、私网与链路本地地址，
 * 避免把用户填的 URL 变成携带凭据的内网代理目标。
 * 仅当 WORKSTREAM_DEV=1（本机 Function 调试）时放行私网，方便连本机 mock 服务。
 */
export function safeApiBaseUrl(value, { allowPrivate = false } = {}) {
  const raw = text(value, { max: 300, name: "api_base_url" });
  if (raw === "demo://local") return { scheme: "demo", url: raw, origin: "demo://local" };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Halt("invalid_api_base_url", 400);
  }
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Halt("invalid_api_base_url", 400);
  if (parsed.username || parsed.password) throw new Halt("invalid_api_base_url", 400);
  if (parsed.search || parsed.hash) throw new Halt("invalid_api_base_url", 400);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && parsed.protocol === "http:") throw new Halt("insecure_api_base_url", 400);
  if (!allowPrivate && isPrivateHost(host)) throw new Halt("private_api_base_url", 400);
  const path = parsed.pathname.replace(/\/+$/, "");
  return {
    scheme: parsed.protocol,
    url: `${parsed.origin}${path}`,
    origin: parsed.origin,
    host,
  };
}

function isPrivateHost(host) {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local") || lower === "metadata.google.internal") return true;
  if (/^127\./.test(lower) || /^10\./.test(lower) || /^192\.168\./.test(lower)) return true;
  if (/^169\.254\./.test(lower) || lower === "0.0.0.0" || lower === "::1" || lower.startsWith("fe80")) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(lower)) return true;
  if (/^fc|^fd/i.test(lower)) return true;
  return false;
}

export const maskKey = (value) =>
  value ? `••••${String(value).slice(-4)}` : "";

export function truncate(value, max) {
  const chars = Array.from(String(value));
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}
