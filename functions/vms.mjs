// 办公虚拟机：每人可登记多台，凭据静态加密；创建群时可绑定，之后可授权/撤销到某个群。
// 说明：站点 Function 是 Edge 运行时，没有可用的 TCP/SSH 客户端，因此这里做的是
// 登记 + 授权 + 一次 HTTP 端口探活，真实的 SSH 命令执行留给群内 Agent 侧的 MCP 工具。
import { seal } from "./sec.mjs";
import { requireMembership, requireRole } from "./perm.mjs";
import { nextSeq } from "./rooms.mjs";
import { Halt, json, newId, now, oneOf, randomHex, safeApiBaseUrl, sha256Hex, text, uuid } from "./util.mjs";

const VM_COLUMNS = "id,label,host,port,username,auth_kind,workdir,last_probe,owner_id,created_at,updated_at";

export const actions = {
  async "vms.list"({ db, user }) {
    const rows = await db.vms.list([["owner_id", user.id]], { columns: VM_COLUMNS, order: ["created_at", { ascending: true }] });
    const grants = await db.stream_vms.list([["vm_id", rows.map((r) => r.id)]], { columns: "vm_id,stream_id,level", limit: 200 }).catch(() => []);
    return json({ ok: true, items: rows.map((row) => ({ ...row, granted_to: grants.filter((g) => g.vm_id === row.id).map((g) => ({ stream_id: g.stream_id, level: g.level })) })) });
  },

  async "vms.create"({ db, user, body, env }) {
    const label = text(body.label, { max: 60, name: "label" });
    const host = hostOf(body.host);
    const port = Number(body.port ?? 22);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Halt("invalid_port", 400);
    const username = text(body.username, { max: 60, name: "username" });
    const authKind = oneOf(body.auth_kind, ["password", "key"], "auth_kind");
    const secret = text(body.secret, { max: 8000, name: "secret" });
    const workdir = text(body.workdir ?? "", { max: 200, required: false });
    const sealed = await seal(secret, { supabase: db.client, env });
    const created = await db.vms.insert({
      id: newId(), owner_id: user.id, label, host, port, username,
      auth_kind: authKind, secret_cipher: sealed.cipher, key_source: sealed.key_source,
      workdir, last_probe: null, created_at: now(), updated_at: now(),
    }, { columns: VM_COLUMNS });
    if (!created) throw new Halt("vm_create_failed", 503);
    return json({ ok: true, vm: created });
  },

  async "vms.update"({ db, user, body, env }) {
    const id = uuid(body.id, "id");
    const vm = await db.vms.byId(id, { columns: VM_COLUMNS });
    if (!vm) throw new Halt("vm_not_found", 404);
    if (vm.owner_id !== user.id) throw new Halt("vm_not_owned", 403);
    const values = { updated_at: now() };
    if (body.label !== undefined) values.label = text(body.label, { max: 60, name: "label" });
    if (body.host !== undefined) values.host = hostOf(body.host);
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Halt("invalid_port", 400);
      values.port = port;
    }
    if (body.username !== undefined) values.username = text(body.username, { max: 60, name: "username" });
    if (body.workdir !== undefined) values.workdir = text(body.workdir, { max: 200, required: false });
    if (body.auth_kind !== undefined) values.auth_kind = oneOf(body.auth_kind, ["password", "key"], "auth_kind");
    if (body.secret) {
      const sealed = await seal(text(body.secret, { max: 8000, name: "secret" }), { supabase: db.client, env });
      values.secret_cipher = sealed.cipher;
      values.key_source = sealed.key_source;
    }
    const updated = await db.vms.claim([["id", id], ["owner_id", user.id]], values);
    if (!updated) throw new Halt("vm_update_failed", 503);
    return json({ ok: true, vm: await db.vms.byId(id, { columns: VM_COLUMNS }) });
  },

  async "vms.delete"({ db, user, body }) {
    const id = uuid(body.id, "id");
    const vm = await db.vms.byId(id, { columns: "id,owner_id" });
    if (!vm) throw new Halt("vm_not_found", 404);
    if (vm.owner_id !== user.id) throw new Halt("vm_not_owned", 403);
    // 机器没了，各群的授权行一起删掉；留着 level="revoked" 没有读者，只会在列表里挂幽灵行。
    await db.stream_vms.removeAll([["vm_id", id]]);
    const removed = await db.vms.remove([["id", id], ["owner_id", user.id]]);
    if (!removed) throw new Halt("vm_delete_failed", 503);
    return json({ ok: true, id: removed });
  },

  /** 端口/HTTP 探活：证明这台机器可达，不代表已经跑通 SSH 会话。 */
  async "vms.probe"({ db, user, body, env }) {
    const id = uuid(body.id, "id");
    const vm = await db.vms.byId(id, { columns: `${VM_COLUMNS},secret_cipher` });
    if (!vm) throw new Halt("vm_not_found", 404);
    if (vm.owner_id !== user.id) throw new Halt("vm_not_owned", 403);
    const allowPrivate = env?.("WORKSTREAM_DEV") === "1";
    const started = Date.now();
    let result;
    try {
      const target = safeApiBaseUrl(`http://${vm.host}:${vm.port}/`, { allowPrivate });
      const response = await fetch(`${target.url}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(4000),
      });
      result = { reachable: true, http_status: response.status, note: "端口有响应（HTTP 层）；SSH 握手需由群内 Agent 侧客户端完成。" };
    } catch (error) {
      result = {
        reachable: false,
        note: error?.name === "TimeoutError"
          ? "4 秒内无响应：可能只监听 SSH 而无 HTTP，或安全组未放行。"
          : "无法建立连接：检查主机、端口与出网策略。",
      };
    }
    const probe = { ...result, checked_at: now(), ms: Date.now() - started };
    await db.vms.patch([["id", id], ["owner_id", user.id]], { last_probe: probe, updated_at: now() });
    return json({ ok: true, probe });
  },

  async "streams.vms.grant"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const vmId = uuid(body.vm_id, "vm_id");
    await requireRole(db, streamId, user, ["owner", "admin"]);
    const vm = await db.vms.byId(vmId, { columns: "id,owner_id,label" });
    if (!vm) throw new Halt("vm_not_found", 404);
    if (vm.owner_id !== user.id) throw new Halt("vm_not_owned", 403);
    const existing = await db.stream_vms.first([["stream_id", streamId], ["vm_id", vmId]]);
    const level = oneOf(body.level ?? "member", ["member", "sudo"], "level");
    if (existing) {
      await db.stream_vms.patch([["id", existing.id]], { level, granted_by: user.id, updated_at: now() });
      return json({ ok: true, grant_id: existing.id, level });
    }
    const created = await db.stream_vms.insert({
      id: newId(), stream_id: streamId, vm_id: vmId, level, granted_by: user.id, created_at: now(),
    }, { columns: "id" });
    if (!created) throw new Halt("grant_failed", 503);
    await db.messages.insert({
      id: newId(), stream_id: streamId, seq: await nextSeq(db, streamId), sender_type: "system",
      sender_id: user.id, sender_name: "系统",
      content: `${user.display_name} 把虚拟机「${vm.label}」授权给本群（级别：${level === "sudo" ? "可用 sudo" : "普通用户"}）。`,
      mentions: [], reply_to: null, kind: "system", error: null, created_at: now(),
    }, { columns: "id" });
    return json({ ok: true, grant_id: created.id });
  },

  async "streams.vms.revoke"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    await requireRole(db, streamId, user, ["owner", "admin"]);
    const grant = await db.stream_vms.byId(uuid(body.grant_id, "grant_id"));
    if (!grant || grant.stream_id !== streamId) throw new Halt("grant_not_found", 404);
    await db.stream_vms.remove([["id", grant.id]]);
    return json({ ok: true, removed: grant.id });
  },

  /** 颁发/重置这个群的 MCP key；明文只在这次响应里出现一次。 */
  async "streams.mcpkey.rotate"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const stream = await db.streams.byId(streamId, { columns: "id,owner_id,name" });
    if (!stream) throw new Halt("stream_not_found", 404);
    if (stream.owner_id !== user.id) throw new Halt("owner_only", 403);
    const plain = randomHex(24);
    await db.streams.patch([["id", streamId]], {
      mcp_key_hash: await sha256Hex(plain),
      mcp_key_set: true,
      updated_at: now(),
    });
    return json({
      ok: true,
      key: plain,
      endpoint: "/functions/v1/app?action=mcp",
      curl: `curl -X POST '$ORIGIN/functions/v1/app?action=mcp' -H 'content-type: application/json' -H 'x-workstream-mcp-key: ${plain}' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    });
  },

  async "streams.mcpkey.clear"({ db, user, body }) {
    const streamId = uuid(body.stream_id, "stream_id");
    const stream = await db.streams.byId(streamId, { columns: "id,owner_id" });
    if (!stream) throw new Halt("stream_not_found", 404);
    if (stream.owner_id !== user.id) throw new Halt("owner_only", 403);
    await db.streams.patch([["id", streamId]], { mcp_key_hash: null, mcp_key_set: false, updated_at: now() });
    return json({ ok: true });
  },

  async "streams.mine.vms"({ db, user, params }) {
    const streamId = uuid(params.get("stream_id"), "stream_id");
    await requireMembership(db, streamId, user.id);
    const grants = await db.stream_vms.list([["stream_id", streamId]], { columns: "id,vm_id,level", limit: 50 });
    const ids = grants.map((g) => g.vm_id);
    const rows = ids.length ? await db.vms.list([["id", ids]], { columns: VM_COLUMNS, limit: 50 }) : [];
    return json({ ok: true, items: grants.map((g) => ({ ...g, vm: rows.find((r) => r.id === g.vm_id) ?? null })) });
  },
};

function hostOf(value) {
  const host = text(value, { max: 200, name: "host" });
  if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new Halt("invalid_host", 400);
  return host.toLowerCase();
}
