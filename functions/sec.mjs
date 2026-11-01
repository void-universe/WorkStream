// 口令散列、会话令牌、以及静态加密（虚拟员工 API Key、虚拟机凭据）。
import { Halt, b64ToBytes, bytesToB64, newId, now, randomHex, sha256Hex } from "./util.mjs";

const PBKDF2_ITERATIONS = 150_000;
const WORKSPACE_STATE_ID = "00000000-0000-4000-8000-000000000001";

async function deriveKey(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: b64ToBytes(hexToB64(saltHex)),
      iterations,
      hash: "SHA-256",
    },
    material,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

const hexToB64 = (hex) => bytesToB64(hexToBytes(hex));
export const hexToBytes = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hashPassword(password) {
  const salt = randomHex(16);
  const derived = await deriveKey(password, salt);
  return { salt, hash: derived, iterations: PBKDF2_ITERATIONS };
}

export async function verifyPassword(password, record) {
  const salt = record?.salt ?? record?.password_salt;
  const stored = record?.hash ?? record?.password_hash;
  const iterations = record?.iterations ?? record?.password_iterations ?? PBKDF2_ITERATIONS;
  if (!salt || !stored) return false;
  const derived = await deriveKey(password, salt, iterations);
  const a = await sha256Hex(derived);
  const b = await sha256Hex(stored);
  return a === b;
}

export const newSessionToken = () => randomHex(32);
export const hashToken = (token) => sha256Hex(token);

/**
 * 静态加密主密钥来源：
 * 1) Sites Settings 里的应用 Secret WORKSTREAM_DATA_KEY（64 位十六进制）；
 * 2) 未配置时退回 app.runtime_state 中的一把随机密钥（首用即生成）。
 * 两种模式都保证明文密钥不入库，但退回模式的可信度较低：持有数据库读写能力者
 * 可同时拿到包裹密钥。前端会在设置页展示当前模式。
 */
export async function dataKey({ supabase, env }) {
  const fromEnv = (env?.("WORKSTREAM_DATA_KEY") ?? "").trim();
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) throw new Halt("data_key_misconfigured", 500);
    const key = await crypto.subtle.importKey(
      "raw", hexToBytes(fromEnv.toLowerCase()), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return { key, source: "secret" };
  }
  const row = await supabase.from("runtime_state")
    .select("id,value").eq("id", WORKSPACE_STATE_ID).maybeSingle();
  if (row.error) throw new Halt("runtime_state_unavailable", 503);
  if (row.data) {
    const stored = row.data.value?.data_key;
    if (typeof stored !== "string" || !/^[0-9a-f]{64}$/.test(stored)) throw new Halt("runtime_state_corrupt", 503);
    const key = await crypto.subtle.importKey("raw", hexToBytes(stored), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return { key, source: "database" };
  }
  const material = randomHex(32);
  const inserted = await supabase.from("runtime_state").insert({
    id: WORKSPACE_STATE_ID,
    value: { data_key: material, created_at: now() },
    created_at: now(),
  }).select("id").maybeSingle();
  if (inserted.error && inserted.error.code !== "23505") throw new Halt("runtime_state_unavailable", 503);
  const key = await crypto.subtle.importKey("raw", hexToBytes(material), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { key, source: "database" };
}

export async function seal(plaintext, { supabase, env }) {
  const { key, source } = await dataKey({ supabase, env });
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return {
    cipher: `${bytesToHex(iv)}:${bytesToB64(new Uint8Array(cipher))}`,
    key_source: source,
  };
}

export async function open(sealed, { supabase, env }) {
  if (typeof sealed !== "string" || !sealed.includes(":")) throw new Halt("secret_unreadable", 500);
  const { key } = await dataKey({ supabase, env });
  const [ivHex, body] = sealed.split(":");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(ivHex) }, key, b64ToBytes(body));
    return new TextDecoder("utf-8").decode(plain);
  } catch {
    throw new Halt("secret_unreadable", 500);
  }
}

export const newSecretId = () => newId();
