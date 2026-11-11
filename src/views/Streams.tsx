// Stream 面板：群就是流。网格/列表看全局，2/4/9 格同时推进多个项目。
import { messageRendererFor } from "../lib/messageRenderers";
import "../lib/renderers/markdown-message";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { describeError, get, type Agent } from "../api";
import type { AgentPresence, Message, Stream, StreamDetail, User, Vm } from "../types";
import { clockOf, shortUuid, timeAgo } from "../lib/format";
import { flashVars, readFlashColors, type FlashColors } from "../lib/flash";
import { markMentionSeen, readSeenMentions } from "../lib/mentions";
import { DeliveryChips, MentionText, MessageImages, PersonAvatar, PresentedCards, RoleBadge } from "../lib/ui";
import { navigate } from "../lib/route";
import { Composer, mentionablesOf } from "./chat/Composer";
import { CreateGroup, JoinByUuid } from "./streams/StreamForms";
import { useI18n, type I18n, type MsgKey } from "../lib/i18n";

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
type StreamState = "mention" | "live" | "queued" | null;

const LIVE_MS = 9_000;
const QUEUED_MS = 25_000;

function stateTitle(i18n: I18n, state: StreamState) {
  if (state === "mention") return i18n.t("stream.stateMention");
  if (state === "live") return i18n.t("stream.stateLive");
  if (state === "queued") return i18n.t("stream.stateQueued");
  return undefined;
}

function stateDot(state: StreamState) {
  if (state === "mention") return "ws-dot-mention";
  if (state === "live") return "ws-dot-live";
  if (state === "queued") return "ws-dot-queued";
  return "";
}

/** 群边框的光环：被 @ 我（黄心跳）盖过有活在跑（绿，30 次/分），再盖过排队。 */
function borderClass(state: StreamState) {
  if (state === "mention") return "ws-flash-mention";
  if (state === "live") return "ws-flash-live";
  if (state === "queued") return "ws-flash-queued";
  return "";
}

type Layout = "grid" | "list" | 2 | 4 | 9;

