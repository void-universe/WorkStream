// 轨迹检视器：时间线上点开一颗音符后，右侧这一栏按步骤类型给出对应的页签。
// 数据只来自 agents.trajectory（轻列没有 detail，原文在那儿才拿得到），所以这里纯粹是展示。
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { describeCode } from "../../api";
import { clockOf } from "../../lib/format";
import { Notice, StatRow } from "../../lib/ui";
import type { RunStep, TrajectoryResponse } from "../../types";
import { useI18n, type I18n, type MsgKey } from "../../lib/i18n";

// 表里只存键、不存句子：这些标签会随界面语言变，翻词发生在取词方。
const KIND_LABEL: Record<RunStep["kind"], MsgKey> = { model: "step.kindModel", tool: "step.kindTool" };
const STATUS_LABEL: Record<RunStep["status"], MsgKey> = {
  running: "step.statusRunning",
  done: "step.statusDone",
  failed: "step.statusFailed",
  cancelled: "step.statusCancelled",
};

/** 轨迹里才会出现的错误码；库外的码交给 describeError 兜底。 */
const STEP_ERROR: Record<string, MsgKey> = {
  tool_unknown: "step.errToolUnknown",
  connector_tool_unmatched: "step.errConnectorToolUnmatched",
  connector_needs_agent_run: "step.errConnectorNeedsRun",
  invalid_arguments: "step.errInvalidArguments",
  interrupted: "step.errInterrupted",
  slice_interrupted: "step.errSliceInterrupted",
  step_unfinished: "step.errStepUnfinished",
  step_write_failed: "step.errStepWriteFailed",
  summary_empty: "step.errSummaryEmpty",
};

// upstream_* 那句话的家在 api.ts 的错误码清单里（界面上别处也要用同一个码说同一件事），
// 这里只是把它接到这一步下面，不在两处各写一遍。
const stepErrorNote = (i18n: I18n, code: string) => {
  const noteKey = STEP_ERROR[code];
  if (noteKey) return i18n.t(noteKey);
  return code.startsWith("upstream_") ? describeCode(i18n, code) : "";
};

function ms(i18n: I18n, msValue: number | null | undefined): string {
  const noData = i18n.t("step.noData");
  if (msValue === null || msValue === undefined) return noData;
  const value = Number(msValue);
  if (!Number.isFinite(value)) return noData;
  // 单位 ms / s 是 SI 写法、不译；只有「分/秒」这个句式要进字典。
  if (value < 1000) return `${i18n.number(Math.round(value))} ms`;
  if (value < 60_000) return `${i18n.number(Number((value / 1000).toFixed(2)))} s`;
  return i18n.tf("step.durationMinSec", {
    m: Math.floor(value / 60_000),
    s: Math.round((value % 60_000) / 1000),
  });
}

function count(i18n: I18n, value: number | null | undefined): string {
  return value === null || value === undefined ? i18n.t("step.noData") : i18n.number(value);
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
  const i18n = useI18n();
  const original = detail?.[`${field}_clipped`];
  if (typeof original !== "number") return null;
  return (
    <p className="mt-1 text-[10px] leading-relaxed text-machine">
      {i18n.tf("step.clippedNote", { original, kept: (String(detail?.[field] ?? "")).length })}
    </p>
  );
}

