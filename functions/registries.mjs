// 远端技能市场：主人自己添加的 registry 源——一个 index JSON 就是一个可公开的技能清单。
// 我们只读不写源；安装或更新的那一刻把正文抄成本地 skills 行，之后上游怎么改都不影响在用的员工。
// skills 上的 source_registry_id + source_slug 把快照回指到源里的条目，用来做版本比对和一键更新。
//
// 出网只发生在服务端：index_url 与 body_url 都过 safeApiBaseUrl（线上只收 https，本机调试才放行私网），
// body_url 还必须和源同一个 origin——否则一个源就能把我们的服务器指去内网任意地址。
// 重定向一律拒绝：跟随后无法再校验目标。
import { MAX_BODY, SKILL_COLUMNS, installedSkillRows, installSkillTargets, markFutureDefault, ownedAgent } from "./skills.mjs";
import { Halt, json, newId, now, safeApiBaseUrl, text, uuid } from "./util.mjs";

export const REGISTRY_COLUMNS =
  "id,owner_id,name,index_url,skill_count,last_error,skills_at,enabled,created_at,updated_at";

const MAX_REGISTRIES_PER_OWNER = 8;
const MAX_SKILLS_PER_REGISTRY = 200;
const INDEX_TIMEOUT_MS = 8000;
const INDEX_MAX_BYTES = 256 * 1024;
const BODY_TIMEOUT_MS = 15000;
const BODY_MAX_BYTES = 200 * 1024;
/** index JSON 的格式版本；上游写成别的值就整源拒绝，不做猜测解析。 */
const INDEX_SCHEMA = 1;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const privateAllowed = (env) => env?.("WORKSTREAM_DEV") === "1";

/** 校验并固化一个远端地址；sameOriginAs 存在时要求同源。 */
function remoteUrl(value, { env, sameOriginAs, name }) {
  const raw = text(value, { max: 300, name });
  let absolute;
  try {
    absolute = new URL(raw, sameOriginAs);
  } catch {
    throw new Halt(`invalid_${name}`, 400);
  }
  if (sameOriginAs && absolute.origin !== new URL(sameOriginAs).origin) {
    throw new Halt(`invalid_${name}`, 400);
  }
  const target = safeApiBaseUrl(absolute.toString(), { allowPrivate: privateAllowed(env) });
  if (target.scheme === "demo") throw new Halt(`invalid_${name}`, 400);
  return target.url;
}

async function readCapped(response, maxBytes, code) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value?.byteLength ?? 0;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Halt(`${code}_too_large`, 502);
    }
    body += decoder.decode(value, { stream: true });
  }
  return body;
}

/** 抓一个远端文本资源：限时、限字节、拒重定向、拒二进制。 */
async function fetchRemote(url, { timeoutMs, maxBytes, code, accept }) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Halt(error?.name === "TimeoutError" ? `${code}_timeout` : `${code}_unreachable`, 502);
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    throw new Halt(`${code}_redirect_blocked`, 502);
  }
  if (!response.ok) {
    await response.text().catch(() => "");
    const status = response.status;
    throw new Halt(status === 401 || status === 403 ? `${code}_unauthorized` : `${code}_rejected`, 502, { status });
  }
  return { response, contentType: response.headers.get("content-type") ?? "" };
}

