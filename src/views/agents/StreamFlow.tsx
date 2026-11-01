// 员工详情里的 Stream flow：横轴是邮件处理时间，纵轴按群权重从高到低排队，
// 每封邮件画成一条占位长条，运行中的那条带流动高光，像音游的下落轨道。
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { clockOf } from "../../lib/format";
import type { AgentPresenceDetail, AgentProfileMail } from "../../types";

const LANE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const WINDOW_SPAN = 15 * 60_000;
const MIN_SPAN = 60_000;
const MAX_NOTES = 24;

const STATUS_LABEL: Record<AgentProfileMail["status"], string> = {
  queued: "未读",
  running: "处理中",
  done: "已读",
  failed: "失败",
  cancelled: "已取消",
};

type Note = {
  mail: AgentProfileMail;
  start: number;
  end: number;
};

type Lane = {
  id: string;
  name: string;
  priority: number | null;
  notes: Note[];
  total: number;
  running: number;
  queued: number;
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

function durationText(ms: number): string {
  if (ms < 60_000) return `${Math.max(ms / 1000, 0.1).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}min`;
}

function axisLabel(stampMs: number, withSeconds: boolean): string {
  if (!withSeconds) return clockOf(new Date(stampMs).toISOString());
  const date = new Date(stampMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

export function StreamFlow({ detail }: { detail: AgentPresenceDetail }) {
  const now = Date.now();
  const flow = useMemo(() => {
    const notes = detail.queue.flatMap<Note>((mail) => {
      const created = stamp(mail.created_at) ?? now;
      if (mail.status === "queued") return [{ mail, start: created, end: created }];
      const started = stamp(mail.started_at) ?? created;
      const finished = stamp(mail.finished_at) ?? (mail.status === "running" ? now : started);
      return [{ mail, start: started, end: Math.max(finished, started) }];
    });
    if (!notes.length) return null;

    // 取最近一段连续处理：从最新一封往前收，直到跨度超过 15 分钟或攒满 24 封，
    // 这样忙碌时有密度，间隔很久时也不会被拉成一条看不到的长条。
    const ordered = [...notes].sort((left, right) => left.start - right.start);
    const newest = ordered[ordered.length - 1].start;
    let from = ordered.length - 1;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      if (newest - ordered[index].start > WINDOW_SPAN) break;
      from = index;
      if (ordered.length - index >= MAX_NOTES) break;
    }
    const recent = ordered.slice(from);
    const first = recent[0].start;
    const last = recent.reduce((acc, note) => Math.max(acc, note.end, note.start), first);
    const span = Math.min(Math.max(last - first, MIN_SPAN), WINDOW_SPAN);
    const domainEnd = last + span * 0.06;
    const domainStart = domainEnd - span;
    const visible = notes.filter((note) => note.end >= domainStart - 1_000);

    // 车道按邮箱里出现过的群来铺，保证权重排序稳定；时间窗里没有长条的群也保留车道。
    const lanes = new Map<string, Lane>();
    for (const note of notes) {
      const lane = lanes.get(note.mail.stream_id) ?? {
        id: note.mail.stream_id,
        name: note.mail.stream_name,
        priority: null,
        notes: [],
        total: 0,
        running: 0,
        queued: 0,
      };
      lane.priority = Math.max(lane.priority ?? 0, note.mail.priority);
      lane.total += 1;
      if (note.mail.status === "running") lane.running += 1;
      if (note.mail.status === "queued") lane.queued += 1;
      if (note.end >= domainStart - 1_000) lane.notes.push(note);
      lanes.set(lane.id, lane);
    }

    const rows = [...lanes.values()].sort((left, right) => {
      const leftWeight = left.priority ?? -1;
      const rightWeight = right.priority ?? -1;
      if (leftWeight !== rightWeight) return rightWeight - leftWeight;
      return left.name.localeCompare(right.name, "zh-CN");
    });

    const pct = (stampMs: number) => ((stampMs - domainStart) / span) * 100;
    const runningNow = visible.some((note) => note.mail.status === "running");
    return { rows, visible, domainStart, domainEnd, pct, runningNow, first, last };
  }, [detail, now]);

  if (!flow) return null;

  const withSeconds = flow.last - flow.first < 5 * 60_000;
  const ticks = [0, 1 / 3, 2 / 3, 1].map((ratio) => {
    const stampMs = flow.domainStart + (flow.domainEnd - flow.domainStart) * ratio;
    return { left: ratio * 100, label: axisLabel(stampMs, withSeconds) };
  });

  return (
    <Card className="mb-4 overflow-hidden">
      <CardContent className="grid gap-3 pt-5 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              Stream flow
              <Badge variant="secondary" className="rounded-full px-1.5 py-0 font-mono text-[10px]">
                {flow.visible.length} 封
              </Badge>
            </h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              横轴是最近一段连续处理的时间，纵轴按群权重从高到低排列；长条越宽，占用越久。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="ws-flow-note h-2 w-5 rounded-full bg-machine" aria-hidden />
              处理中
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-5 rounded-full bg-muted-foreground/45" aria-hidden />
              已读
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-5 rounded-full border border-dashed border-muted-foreground/60" aria-hidden />
              未读
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-5 rounded-full bg-destructive/70" aria-hidden />
              失败
            </span>
          </div>
        </div>

        <div className="grid gap-1.5">
          {flow.rows.map((lane) => {
            const color = laneColor(lane.id);
            return (
              <div key={lane.id} className="grid grid-cols-[minmax(74px,118px)_minmax(0,1fr)] items-center gap-2">
                <div className="min-w-0 leading-tight">
                  <p className="truncate text-[11px]">{lane.name}</p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    权重 {lane.priority ?? "—"} · {lane.total} 封
                    {lane.running ? ` · 运行 ${lane.running}` : ""}
                    {lane.queued ? ` · 排队 ${lane.queued}` : ""}
                  </p>
                </div>
                <div
                  className="relative h-8 overflow-hidden rounded-md bg-muted/30"
                  role="img"
                  aria-label={`${lane.name}：${lane.notes.length} 封邮件的时间片`}
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(90deg, var(--border) 0 1px, transparent 1px 25%)",
                  }}
                >
                  {lane.notes.map((note) => {
                    const left = flow.pct(note.start);
                    const width = Math.max(flow.pct(note.end) - left, 0.6);
                    const status = note.mail.status;
                    const isQueued = status === "queued";
                    const isRunning = status === "running";
                    const isFailed = status === "failed";
                    const isCancelled = status === "cancelled";
                    return (
                      <div
                        key={note.mail.id}
                        title={`${lane.name} · 第 #${note.mail.seq || note.mail.trigger_seq} 条 · ${STATUS_LABEL[status]}${
                          isQueued ? " · 等待时间片" : ` · 占用 ${durationText(note.end - note.start)}`
                        } · 时间片 ${note.mail.slice_count}`}
                        className={`absolute top-1/2 h-3 -translate-y-1/2 rounded-full ${
                          isRunning ? "ws-flow-note" : ""
                        }`}
                        style={{
                          left: `${left}%`,
                          width: `${width}%`,
                          minWidth: "8px",
                          background: isRunning
                            ? "var(--machine)"
                            : isFailed
                              ? "var(--destructive)"
                              : isQueued || isCancelled
                                ? "transparent"
                                : color,
                          opacity: isFailed ? 0.75 : isQueued ? 0.9 : isCancelled ? 0.45 : 0.82,
                          border: isQueued || isCancelled
                            ? `1px dashed ${isCancelled ? "var(--muted-foreground)" : color}`
                            : undefined,
                          boxShadow: isRunning ? "0 0 0 3px color-mix(in srgb, var(--machine) 18%, transparent)" : undefined,
                        }}
                      />
                    );
                  })}
                  {flow.runningNow ? (
                    <span
                      className="absolute inset-y-0 w-px bg-machine/60"
                      style={{ left: `${flow.pct(now)}%` }}
                      aria-hidden
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
          <div className="grid grid-cols-[minmax(74px,118px)_minmax(0,1fr)] items-center gap-2">
            <span />
            <div className="relative h-3 font-mono text-[9px] text-muted-foreground">
              {ticks.map((tick, index) => (
                <span
                  key={tick.label + index}
                  className={`absolute top-0 whitespace-nowrap ${
                    index === 0 ? "" : index === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2"
                  }`}
                  style={{ left: `${tick.left}%` }}
                >
                  {tick.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        <p className="text-[10px] leading-relaxed text-muted-foreground">
          纵轴第一行是权重最高的群，同权重按群名排列；窗口自动取最近 15 分钟或 24 封。虚线是还没开始处理的邮件，跑起来后才会变成实心长条。
        </p>
      </CardContent>
    </Card>
  );
}
