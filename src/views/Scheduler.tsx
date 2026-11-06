// 调度台：每个虚拟员工在各群里的时间片份额、队列状态、手动推进一格，以及按时刻表自己醒来的排程。
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { describeCode, describeError, get, post, type Agent } from "../api";
import type { DreamState, Schedule, Stream } from "../types";
import { shortUuid, timeAgo } from "../lib/format";
import { Field, Notice, PersonAvatar, StatRow } from "../lib/ui";
import { useI18n, type I18n, type MsgKey } from "../lib/i18n";

type Slice = {
  stream_id: string;
  name: string;
  weight: number;
  share: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  slices: number;
  last_error: string | null;
};

type Board = { ok: true; boards: { agent: Agent; streams: Slice[] }[]; budget: number };

/** scheduler.tick 逐条回报的排程观察：投了信、并进了旧信、还是因为员工不在群里自己停了。 */
type CronOutcome = {
  schedule_id: string;
  runs?: number;
  mail_id?: string | null;
  merged_into_pending?: boolean;
  paused?: boolean;
  error?: string;
};

const DAY_SHORT_KEYS: Record<number, MsgKey> = {
  1: "scheduler.dayShortMon",
  2: "scheduler.dayShortTue",
  3: "scheduler.dayShortWed",
  4: "scheduler.dayShortThu",
  5: "scheduler.dayShortFri",
  6: "scheduler.dayShortSat",
  7: "scheduler.dayShortSun",
};
const DAY_KEYS: Record<number, MsgKey> = {
  1: "scheduler.dayMon",
  2: "scheduler.dayTue",
  3: "scheduler.dayWed",
  4: "scheduler.dayThu",
  5: "scheduler.dayFri",
  6: "scheduler.daySat",
  7: "scheduler.daySun",
};
const MAX_INTERVAL_MINUTES = 10080;

/** 表里只收 1-7：数据越界时退回原来的 "?"，不把 undefined 喂给取词。 */
function dayName(i18n: I18n, day: number, short = false): string {
  const key = (short ? DAY_SHORT_KEYS : DAY_KEYS)[day];
  return key ? i18n.t(key) : "?";
}

/** 本机偏移未必落在整小时（UTC+5:30 这类），下拉里要能把这个真实值带进来。 */
const localOffsetMinutes = () => -new Date().getTimezoneOffset();

function tzLabel(minutes: number): string {
  if (!minutes) return "UTC+0";
  const abs = Math.abs(minutes);
  const minutePart = abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : "";
  return `UTC${minutes < 0 ? "-" : "+"}${Math.floor(abs / 60)}${minutePart}`;
}

function intervalLabel(i18n: I18n, minutes: number | null): string {
  if (!minutes) return i18n.t("scheduler.intervalUnset");
  if (minutes % 1440 === 0) return i18n.tf("scheduler.daysN", { n: minutes / 1440 });
  if (minutes % 60 === 0) return i18n.tf("scheduler.hoursN", { n: minutes / 60 });
  return i18n.tf("scheduler.minutesN", { n: minutes });
}

function specLabel(i18n: I18n, row: Schedule): string {
  if (row.kind === "every") {
    return i18n.tf("scheduler.everyInterval", { interval: intervalLabel(i18n, row.interval_minutes) });
  }
  const days = row.weekdays?.length
    ? i18n.list(row.weekdays.map((d) => dayName(i18n, d)))
    : i18n.t("scheduler.everyDay");
  return i18n.tf("scheduler.dailySpec", { days, at: row.at_time ?? "—", tz: tzLabel(row.tz_offset_minutes ?? 0) });
}

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** 归并是被谁叫醒的：后端在信上记了原因，界面上就要能分开这三种入口。 */
const dreamReason = (i18n: I18n, reason: string | null): string =>
  reason === "auto"
    ? i18n.t("scheduler.dreamReasonFold")
    : reason === "cron"
      ? i18n.t("scheduler.dreamReasonCron")
      : i18n.t("scheduler.dreamReasonManual");

