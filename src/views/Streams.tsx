// Stream 面板：群就是流。网格/列表看全局，2/4/9 格同时推进多个项目。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { describeError, get, type Agent } from "../api";
import type { AgentPresence, Message, Stream, StreamDetail, User, Vm } from "../types";
import { clockOf, shortUuid, timeAgo } from "../lib/format";
import { flashVars, readFlashColors, type FlashColors } from "../lib/flash";
import { DeliveryChips, MentionText, PersonAvatar, RoleBadge } from "../lib/ui";
import { navigate } from "../lib/route";
import { Composer, mentionablesOf } from "./chat/Composer";
import { CreateGroup, JoinByUuid } from "./streams/StreamForms";

type TickResult = {
  ok: true;
  ran: { mail_id: string; agent_id: string; stream_id: string; status?: string; error?: string }[];
  queued: number;
  since: number;
};

type BoardResult = {
  ok: true;
  budget?: number;
  boards: { agent: Agent; streams: { stream_id: string; queued: number; running: number }[] }[];
};

type MessagesResult = {
  ok: true;
  items: Message[];
  has_more: boolean;
  oldest_seq: number | null;
  presence?: AgentPresence[];
};
type Counters = Record<string, { queued: number; running: number }>;
type StreamState = "live" | "queued" | null;

const LIVE_MS = 9_000;
const QUEUED_MS = 25_000;

function stateTitle(state: StreamState) {
  if (state === "live") return "虚拟员工正在推进这个群";
  if (state === "queued") return "被 @ 派了活，任务在排队等时间片";
  return undefined;
}

function stateDot(state: StreamState) {
  if (state === "live") return "ws-dot-live";
  if (state === "queued") return "ws-dot-queued";
  return "";
}

type Layout = "grid" | "list" | 2 | 4 | 9;

const BOARD_KEY = "workstream.board";
const PANE_PAGE = 40;
const LAYOUTS: { value: Layout; label: string; title: string }[] = [
  { value: "grid", label: "网格", title: "卡片网格" },
  { value: "list", label: "列表", title: "一行一个群" },
  { value: 2, label: "2", title: "2 分屏" },
  { value: 4, label: "4", title: "4 分屏" },
  { value: 9, label: "9", title: "9 宫格" },
];

function readPrefs(): { layout: Layout; picked: string[] } {
  try {
    const raw = JSON.parse(localStorage.getItem(BOARD_KEY) ?? "{}") as { layout?: unknown; picked?: unknown };
    const layout: Layout =
      raw.layout === 2 || raw.layout === 4 || raw.layout === 9 || raw.layout === "list" ? raw.layout : "grid";
    const picked = Array.isArray(raw.picked)
      ? raw.picked.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 9)
      : [];
    return { layout, picked };
  } catch {
    return { layout: "grid", picked: [] };
  }
}

