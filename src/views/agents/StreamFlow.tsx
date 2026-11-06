// 员工详情里的 Stream flow：纵轴按群权重从高到低排队，横轴上每一颗是轨迹里的一步
// （一轮模型调用 / 一次工具调用），像音游的下落轨道。点一颗看细节，按住横向拖动框选一段时间。
// 横轴默认按步骤顺序铺（一格一步）：真实时间里模型轮几乎一样长，全挤在一起看不出节奏；
// 要看绝对时刻时再切「真实时间」。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { clockOf } from "../../lib/format";
import { useI18n, type I18n, type MsgKey } from "../../lib/i18n";
import { hitRateOf, newUsage, tallyUsage } from "../../lib/usageStats.mjs";
import { describeError, get } from "../../api";
import type { AgentPresenceDetail, AgentProfileMail, RunStep, TrajectoryResponse } from "../../types";
import { StepInspector } from "./StepInspector";

const LANE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const WINDOW_SPAN = 15 * 60_000;
const MIN_SPAN = 60_000;
// 一屏最多铺多少颗：再密就只能靠框选而不是靠眼睛分辨了，多出来的直接不进窗口。
const MAX_UNITS = 80;
const DRAG_THRESHOLD = 3;

/** 命中口径的字段形状跟着实现走，免得这里改一栏、那边漏一栏。 */
type UsageStat = ReturnType<typeof newUsage>;

type Unit = {
  id: string;
  kind: "model" | "tool" | "mail";
  step: RunStep | null;
  mail: AgentProfileMail;
  start: number;
  end: number;
  left: number;
  width: number;
  ordinal: number;
};

type Lane = {
  id: string;
  name: string;
  priority: number | null;
  units: Unit[];
  total: number;
  steps: number;
  queued: number;
  noTrace: number;
  usage: UsageStat;
};

// 存字典键而不是文案：切语言后要到渲染期才取词，模块级常量拿不到 hook。
const MAIL_LABEL: Record<AgentProfileMail["status"], MsgKey> = {
  queued: "deliver.queued",
  running: "deliver.running",
  done: "deliver.done",
  failed: "flow.failed",
  cancelled: "deliver.cancelled",
};

function stamp(iso: string | null): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

function laneColor(streamId: string): string {
  let hash = 0;
  for (let index = 0; index < streamId.length; index += 1) hash = (hash * 31 + streamId.charCodeAt(index)) % 997;
  return LANE_COLORS[hash % LANE_COLORS.length];
}

function durationText(msValue: number): string {
  if (msValue < 60_000) return `${Math.max(msValue / 1000, 0.1).toFixed(1)}s`;
  return `${Math.round(msValue / 60_000)}min`;
}

function axisLabel(i18n: I18n, stampMs: number, withSeconds: boolean): string {
  return clockOf(i18n, new Date(stampMs).toISOString(), withSeconds);
}