/** 未来的对点用「今天/明天/周几 + 钟点」读，钟点按本机时区换算——界面上的时间差一分钟都不该差。 */
function occurrenceLabel(i18n: I18n, iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  if (dayKey(date) === dayKey(today)) return i18n.tf("scheduler.todayAt", { time: hhmm });
  if (dayKey(date) === dayKey(new Date(today.getTime() + 86_400_000))) return i18n.tf("scheduler.tomorrowAt", { time: hhmm });
  return `${dayName(i18n, date.getDay() === 0 ? 7 : date.getDay())} ${hhmm}`;
}

type Draft = {
  id: string;
  name: string;
  instruction: string;
  agent_id: string;
  stream_id: string;
  /** 这条排程到点干什么："" 是干活，"dreaming" 是归并全局记忆。建好后不能改。 */
  purpose: "" | "dreaming";
  kind: "every" | "daily";
  interval_minutes: string;
  at_time: string;
  weekdays: number[];
  tz_offset_minutes: number;
};

const emptyDraft = (): Draft => ({
  id: "",
  name: "",
  instruction: "",
  agent_id: "",
  stream_id: "",
  purpose: "",
  kind: "every",
  interval_minutes: "30",
  at_time: "09:00",
  weekdays: [],
  tz_offset_minutes: localOffsetMinutes(),
});