export function StreamsView({
  streams,
  agents,
  vms,
  user,
  onRefresh,
}: {
  streams: Stream[];
  agents: Agent[];
  vms: Vm[];
  user: User;
  onRefresh: () => Promise<void>;
}) {
  const [prefs, setPrefs] = useState(readPrefs);
  const [panel, setPanel] = useState<"create" | "join" | null>(null);
  const [boards, setBoards] = useState<BoardResult["boards"]>([]);
  const [pulse, setPulse] = useState({ n: 0, ran: [] as string[] });
  const [recent, setRecent] = useState<Record<string, "live" | "queued">>({});
  const [flashColors] = useState(readFlashColors);
  const [pollError, setPollError] = useState("");
  const sinceRef = useRef(0);
  const busyRef = useRef(false);
  const recentTimers = useRef(new Map<string, number>());

  // 时间片是同步跑完的，看板刷到时往往已经归零；用短暂的“刚刚跑过”覆盖这段空窗。
  const markRecent = useCallback((id: string, state: "live" | "queued") => {
    setRecent((current) => (current[id] === state ? current : { ...current, [id]: state }));
    const key = `${state}:${id}`;
    const existing = recentTimers.current.get(key);
    if (existing !== undefined) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      recentTimers.current.delete(key);
      setRecent((current) => {
        if (current[id] !== state) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    }, state === "live" ? LIVE_MS : QUEUED_MS);
    recentTimers.current.set(key, timer);
  }, []);

  useEffect(
    () => () => {
      for (const timer of recentTimers.current.values()) window.clearTimeout(timer);
      recentTimers.current.clear();
    },
    [],
  );

  useEffect(() => {
    localStorage.setItem(BOARD_KEY, JSON.stringify(prefs));
  }, [prefs]);

  // 群被删掉后，分屏里不留幽灵。首帧 streams 还没拉回来时不能清空。
  useEffect(() => {
    if (!streams.length) return;
    setPrefs((current) => {
      const kept = current.picked.filter((id) => streams.some((stream) => stream.id === id));
      return kept.length === current.picked.length ? current : { ...current, picked: kept };
    });
  }, [streams]);

  // 慢上游会把 tick 拖住十几秒；先把 tick 丢出去，读看板不被它卡，
  // 等它跑完再补一次看板并通知分屏刷新消息与员工忙态。
  const tickNow = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const tickPromise = get<TickResult>("scheduler.tick", { since: sinceRef.current }).catch(() => null);
      try {
        setBoards((await get<BoardResult>("scheduler.board")).boards);
        setPollError("");
      } catch (error) {
        setPollError(describeError(error));
      }
      const tick = await tickPromise;
      if (!tick) return;
      sinceRef.current = tick.since;
      const ran = [...new Set(tick.ran.map((item) => item.stream_id))];
      setPulse((current) => ({ n: current.n + 1, ran }));
      for (const id of ran) markRecent(id, "live");
      setBoards((await get<BoardResult>("scheduler.board")).boards);
    } catch {
      /* 下一轮再试 */
    } finally {
      busyRef.current = false;
    }
  }, [markRecent]);

  // 时间片由这里驱动：标签页在后台时停摆，回来第一轮补上。
  useEffect(() => {
    let stopped = false;
    void tickNow();
    const timer = window.setInterval(() => {
      if (!stopped && !document.hidden) void tickNow();
    }, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [tickNow]);

  const counters = useMemo(() => {
    const map: Counters = {};
    for (const entry of boards) {
      for (const row of entry.streams) {
        const cell = (map[row.stream_id] ??= { queued: 0, running: 0 });
        cell.queued += row.queued;
        cell.running += row.running;
      }
    }
    return map;
  }, [boards]);

  const stateOf = useCallback(
    (id: string): StreamState => {
      const cell = counters[id];
      if (cell?.running) return "live";
      // 还有活儿没轮到时以“排队”为准，避免刚跑完的绿色盖住积压。
      if (cell?.queued) return "queued";
      if (recent[id] === "live") return "live";
      if (recent[id] === "queued") return "queued";
      return null;
    },
    [counters, recent],
  );

  const capacity = typeof prefs.layout === "number" ? prefs.layout : 0;
  const slots = useMemo(
    () => Array.from({ length: capacity }, (_, index) => prefs.picked[index] ?? null),
    [capacity, prefs.picked],
  );

  function setLayout(layout: Layout) {
    setPrefs((current) => {
      if (typeof layout !== "number") return { ...current, layout };
      const picked = current.picked.slice(0, layout);
      // 第一次进分屏时给几格现成的群，之后由用户自己挑。
      if (!picked.length) return { layout, picked: streams.slice(0, layout).map((stream) => stream.id) };
      return { layout, picked };
    });
  }

  function togglePin(id: string) {
    setPrefs((current) => ({
      ...current,
      picked: current.picked.includes(id)
        ? current.picked.filter((entry) => entry !== id)
        : [...current.picked, id].slice(-9),
    }));
  }

  function expand(id: string) {
    setPrefs((current) => {
      const picked = current.picked.includes(id) ? current.picked : [...current.picked, id].slice(-9);
      const fit = picked.length <= 2 ? 2 : picked.length <= 4 ? 4 : 9;
      const layout =
        typeof current.layout === "number" && picked.length <= current.layout ? current.layout : fit;
      return { layout, picked };
    });
  }

  function setSlot(index: number, id: string) {
    setPrefs((current) => {
      const picked = [...current.picked];
      picked[index] = id;
      return { ...current, picked };
    });
  }

  function removeSlot(index: number) {
    setPrefs((current) => ({ ...current, picked: current.picked.filter((_, position) => position !== index) }));
  }

  const paneGrid =
    capacity === 2
      ? "lg:grid-cols-2"
      : capacity === 4
        ? "sm:grid-cols-2 lg:grid-rows-2"
        : "sm:grid-cols-2 lg:grid-cols-3 lg:grid-rows-3";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-3">
        <h1 className="text-lg font-semibold tracking-tight">Stream 面板</h1>
        <span className="rounded-full bg-muted/70 px-2 py-0.5 text-[11px] text-muted-foreground">
          {streams.length} 个群 · {prefs.picked.length} 个在台面上
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={panel === "create" ? "secondary" : "default"}
            className="h-7 rounded-full px-3 text-xs"
            onClick={() => setPanel((current) => (current === "create" ? null : "create"))}
          >
            新建群
          </Button>
          <Button
            size="sm"
            variant={panel === "join" ? "secondary" : "ghost"}
            className="h-7 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setPanel((current) => (current === "join" ? null : "join"))}
          >
            凭 UUID 进群
          </Button>
        </div>
        {/* 视图切换：一个胶囊分段控件，比五个独立描边按钮安静得多 */}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">视图</span>
          <div className="flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/40 p-0.5">
            {LAYOUTS.map((option) => {
              const active = prefs.layout === option.value;
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={active}
                  title={option.title}
                  onClick={() => setLayout(option.value)}
                  className={`h-6 rounded-full px-2.5 font-mono text-[11px] transition-[background-color,color,box-shadow] duration-200 ${
                    active
                      ? "ws-pill-active bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0_/_0.14)]"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
        {pollError ? <p className="basis-full text-[11px] text-destructive">队列看板暂不可用：{pollError}</p> : null}
      </header>

      <Dialog open={panel !== null} onOpenChange={(open) => { if (!open) setPanel(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogTitle className="sr-only">{panel === "join" ? "凭 UUID 进群" : "新建群"}</DialogTitle>
          {panel === "create" ? (
            <CreateGroup
              agents={agents}
              vms={vms}
              onCreated={async () => {
                setPanel(null);
                await onRefresh();
              }}
              onCancel={() => setPanel(null)}
            />
          ) : panel === "join" ? (
            <JoinByUuid
              onDone={async () => {
                setPanel(null);
                await onRefresh();
              }}
              onCancel={() => setPanel(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin lg:overflow-hidden">
        {!streams.length ? (
          <div className="grid h-full place-items-center">
            <div className="grid max-w-md gap-2 p-6 text-center">
              <h2 className="text-lg font-semibold">还没有群</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                群就是 stream：一个群推进一个项目。用左侧「新建群」建第一个，或者拿别人的 UUID 申请进群。
              </p>
            </div>
          </div>
        ) : prefs.layout === "grid" ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground sm:col-span-2 xl:col-span-3">
              点「分屏」把群放上工作台，再切右上角的 2/4/9 格同时推进多个项目。
            </p>
            {streams.map((stream) => (
              <StreamTile
                key={stream.id}
                stream={stream}
                counters={counters[stream.id]}
                state={stateOf(stream.id)}
                flash={flashColors[stream.id]}
                pinned={prefs.picked.includes(stream.id)}
                onPin={() => togglePin(stream.id)}
                onExpand={() => expand(stream.id)}
                onEnter={() => navigate(`/stream/${stream.id}`)}
              />
            ))}
          </div>
        ) : prefs.layout === "list" ? (
          <div className="grid gap-2">
            {streams.map((stream) => (
              <StreamRow
                key={stream.id}
                stream={stream}
                counters={counters[stream.id]}
                state={stateOf(stream.id)}
                flash={flashColors[stream.id]}
                pinned={prefs.picked.includes(stream.id)}
                onPin={() => togglePin(stream.id)}
                onExpand={() => expand(stream.id)}
                onEnter={() => navigate(`/stream/${stream.id}`)}
              />
            ))}
          </div>
        ) : (
          <div className={`grid h-full min-h-0 gap-2.5 ${paneGrid}`}>
            {slots.map((id, index) => {
              const stream = id ? streams.find((entry) => entry.id === id) : undefined;
              if (!stream) {
                return (
                  <EmptyPane
                    key={`slot-${index}`}
                    streams={streams}
                    picked={prefs.picked}
                    onPick={(nextId) => setSlot(index, nextId)}
                  />
                );
              }
              return (
                <StreamPane
                  key={stream.id}
                  stream={stream}
                  streams={streams}
                  picked={prefs.picked}
                  counters={counters[stream.id]}
                  state={stateOf(stream.id)}
                  flash={flashColors[stream.id]}
                  pulse={pulse}
                  user={user}
                  dense={capacity === 9}
                  onSwap={(nextId) => setSlot(index, nextId)}
                  onRemove={() => removeSlot(index)}
                  onQueued={() => markRecent(stream.id, "queued")}
                  onActivity={() => {
                    void tickNow();
                    void onRefresh();
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function QueueBadges({ counters, dense }: { counters?: { queued: number; running: number }; dense?: boolean }) {
  const running = counters?.running ?? 0;
  const queued = counters?.queued ?? 0;
  const text = dense ? "text-[10px]" : "text-[11px]";
  return (
    <>
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono ${text} ${
          running ? "bg-signal/12 text-signal" : "bg-muted/60 text-muted-foreground/70"
        }`}
      >
        运行 <span className="tabular-nums">{running}</span>
      </span>
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono ${text} ${
          queued ? "bg-machine/12 text-machine" : "bg-muted/60 text-muted-foreground/70"
        }`}
      >
        排队 <span className="tabular-nums">{queued}</span>
      </span>
    </>
  );
}

function PinButton({ pinned, onClick, dense }: { pinned: boolean; onClick: () => void; dense?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={pinned ? "从分屏移出" : "放上分屏工作台"}
      className={`inline-flex h-7 items-center rounded-full px-2.5 font-medium transition-colors duration-200 ${
        dense ? "text-[11px]" : "text-xs"
      } ${
        pinned
          ? "bg-signal/10 text-signal hover:bg-signal/15"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      {pinned ? "已分屏" : "分屏"}
    </button>
  );
}

function StreamTile({
  stream,
  counters,
  state,
  flash,
  pinned,
  onPin,
  onExpand,
  onEnter,
}: {
  stream: Stream;
  counters?: { queued: number; running: number };
  state: StreamState;
  flash?: FlashColors;
  pinned: boolean;
  onPin: () => void;
  onExpand: () => void;
  onEnter: () => void;
}) {
  const announcement = stream.announcement.trim();
  const border = state === "live" ? "ws-flash-live" : state === "queued" ? "ws-flash-queued" : "";
  return (
    <article
      title={stateTitle(state)}
      style={flashVars(flash)}
      className={`group ws-surface ws-surface-hover relative grid gap-2.5 rounded-xl bg-card p-3.5 ${border}`}
    >
      <header className="flex items-start gap-2">
        {state ? <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${stateDot(state)} animate-pulse`} /> : null}
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onEnter} title="进入群聊">
          <h2 className="truncate text-[15px] font-semibold tracking-tight">{stream.name}</h2>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/80">
            {shortUuid(stream.id)} · {Math.max(0, stream.next_seq - 1)} 条 · {stream.agent_count ?? 0} 虚拟
          </p>
        </button>
        {stream.my_role ? <RoleBadge role={stream.my_role} /> : null}
      </header>
      <div className="flex flex-wrap items-center gap-1.5">
        <QueueBadges counters={counters} />
        <span className="ml-auto text-[11px] text-muted-foreground/70">更新 {timeAgo(stream.updated_at ?? stream.created_at)}</span>
      </div>
      <p className="line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground">
        {announcement || "（没有公告）"}
      </p>
      <footer className="flex items-center gap-0.5">
        <PinButton pinned={pinned} onClick={onPin} />
        <button
          type="button"
          onClick={onExpand}
          className="inline-flex h-7 items-center rounded-full px-2.5 text-xs text-muted-foreground transition-colors duration-200 hover:bg-muted/60 hover:text-foreground"
        >
          展开
        </button>
        <button
          type="button"
          onClick={onEnter}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-foreground/80 transition-colors duration-200 hover:text-foreground"
        >
          进入
          <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5">
            →
          </span>
        </button>
      </footer>
    </article>
  );
}

function StreamRow({
  stream,
  counters,
  state,
  flash,
  pinned,
  onPin,
  onExpand,
  onEnter,
}: {
  stream: Stream;
  counters?: { queued: number; running: number };
  state: StreamState;
  flash?: FlashColors;
  pinned: boolean;
  onPin: () => void;
  onExpand: () => void;
  onEnter: () => void;
}) {
  const border = state === "live" ? "ws-flash-live" : state === "queued" ? "ws-flash-queued" : "";
  return (
    <article
      title={stateTitle(state)}
      style={flashVars(flash)}
      className={`group ws-surface ws-surface-hover flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-card px-3.5 py-2.5 ${border}`}
    >
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onEnter} title="进入群聊">
        <span className="flex items-center gap-2">
          {state ? <span aria-hidden className={`size-2 shrink-0 rounded-full ${stateDot(state)} animate-pulse`} /> : null}
          <span className="truncate text-sm font-medium">{stream.name}</span>
          {stream.my_role ? <RoleBadge role={stream.my_role} /> : null}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground/80">
          {shortUuid(stream.id)} · {Math.max(0, stream.next_seq - 1)} 条 · {stream.agent_count ?? 0} 虚拟 · 更新{" "}
          {timeAgo(stream.updated_at ?? stream.created_at)}
        </span>
      </button>
      <QueueBadges counters={counters} dense />
      <PinButton pinned={pinned} onClick={onPin} dense />
      <button
        type="button"
        onClick={onExpand}
        className="inline-flex h-7 items-center rounded-full px-2.5 text-[11px] text-muted-foreground transition-colors duration-200 hover:bg-muted/60 hover:text-foreground"
      >
        展开
      </button>
      <button
        type="button"
        onClick={onEnter}
        className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium text-foreground/80 transition-colors duration-200 hover:text-foreground"
      >
        进入
        <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5">
          →
        </span>
      </button>
    </article>
  );
}

function EmptyPane({
  streams,
  picked,
  onPick,
}: {
  streams: Stream[];
  picked: string[];
  onPick: (id: string) => void;
}) {
  return (
    <div className="grid min-h-[220px] place-items-center rounded-xl border border-dashed border-border/70 bg-muted/10 p-4 lg:min-h-0">
      <div className="grid justify-items-center gap-2">
        <p className="text-xs text-muted-foreground">这一格空着，放一个群进来。</p>
        <NativeSelect
          size="sm"
          className="h-8 w-52 text-xs"
          value=""
          onChange={(event) => {
            if (event.target.value) onPick(event.target.value);
          }}
        >
          <NativeSelectOption value="">选一个 stream…</NativeSelectOption>
          {streams
            .filter((stream) => !picked.includes(stream.id))
            .map((stream) => (
              <NativeSelectOption key={stream.id} value={stream.id}>
                {stream.name}
              </NativeSelectOption>
            ))}
        </NativeSelect>
      </div>
    </div>
  );
}

function StreamPane({
  stream,
  streams,
  picked,
  counters,
  state,
  flash,
  pulse,
  user,
  dense,
  onSwap,
  onRemove,
  onQueued,
  onActivity,
}: {
  stream: Stream;
  streams: Stream[];
  picked: string[];
  counters?: { queued: number; running: number };
  state: StreamState;
  flash?: FlashColors;
  pulse: { n: number; ran: string[] };
  user: User;
  dense: boolean;
  onSwap: (id: string) => void;
  onRemove: () => void;
  onQueued: () => void;
  onActivity: () => void;
}) {
  const [detail, setDetail] = useState<StreamDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [presence, setPresence] = useState<AgentPresence[]>([]);
  const [error, setError] = useState("");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef(0);
  const aliveRef = useRef(true);
  const stickRef = useRef(true);

  const load = useCallback(
    async (withDetail: boolean) => {
      try {
        const [latest, nextDetail] = await Promise.all([
          get<MessagesResult>("messages.list", { stream_id: stream.id, limit: PANE_PAGE }),
          withDetail ? get<StreamDetail>("streams.get", { id: stream.id }) : Promise.resolve(null),
        ]);
        if (!aliveRef.current) return;
        setMessages(latest.items);
        setPresence(latest.presence ?? []);
        lastSeqRef.current = latest.items[latest.items.length - 1]?.seq ?? 0;
        if (nextDetail) setDetail(nextDetail);
        setError("");
      } catch (cause) {
        if (aliveRef.current) setError(describeError(cause));
      }
    },
    [stream.id],
  );

  useEffect(() => {
    aliveRef.current = true;
    stickRef.current = true;
    setDetail(null);
    setMessages([]);
    setPresence([]);
    setError("");
    lastSeqRef.current = 0;
    void load(true);
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!pulse.n) return;
    void load(pulse.ran.includes(stream.id));
  }, [pulse, load, stream.id]);

  // 有任务在跑时，时间片请求可能被慢上游拖住；分屏自己按 5 秒刷新，
  // 让头像旁的转圈和消息的“处理中/已读”及时出现。
  const running = counters?.running ?? 0;
  useEffect(() => {
    if (!running) return;
    void load(false);
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(false);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [running, load]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node || !messages.length) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    if (nearBottom || stickRef.current) {
      stickRef.current = false;
      requestAnimationFrame(() => {
        node.scrollTop = node.scrollHeight;
      });
    }
  }, [messages]);

  const names = useMemo(() => mentionablesOf(detail?.members ?? []).map((entry) => entry.name), [detail]);
  const colors = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of detail?.members ?? []) {
      if (member.type === "agent" && member.agent?.id && member.agent.color) map.set(member.agent.id, member.agent.color);
    }
    return map;
  }, [detail]);
  const avatars = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of detail?.members ?? []) {
      if (member.type === "human" && member.id && member.avatar) map.set(member.id, member.avatar);
      if (member.type === "agent" && member.agent?.id && member.agent.avatar) map.set(member.agent.id, member.agent.avatar);
    }
    return map;
  }, [detail]);

  const options = streams.filter((entry) => entry.id === stream.id || !picked.includes(entry.id));
  const border = state === "live" ? "ws-flash-live" : state === "queued" ? "ws-flash-queued" : "";

  return (
    <section
      title={stateTitle(state)}
      style={flashVars(flash)}
      className={`ws-surface flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-xl bg-card lg:min-h-0 ${border}`}
    >
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border/50 px-3 py-2">
        {state ? <span aria-hidden className={`size-2 shrink-0 rounded-full ${stateDot(state)} animate-pulse`} /> : null}
        <span className="min-w-0 flex-1">
          <NativeSelect
            size="sm"
            className={`h-7 w-full border-transparent bg-transparent pr-7 pl-2 font-medium hover:bg-muted/40 dark:bg-transparent dark:hover:bg-muted/40 ${dense ? "text-xs" : "text-[13px]"}`}
            value={stream.id}
            title="换一个群放进这一格"
            onChange={(event) => {
              if (event.target.value && event.target.value !== stream.id) onSwap(event.target.value);
            }}
          >
            {options.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {entry.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </span>
        <QueueBadges counters={counters} dense />
        <Button
          size="sm"
          variant="ghost"
          className="h-6 rounded-full px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => navigate(`/stream/${stream.id}`)}
          title="打开全屏群聊"
        >
          全屏
        </Button>
        <Button size="sm" variant="ghost" className="h-6 rounded-full px-2 text-[11px] text-muted-foreground" onClick={onRemove}>
          移除
        </Button>
      </header>

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2 scrollbar-thin"
        style={{ overflowAnchor: "none" }}
      >
        <div className={dense ? "grid gap-1.5" : "grid gap-2"}>
          {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
          {!error && messages.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">这个群还很安静，@ 一位虚拟员工开个头。</p>
          ) : null}
          {messages.map((message) => (
            <PaneMessage
              key={message.id}
              message={message}
              names={names}
              me={user.id}
              color={colors.get(message.sender_id)}
              avatar={
                presence.find((entry) => entry.agent_id === message.sender_id)?.avatar ??
                avatars.get(message.sender_id) ??
                (message.sender_id === user.id ? user.avatar : null)
              }
              presence={message.sender_type === "agent" ? presence.find((entry) => entry.agent_id === message.sender_id) : undefined}
              dense={dense}
            />
          ))}
        </div>
      </div>

      <div className="border-t border-border/50 px-2 py-1.5">
        <Composer
          streamId={stream.id}
          members={detail?.members ?? []}
          presence={presence}
          compact
          onSent={(result) => {
            setMessages((current) => [...current, result.message]);
            lastSeqRef.current = result.message.seq;
            if (result.queued.length) onQueued();
            onActivity();
          }}
        />
      </div>
    </section>
  );
}

function PaneMessage({
  message,
  names,
  me,
  color,
  avatar,
  presence,
  dense,
}: {
  message: Message;
  names: string[];
  me: string;
  color?: string;
  avatar?: string | null;
  presence?: AgentPresence;
  dense: boolean;
}) {
  if (message.sender_type === "system" || message.kind === "system") {
    return (
      <p className="rounded bg-muted/60 px-2 py-1 text-center text-[11px] leading-relaxed text-muted-foreground">
        {message.content}
      </p>
    );
  }
  const agent = message.sender_type === "agent";
  return (
    <article className="flex items-start gap-2">
      <PersonAvatar
        name={message.sender_name}
        kind={agent ? "agent" : "human"}
        color={color}
        avatar={avatar}
        className={dense ? "size-5 text-[10px]" : "size-6 text-[11px]"}
        href={agent ? `#/agents/${message.sender_id}` : undefined}
        busy={presence?.working}
      />
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span className={`truncate font-medium ${dense ? "text-xs" : "text-sm"} ${agent ? "text-machine" : ""}`}>
            {message.sender_name}
          </span>
          {agent && presence?.signature ? (
            <span className="max-w-32 truncate text-[10px] text-muted-foreground">「{presence.signature}」</span>
          ) : null}
          {agent ? <span className="text-[10px] text-machine/70">虚拟</span> : null}
          {message.sender_id === me ? <span className="text-[10px] text-muted-foreground">我</span> : null}
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
            {clockOf(message.created_at)}
          </span>
        </header>
        <p className={`mt-0.5 whitespace-pre-wrap leading-relaxed ${dense ? "text-xs" : "text-[13px]"}`}>
          <MentionText content={message.content} names={names} />
        </p>
        <DeliveryChips deliveries={message.deliveries} dense />
        {message.error ? <p className="mt-0.5 text-[11px] text-destructive">回执出错：{message.error}</p> : null}
      </div>
    </article>
  );
}