function Mono({ children }: { children: string }) {
  const i18n = useI18n();
  if (!children) return <Notice>{i18n.t("step.emptySection")}</Notice>;
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
  const i18n = useI18n();
  const [tab, setTab] = useState<string>("overview");

  const tabs = useMemo<[string, MsgKey][]>(() => {
    if (!step) return [];
    return step.kind === "model"
      ? [["overview", "step.tabOverview"], ["reasoning", "step.tabReasoning"], ["content", "step.tabContent"], ["context", "step.tabContext"], ["timing", "step.tabTiming"]]
      : [["overview", "step.tabOverview"], ["args", "step.tabArgs"], ["result", "step.tabResult"], ["schema", "step.tabSchema"]];
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
  // 提示词槽位：块序即缓存序，所以这里要按原序列出来，并标出第一个每轮重写的块。
  const slots = useMemo(() => {
    try {
      return JSON.parse(String(detail.prompt_slots ?? "[]")) as [string, number, boolean][];
    } catch {
      return null;
    }
  }, [detail.prompt_slots]);
  const firstRewrite = slots?.findIndex(([, , volatile]) => volatile) ?? -1;
  // 整封的码常常就是这一步的码：同一句话在一屏里说两遍是噪声，只在两者不同才补一句人话。
  const mailErrorNote = mail?.error && mail.error !== step?.error ? stepErrorNote(i18n, mail.error) : "";
  const charsOf = (volatile: boolean) => (slots ?? [])
    .filter(([, , slotVolatile]) => slotVolatile === volatile)
    .reduce((sum, [, chars]) => sum + chars, 0);
  const noData = i18n.t("step.noData");
  // 工具声明那句话要在名字前后夹一个等宽元素，所以取词方用 tp 拆两段。
  const schemaNoteParts = i18n.tp("step.schemaNote");

  if (error) return <Notice tone="warn">{i18n.tf("step.loadFailed", { error })}</Notice>;
  if (loading && !step) return <Notice>{i18n.t("step.loading")}</Notice>;
  if (!step) {
    return (
      <Notice>
        {i18n.t("step.pickHint")}
      </Notice>
    );
  }

  const tokens: { labelKey: MsgKey; value: number | null }[] = [
    { labelKey: "step.tokenInput", value: step.input_tokens },
    { labelKey: "step.tokenOutput", value: step.output_tokens },
    { labelKey: "step.tokenReasoning", value: step.reasoning_tokens },
    { labelKey: "step.tokenCached", value: step.cached_tokens },
  ];
  const hitRate = step.input_tokens && step.cached_tokens
    ? `${Math.round((step.cached_tokens / step.input_tokens) * 100)}%`
    : noData;
  const genMs = step.duration_ms !== null && step.first_token_ms !== null
    ? Math.max(step.duration_ms - step.first_token_ms, 0)
    : null;
  const throughput = genMs && step.output_tokens ? `${i18n.number(Number((step.output_tokens / (genMs / 1000)).toFixed(1)))} tok/s` : noData;
  const schema = step.kind === "tool" ? schemas.find((row) => row.name === step.name) : undefined;

  return (
    <div className="grid min-w-0 gap-2 content-start">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
        <p className="flex min-w-0 items-center text-xs font-semibold">
          <span className="shrink-0 font-mono">#{step.seq}</span>
          <span className="mx-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: step.kind === "model" ? "var(--machine)" : "var(--signal)" }} aria-hidden />
          <span className="shrink-0">{i18n.t(KIND_LABEL[step.kind])}</span>
          <span className="ml-1.5 min-w-0 truncate text-[11px] font-normal text-muted-foreground">{step.name || noData}</span>
        </p>
        <button
          type="button"
          onClick={onRefresh}
          className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
        >
          {i18n.t("step.reload")}
        </button>
      </div>

      <div className="flex min-w-0 flex-wrap gap-1">
        {tabs.map(([id, labelKey]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10.5px] transition-colors",
              active === id ? "border-transparent bg-foreground text-background" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {i18n.t(labelKey)}
          </button>
        ))}
      </div>

      {active === "overview" ? (
        <div className="grid min-w-0 gap-0.5">
          <Row label={i18n.t("step.rowStatus")} value={STATUS_LABEL[step.status] ? i18n.t(STATUS_LABEL[step.status]) : step.status} />
          <Row label={i18n.t("step.rowStream")} value={mail?.stream.name ?? noData} />
          <Row label={i18n.t("step.rowTrigger")} multiline value={mail ? `#${mail.trigger_seq} ${mail.trigger_preview || i18n.t("step.noBody")}` : noData} />
          <Row label={i18n.t("step.rowStarted")} value={clockOf(i18n, step.started_at)} />
          <Row label={i18n.t("step.rowEnded")} value={step.finished_at ? clockOf(i18n, step.finished_at) : noData} />
          <Row label={i18n.t("step.rowDuration")} value={ms(i18n, step.duration_ms)} />
          {step.kind === "model" ? <Row label={i18n.t("step.rowTools")} multiline value={detail.tool_names || i18n.t("step.noTools")} /> : null}
          {detail.note ? <Row label={i18n.t("step.rowNote")} multiline value={String(detail.note)} /> : null}
          {step.error ? (
            <p className="mt-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-destructive">
              <span className="font-mono">{step.error}</span>
              <span className="mt-0.5 block text-foreground/80">{stepErrorNote(i18n, step.error)}</span>
            </p>
          ) : null}
          {/* 整封的失败码原来只有裸码一行；同一句话在别处怎么说这里就怎么说，省得两处口径分叉。 */}
          {mail?.error ? <Row label={i18n.t("step.rowMailStatus")} value={mail.error} /> : null}
          {mailErrorNote ? (
            <p className="mt-0.5 text-right text-[10.5px] leading-relaxed text-muted-foreground">{mailErrorNote}</p>
          ) : null}
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {i18n.t("step.chatPrivacyNote")}
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
            <Row label={i18n.t("step.rowTranscriptRange")} value={`#${context.from ?? noData} → #${context.to ?? noData}`} />
            <Row label={i18n.t("step.rowSummaryThrough")} value={context.summary_through ? `#${context.summary_through}` : i18n.t("step.noSummary")} />
            <Row label={i18n.t("step.rowContextBlocks")} value={count(i18n, context.blocks)} />
            <Row label={i18n.t("step.rowContextChars")} value={count(i18n, context.chars)} />
            {slots?.length ? (
              <div className="mt-1 min-w-0 border-t pt-1.5">
                <p className="text-[10px] text-muted-foreground">
                  {i18n.tf("step.slotsHeader", { stable: charsOf(false), volatile: charsOf(true) })}
                </p>
                <div className="mt-1 flex min-w-0 flex-wrap gap-1">
                  {slots.map(([id, chars, volatile], index) => (
                    <span
                      key={id}
                      title={volatile ? i18n.t("step.slotVolatileTitle") : i18n.t("step.slotStableTitle")}
                      className={cn(
                        "rounded border px-1 py-0.5 font-mono text-[10px]",
                        volatile ? "text-foreground" : "border-transparent bg-muted/60 text-muted-foreground",
                      )}
                      style={index === firstRewrite ? { borderColor: "var(--signal)" } : undefined}
                    >
                      {index === firstRewrite ? i18n.tf("step.breakpointTag", { slot: id }) : id}·{chars}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {i18n.t("step.contextNote")}
            </p>
          </div>
        ) : (
          <Mono>{String(detail.context ?? "")}</Mono>
        )
      ) : null}

      {active === "timing" ? (
        <div className="grid min-w-0 gap-1 pt-1">
          <StatRow label={i18n.t("step.statFirstToken")} value={ms(i18n, step.first_token_ms)} tone="signal" />
          <StatRow label={i18n.t("step.statGeneration")} value={ms(i18n, genMs)} />
          <StatRow label={i18n.t("step.statTotal")} value={ms(i18n, step.duration_ms)} />
          <StatRow label={i18n.t("step.statThroughput")} value={throughput} tone="machine" />
          <div className="mt-1 grid min-w-0 grid-cols-2 gap-x-3 gap-y-0.5 border-t pt-1.5">
            {tokens.map(({ labelKey, value }) => (
              <Row key={labelKey} label={i18n.t(labelKey)} value={count(i18n, value)} />
            ))}
            <Row label={i18n.t("step.rowCacheHit")} value={hitRate} />
            <Row label={i18n.t("step.rowStepChars")} value={count(i18n, step.chars)} />
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {i18n.t("step.timingNote")}
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
              {schemaNoteParts[0]}
              <span className="font-mono">{schema.name}</span>
              {schemaNoteParts[1]}
            </p>
            <Mono>{JSON.stringify(schema.parameters ?? {}, null, 2)}</Mono>
          </div>
        ) : (
          <Notice>{i18n.t("step.noSchemaNote")}</Notice>
        )
      ) : null}
    </div>
  );
}
