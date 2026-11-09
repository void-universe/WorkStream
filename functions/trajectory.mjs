// 轨迹读取：员工详情页的时间线点开某一步时，按这封邮箱信取回全部步骤原文。
// 权限口径和 agents.presence 一致——员工主人，或这封信所在群的成员；群已删则成员行不在，读不到。
import { langOf, systemCopy } from "./copy.mjs";
import { toolSchemas } from "./mcp.mjs";
import { connectorSchemas } from "./plugins.mjs";
import { fullSteps } from "./steps.mjs";
import { Halt, json, uuid } from "./util.mjs";

const MAIL_COLUMNS =
  "id,agent_id,stream_id,message_id,trigger_seq,status,priority,error,created_at,started_at,finished_at,slice_count";

export const actions = {
  async "agents.trajectory"({ db, user, params }) {
    const mailId = uuid(params.get("mail_id"), "mail_id");
    const mail = await db.mail.byId(mailId, { columns: MAIL_COLUMNS });
    if (!mail) throw new Halt("mail_not_found", 404);
    const agent = await db.agents.byId(mail.agent_id, { columns: "id,owner_id,name,role" });
    if (agent?.owner_id !== user.id) {
      const member = await db.members.first([
        ["stream_id", mail.stream_id], ["principal_type", "human"], ["principal_id", user.id],
      ], { columns: "id" });
      if (!member) throw new Halt("trajectory_forbidden", 403);
    }
    const stream = await db.streams.byId(mail.stream_id, { columns: "id,name" });
    const trigger = mail.message_id ? await db.messages.byId(mail.message_id, { columns: "seq,content,sender_name" }) : null;
    const steps = await fullSteps(db, mailId);
    const toolNames = [...new Set(steps.filter((step) => step.kind === "tool" && step.name).map((step) => step.name))];
    // 检视器的 Schema 页读这个：内置声明在 mcp.mjs 里，外部插件的声明在连接器缓存里，两份并起来给。
    const schemas = [...toolSchemas(toolNames), ...(await connectorSchemas(db, agent?.owner_id, toolNames))];
    return json({
      ok: true,
      mail: {
        id: mail.id,
        agent: agent ? { id: agent.id, name: agent.name, role: agent.role } : null,
        stream: stream ? { id: stream.id, name: stream.name } : { id: mail.stream_id, name: systemCopy(langOf(user.prefs)).streamDeleted() },
        status: mail.status,
        error: mail.error,
        trigger_seq: mail.trigger_seq,
        slice_count: mail.slice_count,
        started_at: mail.started_at,
        finished_at: mail.finished_at,
        trigger_preview: trigger ? `${trigger.sender_name}：${trigger.content}`.slice(0, 200) : "",
      },
      steps,
      schemas,
    });
  },
};