export function StreamFlow({ detail }: { detail: AgentPresenceDetail }) {
  const i18n = useI18n();
  const now = Date.now();
  const [mode, setMode] = useState<"sequence" | "time">("sequence");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [cache, setCache] = useState<Record<string, TrajectoryResponse>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [loadingMail, setLoadingMail] = useState<string | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const press = useRef<{ x: number; unitId: string | null; moved: boolean } | null>(null);
  // 在途的 mail 用 ref 记，不用 state 当门：StrictMode 下 effect 会连跑两次，
  // 拿 loadingMail 当门会让第二次直接早退、第一次的结果又被 alive 丢掉，轨迹永远取不回来。
  const inFlight = useRef(new Set<string>());

  const flow = useMemo(() => {
    const units: Unit[] = [];
    for (const mail of detail.queue) {
      const created = stamp(mail.created_at) ?? now;
      if (!mail.steps?.length) {
        // 已经收尾却没有步骤的记录 = 轨迹上线前跑完的历史邮件，画一颗假音符只会骗人。
        if (mail.status !== "queued" && mail.status !== "running") continue;
        // 剩下两种：还在排队的，和刚开跑还没发出第一轮模型的。
        const started = stamp(mail.started_at) ?? created;
        const finished = stamp(mail.finished_at) ?? (mail.status === "running" ? now : started);
        units.push({
          id: `mail:${mail.id}`, kind: "mail", step: null, mail,
          start: mail.status === "queued" ? created : started,
          end: mail.status === "queued" ? created : Math.max(finished, started),
          left: 0, width: 0, ordinal: 0,
        });
        continue;
      }
      for (const step of mail.steps) {
        const start = stamp(step.started_at);
        if (start === null) continue;
        const end = Math.max(stamp(step.finished_at) ?? (step.status === "running" ? now : start), start);
        units.push({ id: step.id, kind: step.kind, step, mail, start, end, left: 0, width: 0, ordinal: 0 });
      }
    }
    if (!units.length) return null;

    const ordered = [...units].sort((left, right) => left.start - right.start);
    const recent = ordered.slice(Math.max(ordered.length - MAX_UNITS, 0));
    let domain: { start: number; span: number } | null = null;

    if (mode === "sequence") {
      // 一格一步：宽度只由颗数决定，密集时照样数得清先后。
      const slot = 100 / recent.length;
      recent.forEach((unit, index) => {
        unit.ordinal = index + 1;
        unit.left = index * slot;
        unit.width = slot;
      });
    } else {
      // 真实时间：从最新一颗往前收到跨度 15 分钟为止，忙碌时有密度，
      // 间隔很久时也不会被拉成一条看不到的长条。
      const newest = recent[recent.length - 1].start;
      let from = recent.length - 1;
      for (let index = recent.length - 1; index >= 0; index -= 1) {
        if (newest - recent[index].start > WINDOW_SPAN) break;
        from = index;
      }
      const windowUnits = recent.slice(from);
      const first = windowUnits[0].start;
      const last = windowUnits.reduce((acc, unit) => Math.max(acc, unit.end, unit.start), first);
      const span = Math.min(Math.max(last - first, MIN_SPAN), WINDOW_SPAN);
      const domainEnd = last + span * 0.06;
      const domainStart = domainEnd - span;
      windowUnits.forEach((unit, index) => {
        unit.ordinal = index + 1;
        unit.left = ((unit.start - domainStart) / span) * 100;
        unit.width = Math.max(((unit.end - unit.start) / span) * 100, 0.15);
      });
      domain = { start: domainStart, span };
      recent.forEach((unit) => {
        if (!windowUnits.includes(unit)) unit.left = Number.NaN;
      });
    }

    const visible = recent.filter((unit) => Number.isFinite(unit.left));
    if (!visible.length) return null;

    // 车道按邮箱里出现过的群来铺，保证权重排序稳定；窗口里没有长条的群也保留车道。
    const lanes = new Map<string, Lane>();
    for (const mail of detail.queue) {
      const lane = lanes.get(mail.stream_id) ?? {
        id: mail.stream_id, name: mail.stream_name, priority: null, units: [], total: 0, steps: 0, queued: 0, noTrace: 0,
        usage: newUsage(),
      };
      lane.priority = Math.max(lane.priority ?? 0, mail.priority);
      lane.total += 1;
      lane.steps += mail.steps?.length ?? 0;
      tallyUsage(lane.usage, mail.steps ?? []);
      if (mail.status === "queued") lane.queued += 1;
      if (!mail.steps?.length && mail.status !== "queued" && mail.status !== "running") lane.noTrace += 1;
      lanes.set(mail.stream_id, lane);
    }
    // 汇总条按整个读取窗口算，和下面的车道计数同一口径，不受横向缩放/框选影响。
    const usage = newUsage();
    for (const lane of lanes.values()) {
      usage.rounds += lane.usage.rounds;
      usage.reported += lane.usage.reported;
      usage.input += lane.usage.input;
      usage.cached += lane.usage.cached;
    }
    for (const unit of visible) lanes.get(unit.mail.stream_id)?.units.push(unit);

    const rows = [...lanes.values()].sort((left, right) => {
      const leftWeight = left.priority ?? -1;
      const rightWeight = right.priority ?? -1;
      if (leftWeight !== rightWeight) return rightWeight - leftWeight;
      // lane 名是用户起的群名：排序规则跟着阅读者的语言走，而不是永远按中文拼音。
      return left.name.localeCompare(right.name, i18n.intl);
    });

    return {
      rows,
      usage,
      visible,
      byKey: new Map(ordered.map((unit) => [unit.id, unit])),
      domain,
      first: visible[0],
      last: visible[visible.length - 1],
      count: visible.length,
      stepCount: visible.filter((unit) => unit.kind !== "mail").length,
      runningNow: visible.some((unit) => unit.step?.status === "running" || (unit.kind === "mail" && unit.mail.status === "running")),
    };
  }, [detail, now, mode]);

  const selected = selectedId ? flow?.byKey.get(selectedId) ?? null : null;
  const selectedMailId = selected && selected.kind !== "mail" ? selected.mail.id : null;

  useEffect(() => {
    const mailId = selectedMailId;
    if (!mailId || cache[mailId] || failed[mailId] || inFlight.current.has(mailId)) return;
    inFlight.current.add(mailId);
    setLoadingMail(mailId);
    get<TrajectoryResponse>("agents.trajectory", { mail_id: mailId })
      .then((data) => setCache((prev) => ({ ...prev, [mailId]: data })))
      .catch((error) => setFailed((prev) => ({ ...prev, [mailId]: describeError(i18n, error) })))
      .finally(() => {
        inFlight.current.delete(mailId);
        setLoadingMail(null);
      });
  }, [selectedMailId, cache, failed]);

  const refresh = useCallback(() => {
    if (!selectedMailId) return;
    setCache((prev) => {
      const next = { ...prev };
      delete next[selectedMailId];
      return next;
    });
    setFailed((prev) => {
      const next = { ...prev };
      delete next[selectedMailId];
      return next;
    });
  }, [selectedMailId]);

  const inRange = useMemo(() => {
    if (!range || !flow) return null;
    return new Set(
      flow.visible
        .filter((unit) => unit.left + unit.width >= range[0] && unit.left <= range[1])
        .map((unit) => unit.id),
    );
  }, [range, flow]);

  const pctOf = useCallback((clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.min(Math.max(((clientX - rect.left) / rect.width) * 100, 0), 100);
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const unitId = (event.target as HTMLElement).closest("[data-unit]")?.getAttribute("data-unit");
    press.current = { x: event.clientX, unitId: unitId ?? null, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = press.current;
    if (!state) return;
    if (!state.moved && Math.abs(event.clientX - state.x) < DRAG_THRESHOLD) return;
    state.moved = true;
    const from = pctOf(state.x);
    const to = pctOf(event.clientX);
    setRange([Math.min(from, to), Math.max(from, to)]);
  }, [pctOf]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = press.current;
    press.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!state) return;
    if (state.moved) return;
    // 没拖动就是单击：点中的是可选的颗就选中，再点同一颗取消；点空白清掉框选。
    if (state.unitId && !state.unitId.startsWith("mail:")) {
      setSelectedId((prev) => (prev === state.unitId ? null : state.unitId));
    } else if (!state.unitId) {
      setSelectedId(null);
      setRange(null);
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelectedId(null);
      setRange(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!flow) return null;

  const withSeconds = flow.last.start - flow.first.start < 5 * 60_000;
  const rawTicks = [0, 1 / 3, 2 / 3, 1].map((ratio) => ({
    left: ratio * 100,
    label: mode === "sequence" || !flow.domain
      ? `#${Math.max(1, Math.round(1 + ratio * (flow.count - 1)))}`
      : axisLabel(i18n, flow.domain.start + flow.domain.span * ratio, withSeconds),
  }));
  // 顺序模式下刻度是「第几步」：步数少于刻度数时四个刻度会算出同一个序号，
  // 一排 "#1 #1 #2 #2" 读起来像坏了。相邻同 label 只留第一个，两端的位置仍然对得上。
  const ticks = rawTicks.filter((tick, index) => index === 0 || tick.label !== rawTicks[index - 1].label);
  const nowLeft = flow.domain
    ? Math.min(Math.max(((now - flow.domain.start) / flow.domain.span) * 100, 0), 100)
    : null;

  const trajectory = selectedMailId ? cache[selectedMailId] : undefined;
  const lightStep = selected?.step ?? null;
  const stepFor = trajectory?.steps.find((step) => step.id === lightStep?.id) ?? lightStep;
  const rangeUnits = inRange ? flow.visible.filter((unit) => inRange.has(unit.id)) : [];
  const rangeSteps = rangeUnits.map((unit) => unit.step).filter((step): step is RunStep => Boolean(step));
  const rangeMs = rangeSteps.reduce((sum, step) => sum + Number(step.duration_ms ?? 0), 0);
  const rangeTokens = rangeSteps.reduce((sum, step) => sum + Number(step.output_tokens ?? 0), 0);
  const rangeUsage = newUsage();
  tallyUsage(rangeUsage, rangeSteps);
  // 分群命中率按群名合并：同名群在统计条里并成一条（上面车道仍然分开画），
  // 否则两行一模一样的名字看着像 bug。单群时它和总数是同一个数，不重复列。
  const usageRows = (() => {
    const byName = new Map<string, { color: string; usage: UsageStat }>();
    for (const lane of flow.rows) {
      if (!lane.usage.reported) continue;
      const entry = byName.get(lane.name) ?? { color: laneColor(lane.id), usage: newUsage() };
      entry.usage.rounds += lane.usage.rounds;
      entry.usage.reported += lane.usage.reported;
      entry.usage.input += lane.usage.input;
      entry.usage.cached += lane.usage.cached;
      byName.set(lane.name, entry);
    }
    return [...byName].sort((left, right) => right[1].usage.input - left[1].usage.input);
  })();

  return (
    <Card className="mb-4 overflow-hidden">
      <CardContent className="grid gap-3 pt-5 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              Stream flow
              <Badge variant="secondary" className="rounded-full px-1.5 py-0 font-mono text-[10px]">
                {i18n.tf("flow.stepsCount", { n: flow.stepCount })}
              </Badge>
            </h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {i18n.t(mode === "sequence" ? "flow.modeSequenceHint" : "flow.modeTimeHint")}
              {" "}{i18n.t("flow.interactionHint")}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2.5 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="ws-flow-note h-2 w-5 rounded-full bg-machine" aria-hidden />
              {i18n.t("flow.running")}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-3 w-5 rounded-full bg-muted-foreground/70" aria-hidden />
              {i18n.t("flow.modelTurn")}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-5 rounded-[2px] bg-muted-foreground/70" aria-hidden />
              {i18n.t("flow.tool")}
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="h-2 w-5 rounded-full bg-destructive/55"
                style={{ backgroundImage: "repeating-linear-gradient(45deg, var(--destructive) 0 2px, transparent 2px 5px)" }}
                aria-hidden
              />
              {i18n.t("flow.failed")}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-5 rounded-full border border-muted-foreground/70" aria-hidden />
              {i18n.t("flow.aborted")}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-5 rounded-full border border-dashed border-muted-foreground/60" aria-hidden />
              {i18n.t("deliver.queued")}
            </span>
            <div className="flex overflow-hidden rounded-full border">
              {([["sequence", "flow.modeSequence"], ["time", "flow.modeTime"]] as const).map(([value, labelKey]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setMode(value);
                    setRange(null);
                  }}
                  aria-pressed={mode === value}
                  className={cn(
                    "px-2 py-0.5 text-[10px] transition-colors",
                    mode === value ? "bg-foreground text-background" : "hover:bg-muted",
                  )}
                >
                  {i18n.t(labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_290px]">
          <div className="grid content-start min-w-0 grid-cols-[minmax(62px,104px)_minmax(0,1fr)] gap-2">
            <div className="grid content-start gap-1.5">
              {flow.rows.map((lane) => (
                <div key={lane.id} className="grid h-7 min-w-0 content-start gap-0.5 leading-tight">
                  <p className="truncate text-[11px]">{lane.name}</p>
                  <p className="truncate font-mono text-[9.5px] text-muted-foreground">
                    {i18n.tf("flow.weight", { n: lane.priority ?? "—" })} ·{" "}
                    {lane.steps
                      ? i18n.tf("flow.stepsCount", { n: lane.steps })
                      : lane.noTrace
                        ? i18n.tf("flow.noTraceCount", { n: lane.noTrace })
                        : i18n.tf("flow.stepsCount", { n: 0 })}
                    {lane.queued ? ` · ${i18n.tf("flow.queuedCount", { n: lane.queued })}` : ""}
                  </p>
                </div>
              ))}
            </div>

            <div
              ref={plotRef}
              className="relative grid content-start min-w-0 cursor-crosshair touch-none gap-1.5 select-none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                press.current = null;
              }}
            >
              {flow.rows.map((lane) => {
                const color = laneColor(lane.id);
                return (
                  <div
                    key={lane.id}
                    className="relative h-7 overflow-hidden rounded-md bg-muted/30"
                    role="group"
                    aria-label={i18n.tf("flow.laneAria", { name: lane.name, n: lane.units.length })}
                    style={{ backgroundImage: "repeating-linear-gradient(90deg, var(--border) 0 1px, transparent 1px 25%)" }}
                  >
                    {lane.units.map((unit) => {
                      const status = unit.step?.status ?? unit.mail.status;
                      const isMail = unit.kind === "mail";
                      const isRunning = status === "running";
                      const isFailed = status === "failed";
                      const isCancelled = status === "cancelled";
                      const isSelected = unit.id === selectedId;
                      const dimmed = inRange ? !inRange.has(unit.id) : false;
                      const label = isMail
                        ? i18n.tf("flow.mailUnitAria", { name: lane.name, status: i18n.t(MAIL_LABEL[unit.mail.status]) })
                        : i18n.tf("flow.stepUnitAria", {
                            name: lane.name,
                            n: unit.ordinal,
                            kind: i18n.t(unit.kind === "model" ? "flow.modelTurn" : "flow.tool"),
                            stepName: unit.step?.name ?? "",
                            duration: durationText(Math.max(unit.end - unit.start, 0)),
                          });
                      return (
                        <button
                          key={unit.id}
                          type="button"
                          data-unit={unit.id}
                          aria-label={label}
                          aria-pressed={isSelected}
                          aria-disabled={isMail || undefined}
                          title={label}
                          // 格子只有键盘处理时，鼠标用户看着能点（cursor-pointer）却点开不了检视器。
                          onClick={() => {
                            if (!isMail) setSelectedId((prev) => (prev === unit.id ? null : unit.id));
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              if (!isMail) setSelectedId((prev) => (prev === unit.id ? null : unit.id));
                            }
                          }}
                          className={cn(
                            "absolute top-1/2 -translate-y-1/2 rounded-full",
                            unit.kind === "tool" ? "h-1.5 rounded-[2px]" : "h-3",
                            isRunning && "ws-flow-note",
                            isMail ? "cursor-default" : "cursor-pointer",
                          )}
                          style={{
                            left: `${unit.left}%`,
                            width: `calc(${unit.width}% - 1px)`,
                            minWidth: "2px",
                            background: isRunning
                              ? "var(--machine)"
                              : isFailed
                                ? "color-mix(in srgb, var(--destructive) 55%, transparent)"
                                : isMail || isCancelled
                                  ? "transparent"
                                  : unit.kind === "tool"
                                    ? `color-mix(in srgb, ${color} 45%, transparent)`
                                    : color,
                            // 失败/掐断不能只靠颜色区分：暗色主题下群 lane 色本身就偏红，
                            // 所以失败加斜纹、掐断改成空心，形状上就能分开。
                            backgroundImage: isFailed
                              ? "repeating-linear-gradient(45deg, var(--destructive) 0 2px, transparent 2px 5px)"
                              : undefined,
                            border: isMail
                              ? `1px dashed ${color}`
                              : isCancelled
                                ? `1px solid color-mix(in srgb, ${color} 70%, transparent)`
                                : undefined,
                            opacity: dimmed ? 0.25 : isFailed ? 0.9 : isCancelled ? 0.7 : unit.kind === "tool" ? 0.95 : 0.85,
                            boxShadow: isSelected
                              ? "0 0 0 2px var(--foreground)"
                              : isRunning
                                ? "0 0 0 3px color-mix(in srgb, var(--machine) 18%, transparent)"
                                : undefined,
                            zIndex: isSelected ? 2 : undefined,
                          }}
                        />
                      );
                    })}
                  </div>
                );
              })}

              {range ? (
                <span
                  className="pointer-events-none absolute top-0 bottom-[22px] z-10 rounded-md border-x border-machine/70 bg-machine/10"
                  style={{ left: `${range[0]}%`, width: `${Math.max(range[1] - range[0], 0)}%` }}
                  aria-hidden
                />
              ) : null}
              {flow.runningNow && nowLeft !== null ? (
                <span
                  className="pointer-events-none absolute top-0 bottom-[22px] z-10 w-px bg-machine/70"
                  style={{ left: `${nowLeft}%` }}
                  aria-hidden
                />
              ) : null}

              <div className="relative h-4 font-mono text-[9px] text-muted-foreground">
                {ticks.map((tick, index) => (
                  <span
                    key={tick.label + index}
                    className={cn(
                      "absolute top-0 whitespace-nowrap",
                      index === 0 ? "" : index === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
                    )}
                    style={{ left: `${tick.left}%` }}
                  >
                    {tick.label}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <aside className="grid min-w-0 content-start gap-2 rounded-lg border bg-card/60 p-3">
            {inRange ? (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted/60 px-2 py-1 font-mono text-[10px]">
                <span>{i18n.tf("flow.rangeUnits", { n: rangeUnits.length })}</span>
                <span>{i18n.tf("flow.rangeTools", { n: rangeSteps.filter((step) => step.kind === "tool").length })}</span>
                <span>{durationText(rangeMs)}</span>
                {rangeTokens ? <span>{i18n.number(rangeTokens)} tok</span> : null}
                {rangeUsage.reported ? <span>{i18n.tf("flow.hitValue", { n: hitRateOf(rangeUsage) })}</span> : null}
                <button
                  type="button"
                  onClick={() => {
                    setRange(null);
                    setSelectedId(null);
                  }}
                  className="ml-auto rounded-full border px-1.5 text-[10px] hover:bg-muted"
                >
                  {i18n.t("common.clear")}
                </button>
              </p>
            ) : null}
            <StepInspector
              step={stepFor ?? null}
              mail={trajectory?.mail ?? null}
              schemas={trajectory?.schemas ?? []}
              loading={Boolean(selectedMailId) && loadingMail === selectedMailId}
              error={selectedMailId ? failed[selectedMailId] ?? "" : ""}
              onRefresh={refresh}
            />
          </aside>
        </div>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[10px]">
          <span className="text-muted-foreground">{i18n.tf("flow.cacheHitTitle", { n: detail.queue.length })}</span>
          {flow.usage.reported ? (
            <>
              <span>{i18n.tf("flow.inputTokens", { n: flow.usage.input })}</span>
              <span>{i18n.tf("flow.hitValue", { n: flow.usage.cached })}</span>
              <span className="font-semibold">{hitRateOf(flow.usage)}</span>
            </>
          ) : (
            <span>{i18n.t("flow.noUsage")}</span>
          )}
          <span className="text-muted-foreground">
            {i18n.tf("flow.modelRounds", { rounds: flow.usage.rounds, reported: flow.usage.reported })}
          </span>
          {usageRows.length > 1 ? (
            <>
              <span className="text-muted-foreground">{i18n.t("flow.byStream")}</span>
              {usageRows.map(([name, entry]) => (
                <span key={name} className="inline-flex items-center gap-1" title={name}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: entry.color }} aria-hidden />
                  <span className="max-w-[90px] truncate">{name}</span>
                  {hitRateOf(entry.usage)}
                </span>
              ))}
            </>
          ) : null}
        </div>

        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {i18n.t("flow.legendHint")}
          <br />
          {i18n.t("flow.hitRateNote")}
        </p>
      </CardContent>
    </Card>
  );
}
