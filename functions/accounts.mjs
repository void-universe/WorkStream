// 真实员工账号、验证令牌与开发态收件箱。
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "./sec.mjs";
import { smtpEndpoint } from "./runtime.mjs";
import { Halt, avatarData, email as emailOf, json, later, newId, now, oneOf, text, uuid } from "./util.mjs";

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const VERIFY_SECONDS = 24 * 60 * 60;

export const PUBLIC_USER =
  "id,email,email_verified,display_name,avatar,at_channel,prefs,delegate_agent_id,delegate_start_at,delegate_end_at,created_at";

export const actions = {
  async "auth.register"({ db, body }) {
    const email = emailOf(body.email);
    const password = text(body.password, { min: 8, max: 200, name: "password" });
    const displayName = text(body.display_name, { max: 64, name: "display_name" });
    const existing = await db.users.first([["email", email]], { columns: "id" });
    if (existing) throw new Halt("email_taken", 409);
    const { salt, hash, iterations } = await hashPassword(password);
    const id = newId();
    let created;
    try {
      created = await db.users.insert({
        id,
        email,
        email_verified: false,
        display_name: displayName,
        password_hash: hash,
        password_salt: salt,
        password_iterations: iterations,
        at_channel: "virtual",
        prefs: { theme: "system", notify_real_email: false },
        created_at: now(),
        updated_at: now(),
      }, { columns: PUBLIC_USER });
    } catch (error) {
      if (error?.detail?.code === "23505") throw new Halt("email_taken", 409);
      throw error;
    }
    if (!created) throw new Halt("registration_failed", 503);
    const link = await issueVerifyToken({ db, userId: id, email, displayName });
    return json({ ok: true, user: created, verify_link: link });
  },

  async "auth.verify"({ db, body }) {
    const token = text(body.token, { min: 20, max: 128, name: "token" });
    const hash = await hashToken(token);
    const record = await db.tokens.first([["token_hash", hash], ["kind", "verify"]]);
    if (!record) throw new Halt("link_invalid", 404);
    if (record.consumed) throw new Halt("link_used", 410);
    if (new Date(record.expires_at).getTime() < Date.now()) throw new Halt("link_expired", 410);
    await db.users.patch([["id", record.user_id]], { email_verified: true, updated_at: now() });
    await db.tokens.patch([["id", record.id]], { consumed: true, updated_at: now() });
    const user = await db.users.byId(record.user_id, { columns: PUBLIC_USER });
    if (!user) throw new Halt("account_missing", 503);
    return json({ ok: true, email: user.email, display_name: user.display_name });
  },

  async "auth.resend"({ db, body, user }) {
    void body;
    if (user.email_verified) throw new Halt("already_verified", 200);
    const link = await issueVerifyToken({ db, userId: user.id, email: user.email, displayName: user.display_name });
    return json({ ok: true, verify_link: link });
  },

  async "auth.login"({ db, body, request }) {
    const email = emailOf(body.email);
    const password = text(body.password, { min: 1, max: 200, name: "password" });
    const user = await db.users.first([["email", email]]);
    const ok = user ? await verifyPassword(password, user) : false;
    if (!user || !ok) throw new Halt("bad_credentials", 401);
    const token = newSessionToken();
    const session = await db.sessions.insert({
      id: newId(),
      user_id: user.id,
      token_hash: await hashToken(token),
      created_at: now(),
      expires_at: later(SESSION_SECONDS),
      user_agent: text(request.headers.get("user-agent") ?? "", { max: 200, required: false }),
    }, { columns: "id" });
    if (!session) throw new Halt("session_failed", 503);
    return json({
      ok: true,
      token,
      user: shapeUser(user),
      expires_at: later(SESSION_SECONDS),
    });
  },

  async "auth.logout"({ db, session }) {
    if (session) await db.sessions.patch([["id", session.id]], { expires_at: now(), updated_at: now() });
    return json({ ok: true });
  },

  async "auth.me"({ user }) {
    return json({ ok: true, user: shapeUser(user) });
  },

  async "auth.patch"({ db, body, user }) {
    const values = { updated_at: now() };
    if (body.display_name !== undefined) values.display_name = text(body.display_name, { max: 64, name: "display_name" });
    if (body.avatar !== undefined) values.avatar = avatarData(body.avatar);
    if (body.at_channel !== undefined) {
      values.at_channel = oneOf(body.at_channel, ["virtual", "real_email"], "at_channel");
      if (values.at_channel === "real_email" && !user.email_verified) throw new Halt("email_not_verified", 409);
    }
    if (body.prefs && typeof body.prefs === "object") {
      const prefs = { ...(user.prefs ?? {}) };
      if (body.prefs.theme !== undefined) prefs.theme = oneOf(body.prefs.theme, ["light", "dark", "system"], "theme");
      prefs.notify_real_email = Boolean(body.prefs.notify_real_email ?? prefs.notify_real_email);
      values.prefs = prefs;
    }
    const updated = await db.users.patch([["id", user.id]], values, { returning: true });
    if (!updated) throw new Halt("profile_write_failed", 503);
    const row = await db.users.byId(user.id, { columns: PUBLIC_USER });
    return json({ ok: true, user: shapeUser(row) });
  },

  async "auth.password"({ db, body, user }) {
    const current = text(body.current_password, { min: 1, max: 200, name: "current_password" });
    const next = text(body.new_password, { min: 8, max: 200, name: "new_password" });
    if (!(await verifyPassword(current, user))) throw new Halt("bad_credentials", 401);
    const { salt, hash, iterations } = await hashPassword(next);
    await db.users.patch([["id", user.id]], {
      password_hash: hash, password_salt: salt, password_iterations: iterations, updated_at: now(),
    });
    await db.sessions.patch([["user_id", user.id]], { expires_at: now(), updated_at: now() });
    return json({ ok: true, note: "所有设备的会话都已失效，请用新口令重新登录。" });
  },

  async "inbox.list"({ db, user, params }) {
    const limit = Math.min(Number(params.get("limit") ?? 40) || 40, 100);
    const rows = await db.outbox.list(
      [["user_id", user.id]],
      { columns: "id,kind,subject,body,link,stream_id,channel,status,created_at,read_at", order: ["created_at", { ascending: false }], limit },
    );
    return json({ ok: true, items: rows, smtp_relay: smtpStatus() });
  },

  async "inbox.read"({ db, body, user }) {
    const id = uuid(body.id, "id");
    const updated = await db.outbox.claim([["id", id], ["user_id", user.id]], { read_at: now() });
    if (!updated) throw new Halt("message_missing", 404);
    return json({ ok: true, id });
  },
};