async function fetchIndexJson(registry, env) {
  const { response, contentType } = await fetchRemote(registry.index_url, {
    timeoutMs: INDEX_TIMEOUT_MS, maxBytes: INDEX_MAX_BYTES, code: "registry",
    accept: "application/json",
  });
  if (contentType && !/json|text\/plain/i.test(contentType)) throw new Halt("registry_bad_response", 502);
  let parsed;
  try {
    parsed = JSON.parse(await readCapped(response, INDEX_MAX_BYTES, "registry"));
  } catch (error) {
    if (error instanceof Halt) throw error;
    throw new Halt("registry_bad_response", 502);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Halt("registry_bad_response", 502);
  if (parsed.schema !== INDEX_SCHEMA) throw new Halt("registry_schema_unsupported", 502, { schema: parsed.schema ?? null });
  const { items, skipped } = normalizeIndex(parsed.skills, registry, env);
  return { items, skipped, name: String(parsed.name ?? "").slice(0, 60) };
}

/** 源里的条目 → 我们的形状。结构性问题（无 slug、重名、越界、地址不合法）跳过并如实报出来。 */
function normalizeIndex(raw, registry, env) {
  const items = [];
  const skipped = [];
  const note = (slug, reason) => {
    if (skipped.length < 20) skipped.push({ slug: String(slug ?? "").slice(0, 64), reason });
  };
  for (const entry of Array.isArray(raw) ? raw : []) {
    const slug = String(entry?.slug ?? "");
    const name = String(entry?.name ?? "").trim();
    if (!SLUG_RE.test(slug)) {
      note(slug, "invalid_slug");
      continue;
    }
    if (!name || name.length > 60) {
      note(slug, "invalid_name");
      continue;
    }
    if (items.some((item) => item.slug === slug)) {
      note(slug, "duplicate_slug");
      continue;
    }
    if (items.length >= MAX_SKILLS_PER_REGISTRY) {
      note(slug, "over_limit");
      continue;
    }
    let bodyUrl = "";
    try {
      bodyUrl = remoteUrl(entry?.body_url, { env, sameOriginAs: registry.index_url, name: "body_url" });
    } catch {
      note(slug, "invalid_body_url");
      continue;
    }
    items.push({
      slug,
      name,
      summary: String(entry?.summary ?? "").trim().slice(0, 300),
      category: String(entry?.category ?? "协作").trim().slice(0, 20) || "协作",
      version: String(entry?.version ?? "").trim().slice(0, 24),
      updated_at: String(entry?.updated_at ?? "").slice(0, 40),
      size: Number.isSafeInteger(entry?.size) && entry.size > 0 ? entry.size : null,
      body_url: bodyUrl,
    });
  }
  return { items, skipped };
}

async function fetchSkillBody(item) {
  const { response, contentType } = await fetchRemote(item.body_url, {
    timeoutMs: BODY_TIMEOUT_MS, maxBytes: BODY_MAX_BYTES, code: "registry_body",
    accept: "text/plain;q=0.9, text/markdown;q=0.8, application/json;q=0.5",
  });
  if (contentType && /octet-stream|image\/|video\/|audio\//i.test(contentType)) {
    throw new Halt("registry_body_binary", 502);
  }
  return readCapped(response, BODY_MAX_BYTES, "registry_body");
}

/** 版本号比对：点分数字按段比大小，比不动就退回字符串不等。空值不代表差异。 */
export function isUpdateAvailable(installed, latest) {
  const left = String(installed ?? "").trim();
  const right = String(latest ?? "").trim();
  if (!right) return false;
  if (!left) return true;
  if (left === right) return false;
  const parse = (value) => (/^\d+(\.\d+)*$/.test(value) ? value.split(".").map(Number) : null);
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return true;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

async function ownedRegistry(db, userId, id, { columns = REGISTRY_COLUMNS } = {}) {
  const row = await db.skill_registries.byId(uuid(id, "registry_id"), { columns });
  if (!row) throw new Halt("registry_not_found", 404);
  if (row.owner_id !== userId) throw new Halt("registry_not_owned", 403);
  return row;
}

/** 抓源并回写缓存字段；失败也写回 last_error，界面上能看到是哪个源、什么错。 */
async function refreshRegistry(db, env, row) {
  try {
    const { items, skipped } = await fetchIndexJson(row, env);
    const stamped = now();
    await db.skill_registries.patch([["id", row.id]], {
      skill_count: items.length, last_error: null, skills_at: stamped, updated_at: stamped,
    }, { returning: false });
    return { items, skipped, skills_at: stamped, error: null };
  } catch (error) {
    // 只把 Halt（源的问题）写回 last_error；我们自己的异常不能被伪装成"源连不上"。
    if (!(error instanceof Halt)) throw error;
    await db.skill_registries.patch([["id", row.id]], { last_error: error.error, updated_at: now() }, { returning: false });
    return { items: [], skipped: [], skills_at: null, error: error.error };
  }
}

/** 已装快照：按主人 + 源 + slug 回查，用于列表标注和更新时的目标行。 */
async function snapshotsOf(db, userId, registryIds) {
  if (!registryIds.length) return new Map();
  const rows = await db.skills.list(
    [["owner_id", userId], ["source_registry_id", registryIds]],
    { columns: `${SKILL_COLUMNS},body`, limit: 500 },
  );
  const map = new Map();
  for (const row of rows) map.set(`${row.source_registry_id}:${row.source_slug}`, row);
  return map;
}

/** 安装或更新一个远端技能：正文抄进本地行，记下版本与来源。 */
async function snapshotSkill(db, user, registry, item) {
  const raw = await fetchSkillBody(item);
  const body = raw.trimEnd();
  if (!body.trim()) throw new Halt("registry_body_empty", 502);
  if (Array.from(body).length > MAX_BODY) throw new Halt("skill_body_too_large", 400);
  const values = {
    name: item.name,
    summary: item.summary || "（源上没有简介）",
    category: item.category,
    body,
    version: item.version || null,
    updated_at: now(),
  };
  const existing = await db.skills.first([
    ["owner_id", user.id], ["source_registry_id", registry.id], ["source_slug", item.slug],
  ], { columns: "id" });
  if (existing) {
    const patched = await db.skills.patch([["id", existing.id]], values, { returning: false });
    if (!patched) throw new Halt("skill_update_failed", 503);
    return db.skills.byId(existing.id, { columns: SKILL_COLUMNS });
  }
  const created = await db.skills.insert({
    id: newId(),
    owner_id: user.id,
    source: "remote",
    is_public: false,
    is_default: false,
    always_on: false,
    downloads: 0,
    installs: 0,
    created_at: now(),
    source_registry_id: registry.id,
    source_slug: item.slug,
    ...values,
  }, { columns: SKILL_COLUMNS });
  if (!created) throw new Halt("skill_upload_failed", 503);
  return created;
}

async function resolveRemoteItem(db, env, registry, slug) {
  const wanted = text(slug, { max: 64, name: "slug" });
  const { items, skipped, error } = await refreshRegistry(db, env, registry);
  if (error) throw new Halt(error, 502);
  const item = items.find((entry) => entry.slug === wanted);
  if (item) return { item, skipped };
  const reason = skipped.find((entry) => entry.slug === wanted)?.reason;
  throw new Halt(reason ? `skill_skipped_${reason}` : "skill_not_in_registry", 404);
}

export const actions = {
  async "registries.list"({ db, user }) {
    const rows = await db.skill_registries.list([["owner_id", user.id]], {
      columns: REGISTRY_COLUMNS, order: ["created_at", { ascending: true }], limit: MAX_REGISTRIES_PER_OWNER,
    });
    return json({ ok: true, items: rows, limit: MAX_REGISTRIES_PER_OWNER });
  },

  async "registries.add"({ db, user, env, body }) {
    const name = text(body.name, { max: 40, name: "registry_name" });
    const indexUrl = remoteUrl(body.index_url, { env, name: "index_url" });
    const total = await db.skill_registries.total([["owner_id", user.id]], { columns: "id" });
    if (total >= MAX_REGISTRIES_PER_OWNER) throw new Halt("too_many_registries", 400);
    const clash = await db.skill_registries.first([["owner_id", user.id], ["index_url", indexUrl]], {
      columns: "id,name",
    });
    if (clash) throw new Halt("registry_exists", 400);
    const created = await db.skill_registries.insert({
      id: newId(),
      owner_id: user.id,
      name,
      index_url: indexUrl,
      skill_count: 0,
      last_error: null,
      skills_at: null,
      enabled: true,
      created_at: now(),
      updated_at: now(),
    }, { columns: REGISTRY_COLUMNS });
    if (!created) throw new Halt("registry_upload_failed", 503);
    // 立刻拉一次：源不通不丢用户填的东西，行留着、错误码写进去，界面上能重测。
    const probe = await refreshRegistry(db, env, created);
    const fresh = await db.skill_registries.byId(created.id, { columns: REGISTRY_COLUMNS });
    return json({ ok: true, registry: fresh ?? created, probe });
  },

  async "registries.refresh"({ db, user, env, body }) {
    const row = await ownedRegistry(db, user.id, body.id);
    const probe = await refreshRegistry(db, env, row);
    const fresh = await db.skill_registries.byId(row.id, { columns: REGISTRY_COLUMNS });
    return json({ ok: true, registry: fresh ?? row, probe });
  },

  async "registries.update"({ db, user, body }) {
    const row = await ownedRegistry(db, user.id, body.id, { columns: "id,owner_id" });
    const values = { updated_at: now() };
    if (body.name !== undefined) values.name = text(body.name, { max: 40, name: "registry_name" });
    if (body.enabled !== undefined) values.enabled = Boolean(body.enabled);
    if (Object.keys(values).length > 1) {
      const patched = await db.skill_registries.patch([["id", row.id]], values, { returning: false });
      if (!patched) throw new Halt("registry_update_failed", 503);
    }
    const fresh = await db.skill_registries.byId(row.id, { columns: REGISTRY_COLUMNS });
    return json({ ok: true, registry: fresh });
  },

  async "registries.remove"({ db, user, body }) {
    const row = await ownedRegistry(db, user.id, body.id, { columns: "id,owner_id" });
    // 只删源。已经抄到本地的技能是员工正在用的东西，删源不该把它们的技能抽走。
    const removed = await db.skill_registries.remove([["id", row.id]]);
    if (!removed) throw new Halt("registry_remove_failed", 503);
    return json({ ok: true });
  },

  /** 远端清单：逐源现拉（限时），单源失败只标在那个源上，不影响别的源出结果。 */
  async "skills.remoteList"({ db, user, env, params }) {
    const needle = text(params.get("q") ?? "", { max: 60, name: "q", required: false }).toLowerCase();
    const only = params.get("registry_id");
    const rows = await db.skill_registries.list(
      only ? [["owner_id", user.id], ["id", uuid(only, "registry_id")]] : [["owner_id", user.id], ["enabled", true]],
      { columns: REGISTRY_COLUMNS, order: ["created_at", { ascending: true }], limit: MAX_REGISTRIES_PER_OWNER },
    );
    const probed = await Promise.all(rows.map(async (row) => ({ row, probe: await refreshRegistry(db, env, row) })));
    const snapshots = await snapshotsOf(db, user.id, rows.map((row) => row.id));
    const items = [];
    const registries = [];
    for (const { row, probe } of probed) {
      registries.push({
        id: row.id,
        name: row.name,
        index_url: row.index_url,
        enabled: row.enabled,
        error: probe.error,
        skill_count: probe.items.length,
        skills_at: probe.skills_at ?? row.skills_at,
        skipped: probe.skipped,
      });
      for (const item of probe.items) {
        const snapshot = snapshots.get(`${row.id}:${item.slug}`);
        items.push({
          ...item,
          registry_id: row.id,
          registry_name: row.name,
          installed_skill_id: snapshot?.id ?? null,
          installed_version: snapshot?.version ?? "",
          update_available: isUpdateAvailable(snapshot?.version, item.version),
        });
      }
    }
    const filtered = needle === ""
      ? items
      : items.filter((item) => [item.name, item.summary, item.category, item.slug, item.registry_name]
        .some((value) => String(value ?? "").toLowerCase().includes(needle)));
    return json({ ok: true, items: filtered, registries, limit: MAX_SKILLS_PER_REGISTRY });
  },

  /** 从远端装：正文抄一份、记版本，然后按目标装到某个/全部员工。 */
  async "skills.remoteInstall"({ db, user, env, body }) {
    const registry = await ownedRegistry(db, user.id, body.registry_id);
    const { item, skipped } = await resolveRemoteItem(db, env, registry, body.slug);
    const skill = await snapshotSkill(db, user, registry, item);
    const install = await installSkillTargets(db, user, skill, body);
    const future = body.include_future ? await markFutureDefault(db, user, skill) : null;
    return json({
      ok: true,
      skill,
      install,
      future,
      skipped,
      registry: { id: registry.id, name: registry.name },
    });
  },

  /** 更新一个已装的远端技能：重新抄正文并写新版本号。 */
  async "skills.remoteUpdate"({ db, user, env, body }) {
    const skill = await db.skills.byId(uuid(body.skill_id, "skill_id"), { columns: SKILL_COLUMNS });
    if (!skill) throw new Halt("skill_not_found", 404);
    if (skill.owner_id !== user.id) throw new Halt("skill_not_owned", 403);
    if (!skill.source_registry_id) throw new Halt("skill_not_remote", 400);
    const registry = await db.skill_registries.byId(skill.source_registry_id, { columns: REGISTRY_COLUMNS });
    if (!registry) throw new Halt("registry_not_found", 404);
    if (registry.owner_id !== user.id) throw new Halt("registry_not_owned", 403);
    const { item } = await resolveRemoteItem(db, env, registry, skill.source_slug);
    const refreshed = await snapshotSkill(db, user, registry, item);
    return json({
      ok: true,
      skill: refreshed,
      from_version: skill.version ?? "",
      to_version: item.version ?? "",
      registry: { id: registry.id, name: registry.name },
    });
  },

  /** 员工已装列表的版本自查：按源各拉一次 index，比对快照版本号。 */
  async "skills.checkUpdates"({ db, user, env, params }) {
    await ownedAgent(db, user.id, params.get("agent_id"));
    const rows = (await installedSkillRows(db, uuid(params.get("agent_id"), "agent_id")))
      .filter((row) => row.source_registry_id);
    const remote = rows.filter((row) => row.source_registry_id);
    const registryIds = [...new Set(remote.map((row) => row.source_registry_id))];
    const registries = registryIds.length
      ? await db.skill_registries.list([["id", registryIds]], { columns: REGISTRY_COLUMNS })
      : [];
    const probed = await Promise.all(registries.map(async (row) => ({ row, probe: await refreshRegistry(db, env, row) })));
    const byRegistry = new Map(probed.map((entry) => [entry.row.id, entry]));
    const items = [];
    const unavailable = [];
    for (const row of remote) {
      const entry = byRegistry.get(row.source_registry_id);
      if (!entry) {
        unavailable.push({ skill_id: row.id, name: row.name, reason: "registry_not_found" });
        continue;
      }
      if (entry.probe.error) {
        unavailable.push({ skill_id: row.id, name: row.name, reason: entry.probe.error });
        continue;
      }
      const latest = entry.probe.items.find((item) => item.slug === row.source_slug);
      if (!latest) {
        unavailable.push({ skill_id: row.id, name: row.name, reason: "skill_not_in_registry" });
        continue;
      }
      items.push({
        skill_id: row.id,
        name: row.name,
        registry_name: entry.row.name,
        current_version: row.version ?? "",
        latest_version: latest.version,
        update_available: isUpdateAvailable(row.version, latest.version),
      });
    }
    return json({ ok: true, items, unavailable, checked_at: now() });
  },
};
