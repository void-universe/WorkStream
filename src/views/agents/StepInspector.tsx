// 轨迹检视器：时间线上点开一颗音符后，右侧这一栏按步骤类型给出对应的页签。
// 数据只来自 agents.trajectory（轻列没有 detail，原文在那儿才拿得到），所以这里纯粹是展示。
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { clockOf } from "../../lib/format";
import { Notice, StatRow } from "../../lib/ui";
import type { RunStep, TrajectoryResponse } from "../../types";

const KIND_LABEL = { model: "模型轮", tool: "工具调用" } as const;
const STATUS_LABEL: Record<RunStep["status"], string> = {
  running: "进行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已掐断",
};

/** 轨迹里才会出现的错误码；库外的码交给 describeError 兜底。 */
const STEP_ERROR: Record<string, string> = {
  tool_not_allowed: "这个工具名不在清单里，是模型临时编出来的，没有执行。",
  invalid_arguments: "参数不是合法 JSON，没有送进工具。",
  interrupted: "群里有人插话，这一轮被掐断。",
  slice_interrupted: "时间片结束时这一步还没合上，已回收。",
  step_unfinished: "整封邮件收尾时这一步仍未结束。",
  step_write_failed: "这一步没能写进库。",
};

function ms(msValue: number | null | undefined): string {
  if (msValue === null || msValue === undefined) return "—";
  const value = Number(msValue);
  if (!Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.floor(value / 60_000)} 分 ${Math.round((value % 60_000) / 1000)} 秒`;
}

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : String(value);
}

function pretty(raw: string | undefined): string {
  const value = String(raw ?? "");
  if (!value) return "";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function ClipNote({ field, detail }: { field: "args" | "result" | "reasoning" | "content"; detail: RunStep["detail"] }) {
  const original = detail?.[`${field}_clipped`];
  if (typeof original !== "number") return null;
  return (
    <p className="mt-1 text-[10px] leading-relaxed text-machine">
      原文 {original.toLocaleString("zh-CN")} 字，库里按单步上限只留了前 {(String(detail?.[field] ?? "")).length.toLocaleString("zh-CN")} 字。
    </p>
  );
}

function Mono({ children }: { children: string }) {
  if (!children) return <Notice>这一段是空的。</Notice>;
  return (
    <pre className="max-h-60 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[10.5px] leading-relaxed break-words whitespace-pre-wrap">
      {children}
    </pre>
  );
}

function Row({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 py-0.5">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-right font-mono text-[11px]",
          multiline ? "min-w-0 break-words" : "min-w-0 truncate",
        )}
      >
        {value}
      </span>
    </div>
  );
}

type Props = {
  step: RunStep | null;
  mail: TrajectoryResponse["mail"] | null;
  schemas: TrajectoryResponse["schemas"];
  loading: boolean;
  error: string;
  onRefresh: () => void;
};

export function StepInspector({ step, mail, schemas, loading, error, onRefresh }: Props) {
  const [tab, setTab] = useState<string>("overview");

  const tabs = useMemo(() => {
    if (!step) return [];
    return step.kind === "model"
      ? [["overview", "概述"], ["reasoning", "思考链"], ["content", "输出"], ["context", "上下文"], ["timing", "计时"]]
      : [["overview", "概述"], ["args", "参数"], ["result", "结果"], ["schema", "Schema"]];
  }, [step]);

  const active = tabs.some(([id]) => id === tab) ? tab : "overview";
  const detail = step?.detail ?? {};
  const context = useMemo(() => {
    try {
      return JSON.parse(String(detail.context ?? "{}")) as Record<string, number>;
    } catch {
      return null;
    }
  }, [detail.context]);

  if (error) return <Notice tone="warn">读不到这一步：{error}</Notice>;
  if (loading && !step) return <Notice>正在取这一步的原文……</Notice>;
  if (!step) {
    return (
      <Notice>
        点一颗音符看那一轮的思考链、工具参数与结果；按住拖动可以框选一段时间。
      </Notice>
    );
  }

  const tokens = [
    ["输入", step.input_tokens],
    ["输出", step.output_tokens],
    ["思考", step.reasoning_tokens],
    ["命中缓存", step.cached_tokens],
  ] as const;
  const hitRate = step.input_tokens && step.cached_tokens
    ? `${Math.round((step.cached_tokens / step.input_tokens) * 100)}%`
    : "—";
  const genMs = step.duration_ms !== null && step.first_token_ms !== null
    ? Math.max(step.duration_ms - step.first_token_ms, 0)
    : null;
  const throughput = genMs && step.output_tokens ? `${(step.output_tokens / (genMs / 1000)).toFixed(1)} tok/s` : "—";
  const schema = step.kind === "tool" ? schemas.find((row) => row.name === step.name) : undefined;

  return (
    <div className="grid min-w-0 gap-2 content-start">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
        <p className="flex min-w-0 items-center text-xs font-semibold">
          <span className="shrink-0 font-mono">#{step.seq}</span>
          <span className="mx-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: step.kind === "model" ? "var(--machine)" : "var(--signal)" }} aria-hidden />
          <span className="shrink-0">{KIND_LABEL[step.kind]}</span>
          <span className="ml-1.5 min-w-0 truncate text-[11px] font-normal text-muted-foreground">{step.name || "—"}</span>
        </p>
        <button
          type="button"
          onClick={onRefresh}
          className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
        >
          重新读取
        </button>
      </div>

      <div className="flex min-w-0 flex-wrap gap-1">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10.5px] transition-colors",
              active === id ? "border-transparent bg-foreground text-background" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {active === "overview" ? (
        <div className="grid min-w-0 gap-0.5">
          <Row label="状态" value={STATUS_LABEL[step.status] ?? step.status} />
          <Row label="群" value={mail?.stream.name ?? "—"} />
          <Row label="起因" multiline value={mail ? `#${mail.trigger_seq} ${mail.trigger_preview || "（无正文）"}` : "—"} />
          <Row label="开始" value={clockOf(step.started_at)} />
          <Row label="结束" value={step.finished_at ? clockOf(step.finished_at) : "—"} />
          <Row label="占用" value={ms(step.duration_ms)} />
          {step.kind === "model" ? <Row label="本轮调的工具" multiline value={detail.tool_names || "（没有，直接成文）"} /> : null}
          {detail.note ? <Row label="备注" multiline value={String(detail.note)} /> : null}
          {step.error ? (
            <p className="mt-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-destructive">
              <span className="font-mono">{step.error}</span>
              <span className="mt-0.5 block text-foreground/80">{STEP_ERROR[step.error] ?? ""}</span>
            </p>
          ) : null}
          {mail?.error ? <Row label="整封的状态" value={mail.error} /> : null}
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            群聊里看不到这些过程——它们只记在这封邮件的轨迹上，正文照常只发最终回复。
          </p>
        </div>
      ) : null}

      {active === "reasoning" ? (
        <div className="min-w-0">
          <Mono>{String(detail.reasoning ?? "")}</Mono>
          <ClipNote field="reasoning" detail={detail} />
        </div>
      ) : null}

      {active === "content" ? (
        <div className="min-w-0">
          <Mono>{String(detail.content ?? "")}</Mono>
          <ClipNote field="content" detail={detail} />
        </div>
      ) : null}

      {active === "context" ? (
        context ? (
          <div className="grid min-w-0 gap-0.5">
            <Row label="转录区间" value={`#${context.from ?? "—"} → #${context.to ?? "—"}`} />
            <Row label="摘要覆盖到" value={context.summary_through ? `#${context.summary_through}` : "（无摘要）"} />
            <Row label="上下文块数" value={count(context.blocks)} />
            <Row label="上下文字符" value={count(context.chars)} />
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              这里只记口径不记正文：这段转录在群里本来就能翻，重复存一份只会把库撑大。
            </p>
          </div>
        ) : (
          <Mono>{String(detail.context ?? "")}</Mono>
        )
      ) : null}

      {active === "timing" ? (
        <div className="grid min-w-0 gap-1 pt-1">
          <StatRow label="首字延迟" value={ms(step.first_token_ms)} tone="signal" />
          <StatRow label="生成阶段" value={ms(genMs)} />
          <StatRow label="总占用" value={ms(step.duration_ms)} />
          <StatRow label="输出吞吐" value={throughput} tone="machine" />
          <div className="mt-1 grid min-w-0 grid-cols-2 gap-x-3 gap-y-0.5 border-t pt-1.5">
            {tokens.map(([label, value]) => (
              <Row key={label} label={label} value={count(value)} />
            ))}
            <Row label="缓存命中" value={hitRate} />
            <Row label="这一步字符" value={count(step.chars)} />
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            吞吐按「输出 token ÷ 首字之后的时间」算；缓存命中来自上游回报的 usage，端点不回报时就是「—」。
          </p>
        </div>
      ) : null}

      {active === "args" ? (
        <div className="min-w-0">
          <Mono>{pretty(detail.args)}</Mono>
          <ClipNote field="args" detail={detail} />
        </div>
      ) : null}

      {active === "result" ? (
        <div className="min-w-0">
          <Mono>{pretty(detail.result)}</Mono>
          <ClipNote field="result" detail={detail} />
        </div>
      ) : null}

      {active === "schema" ? (
        schema ? (
          <div className="min-w-0">
            <p className="mb-1 break-words text-[10.5px] text-muted-foreground">
              <span className="font-mono">{schema.name}</span> 的入参声明，与这次实际传的参数同一份工具清单。
            </p>
            <Mono>{JSON.stringify(schema.parameters ?? {}, null, 2)}</Mono>
          </div>
        ) : (
          <Notice>这一步没有对应的工具声明（多半是模型编出来的工具名）。</Notice>
        )
      ) : null}
    </div>
  );
}
