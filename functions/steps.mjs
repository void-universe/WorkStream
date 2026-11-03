// 轨迹（run_steps）：一次运行 = app.mail 那一行，拆成一串密序号的步骤。
//  kinds：model = 一轮模型调用（思考链、用量、首字延迟）；tool = 一次工具调用（参数、结果）。
//  写路径只有这一处：引擎握着一份 writer，模型轮自己开合，工具步由 mcp.mjs 的 pre/post 钩子开合。
//  原文落库但有单步上限：超上限的字段截断，并把原文长度记成 `<字段>_clipped`，
//  前端据此写明"原文 N 字，这里显示前 M 字"，不让它悄悄变短。
import { Halt, newId, now } from "./util.mjs";

const FIELD_CAPS = {
  args: 2000,
  result: 8000,
  reasoning: 8000,
  content: 4000,
  context: 800,
  note: 1000,
};
const DEFAULT_CAP = 1500;

/** 时间线用的轻列：不含 detail，一条几十字节，四十封邮箱信也拉得动。 */
export const STEP_LIGHT_COLUMNS =
  "id,mail_id,seq,kind,status,name,call_id,chars,input_tokens,output_tokens,reasoning_tokens,cached_tokens,first_token_ms,duration_ms,error,started_at,finished_at";

const asText = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

function packDetail(fields) {
  const detail = {};
  let chars = 0;
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined || raw === null) continue;
    const text = asText(raw);
    chars += text.length;
    const cap = FIELD_CAPS[key] ?? DEFAULT_CAP;
    if (text.length > cap) {
      detail[key] = text.slice(0, cap);
      detail[`${key}_clipped`] = text.length;
    } else {
      detail[key] = text;
    }
  }
  return { detail, chars };
}

const usageColumns = (usage) => ({
  input_tokens: usage?.input ?? null,
  output_tokens: usage?.output ?? null,
  reasoning_tokens: usage?.reasoning ?? null,
  cached_tokens: usage?.cached ?? null,
});

/**
 * 一次运行的步骤写入器。seq 从 1 开始密排，写在同一行 mail 上；
 * 引擎每次跑一封信新建一个，绝不跨运行复用，否则两个 worker 会把序号搅在一起。
 */
export function createStepWriter(db, { mailId, agentId, streamId }) {
  let seq = 0;
  const open = async ({ kind, name = null, callId = null, detail = null, usage = null, firstTokenMs = null }) => {
    seq += 1;
    const stamp = now();
    const packed = packDetail(detail ?? {});
    const created = await db.run_steps.insert({
      id: newId(),
      mail_id: mailId,
      agent_id: agentId,
      stream_id: streamId,
      seq,
      kind,
      status: "running",
      name,
      call_id: callId,
      detail: packed.detail,
      chars: packed.chars,
      ...usageColumns(usage),
      first_token_ms: firstTokenMs,
      duration_ms: null,
      error: null,
      started_at: stamp,
      finished_at: null,
      created_at: stamp,
      updated_at: stamp,
    }, { columns: "id" });
    if (!created) throw new Halt("step_write_failed", 503, { mail_id: mailId, seq });
    return { id: created.id, seq, kind, t0: Date.now(), detail: detail ?? {} };
  };

  const close = async (step, { status = "done", detail = null, error = null, usage = null, firstTokenMs = null }) => {
    const packed = packDetail({ ...step.detail, ...(detail ?? {}) });
    await db.run_steps.patch([["id", step.id]], {
      status,
      detail: packed.detail,
      chars: packed.chars,
      ...usageColumns(usage),
      first_token_ms: firstTokenMs ?? null,
      duration_ms: Math.max(Date.now() - step.t0, 0),
      error: error ?? null,
      finished_at: now(),
      updated_at: now(),
    });
    return { ...step, status };
  };

  return {
    /** 一轮模型调用：开在发请求前，合在拿到结果后；被掐断/失败也要合上。 */
    openModel: ({ model }) => open({ kind: "model", name: model ?? null, detail: { model: model ?? "" } }),
    /** 后台压缩信没有工具回路，只记模型轮。 */
    openCompression: ({ model }) => open({ kind: "model", name: model ?? null, detail: { model: model ?? "", note: "压缩摘要" } }),
    /** 下面两个是 mcp.mjs 工具钩子的实现：pre 记参数，post 记结果。 */
    recordToolPre: async (ctx) => {
      ctx.step = await open({
        kind: "tool",
        name: ctx.name,
        callId: ctx.callId ?? null,
        detail: { args: ctx.args },
      });
    },
    recordToolPost: async (ctx) => {
      if (!ctx.step) return;
      const failure = ctx.error;
      await close(ctx.step, {
        status: failure ? "failed" : ctx.output?.error ? "failed" : "done",
        detail: { result: ctx.output },
        error: failure ? (failure.error ?? "tool_failed") : null,
      });
    },
    /**
     * 没进 handler 的调用（模型编出工具名、参数不是合法 JSON）：也要留痕。
     * 不然时间线上这一段是空的，看的人只会以为员工"什么都没干"。
     */
    recordRejected: async ({ name, callId, reason, raw }) => {
      const step = await open({
        kind: "tool",
        name: name || "(空工具名)",
        callId: callId ?? null,
        detail: { args: raw ?? "", note: reason },
      });
      return close(step, { status: "failed", error: reason });
    },
    close,
    open,
  };
}

/** 工具钩子：作用域里没有 writer（外部 MCP 调用）就整段跳过——那不属于任何一次运行。 */
export const runStepsTrace = {
  name: "run-steps",
  pre: (ctx) => ctx.scope.trace?.recordToolPre(ctx),
  post: (ctx) => ctx.scope.trace?.recordToolPost(ctx),
};

/** 时间线批量读：一次取回若干封邮箱信的步骤轻列（不含 detail）。
 *  按 started_at 倒序截最近 limit 条：四十封信全量会把轮询的响应撑大到几十 KB。 */
export async function lightSteps(db, mailIds, { limit = 240 } = {}) {
  const ids = [...new Set(mailIds.filter(Boolean))];
  if (!ids.length) return [];
  return db.run_steps.list([["mail_id", ids]], {
    columns: STEP_LIGHT_COLUMNS,
    order: ["started_at", { ascending: false }],
    limit,
  });
}

/** 检视器单封读：带 detail 原文。 */
export async function fullSteps(db, mailId, { limit = 80 } = {}) {
  return db.run_steps.list([["mail_id", mailId]], {
    columns: `${STEP_LIGHT_COLUMNS},detail`,
    order: ["seq", { ascending: true }],
    limit,
  });
}

/**
 * 回收：跑崩/被杀的进程会留下 status=running 的步骤。
 * 不补这一步，时间线上会出现永远闪着的假高光。
 */
export async function closeOrphanSteps(db, mailId, { error = "slice_interrupted" } = {}) {
  const rows = await db.run_steps.list([["mail_id", mailId], ["status", "running"]], {
    columns: "id,started_at", limit: 100,
  });
  let closed = 0;
  for (const row of rows) {
    const started = Date.parse(row.started_at);
    await db.run_steps.patch([["id", row.id]], {
      status: "cancelled",
      error,
      duration_ms: Number.isFinite(started) ? Math.max(Date.now() - started, 0) : null,
      finished_at: now(),
      updated_at: now(),
    });
    closed += 1;
  }
  return closed;
}
