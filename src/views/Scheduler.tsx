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

const WEEK_NAMES: Record<number, string> = { 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "日" };
const MAX_INTERVAL_MINUTES = 10080;

/** 本机偏移未必落在整小时（UTC+5:30 这类），下拉里要能把这个真实值带进来。 */
const localOffsetMinutes = () => -new Date().getTimezoneOffset();

function tzLabel(minutes: number): string {
  if (!minutes) return "UTC+0";
  const abs = Math.abs(minutes);
  const minutePart = abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : "";
  return `UTC${minutes < 0 ? "-" : "+"}${Math.floor(abs / 60)}${minutePart}`;
}

function intervalLabel(minutes: number | null): string {
  if (!minutes) return "间隔未设";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function specLabel(row: Schedule): string {
  if (row.kind === "every") return `每 ${intervalLabel(row.interval_minutes)}`;
  const days = row.weekdays?.length ? row.weekdays.map((d) => `周${WEEK_NAMES[d] ?? "?"}`).join("、") : "每天";
  return `${days} ${row.at_time ?? "—"}（${tzLabel(row.tz_offset_minutes ?? 0)}）`;
}

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** 归并是被谁叫醒的：后端在信上记了原因，界面上就要能分开这三种入口。 */
const dreamReason = (reason: string | null): string =>
  reason === "auto" ? "群折叠触发" : reason === "cron" ? "排程触发" : "手动按钮";

/** 未来的对点用「今天/明天/周几 + 钟点」读，钟点按本机时区换算——界面上的时间差一分钟都不该差。 */
function occurrenceLabel(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  if (dayKey(date) === dayKey(today)) return `今天 ${hhmm}`;
  if (dayKey(date) === dayKey(new Date(today.getTime() + 86_400_000))) return `明天 ${hhmm}`;
  return `周${WEEK_NAMES[date.getDay() === 0 ? 7 : date.getDay()]} ${hhmm}`;
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
      toast.error(describeError(error));
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
      if (result.ran.length) parts.push(`这一格推进了 ${result.ran.length} 个任务`);
      if (fired.length) parts.push(`${fired.length} 条排程到点`);
      if (merged) parts.push(`${merged} 条并进了还没跑的那封`);
      if (stopped) parts.push(`${stopped} 条因员工不在群里自己停了`);
      if (undelivered) parts.push(`${undelivered} 条投递失败，时钟已回拨`);
      toast.success(parts.length ? parts.join("，") : "没有待办任务，队列是空的");
      await refresh();
    } catch (error) {
      toast.error(describeError(error));
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
      label: minutes === local ? `${tzLabel(minutes)} · 本机` : tzLabel(minutes),
    }));
  }, []);

  const draftIsPaused = Boolean(draft?.id) && schedules.some((row) => row.id === draft?.id && row.next_run_at === null);

  function startNew() {
    if (schedules.length >= limits.max_per_owner) {
      toast.error(`每人最多 ${limits.max_per_owner} 条排程，先删掉不用的。`);
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
      toast.error("给排程起个名字：群里回头要认得出是哪一条在说话。");
      return;
    }
    // 归并全局记忆那条不看「要办的事」：正文是可选的额外要求，留空就用默认口径。
    if (!draft.instruction.trim() && draft.purpose !== "dreaming") {
      toast.error("「要办的事」不能空着：这一轮醒来它主要就看这句话。");
      return;
    }
    if (!draft.agent_id || !draft.stream_id) {
      toast.error("先选干活的员工和发话的群。");
      return;
    }
    if (draft.kind === "every"
      && (!Number.isInteger(interval) || interval < limits.min_interval_minutes || interval > MAX_INTERVAL_MINUTES)) {
      toast.error(`间隔要填 ${limits.min_interval_minutes} 到 ${MAX_INTERVAL_MINUTES} 之间的整数分钟。`);
      return;
    }
    if (draft.kind === "daily" && !/^\d{2}:\d{2}$/.test(draft.at_time)) {
      toast.error("时刻要填 HH:MM，比如 09:30。");
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
      toast.success(draft.id ? "排程已更新，时钟按新规格重新锚到下一个对点。" : "排程已建好，到点它会自己醒。");
      setDraft(null);
      await refresh();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  async function toggleRunning(row: Schedule) {
    try {
      await post(row.next_run_at ? "cron.pause" : "cron.resume", { id: row.id });
      toast.success(row.next_run_at ? `「${row.name}」已暂停，暂停期间欠下的对点不补。` : `「${row.name}」已恢复，从下一个对点重新走。`);
      await refresh();
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function removeRow(row: Schedule) {
    if (!window.confirm(`删掉排程「${row.name}」？还没跑的那一轮会一并撤回。`)) return;
    try {
      const result = await post<{ ok: true; cancelled: number }>("cron.delete", { id: row.id });
      toast.success(result.cancelled ? `排程已删除，同时撤回了 ${result.cancelled} 封还没跑的排程信。` : "排程已删除。");
      if (draft?.id === row.id) setDraft(null);
      await refresh();
    } catch (error) {
      toast.error(describeError(error));
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
      toast.success(next ? "已打开：任何一个群折叠历史时，顺手补一次归并。" : "已关闭：归并只按排程或手动按钮走。");
    } catch (error) {
      setDream((prev) => (prev ? { ...prev, auto: !next } : prev));
      toast.error(describeError(error));
    }
  }

  async function runDreamNow() {
    if (!dreamAgent || !dreamStream) {
      toast.error("先选归并走哪位员工、落哪个群。");
      return;
    }
    setDreaming(true);
    try {
      const result = await post<{ ok: true; queued: boolean; reason?: string }>("dreaming.run", {
        agent_id: dreamAgent,
        stream_id: dreamStream,
      });
      toast.success(result.queued
        ? "已投给后台：这一轮跑完就能看到新的全局记忆，它不会在群里说话。"
        : `这次没排队：${result.reason === "already_pending" ? "已经有一封还没跑的归并信了。" : "名下没有可用的虚拟员工。"}`);
      await refresh();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setDreaming(false);
    }
  }

  async function clearDream() {
    if (!window.confirm("删掉这份全局记忆？每群的覆盖水位会一并清空，下一次归并从各群现有的摘要重并。")) return;
    try {
      await post("dreaming.clear", {});
      toast.success("全局记忆已清空。");
      await refresh();
    } catch (error) {
      toast.error(describeError(error));
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
          <h1 className="text-lg font-semibold tracking-tight">调度台</h1>
          <p className="text-sm text-muted-foreground">
            每个虚拟员工按 FIFO 从自己的邮箱取件，跨群按权重切时间片；没有实时抢占，单个任务会跑完再让位。
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="text-xs" onClick={() => void refresh()}>
            刷新
          </Button>
          <Button size="sm" className="text-xs" onClick={() => void tick()} disabled={busy}>
            {busy ? "推进中…" : "手动推进一格"}
          </Button>
        </div>
      </header>

      <div className="grid gap-2 rounded-lg border bg-card p-3 sm:grid-cols-4">
        <StatRow label="每格槽位预算" value={board?.budget ?? "—"} tone="muted" />
        <StatRow label="排队" value={totals.queued} tone="machine" />
        <StatRow label="运行中" value={totals.running} tone="signal" />
        <StatRow label="完成 / 失败" value={`${totals.done} / ${totals.failed}`} tone="muted" />
      </div>

      {!board?.boards.length ? (
        <Notice>还没有可调度的人：先创建虚拟员工，并让 ta 进至少一个群。</Notice>
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
                  {entry.agent.status === "paused" ? "暂停接活" : `${entry.agent.model} · ${entry.agent.api_key_tail}`}
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
                    <span className="font-mono text-[11px] text-muted-foreground">权重 {slice.weight}/{totalWeight}</span>
                    <span className="ml-auto flex items-center gap-1.5">
                      {slice.queued ? <Badge variant="secondary" className="rounded-sm font-mono text-[11px]">排队 {slice.queued}</Badge> : null}
                      {slice.running ? <Badge className="rounded-sm font-mono text-[11px]">运行 {slice.running}</Badge> : null}
                      <span className="font-mono text-[11px] text-muted-foreground">片 {slice.slices}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Progress value={slice.share} className="h-1.5" />
                    <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{slice.share}%</span>
                  </div>
                  {slice.last_error ? <p className="text-[11px] text-destructive">最近失败：{slice.last_error}</p> : null}
                </div>
              ))}
              <Separator />
              <p className="text-xs text-muted-foreground">
                份额由最大余数法从每格预算里切出；改权重请在群里的「成员」面板由群主或管理员确认。
              </p>
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm">排程</CardTitle>
            <Button size="sm" variant="outline" className="text-xs" onClick={startNew} disabled={!board?.boards.length}>
              新建排程
            </Button>
          </div>
          <CardDescription className="text-xs">
            到点由服务端按时钟现算，不靠"翻牌"：上限每人 {limits.max_per_owner} 条、最短间隔 {limits.min_interval_minutes} 分钟。
            掉线期间攒下的对点只投一封，其余记进「累计合并」；暂停期间欠掉的不补，恢复时从现在之后的第一个对点重新走。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {draft ? (
            <div className="grid gap-3 rounded-lg border bg-muted/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold">{draft.id ? "编辑排程" : "新建排程"}</h3>
                <Button size="xs" variant="ghost" className="text-xs" onClick={() => setDraft(null)}>
                  收起
                </Button>
              </div>
              {draftIsPaused ? (
                <Notice tone="warn">这条现在是暂停状态：改规格保存之后仍然暂停，要让它继续走得点「恢复」。</Notice>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="名称" htmlFor="cron-name">
                  <Input
                    id="cron-name"
                    value={draft.name}
                    maxLength={60}
                    placeholder="晨间巡检"
                    className="h-8 text-xs"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </Field>
                <Field label="这条排程干什么" htmlFor="cron-purpose" hint="建好之后不能改：换成另一种活法，等于悄悄改了同一条排程的语义，要改就删了重建。">
                  <NativeSelect
                    id="cron-purpose"
                    className="h-8 text-xs"
                    value={draft.purpose}
                    disabled={Boolean(draft.id)}
                    onChange={(event) => setDraft({ ...draft, purpose: event.target.value as Draft["purpose"] })}
                  >
                    <NativeSelectOption value="">到点干活（在群里说话）</NativeSelectOption>
                    <NativeSelectOption value="dreaming">到点归并全局记忆（不进群）</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field label="干活的员工" htmlFor="cron-agent" hint="只能排你自己名下的虚拟员工：借别人的员工排班是烧别人的 Key。">
                  <NativeSelect
                    id="cron-agent"
                    className="h-8 text-xs"
                    value={draft.agent_id}
                    onChange={(event) => setDraft({ ...draft, agent_id: event.target.value, stream_id: "" })}
                  >
                    <NativeSelectOption value="">选一个虚拟员工</NativeSelectOption>
                    {(board?.boards ?? []).map((entry) => (
                      <NativeSelectOption key={entry.agent.id} value={entry.agent.id}>
                        {entry.agent.name}
                        {entry.agent.status === "paused" ? " · 暂停接活" : ""}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="发话的群" htmlFor="cron-stream" hint="只列这位员工和你都在的群。">
                  <NativeSelect
                    id="cron-stream"
                    className="h-8 text-xs"
                    value={draft.stream_id}
                    onChange={(event) => setDraft({ ...draft, stream_id: event.target.value })}
                  >
                    <NativeSelectOption value="">
                      {draft.agent_id && !draftStreams.length ? "这位员工没和你在任何共同群里" : "选一个群"}
                    </NativeSelectOption>
                    {draftStreams.map((slice) => (
                      <NativeSelectOption key={slice.stream_id} value={slice.stream_id}>
                        {slice.name || shortUuid(slice.stream_id)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="节奏" htmlFor="cron-kind">
                  <NativeSelect
                    id="cron-kind"
                    className="h-8 text-xs"
                    value={draft.kind}
                    onChange={(event) => setDraft({ ...draft, kind: event.target.value as "every" | "daily" })}
                  >
                    <NativeSelectOption value="every">每隔多久</NativeSelectOption>
                    <NativeSelectOption value="daily">每天几点</NativeSelectOption>
                  </NativeSelect>
                </Field>
                {draft.kind === "every" ? (
                  <Field
                    label="间隔（分钟）"
                    htmlFor="cron-interval"
                    hint={`最短 ${limits.min_interval_minutes} 分钟，最长 ${MAX_INTERVAL_MINUTES} 分钟。改间隔会把时钟重新锚到下一个对点。`}
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
                    <Field label="时刻" htmlFor="cron-at" hint="按下面的时区偏移读这个墙钟时刻。">
                      <Input
                        id="cron-at"
                        type="time"
                        className="h-8 text-xs font-mono"
                        value={draft.at_time}
                        onChange={(event) => setDraft({ ...draft, at_time: event.target.value })}
                      />
                    </Field>
                    <Field label="时区偏移" htmlFor="cron-tz">
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
                    <Field label="哪几天（一个都不选=每天）">
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
                            {WEEK_NAMES[day]}
                          </Button>
                        ))}
                      </div>
                    </Field>
                  </>
                )}
              </div>
              <Field
                label="要办的事"
                htmlFor="cron-instruction"
                hint={draft.purpose === "dreaming"
                  ? "归并那一轮的素材是你名下各个群的压缩摘要，这句话只是额外交代（比如「只并待办和数字」），可以留空。"
                  : "这一轮醒来时它看到的是这句话加上群里最近的转录。这句话不能空着；要在「没事的时候别说话」，就把它写进这句话里。"}
              >
                <Textarea
                  id="cron-instruction"
                  rows={3}
                  maxLength={2000}
                  className="text-xs"
                  value={draft.instruction}
                  placeholder={draft.purpose === "dreaming"
                    ? "只并稳定事实和还没办完的待办，人名与数字照抄。"
                    : "看一眼线上告警，把要紧的报出来；没有要紧的就别说话。"}
                  onChange={(event) => setDraft({ ...draft, instruction: event.target.value })}
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" className="text-xs" onClick={() => setDraft(null)}>
                  取消
                </Button>
                <Button size="sm" className="text-xs" onClick={() => void saveDraft()} disabled={saving}>
                  {saving ? "保存中…" : "保存排程"}
                </Button>
              </div>
            </div>
          ) : null}

          {!schedules.length && !draft ? (
            <Notice>
              还没有排程：给名下的虚拟员工排一件事，到点它会自己在群里说话，不需要有人先 @ 它。
            </Notice>
          ) : null}

          {schedules.map((row) => {
            const paused = row.next_run_at === null;
            const isDream = row.purpose === "dreaming";
            return (
              <div key={row.id} className="grid gap-1.5 rounded-lg border bg-card/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{row.name}</span>
                  {isDream ? (
                    <Badge variant="outline" className="rounded-sm font-mono text-[11px]">归并全局记忆</Badge>
                  ) : null}
                  <Badge variant={paused ? "secondary" : "outline"} className="rounded-sm font-mono text-[11px]">
                    {paused ? "已暂停" : specLabel(row)}
                  </Badge>
                  {row.merged_runs ? (
                    <Badge variant="secondary" className="rounded-sm font-mono text-[11px]">
                      累计合并 {row.merged_runs} 个对点
                    </Badge>
                  ) : null}
                  <span className="ml-auto flex gap-1.5">
                    <Button size="xs" variant="ghost" className="text-xs" onClick={() => startEdit(row)}>
                      编辑
                    </Button>
                    <Button size="xs" variant="outline" className="text-xs" onClick={() => void toggleRunning(row)}>
                      {paused ? "恢复" : "暂停"}
                    </Button>
                    <Button size="xs" variant="ghost" className="text-xs" onClick={() => void removeRow(row)}>
                      删除
                    </Button>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {agentNames.get(row.agent_id) ?? shortUuid(row.agent_id)} →{" "}
                    <a className="hover:underline" href={`#/stream/${row.stream_id}`}>
                      {streamNames.get(row.stream_id) ?? shortUuid(row.stream_id)}
                    </a>
                    {isDream ? "（只是走信的群，这一轮不进群说话）" : ""}
                  </span>
                  <span>下一次 {occurrenceLabel(row.upcoming[0])}</span>
                  <span>{row.last_run_at ? `上次跑 ${timeAgo(row.last_run_at)}` : "还没跑过"}</span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {row.instruction || (isDream ? "（这次没有额外交代，按默认口径归并）" : "")}
                </p>
                {pausedAgents.has(row.agent_id) ? (
                  <p className="text-[11px] text-machine">这位员工现在「暂停接活」，到点的那一轮会直接失败。</p>
                ) : null}
              </div>
            );
          })}

          <Separator />
          <p className="text-xs text-muted-foreground">
            到点那一轮排在真人 @ 之后：同事在线等回答时先答人，欠下的对点下一轮照样按时钟追上来。
            员工中途退群时这条会自己暂停，界面上如实显示「已暂停」，要恢复得由主人重新排。
            「归并全局记忆」那一类到点不进群说话，只把各群的摘要并进下面这一份。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">全局记忆（dreaming）</CardTitle>
          <CardDescription className="text-xs">
            把你名下各个群的压缩摘要归并成一份「属于你」的结论。它每一轮都在提示词里，但只用来判断该怎么答——
            那是跨群归并出来的东西，不会被念给当前这个群听。三个入口：群一折叠历史就顺手归并（下面的开关）、
            按排程定时归并（在上面新建一条「到点归并全局记忆」的排程，现在 {dreamCount} 条）、以及这里手动跑一次。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Field label="群一压缩完就归并一次" hint="没有新要点的那一轮直接算没事，不付模型调用；攒着等下一个群有新材料。">
            <div className="flex h-8 items-center">
              <Switch
                checked={Boolean(dream?.auto)}
                disabled={!dream}
                onCheckedChange={(next) => void saveDreamAuto(next)}
              />
            </div>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="归并走哪位员工" htmlFor="dream-agent" hint="只是借它的模型和 Key 跑这一次；结果归你，不归这位员工。">
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
                <NativeSelectOption value="">选一个虚拟员工</NativeSelectOption>
                {(board?.boards ?? []).map((entry) => (
                  <NativeSelectOption key={entry.agent.id} value={entry.agent.id}>
                    {entry.agent.name}
                    {entry.agent.status === "paused" ? " · 暂停接活" : ""}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field label="落哪个群" htmlFor="dream-stream" hint="这封信要落进某位员工的某个群邮箱才能排队；归并本身不进群。">
              <NativeSelect
                id="dream-stream"
                className="h-8 text-xs"
                value={dreamStream}
                onChange={(event) => setDreamStream(event.target.value)}
              >
                <NativeSelectOption value="">
                  {dreamAgent && !dreamStreams.length ? "这位员工没和你在任何共同群里" : "选一个群"}
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
              {dreaming ? "投递中…" : "立即归并一次"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              onClick={() => void clearDream()}
              disabled={!dream?.memory}
            >
              清空全局记忆
            </Button>
            {dream?.memory ? (
              <span className="font-mono text-[11px] text-muted-foreground">
                已并入 {Object.keys(dream.memory.covers_streams).length} 份群摘要 · 更新于 {timeAgo(dream.memory.updated_at)}
              </span>
            ) : null}
          </div>

          {dream?.memory ? (
            <p className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
              {dream.memory.content}
            </p>
          ) : (
            <Notice>
              还没有全局记忆：先让名下的员工在群里跑起来——各群要有压缩摘要，这里才并得出东西。
            </Notice>
          )}

          {dream?.last_run ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              上一次归并：
              {dream.last_run.status === "done"
                ? `跑完于 ${dream.last_run.finished_at ? timeAgo(dream.last_run.finished_at) : "—"}`
                : dream.last_run.status === "failed"
                  ? `失败：${describeCode(dream.last_run.error ?? "dream_failed")}`
                  : `${dream.last_run.status === "queued" ? "排队中" : dream.last_run.status === "running" ? "正在跑" : "已撤回"}`}
              （{dreamReason(dream.last_run.reason)}）
            </p>
          ) : null}
        </CardContent>
      </Card>

      {streams.length ? (
        <p className="text-xs text-muted-foreground">
          你在 {streams.length} 个群里；最近一次活动 {timeAgo(streams[0]?.created_at)}。
        </p>
      ) : null}
    </div>
  );
}