const BOARD_KEY = "workstream.board";
const PANE_PAGE = 40;
// 2/4/9 的胶囊标签就是数字本身，跨语言通用，不进字典；需要译的只有提示语。
const LAYOUTS: { value: Layout; labelKey?: MsgKey; titleKey: MsgKey }[] = [
  { value: "grid", labelKey: "stream.layoutGrid", titleKey: "stream.layoutGridTitle" },
  { value: "list", labelKey: "stream.layoutList", titleKey: "stream.layoutListTitle" },
  { value: 2, titleKey: "stream.layoutSplit2" },
  { value: 4, titleKey: "stream.layoutSplit4" },
  { value: 9, titleKey: "stream.layoutNineGrid" },
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
  const i18n = useI18n();
  const [prefs, setPrefs] = useState(readPrefs);
  const [panel, setPanel] = useState<"create" | "join" | null>(null);
  const [boards, setBoards] = useState<BoardResult["boards"]>([]);
  const [pulse, setPulse] = useState({ n: 0, ran: [] as string[] });
  const [recent, setRecent] = useState<Record<string, "live" | "queued">>({});
  const [seen, setSeen] = useState(readSeenMentions);
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
        setPollError(describeError(i18n, error));
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
      // 有人 @ 我先于别的状态：群里有没有活在跑是次要的，有人喊我才是最该看见的那条。
      const mentionSeq = streams.find((entry) => entry.id === id)?.mentioned_seq ?? null;
      if (mentionSeq && mentionSeq > (seen[id] ?? 0)) return "mention";
      const cell = counters[id];
      if (cell?.running) return "live";
      // 还有活儿没轮到时以“排队”为准，避免刚跑完的绿色盖住积压。
      if (cell?.queued) return "queued";
      if (recent[id] === "live") return "live";
      if (recent[id] === "queued") return "queued";
      return null;
    },
    [counters, recent, streams, seen],
  );

  // 看清了就把水位推到这条 @ 上：黄心跳只在这个水位之后的新 @ 上重新亮。
  const seeMention = useCallback((id: string, seq: number | null | undefined) => {
    if (!id || !seq) return;
    markMentionSeen(id, seq);
    setSeen((current) => ((current[id] ?? 0) >= seq ? current : { ...current, [id]: seq }));
  }, []);

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
        <h1 className="text-lg font-semibold tracking-tight">{i18n.t("nav.streamBoard")}</h1>
        <span className="rounded-full bg-muted/70 px-2 py-0.5 text-[11px] text-muted-foreground">
          {i18n.tf("stream.boardSummary", { groups: streams.length, onBoard: prefs.picked.length })}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={panel === "create" ? "secondary" : "default"}
            className="h-7 rounded-full px-3 text-xs"
            onClick={() => setPanel((current) => (current === "create" ? null : "create"))}
          >
            {i18n.t("stream.newGroup")}
          </Button>
          <Button
            size="sm"
            variant={panel === "join" ? "secondary" : "ghost"}
            className="h-7 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setPanel((current) => (current === "join" ? null : "join"))}
          >
            {i18n.t("stream.joinByUuid")}
          </Button>
        </div>
        {/* 视图切换：一个胶囊分段控件，比五个独立描边按钮安静得多 */}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">{i18n.t("stream.viewLabel")}</span>
          <div className="flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/40 p-0.5">
            {LAYOUTS.map((option) => {
              const active = prefs.layout === option.value;
              return (
                <button
                  key={String(option.value)}
                  type="button"
                  aria-pressed={active}
                  title={i18n.t(option.titleKey)}
                  onClick={() => setLayout(option.value)}
                  className={`h-6 rounded-full px-2.5 font-mono text-[11px] transition-[background-color,color,box-shadow] duration-200 ${
                    active
                      ? "ws-pill-active bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0_/_0.14)]"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option.labelKey ? i18n.t(option.labelKey) : option.value}
                </button>
              );
            })}
          </div>
        </div>
        {pollError ? <p className="basis-full text-[11px] text-destructive">{i18n.tf("stream.boardUnavailable", { error: pollError })}</p> : null}
      </header>

      <Dialog open={panel !== null} onOpenChange={(open) => { if (!open) setPanel(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogTitle className="sr-only">{panel === "join" ? i18n.t("stream.joinByUuid") : i18n.t("stream.newGroup")}</DialogTitle>
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
              <h2 className="text-lg font-semibold">{i18n.t("stream.emptyTitle")}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{i18n.t("stream.emptyHint")}</p>
            </div>
          </div>
        ) : prefs.layout === "grid" ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground sm:col-span-2 xl:col-span-3">
              {i18n.t("stream.splitHint")}
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
                onEnter={() => {
                  seeMention(stream.id, stream.mentioned_seq);
                  navigate(`/stream/${stream.id}`);
                }}
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
                onEnter={() => {
                  seeMention(stream.id, stream.mentioned_seq);
                  navigate(`/stream/${stream.id}`);
                }}
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
                  onSeenMention={(seq) => seeMention(stream.id, seq)}
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
  const i18n = useI18n();
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
        {i18n.t("stream.badgeRunning")} <span className="tabular-nums">{i18n.number(running)}</span>
      </span>
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono ${text} ${
          queued ? "bg-machine/12 text-machine" : "bg-muted/60 text-muted-foreground/70"
        }`}
      >
        {i18n.t("stream.badgeQueued")} <span className="tabular-nums">{i18n.number(queued)}</span>
      </span>
    </>
  );
}

function PinButton({ pinned, onClick, dense }: { pinned: boolean; onClick: () => void; dense?: boolean }) {
  const i18n = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      title={pinned ? i18n.t("stream.unpinTitle") : i18n.t("stream.pinTitle")}
      className={`inline-flex h-7 items-center rounded-full px-2.5 font-medium transition-colors duration-200 ${
        dense ? "text-[11px]" : "text-xs"
      } ${
        pinned
          ? "bg-signal/10 text-signal hover:bg-signal/15"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      {pinned ? i18n.t("stream.pinnedLabel") : i18n.t("stream.pinLabel")}
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
  const i18n = useI18n();
  const announcement = stream.announcement.trim();
  const border = borderClass(state);
  return (
    <article
      title={stateTitle(i18n, state)}
      style={flashVars(flash)}
      className={`group ws-surface ws-surface-hover relative grid cursor-pointer gap-2.5 rounded-xl bg-card p-3.5 ${border}`}
    >
      {/* 整张卡片即入口：一层铺满的透明按钮接点击，分屏/展开等控件浮在它上面。 */}
      <button
        type="button"
        onClick={onEnter}
        aria-label={i18n.tf("stream.enterGroup", { name: stream.name })}
        className="absolute inset-0 z-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
      />
      <header className="flex items-start gap-2">
        {state ? <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${stateDot(state)} animate-pulse`} /> : null}
        <div className="min-w-0 flex-1 text-left">
          <h2 className="truncate text-[15px] font-semibold tracking-tight">{stream.name}</h2>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/80">
            {shortUuid(stream.id)} · {i18n.tf("stream.msgCount", { n: Math.max(0, stream.next_seq - 1) })} ·{" "}
            {i18n.tf("stream.agentCount", { n: stream.agent_count ?? 0 })}
          </p>
        </div>
        {stream.my_role ? <RoleBadge role={stream.my_role} /> : null}
      </header>
      <div className="flex flex-wrap items-center gap-1.5">
        <QueueBadges counters={counters} />
        <span className="ml-auto text-[11px] text-muted-foreground/70">{i18n.tf("stream.updatedAt", { time: timeAgo(i18n, stream.updated_at ?? stream.created_at) })}</span>
      </div>
      <p className="line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground">
        {announcement || i18n.t("stream.noAnnouncement")}
      </p>
      <footer className="flex items-center gap-0.5">
        <span className="relative z-10 flex items-center gap-0.5">
          <PinButton pinned={pinned} onClick={onPin} />
          <button
            type="button"
            onClick={onExpand}
            className="inline-flex h-7 items-center rounded-full px-2.5 text-xs text-muted-foreground transition-colors duration-200 hover:bg-muted/60 hover:text-foreground"
          >
            {i18n.t("common.expand")}
          </button>
        </span>
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
  const i18n = useI18n();
  const border = borderClass(state);
  return (
    <article
      title={stateTitle(i18n, state)}
      style={flashVars(flash)}
      className={`group ws-surface ws-surface-hover relative flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-card px-3.5 py-2.5 ${border}`}
    >
      <button
        type="button"
        onClick={onEnter}
        aria-label={i18n.tf("stream.enterGroup", { name: stream.name })}
        className="absolute inset-0 z-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
      />
      <div className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-2">
          {state ? <span aria-hidden className={`size-2 shrink-0 rounded-full ${stateDot(state)} animate-pulse`} /> : null}
          <span className="truncate text-sm font-medium">{stream.name}</span>
          {stream.my_role ? <RoleBadge role={stream.my_role} /> : null}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground/80">
          {shortUuid(stream.id)} · {i18n.tf("stream.msgCount", { n: Math.max(0, stream.next_seq - 1) })} ·{" "}
          {i18n.tf("stream.agentCount", { n: stream.agent_count ?? 0 })} ·{" "}
          {i18n.tf("stream.updatedAt", { time: timeAgo(i18n, stream.updated_at ?? stream.created_at) })}
        </span>
      </div>
      <QueueBadges counters={counters} dense />
      <span className="relative z-10 flex items-center gap-0.5">
        <PinButton pinned={pinned} onClick={onPin} dense />
        <button
          type="button"
          onClick={onExpand}
          className="inline-flex h-7 items-center rounded-full px-2.5 text-[11px] text-muted-foreground transition-colors duration-200 hover:bg-muted/60 hover:text-foreground"
        >
          {i18n.t("common.expand")}
        </button>
      </span>
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
  const i18n = useI18n();
  return (
    <div className="grid min-h-[220px] place-items-center rounded-xl border border-dashed border-border/70 bg-muted/10 p-4 lg:min-h-0">
      <div className="grid justify-items-center gap-2">
        <p className="text-xs text-muted-foreground">{i18n.t("stream.emptyPane")}</p>
        <NativeSelect
          size="sm"
          className="h-8 w-52 text-xs"
          value=""
          onChange={(event) => {
            if (event.target.value) onPick(event.target.value);
          }}
        >
          <NativeSelectOption value="">{i18n.t("stream.pickStream")}</NativeSelectOption>
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
  onSeenMention,
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
  onSeenMention: (seq: number | null | undefined) => void;
}) {
  const i18n = useI18n();
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
        if (aliveRef.current) setError(describeError(i18n, cause));
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

  // 这个群已经摊在这块面板上：里面的 @ 就当你看到了，黄心跳收掉；关掉面板后新来的 @ 还会亮。
  useEffect(() => {
    if (stream.mentioned_seq) onSeenMention(stream.mentioned_seq);
  }, [stream.mentioned_seq]);

  const everyoneName = i18n.t("composer.everyone");
  const names = useMemo(
    () => [...mentionablesOf(detail?.members ?? []).map((entry) => entry.name), everyoneName],
    [detail, everyoneName],
  );
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
  const border = borderClass(state);

  return (
    <section
      title={stateTitle(i18n, state)}
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
            title={i18n.t("stream.swapGroupTitle")}
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
          title={i18n.t("stream.fullscreenTitle")}
        >
          {i18n.t("stream.fullscreen")}
        </Button>
        <Button size="sm" variant="ghost" className="h-6 rounded-full px-2 text-[11px] text-muted-foreground" onClick={onRemove}>
          {i18n.t("stream.removeSlot")}
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
            <p className="py-8 text-center text-xs text-muted-foreground">{i18n.t("stream.quietPane")}</p>
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
  const i18n = useI18n();
  const quote = i18n.tp("stream.signatureQuote");
  if (message.sender_type === "system" || message.kind === "system") {
    return <p className="py-0.5 text-center text-[10px] leading-relaxed text-muted-foreground">{message.content}</p>;
  }
  const agent = message.sender_type === "agent";
  const mine = message.sender_id === me;
  return (
    <article className={cn("group flex items-start gap-2", mine && "flex-row-reverse")}>
      <PersonAvatar
        name={message.sender_name}
        kind={agent ? "agent" : "human"}
        color={color}
        avatar={avatar}
        className={dense ? "size-5 text-[10px]" : "size-6 text-[11px]"}
        href={agent ? `#/agents/${message.sender_id}` : undefined}
        busy={presence?.working}
      />
      <div className={cn("flex min-w-0 max-w-[85%] flex-col items-start gap-0.5", mine && "items-end")}>
        <header className={cn("flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 px-0.5", mine && "flex-row-reverse")}>
          <span className={`truncate font-medium ${dense ? "text-xs" : "text-sm"} ${agent ? "text-machine" : ""}`}>
            {message.sender_name}
          </span>
          {agent && presence?.signature ? (
            <span className="max-w-32 truncate text-[10px] text-muted-foreground">
              {quote[0]}
              {presence.signature}
              {quote[1]}
            </span>
          ) : null}
          {agent ? <span className="text-[10px] text-machine/70">{i18n.t("ui.kindAgentShort")}</span> : null}
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{clockOf(i18n, message.created_at)}</span>
        </header>
        {message.content || message.attachments?.length ? (
          <div
            className={cn(
              "whitespace-pre-wrap leading-relaxed",
              dense ? "rounded-xl px-2 py-1 text-xs" : "rounded-xl px-2.5 py-1.5 text-[13px]",
              mine ? "rounded-tr-sm bg-signal-soft" : "rounded-tl-sm border border-border/50 bg-card",
            )}
          >
            <MessageImages attachments={message.attachments} dense />
            {(() => {
              const renderer = messageRendererFor(message);
              return renderer
                ? renderer.render({ message, mentions: names })
                : <MentionText content={message.content} names={names} />;
            })()}
          </div>
        ) : null}
        {/* 监控位没有群文件抽屉可开，卡片只用来认出交付物，整块不可点。 */}
        <PresentedCards items={message.presented} dense />
        {message.mentions.some((entry) => entry.type === "all") ? (
          <span className="px-0.5 text-[10px] text-muted-foreground">@{i18n.t("chat.everyoneChip")}</span>
        ) : null}
        <DeliveryChips deliveries={message.deliveries} dense />
        {message.error ? <p className="px-0.5 text-[11px] text-destructive">{i18n.tf("stream.receiptError", { error: message.error })}</p> : null}
      </div>
    </article>
  );
}