function shapeUser(row) {
  return {
    id: row.id,
    email: row.email,
    email_verified: Boolean(row.email_verified),
    display_name: row.display_name,
    avatar: row.avatar ?? null,
    at_channel: row.at_channel,
    prefs: row.prefs ?? {},
    delegate: {
      agent_id: row.delegate_agent_id ?? null,
      start_at: row.delegate_start_at ?? null,
      end_at: row.delegate_end_at ?? null,
    },
    created_at: row.created_at,
  };
}

function smtpStatus() {
  const endpoint = smtpEndpoint();
  return endpoint
    ? { configured: true, mode: "relay" }
    : { configured: false, mode: "dev_inbox", note: "未配置 WORKSTREAM_SMTP_URL 中转端点，真人 @ 通知只落开发态收件箱。" };
}

/** 开发态收件箱：验证邮件不真发 SMTP，而是落库并把链接直接回给调用方。 */
async function issueVerifyToken({ db, userId, email, displayName }) {
  const token = newSessionToken();
  const record = await db.tokens.insert({
    id: newId(),
    user_id: userId,
    kind: "verify",
    token_hash: await hashToken(token),
    expires_at: later(VERIFY_SECONDS),
    consumed: false,
    created_at: now(),
    updated_at: now(),
  }, { columns: "id" });
  if (!record) throw new Halt("verify_token_failed", 503);
  const link = `#/verify?token=${token}`;
  await deliver({
    db,
    recipientEmail: email,
    userId,
    kind: "verify",
    subject: "确认你的 WorkStream 账号",
    body: `${displayName}，点击链接验证邮箱（24 小时内有效）：${link}`,
    link,
    channel: "virtual",
  });
  return link;
}

/** 统一出站投递：SMTP 端点存在则中转，否则一律落开发态收件箱。 */
export async function deliver({ db, recipientEmail, userId, kind, subject, body, link, streamId }) {
  const endpoint = smtpEndpoint();
  const row = {
    id: newId(),
    recipient_email: recipientEmail,
    user_id: userId ?? null,
    kind,
    subject,
    body,
    link: link ?? null,
    stream_id: streamId ?? null,
    channel: endpoint ? "real_email" : "virtual",
    status: "queued",
    created_at: now(),
    read_at: null,
  };
  if (endpoint) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: recipientEmail, subject, text: body }),
        signal: AbortSignal.timeout(8000),
      });
      row.status = response.ok ? "sent" : "failed";
    } catch {
      row.status = "failed";
    }
  }
  const inserted = await db.outbox.insert(row, { columns: "id" });
  if (!inserted && row.status === "queued") throw new Halt("outbox_write_failed", 503);
  return inserted?.id ?? null;
}

export { shapeUser, smtpStatus };
