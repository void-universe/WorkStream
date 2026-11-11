// Deployment targets: one running Stream Server executor that employees can be created on.
//
// Why a separate table instead of retyping the address for every employee: a shared executor serves
// many employees, so its address and bearer token are one fact owned by the box. The employee still
// keeps its own copy, so removing a server never breaks an employee that already runs on it.
import { Halt, json, maskKey, newId, now, safeApiBaseUrl, text, uuid } from "./util.mjs";
import { open, seal } from "./sec.mjs";
import { checkStreamAccess } from "./stream.mjs";

const privateAllowed = (env) => env?.("WORKSTREAM_DEV") === "1";
const COLUMNS = "id,owner_id,name,base_url,token_tail,stream_profile,label,models,last_seen_at,created_at,updated_at";

/** Discovery answers with a model list; the column is text so the fake JSON store and Postgres agree. */
const modelsOf = (raw) => {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const shape = (row) => ({
  id: row.id,
  name: row.name,
  base_url: row.base_url,
  token_tail: row.token_tail,
  stream_profile: row.stream_profile,
  label: row.label,
  models: modelsOf(row.models),
  last_seen_at: row.last_seen_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

/** Owner-scoped lookup. Callers copy the row into an employee, so the full row (cipher included)
 *  never leaves this module except through `serverById`. */
export async function serverById(db, user, id) {
  const serverId = uuid(id, "server_id");
  const row = await db.servers.byId(serverId);
  if (!row || row.owner_id !== user.id) throw new Halt("server_not_found", 404);
  return row;
}

/** Ask the box which profile it declares. An address that cannot answer is not a server yet:
 *  storing it would hand every employee created on it a record that fails on its first round. */
async function probe(baseUrl, token) {
  const access = await checkStreamAccess({ baseUrl, token });
  if (!access.storable) {
    throw new Halt("server_unreachable", 400, { code: access.code ?? null, detail: access.detail ?? null });
  }
  return access;
}

export const actions = {
  async "servers.list"({ db, user }) {
    const rows = await db.servers.list([["owner_id", user.id]], {
      columns: COLUMNS, order: ["created_at", { ascending: true }], limit: 100,
    });
    return json({ ok: true, items: rows.map(shape) });
  },

  async "servers.create"({ db, user, body, env }) {
    const name = text(body.name, { max: 60, name: "name" });
    const target = safeApiBaseUrl(body.base_url, { allowPrivate: privateAllowed(env) });
    const token = text(body.token, { max: 400, name: "token" });
    const access = await probe(target.url, token);
    const sealed = await seal(token, { supabase: db.client, env });
    const created = await db.servers.insert({
      id: newId(),
      owner_id: user.id,
      name,
      base_url: target.url,
      token_cipher: sealed.cipher,
      token_tail: maskKey(token),
      key_source: sealed.key_source,
      stream_profile: access.profile,
      label: access.label ?? null,
      models: JSON.stringify(access.models ?? []),
      last_seen_at: now(),
      created_at: now(),
      updated_at: now(),
    }, { columns: COLUMNS });
    if (!created) throw new Halt("server_write_failed", 503);
    return json({ ok: true, server: shape(created) });
  },

  async "servers.update"({ db, user, body, env }) {
    const server = await serverById(db, user, body.id);
    const values = { updated_at: now() };
    if (body.name !== undefined) values.name = text(body.name, { max: 60, name: "name" });
    const nextUrl = body.base_url !== undefined
      ? safeApiBaseUrl(body.base_url, { allowPrivate: privateAllowed(env) }).url
      : server.base_url;
    const newToken = body.token ? text(body.token, { max: 400, name: "token" }) : null;
    // Address or token changed: ask again before writing, so the stored profile and the box agree.
    if (body.base_url !== undefined || newToken) {
      const token = newToken ?? await open(server.token_cipher, { supabase: db.client, env });
      const access = await probe(nextUrl, token);
      values.base_url = nextUrl;
      values.stream_profile = access.profile;
      values.label = access.label ?? null;
      values.models = JSON.stringify(access.models ?? []);
      values.last_seen_at = now();
      if (newToken) {
        const sealed = await seal(newToken, { supabase: db.client, env });
        values.token_cipher = sealed.cipher;
        values.token_tail = maskKey(newToken);
        values.key_source = sealed.key_source;
      }
    }
    const updated = await db.servers.claim([["id", server.id], ["owner_id", user.id]], values);
    if (!updated) throw new Halt("server_write_failed", 503);
    // claim reports success, not the row; re-read so the response is the stored state.
    const row = await db.servers.byId(server.id, { columns: COLUMNS });
    return json({ ok: true, server: shape(row) });
  },

  async "servers.remove"({ db, user, body }) {
    const server = await serverById(db, user, body.id);
    const removed = await db.servers.remove([["id", server.id], ["owner_id", user.id]]);
    if (!removed) throw new Halt("server_write_failed", 503);
    return json({ ok: true, id: server.id });
  },

  async "servers.test"({ db, user, body, env }) {
    const server = await serverById(db, user, body.id);
    const token = await open(server.token_cipher, { supabase: db.client, env });
    const access = await checkStreamAccess({ baseUrl: server.base_url, token });
    if (!access.storable) {
      return json({ ok: true, result: { reachable: false, error: access.code ?? "unreachable", detail: access.detail ?? null } });
    }
    // The check is also the only place that refreshes what the list shows, so it writes the facts
    // it just learned instead of leaving the row describing an older box.
    await db.servers.claim([["id", server.id], ["owner_id", user.id]], {
      stream_profile: access.profile,
      label: access.label ?? null,
      models: JSON.stringify(access.models ?? []),
      last_seen_at: now(),
      updated_at: now(),
    });
    return json({
      ok: true,
      result: {
        reachable: true,
        profile: access.profile,
        speaks_spec: access.speaks_spec,
        profiles: access.profiles ?? [],
        label: access.label ?? null,
        models: access.models ?? [],
      },
    });
  },
};