export function SchedulerView({ onBusyChanged }: { onBusyChanged?: (busy: boolean) => void }) {
  const i18n = useI18n();
  const [board, setBoard] = useState<Board | null>(null);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [busy, setBusy] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [limits, setLimits] = useState({ max_per_owner: 20, min_interval_minutes: 1 });
  const [dream, setDream] = useState<DreamState | null>(null);
  const [dreamAgent, setDreamAgent] = useState("");
  const [dreamStream, setDreamStream] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [dreaming, setDreaming] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [next, mine, cron, dreamState] = await Promise.all([
        get<Board>("scheduler.board"),
        get<{ ok: true; items: Stream[] }>("streams.mine"),
        get<{ ok: true; items: Schedule[]; limits: typeof limits }>("cron.list"),
        get<DreamState>("dreaming.get"),
      ]);
      setBoard(next);
      setStreams(mine.items);
      setSchedules(cron.items);
      setLimits(cron.limits);
      setDream(dreamState);
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function tick() {
    setBusy(true);
    onBusyChanged?.(true);
    try {
      const result = await get<{ ok: true; ran: unknown[]; queued: number; budget?: number; cron?: CronOutcome[] }>(
        "scheduler.tick",
        { since: 0 },
      );
      const fired = result.cron ?? [];
      const merged = fired.filter((row) => row.merged_into_pending).length;
      const stopped = fired.filter((row) => row.paused).length;
      const undelivered = fired.filter((row) => row.error).length;
      const parts: string[] = [];
      if (result.ran.length) parts.push(i18n.tf("scheduler.tickRan", { n: result.ran.length }));
      if (fired.length) parts.push(i18n.tf("scheduler.tickFired", { n: fired.length }));
      if (merged) parts.push(i18n.tf("scheduler.tickMerged", { n: merged }));
      if (stopped) parts.push(i18n.tf("scheduler.tickStopped", { n: stopped }));
      if (undelivered) parts.push(i18n.tf("scheduler.tickUndelivered", { n: undelivered }));
      toast.success(parts.length ? i18n.list(parts) : i18n.t("scheduler.tickEmpty"));
      await refresh();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy(false);
      onBusyChanged?.(false);
    }
  }

  const agentNames = useMemo(
    () => new Map((board?.boards ?? []).map((entry) => [entry.agent.id, entry.agent.name])),
    [board],
  );
  const pausedAgents = useMemo(
    () => new Set((board?.boards ?? []).filter((entry) => entry.agent.status === "paused").map((entry) => entry.agent.id)),
    [board],
  );
  // 排程行只带 id：群名先从这些员工所在的群取，取不到再回落到我自己所在的群。
  const streamNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of board?.boards ?? []) {
      for (const slice of entry.streams) if (slice.name) map.set(slice.stream_id, slice.name);
    }
    for (const stream of streams) if (stream.name) map.set(stream.id, stream.name);
    return map;
  }, [board, streams]);
  // 「这位员工和我也都在的群」这张表排程和归并用同一份：两处各算一遍迟早会算出两种口径。
  const streamsByAgent = useMemo(() => {
    const mine = new Set(streams.map((stream) => stream.id));
    const map = new Map<string, Slice[]>();
    for (const entry of board?.boards ?? []) {
      map.set(entry.agent.id, entry.streams.filter((slice) => mine.has(slice.stream_id)));
    }
    return map;
  }, [board, streams]);
  const draftStreams = streamsByAgent.get(draft?.agent_id ?? "") ?? [];
  const dreamStreams = streamsByAgent.get(dreamAgent) ?? [];
  const tzOptions = useMemo(() => {
    const whole: number[] = [];
    for (let hour = -12; hour <= 14; hour += 1) whole.push(hour * 60);
    const local = localOffsetMinutes();
    const values = whole.includes(local) ? whole : [...whole, local].sort((a, b) => a - b);
    return values.map((minutes) => ({
      minutes,
      label: minutes === local ? `${tzLabel(minutes)} · ${i18n.t("scheduler.tzLocal")}` : tzLabel(minutes),
    }));
  }, [i18n]);

  const draftIsPaused = Boolean(draft?.id) && schedules.some((row) => row.id === draft?.id && row.next_run_at === null);

  function startNew() {
    if (schedules.length >= limits.max_per_owner) {
      toast.error(i18n.tf("scheduler.maxReached", { max: limits.max_per_owner }));
      return;
    }
    const first = (board?.boards ?? [])[0];
    const shared = first ? streamsByAgent.get(first.agent.id) ?? [] : [];
    setDraft({ ...emptyDraft(), agent_id: first?.agent.id ?? "", stream_id: shared[0]?.stream_id ?? "" });
  }

  function startEdit(row: Schedule) {
    setDraft({
      id: row.id,
      name: row.name,
      instruction: row.instruction,
      agent_id: row.agent_id,
      stream_id: row.stream_id,
      purpose: row.purpose === "dreaming" ? "dreaming" : "",
      kind: row.kind,
      interval_minutes: String(row.interval_minutes ?? 30),
      at_time: row.at_time ?? "09:00",
      weekdays: row.weekdays ?? [],
      tz_offset_minutes: row.tz_offset_minutes ?? localOffsetMinutes(),
    });
  }

  async function saveDraft() {
    if (!draft) return;
    const interval = Number(draft.interval_minutes);
    if (!draft.name.trim()) {
      toast.error(i18n.t("scheduler.needName"));
      return;
    }
    // 归并全局记忆那条不看「要办的事」：正文是可选的额外要求，留空就用默认口径。
    if (!draft.instruction.trim() && draft.purpose !== "dreaming") {
      toast.error(i18n.t("scheduler.needInstruction"));
      return;
    }
    if (!draft.agent_id || !draft.stream_id) {
      toast.error(i18n.t("scheduler.needAgentStream"));
      return;
    }
    if (draft.kind === "every"
      && (!Number.isInteger(interval) || interval < limits.min_interval_minutes || interval > MAX_INTERVAL_MINUTES)) {
      toast.error(i18n.tf("scheduler.badInterval", { min: limits.min_interval_minutes, max: MAX_INTERVAL_MINUTES }));
      return;
    }
    if (draft.kind === "daily" && !/^\d{2}:\d{2}$/.test(draft.at_time)) {
      toast.error(i18n.t("scheduler.badAtTime"));
      return;
    }
    setSaving(true);
    try {
      await post("cron.set", {
        id: draft.id || undefined,
        name: draft.name.trim(),
        instruction: draft.instruction.trim(),
        agent_id: draft.agent_id,
        stream_id: draft.stream_id,
        purpose: draft.purpose || undefined,
        kind: draft.kind,
        interval_minutes: draft.kind === "every" ? interval : null,
        at_time: draft.kind === "daily" ? draft.at_time : null,
        weekdays: draft.kind === "daily" ? draft.weekdays : null,
        tz_offset_minutes: draft.kind === "daily" ? draft.tz_offset_minutes : null,
      });
      toast.success(i18n.t(draft.id ? "scheduler.updatedToast" : "scheduler.createdToast"));
      setDraft(null);
      await refresh();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setSaving(false);
    }
  }

  async function toggleRunning(row: Schedule) {
    try {
      await post(row.next_run_at ? "cron.pause" : "cron.resume", { id: row.id });
      toast.success(row.next_run_at
        ? i18n.tf("scheduler.pausedToast", { name: row.name })
        : i18n.tf("scheduler.resumedToast", { name: row.name }));
      await refresh();
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  async function removeRow(row: Schedule) {
    if (!window.confirm(i18n.tf("scheduler.deleteConfirm", { name: row.name }))) return;
    try {
      const result = await post<{ ok: true; cancelled: number }>("cron.delete", { id: row.id });
      toast.success(result.cancelled
        ? i18n.tf("scheduler.deletedToast", { n: result.cancelled })
        : i18n.t("scheduler.deletedPlain"));
      if (draft?.id === row.id) setDraft(null);
      await refresh();
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  // 归并的信要落进某位员工的某个群邮箱才能排队；默认取第一个能用的组合，不逼用户先选一遍。
  useEffect(() => {
    if (dreamAgent || !board?.boards.length) return;
    const entry = board.boards.find((item) => (streamsByAgent.get(item.agent.id) ?? []).length);
    if (!entry) return;
    setDreamAgent(entry.agent.id);
    setDreamStream(streamsByAgent.get(entry.agent.id)?.[0]?.stream_id ?? "");
  }, [board, streamsByAgent, dreamAgent]);

  async function saveDreamAuto(next: boolean) {
    setDream((prev) => (prev ? { ...prev, auto: next } : prev));
    try {
      await post("auth.patch", { prefs: { dreaming_auto: next } });
      toast.success(next ? i18n.t("scheduler.dreamAutoOn") : i18n.t("scheduler.dreamAutoOff"));
    } catch (error) {
      setDream((prev) => (prev ? { ...prev, auto: !next } : prev));
      toast.error(describeError(i18n, error));
    }
  }

  async function runDreamNow() {
    if (!dreamAgent || !dreamStream) {
      toast.error(i18n.t("scheduler.dreamNeedPick"));
      return;
    }
    setDreaming(true);
    try {
      const result = await post<{ ok: true; queued: boolean; reason?: string }>("dreaming.run", {
        agent_id: dreamAgent,
        stream_id: dreamStream,
      });
      toast.success(result.queued
        ? i18n.t("scheduler.dreamQueuedToast")
        : i18n.tf("scheduler.dreamNotQueued", {
            reason: i18n.t(result.reason === "already_pending" ? "scheduler.dreamPendingReason" : "scheduler.dreamNoAgentReason"),
          }));
      await refresh();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setDreaming(false);
    }
  }

  async function clearDream() {
    if (!window.confirm(i18n.t("scheduler.dreamClearConfirm"))) return;
    try {
      await post("dreaming.clear", {});
      toast.success(i18n.t("scheduler.dreamClearedToast"));
      await refresh();
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  const totals = (board?.boards ?? [])
    .flatMap((entry) => entry.streams)
    .reduce(
      (sum, row) => ({
        queued: sum.queued + row.queued,
        running: sum.running + row.running,
        done: sum.done + row.done,
        failed: sum.failed + row.failed,
      }),
      { queued: 0, running: 0, done: 0, failed: 0 },
    );
  // 排程那一张表已经带了 purpose，这里只数一下，不另开一份"定时归并列表"。
  const dreamCount = schedules.filter((row) => row.purpose === "dreaming").length;

  return (
    <div className="mx-auto grid h-full w-full max-w-5xl min-h-0 gap-4 overflow-y-auto p-4 scrollbar-thin md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold tracking-tight">{i18n.t("nav.scheduler")}</h1>
          <p className="text-sm text-muted-foreground">{i18n.t("scheduler.intro")}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="text-xs" onClick={() => void refresh()}>
            {i18n.t("common.refresh")}
          </Button>
          <Button size="sm" className="text-xs" onClick={() => void tick()} disabled={busy}>
            {busy ? i18n.t("scheduler.ticking") : i18n.t("scheduler.tickNow")}
          </Button>
        </div>
      </header>

      <div className="grid gap-2 rounded-lg border bg-card p-3 sm:grid-cols-4">
        <StatRow label={i18n.t("scheduler.budgetLabel")} value={board?.budget ?? "—"} tone="muted" />
        <StatRow label={i18n.t("scheduler.statQueued")} value={totals.queued} tone="machine" />
        <StatRow label={i18n.t("scheduler.statRunning")} value={totals.running} tone="signal" />
        <StatRow label={i18n.t("scheduler.statDoneFailed")} value={`${totals.done} / ${totals.failed}`} tone="muted" />
      </div>

      {!board?.boards.length ? (
        <Notice>{i18n.t("scheduler.noAgents")}</Notice>
      ) : null}

      {board?.boards.map((entry) => {
        const totalWeight = entry.streams.reduce((sum, row) => sum + row.weight, 0) || 1;
        return (
          <Card key={entry.agent.id}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <PersonAvatar name={entry.agent.name} kind="agent" color={entry.agent.color} avatar={entry.agent.avatar} />
                <div className="min-w-0 flex-1">
                  <CardTitle className="truncate text-sm">{entry.agent.name}</CardTitle>
                  <CardDescription className="truncate text-xs">{entry.agent.role}</CardDescription>
                </div>
                <Badge variant={entry.agent.status === "paused" ? "secondary" : "outline"} className="rounded-sm text-xs">
                  {entry.agent.status === "paused" ? i18n.t("scheduler.pausedAgent") : `${entry.agent.model} · ${entry.agent.api_key_tail}`}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              {entry.streams.map((slice) => (
                <div key={slice.stream_id} className="grid gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <a className="truncate text-sm hover:underline" href={`#/stream/${slice.stream_id}`}>
                      {slice.name || shortUuid(slice.stream_id)}
                    </a>
                    <span className="font-mono text-[11px] text-muted-foreground">{i18n.tf("scheduler.weightOf", { weight: slice.weight, total: totalWeight })}</span>
                    <span className="ml-auto flex items-center gap-1.5">
                      {slice.queued ? <Badge variant="secondary" className="rounded-sm font-mono text-[11px]">{i18n.tf("scheduler.badgeQueued", { n: slice.queued })}</Badge> : null}
                      {slice.running ? <Badge className="rounded-sm font-mono text-[11px]">{i18n.tf("scheduler.badgeRunning", { n: slice.running })}</Badge> : null}
                      <span className="font-mono text-[11px] text-muted-foreground">{i18n.tf("scheduler.badgeSlices", { n: slice.slices })}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Progress value={slice.share} className="h-1.5" />
                    <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{slice.share}%</span>
                  </div>
                  {slice.last_error ? <p className="text-[11px] text-destructive">{i18n.tf("scheduler.lastError", { error: slice.last_error })}</p> : null}
                </div>
              ))}
              <Separator />
              <p className="text-xs text-muted-foreground">{i18n.t("scheduler.shareHint")}</p>
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm">{i18n.t("scheduler.cronTitle")}</CardTitle>
            <Button size="sm" variant="outline" className="text-xs" onClick={startNew} disabled={!board?.boards.length}>
              {i18n.t("scheduler.newCron")}
            </Button>
          </div>
          <CardDescription className="text-xs">{i18n.tf("scheduler.cronLimitHint", { max: limits.max_per_owner, min: limits.min_interval_minutes })}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {draft ? (
            <div className="grid gap-3 rounded-lg border bg-muted/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold">{i18n.t(draft.id ? "scheduler.editCron" : "scheduler.newCron")}</h3>
                <Button size="xs" variant="ghost" className="text-xs" onClick={() => setDraft(null)}>
                  {i18n.t("common.collapse")}
                </Button>
              </div>
              {draftIsPaused ? (
                <Notice tone="warn">{i18n.t("scheduler.draftPausedHint")}</Notice>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={i18n.t("scheduler.nameLabel")} htmlFor="cron-name">
                  <Input
                    id="cron-name"
                    value={draft.name}
                    maxLength={60}
                    placeholder={i18n.t("scheduler.namePlaceholder")}
                    className="h-8 text-xs"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </Field>
                <Field label={i18n.t("scheduler.purposeLabel")} htmlFor="cron-purpose" hint={i18n.t("scheduler.purposeHint")}>
                  <NativeSelect
                    id="cron-purpose"
                    className="h-8 text-xs"
                    value={draft.purpose}
                    disabled={Boolean(draft.id)}
                    onChange={(event) => setDraft({ ...draft, purpose: event.target.value as Draft["purpose"] })}
                  >
                    <NativeSelectOption value="">{i18n.t("scheduler.purposeWork")}</NativeSelectOption>
                    <NativeSelectOption value="dreaming">{i18n.t("scheduler.purposeDream")}</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field label={i18n.t("scheduler.agentLabel")} htmlFor="cron-agent" hint={i18n.t("scheduler.agentHint")}>
                  <NativeSelect
                    id="cron-agent"
                    className="h-8 text-xs"
                    value={draft.agent_id}
                    onChange={(event) => setDraft({ ...draft, agent_id: event.target.value, stream_id: "" })}
                  >
                    <NativeSelectOption value="">{i18n.t("scheduler.pickAgent")}</NativeSelectOption>
                    {(board?.boards ?? []).map((entry) => (
                      <NativeSelectOption key={entry.agent.id} value={entry.agent.id}>
                        {entry.agent.name}
                        {entry.agent.status === "paused" ? ` · ${i18n.t("scheduler.pausedAgent")}` : ""}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label={i18n.t("scheduler.streamLabel")} htmlFor="cron-stream" hint={i18n.t("scheduler.streamHint")}>
                  <NativeSelect
                    id="cron-stream"
                    className="h-8 text-xs"
                    value={draft.stream_id}
                    onChange={(event) => setDraft({ ...draft, stream_id: event.target.value })}
                  >
                    <NativeSelectOption value="">
                      {draft.agent_id && !draftStreams.length ? i18n.t("scheduler.noSharedStream") : i18n.t("scheduler.pickStream")}
                    </NativeSelectOption>
                    {draftStreams.map((slice) => (
                      <NativeSelectOption key={slice.stream_id} value={slice.stream_id}>
                        {slice.name || shortUuid(slice.stream_id)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label={i18n.t("scheduler.kindLabel")} htmlFor="cron-kind">
                  <NativeSelect
                    id="cron-kind"
                    className="h-8 text-xs"
                    value={draft.kind}
                    onChange={(event) => setDraft({ ...draft, kind: event.target.value as "every" | "daily" })}
                  >
                    <NativeSelectOption value="every">{i18n.t("scheduler.kindEvery")}</NativeSelectOption>
                    <NativeSelectOption value="daily">{i18n.t("scheduler.kindDaily")}</NativeSelectOption>
                  </NativeSelect>
                </Field>
                {draft.kind === "every" ? (
                  <Field
                    label={i18n.t("scheduler.intervalFieldLabel")}
                    htmlFor="cron-interval"
                    hint={i18n.tf("scheduler.intervalHint", { min: limits.min_interval_minutes, max: MAX_INTERVAL_MINUTES })}
                  >
                    <Input
                      id="cron-interval"
                      type="number"
                      min={limits.min_interval_minutes}
                      max={MAX_INTERVAL_MINUTES}
                      step={1}
                      className="h-8 text-xs font-mono"
                      value={draft.interval_minutes}
                      onChange={(event) => setDraft({ ...draft, interval_minutes: event.target.value })}
                    />
                  </Field>
                ) : (
                  <>
                    <Field label={i18n.t("scheduler.atLabel")} htmlFor="cron-at" hint={i18n.t("scheduler.atHint")}>
                      <Input
                        id="cron-at"
                        type="time"
                        className="h-8 text-xs font-mono"
                        value={draft.at_time}
                        onChange={(event) => setDraft({ ...draft, at_time: event.target.value })}
                      />
                    </Field>
                    <Field label={i18n.t("scheduler.tzFieldLabel")} htmlFor="cron-tz">
                      <NativeSelect
                        id="cron-tz"
                        className="h-8 text-xs font-mono"
                        value={String(draft.tz_offset_minutes)}
                        onChange={(event) => setDraft({ ...draft, tz_offset_minutes: Number(event.target.value) })}
                      >
                        {tzOptions.map((option) => (
                          <NativeSelectOption key={option.minutes} value={String(option.minutes)}>
                            {option.label}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Field label={i18n.t("scheduler.daysFieldLabel")}>
                      <div className="flex flex-wrap gap-1.5">
                        {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                          <Button
                            key={day}
                            size="xs"
                            variant={draft.weekdays.includes(day) ? "default" : "outline"}
                            className="w-9 px-0"
                            onClick={() => setDraft({
                              ...draft,
                              weekdays: draft.weekdays.includes(day)
                                ? draft.weekdays.filter((item) => item !== day)
                                : [...draft.weekdays, day].sort((a, b) => a - b),
                            })}
                          >
                            {dayName(i18n, day, true)}
                          </Button>
                        ))}
                      </div>
                    </Field>
                  </>
                )}
              </div>
              <Field
                label={i18n.t("scheduler.instructionLabel")}
                htmlFor="cron-instruction"
                hint={draft.purpose === "dreaming" ? i18n.t("scheduler.instructionHintDream") : i18n.t("scheduler.instructionHintWork")}
              >
                <Textarea
                  id="cron-instruction"
                  rows={3}
                  maxLength={2000}
                  className="text-xs"
                  value={draft.instruction}
                  placeholder={i18n.t(draft.purpose === "dreaming" ? "scheduler.instructionPlaceholderDream" : "scheduler.instructionPlaceholderWork")}
                  onChange={(event) => setDraft({ ...draft, instruction: event.target.value })}
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" className="text-xs" onClick={() => setDraft(null)}>
                  {i18n.t("scheduler.cancel")}
                </Button>
                <Button size="sm" className="text-xs" onClick={() => void saveDraft()} disabled={saving}>
                  {saving ? i18n.t("scheduler.saving") : i18n.t("scheduler.saveCron")}
                </Button>
              </div>
            </div>
          ) : null}

          {!schedules.length && !draft ? (
            <Notice>{i18n.t("scheduler.noCron")}</Notice>
          ) : null}

          {schedules.map((row) => {
            const paused = row.next_run_at === null;
            const isDream = row.purpose === "dreaming";
            return (
              <div key={row.id} className="grid gap-1.5 rounded-lg border bg-card/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{row.name}</span>
                  {isDream ? (
                    <Badge variant="outline" className="rounded-sm font-mono text-[11px]">{i18n.t("scheduler.dreamBadge")}</Badge>
                  ) : null}
                  <Badge variant={paused ? "secondary" : "outline"} className="rounded-sm font-mono text-[11px]">
                    {paused ? i18n.t("scheduler.pausedState") : specLabel(i18n, row)}
                  </Badge>
                  {row.merged_runs ? (
                    <Badge variant="secondary" className="rounded-sm font-mono text-[11px]">
                      {i18n.tf("scheduler.mergedRuns", { n: row.merged_runs })}
                    </Badge>
                  ) : null}
                  <span className="ml-auto flex gap-1.5">
                    <Button size="xs" variant="ghost" className="text-xs" onClick={() => startEdit(row)}>
                      {i18n.t("common.edit")}
                    </Button>
                    <Button size="xs" variant="outline" className="text-xs" onClick={() => void toggleRunning(row)}>
                      {i18n.t(paused ? "scheduler.resume" : "scheduler.pause")}
                    </Button>
                    <Button size="xs" variant="ghost" className="text-xs" onClick={() => void removeRow(row)}>
                      {i18n.t("common.delete")}
                    </Button>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {agentNames.get(row.agent_id) ?? shortUuid(row.agent_id)} →{" "}
                    <a className="hover:underline" href={`#/stream/${row.stream_id}`}>
                      {streamNames.get(row.stream_id) ?? shortUuid(row.stream_id)}
                    </a>
                    {isDream ? i18n.t("scheduler.dreamStreamNote") : ""}
                  </span>
                  <span>{i18n.tf("scheduler.nextRun", { time: occurrenceLabel(i18n, row.upcoming[0]) })}</span>
                  <span>{row.last_run_at ? i18n.tf("scheduler.lastRun", { time: timeAgo(i18n, row.last_run_at) }) : i18n.t("scheduler.neverRun")}</span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {row.instruction || (isDream ? i18n.t("scheduler.dreamNoInstruction") : "")}
                </p>
                {pausedAgents.has(row.agent_id) ? (
                  <p className="text-[11px] text-machine">{i18n.t("scheduler.agentPausedWarn")}</p>
                ) : null}
              </div>
            );
          })}

          <Separator />
          <p className="text-xs text-muted-foreground">{i18n.t("scheduler.cronFooter")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{i18n.t("scheduler.dreamTitle")}</CardTitle>
          <CardDescription className="text-xs">{i18n.tf("scheduler.dreamIntro", { n: dreamCount })}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Field label={i18n.t("scheduler.dreamAutoLabel")} hint={i18n.t("scheduler.dreamAutoHint")}>
            <div className="flex h-8 items-center">
              <Switch
                checked={Boolean(dream?.auto)}
                disabled={!dream}
                onCheckedChange={(next) => void saveDreamAuto(next)}
              />
            </div>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={i18n.t("scheduler.dreamAgentLabel")} htmlFor="dream-agent" hint={i18n.t("scheduler.dreamAgentHint")}>
              <NativeSelect
                id="dream-agent"
                className="h-8 text-xs"
                value={dreamAgent}
                onChange={(event) => {
                  const id = event.target.value;
                  setDreamAgent(id);
                  setDreamStream(streamsByAgent.get(id)?.[0]?.stream_id ?? "");
                }}
              >
                <NativeSelectOption value="">{i18n.t("scheduler.pickAgent")}</NativeSelectOption>
                {(board?.boards ?? []).map((entry) => (
                  <NativeSelectOption key={entry.agent.id} value={entry.agent.id}>
                    {entry.agent.name}
                    {entry.agent.status === "paused" ? ` · ${i18n.t("scheduler.pausedAgent")}` : ""}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field label={i18n.t("scheduler.dreamStreamLabel")} htmlFor="dream-stream" hint={i18n.t("scheduler.dreamStreamHint")}>
              <NativeSelect
                id="dream-stream"
                className="h-8 text-xs"
                value={dreamStream}
                onChange={(event) => setDreamStream(event.target.value)}
              >
                <NativeSelectOption value="">
                  {dreamAgent && !dreamStreams.length ? i18n.t("scheduler.noSharedStream") : i18n.t("scheduler.pickStream")}
                </NativeSelectOption>
                {dreamStreams.map((slice) => (
                  <NativeSelectOption key={slice.stream_id} value={slice.stream_id}>
                    {slice.name || shortUuid(slice.stream_id)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="text-xs"
              onClick={() => void runDreamNow()}
              disabled={dreaming || !dreamAgent || !dreamStream}
            >
              {dreaming ? i18n.t("scheduler.dreamDelivering") : i18n.t("scheduler.dreamRunNow")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              onClick={() => void clearDream()}
              disabled={!dream?.memory}
            >
              {i18n.t("scheduler.dreamClear")}
            </Button>
            {dream?.memory ? (
              <span className="font-mono text-[11px] text-muted-foreground">
                {i18n.tf("scheduler.dreamCovers", {
                  n: Object.keys(dream.memory.covers_streams).length,
                  time: timeAgo(i18n, dream.memory.updated_at),
                })}
              </span>
            ) : null}
          </div>

          {dream?.memory ? (
            <p className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
              {dream.memory.content}
            </p>
          ) : (
            <Notice>{i18n.t("scheduler.dreamEmpty")}</Notice>
          )}

          {dream?.last_run ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              {i18n.tf("scheduler.dreamLastRun", {
                status: dream.last_run.status === "done"
                  ? i18n.tf("scheduler.dreamFinished", { time: dream.last_run.finished_at ? timeAgo(i18n, dream.last_run.finished_at) : "—" })
                  : dream.last_run.status === "failed"
                    ? i18n.tf("scheduler.dreamFailed", { error: describeCode(i18n, dream.last_run.error ?? "dream_failed") })
                    : i18n.t(
                      dream.last_run.status === "queued"
                        ? "scheduler.dreamStatusQueued"
                        : dream.last_run.status === "running"
                          ? "scheduler.dreamStatusRunning"
                          : "scheduler.dreamStatusWithdrawn",
                    ),
                reason: dreamReason(i18n, dream.last_run.reason),
              })}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {streams.length ? (
        <p className="text-xs text-muted-foreground">
          {i18n.tf("scheduler.yourStreams", { n: streams.length, time: timeAgo(i18n, streams[0]?.created_at) })}
        </p>
      ) : null}
    </div>
  );
}
