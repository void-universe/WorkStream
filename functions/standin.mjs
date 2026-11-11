// AI stand-in: one hidden agent per account, switched on with one call.
//
// It is not one of your employees: kind='standin' keeps it out of the employee list, and the
// delivery path is the existing delegate one (users.delegate_agent_id plus the optional window), so a
// stand-in and a manually appointed employee answer through exactly the same mail and time slices.
import { AGENT_COLUMNS, AGENT_SECRET_COLUMNS } from "./agents.mjs";
import { serverById } from "./servers.mjs";
import { installDefaultSkillsFor } from "./skills.mjs";
import { Halt, CONTEXT_CHARS_DEFAULT, json, newId, now, text, uuid } from "./util.mjs";

export const STANDIN_KIND = "standin";
const STANDIN_COLOR = "#3f6f6a";

export async function standinOf(db, ownerId) {
  return db.agents.first([["owner_id", ownerId], ["kind", STANDIN_KIND]], { columns: AGENT_COLUMNS });
}

/** 把替身塞进这位真人在的所有群：它只替 ta 回话，所以范围就是 ta 的群。 */
async function joinAllStreams(db, humanId, agentId) {
  const memberships = await db.members.list([["principal_type", "human"], ["principal_id", humanId]], {
    columns: "stream_id", limit: 500,
  });
  const have = await db.members.list([["principal_type", "agent"], ["principal_id", agentId]], {
    columns: "stream_id", limit: 500,
  });
  const joined = new Set(have.map((row) => row.stream_id));
  const added = [];
  for (const row of memberships) {
    if (joined.has(row.stream_id)) continue;
    await db.members.insert({
      id: newId(),
      stream_id: row.stream_id,
      principal_type: "agent",
      principal_id: agentId,
      role: "member",
      joined_at: now(),
    }, { columns: "id" });
    added.push(row.stream_id);
  }
  return added;
}

async function createStandin(db, user, { serverId, model }) {
  const server = await serverById(db, user, serverId);
  const models = (() => {
    try {
      const parsed = JSON.parse(server.models ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const id = newId();
  const created = await db.agents.insert({
    id,
    owner_id: user.id,
    name: `替身 · ${user.display_name}`,
    role: "代我处理群里的 @，替不在线的我回话",
    signature: "",
    avatar: "",
    api_base_url: server.base_url,
    api_key_cipher: server.token_cipher,
    api_key_tail: server.token_tail,
    key_source: server.key_source,
    model: text(model ?? models[0] ?? "default", { max: 120, name: "model" }),
    system_prompt: "你在替主人回复群里的 @：说清楚你知道什么、不知道什么，别替 ta 承诺没确认的事。",
    context_chars: CONTEXT_CHARS_DEFAULT,
    compact_at: 95,
    backend: "stream",
    qca_agent_id: null,
    qca_environment_id: null,
    stream_profile: server.stream_profile,
    kind: STANDIN_KIND,
    color: STANDIN_COLOR,
    status: "active",
    created_at: now(),
    updated_at: now(),
  }, { columns: AGENT_COLUMNS });
  if (!created) throw new Halt("standin_create_failed", 503);
  await installDefaultSkillsFor(db, id, user.id);
  return created;
}

export const actions = {
  /** 当前替身状态：开没开、对应哪条隐藏员工、窗口、覆盖了多少群。 */
  async "standin.get"({ db, user }) {
    const agent = await standinOf(db, user.id);
    return json({
      ok: true,
      enabled: Boolean(user.standin_enabled),
      agent: agent ? { id: agent.id, name: agent.name, model: agent.model, api_base_url: agent.api_base_url } : null,
      mode: user.standin_enabled ? (user.delegate_start_at || user.delegate_end_at ? "window" : "now") : "off",
      start_at: user.delegate_start_at ?? null,
      end_at: user.delegate_end_at ?? null,
    });
  },

  /** 一键开：没有替身就用这台 server 建一条隐藏员工，然后把它加进你在的所有群。 */
  async "standin.enable"({ db, user, body }) {
    const serverId = uuid(body.server_id, "server_id");
    let agent = await standinOf(db, user.id);
    if (!agent) agent = await createStandin(db, user, { serverId, model: body.model });
    if (agent.status !== "active") {
      await db.agents.claim([["id", agent.id], ["owner_id", user.id]], { status: "active", updated_at: now() });
    }
    const startAt = body.start_at ? text(body.start_at, { max: 40, name: "start_at" }) : null;
    const endAt = body.end_at ? text(body.end_at, { max: 40, name: "end_at" }) : null;
    const window = Boolean(startAt || endAt);
    await db.users.patch([["id", user.id]], {
      standin_enabled: true,
      delegate_agent_id: agent.id,
      delegate_start_at: startAt,
      delegate_end_at: endAt,
      updated_at: now(),
    });
    const joined = await joinAllStreams(db, user.id, agent.id);
    return json({ ok: true, enabled: true, agent_id: agent.id, joined });
  },

  /** 一键关：停用替身并撤销委派；隐藏员工本身留着，下次开还是同一条。 */
  async "standin.disable"({ db, user }) {
    await db.users.patch([["id", user.id]], {
      standin_enabled: false,
      delegate_agent_id: null,
      delegate_start_at: null,
      delegate_end_at: null,
      updated_at: now(),
    });
    return json({ ok: true, enabled: false });
  },
};
