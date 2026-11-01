// 群聊主视图：时间线 + @ 派发输入框 + 右侧操作面板。
// 站点 Function 不能常驻后台，所以时间片推进由这里的轮询驱动（标签页切到后台时自动停）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeError, get, type Agent } from "../../api";
import type { AgentPresence, Message, StreamDetail, User, Vm } from "../../types";
import { clockOf, shortUuid, timeAgo } from "../../lib/format";
import { CopyButton, DeliveryChips, MentionText, PersonAvatar } from "../../lib/ui";
import { Composer, mentionablesOf, type SendResult } from "./Composer";
import { AnnouncementSection, FilesSection, McpPanel, MembersPanel, SettingsPanel, VmsPanel } from "./Panels";

type TickResult = {
  ok: true;
  ran: { mail_id: string; agent_id: string; stream_id: string; status?: string; error?: string }[];
  queued: number;
  budget?: number;
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

const PAGE = 60;

/** 消息序号不变时，@ 派发的读/处理状态也可能变化；用它决定是否替换列表。 */
function messageKey(items: Message[]) {
  return items
    .map((item) => `${item.id}:${item.seq}:${(item.deliveries ?? []).map((row) => `${row.agent_id}=${row.status}`).join(",")}`)
    .join("|");
}

export function ChatView({
  streamId,
  user,
  myAgents,
  myVms,
}: {
  streamId: string;
  user: User;
  myAgents: Agent[];
  myVms: Vm[];
}) {
  const [detail, setDetail] = useState<StreamDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [presence, setPresence] = useState<AgentPresence[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [queue, setQueue] = useState({ queued: 0, running: 0 });
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef(0);
  const messageKeyRef = useRef("");
  const sinceRef = useRef(0);
  const stickRef = useRef(true);
  const tickRef = useRef(false);

  const loadDetail = useCallback(async () => {
    try {
      setDetail(await get<StreamDetail>("streams.get", { id: streamId }));
      setLoadError("");
    } catch (error) {
      setLoadError(describeError(error));
    }
  }, [streamId]);

  const loadLatest = useCallback(async () => {
    try {
      const result = await get<MessagesResult>("messages.list", { stream_id: streamId, limit: PAGE });
      setMessages(result.items);
      setPresence(result.presence ?? []);
      setHasMore(result.has_more);
      lastSeqRef.current = result.items[result.items.length - 1]?.seq ?? 0;
      messageKeyRef.current = messageKey(result.items);
    } catch (error) {
      setLoadError(describeError(error));
    }
  }, [streamId]);

  // 一次 tick 可能被慢上游拖住十几秒；同一时刻只允许一个在跑，别堆叠。
  const runTick = useCallback(async () => {
    if (tickRef.current) return null;
    tickRef.current = true;
    try {
      const tick = await get<TickResult>("scheduler.tick", { since: sinceRef.current });
      sinceRef.current = tick.since;
      return tick;
    } catch {
      return null;
    } finally {
      tickRef.current = false;
    }
  }, []);

  const applyLatest = useCallback((result: MessagesResult) => {
    setPresence(result.presence ?? []);
    setHasMore(result.has_more);
    const nextKey = messageKey(result.items);
    if (nextKey === messageKeyRef.current) return false;
    setMessages(result.items);
    lastSeqRef.current = result.items[result.items.length - 1]?.seq ?? 0;
    messageKeyRef.current = nextKey;
    return true;
  }, []);

  useEffect(() => {
    setDetail(null);
    setMessages([]);
    setPresence([]);
    lastSeqRef.current = 0;
    messageKeyRef.current = "";
    void loadDetail();
    void loadLatest();
  }, [loadDetail, loadLatest]);

  // 每 5 秒：先把时间片丢出去（不阻塞下面的读），再读队列看板与最新消息。
  // tick 跑完后再补一次读，让“处理中 → 已读”尽快落到界面。
  useEffect(() => {
    let stopped = false;
    const timer = window.setInterval(async () => {
      if (stopped || document.hidden) return;
      const tickPromise = runTick();
      try {
        const [board, latest] = await Promise.all([
          get<BoardResult>("scheduler.board"),
          get<MessagesResult>("messages.list", { stream_id: streamId, limit: PAGE }),
        ]);
        if (stopped) return;
        const counters = board.boards
          .flatMap((entry) => entry.streams)
          .filter((row) => row.stream_id === streamId)
          .reduce(
            (sum, row) => ({ queued: sum.queued + row.queued, running: sum.running + row.running }),
            { queued: 0, running: 0 },
          );
        setQueue(counters);
        const changed = applyLatest(latest);
        const tick = await tickPromise;
        if (stopped || !tick) return;
        const seqChanged = changed && tick.ran.some((item) => item.stream_id === streamId);
        if (seqChanged) void loadDetail();
        const after = await get<MessagesResult>("messages.list", { stream_id: streamId, limit: PAGE });
        if (stopped) return;
        applyLatest(after);
        setQueue((current) => ({ ...current, queued: tick.queued }));
      } catch {
        /* 轮询失败下一轮再试，不打扰用户 */
      }
    }, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [streamId, loadDetail, runTick, applyLatest]);

  // 首屏直接落在最新消息；之后新消息贴底，用户往上翻看历史时不打断。
  useEffect(() => {
    const node = scrollerRef.current;
    if (!node || !messages.length) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 160;
    if (nearBottom || stickRef.current) {
      stickRef.current = false;
      requestAnimationFrame(() => {
        node.scrollTop = node.scrollHeight;
      });
    }
  }, [messages]);

  const mentionables = useMemo(() => mentionablesOf(detail?.members ?? []), [detail]);
  const names = useMemo(() => mentionables.map((entry) => entry.name), [mentionables]);
  const presenceMap = useMemo(
    () => new Map(presence.map((entry) => [entry.agent_id, entry])),
    [presence],
  );
  // 消息只存发送者名字，头像按成员目录补；成员改了头像，下次打开群就跟着变。
  const avatarMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of detail?.members ?? []) {
      if (member.type === "human" && member.id && member.avatar) map.set(member.id, member.avatar);
      if (member.type === "agent" && member.agent?.id && member.agent.avatar) map.set(member.agent.id, member.agent.avatar);
    }
    return map;
  }, [detail]);

  async function afterSent(result: SendResult) {
    setMessages((current) => [...current, result.message]);
    lastSeqRef.current = result.message.seq;
    messageKeyRef.current = messageKey([...messages, result.message]);
    const tick = await runTick();
    if (tick) setQueue((current) => ({ ...current, queued: tick.queued }));
  }

  async function loadEarlier() {
    const oldest = messages[0]?.seq;
    if (!oldest) return;
    try {
      const result = await get<MessagesResult>("messages.list", { stream_id: streamId, before_seq: oldest, limit: PAGE });
      const node = scrollerRef.current;
      const previousHeight = node?.scrollHeight ?? 0;
      setMessages((current) => [...result.items, ...current]);
      setHasMore(result.has_more);
      requestAnimationFrame(() => {
        if (node) node.scrollTop = node.scrollHeight - previousHeight;
      });
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  if (loadError && !detail) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button variant="outline" className="justify-self-center" onClick={() => void loadDetail()}>
            重试
          </Button>
        </div>
      </div>
    );
  }

  if (!detail) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">正在打开群…</div>;
  }

  const announcement = detail.stream.announcement.trim();
  const reload = loadDetail;
  const agentColors = new Map<string, string>();
  for (const agent of myAgents) if (agent.color) agentColors.set(agent.id, agent.color);
  for (const member of detail.members) {
    if (member.type === "agent" && member.agent?.id && member.agent.color) agentColors.set(member.agent.id, member.agent.color);
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="flex min-h-0 flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
          <h1 className="text-base font-semibold tracking-tight">{detail.stream.name}</h1>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{shortUuid(detail.stream.id)}</code>
          <CopyButton value={detail.stream.id} label="UUID" />
          <span className="text-xs text-muted-foreground">
            {detail.members.filter((m) => m.type === "human").length} 真人 · {detail.members.filter((m) => m.type === "agent").length} 虚拟
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Badge variant={queue.running ? "default" : "outline"} className="rounded-sm font-mono text-[11px]">
              运行 {queue.running}
            </Badge>
            <Badge variant="secondary" className="rounded-sm font-mono text-[11px]">
              排队 {queue.queued}
            </Badge>
          </span>
        </header>

        {announcement ? (
          <div className="flex items-start gap-2 border-b bg-machine-soft px-4 py-2.5 text-machine lg:hidden">
            <span className="mt-0.5 shrink-0 text-[11px] font-semibold tracking-wide uppercase">公告</span>
            <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs leading-relaxed">{announcement}</p>
            <span className="shrink-0 font-mono text-[11px] opacity-70">{timeAgo(detail.stream.announcement_at)}</span>
          </div>
        ) : null}

        <div
          ref={scrollerRef}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4 scrollbar-thin"
          style={{ overflowAnchor: "none" }}
        >
          <div className="grid gap-3">
            {hasMore ? (
              <Button size="sm" variant="ghost" className="justify-self-center text-xs" onClick={() => void loadEarlier()}>
                加载更早的消息
              </Button>
            ) : null}
            {messages.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">群里还很安静，@ 一位虚拟员工开个头。</p>
            ) : null}
            {messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                names={names}
                me={user.id}
                color={agentColors.get(message.sender_id)}
                avatar={
                  presenceMap.get(message.sender_id)?.avatar ??
                  avatarMap.get(message.sender_id) ??
                  (message.sender_id === user.id ? user.avatar : null)
                }
                presence={message.sender_type === "agent" ? presenceMap.get(message.sender_id) : undefined}
              />
            ))}
          </div>
        </div>

        <footer className="border-t px-4 py-3">
          <Composer streamId={streamId} members={detail.members} presence={presence} onSent={(result) => void afterSent(result)} />
        </footer>
      </section>

      <aside className="min-h-0 overflow-y-auto border-t bg-sidebar p-3 scrollbar-thin lg:border-l lg:border-t-0">
        <div className="grid gap-2.5">
          <AnnouncementSection detail={detail} myAgents={myAgents} myVms={myVms} reload={reload} />
          <FilesSection detail={detail} myAgents={myAgents} myVms={myVms} reload={reload} />
        </div>
        <Tabs defaultValue="members" className="mt-3">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="members" className="text-xs">成员</TabsTrigger>
            <TabsTrigger value="vms" className="text-xs">虚拟机</TabsTrigger>
            <TabsTrigger value="mcp" className="text-xs">MCP</TabsTrigger>
            <TabsTrigger value="settings" className="text-xs">设置</TabsTrigger>
          </TabsList>
          {([
            ["members", <MembersPanel key="m" detail={detail} myAgents={myAgents} myVms={myVms} reload={reload} presence={presence} />],
            ["vms", <VmsPanel key="v" detail={detail} myAgents={myAgents} myVms={myVms} reload={reload} />],
            ["mcp", <McpPanel key="p" detail={detail} myAgents={myAgents} myVms={myVms} reload={reload} />],
            ["settings", <SettingsPanel key="s" detail={detail} myAgents={myAgents} myVms={myVms} reload={reload} />],
          ] as const).map(([value, node]) => (
            <TabsContent key={value} value={value} className="mt-0 p-0 pt-3">
              {node}
            </TabsContent>
          ))}
        </Tabs>
      </aside>
    </div>
  );
}

function MessageRow({
  message,
  names,
  me,
  color,
  avatar,
  presence,
}: {
  message: Message;
  names: string[];
  me: string;
  color?: string;
  avatar?: string | null;
  presence?: AgentPresence;
}) {
  if (message.sender_type === "system" || message.kind === "system") {
    return (
      <p className="mx-auto max-w-lg rounded-md bg-muted/60 px-3 py-1.5 text-center text-xs leading-relaxed text-muted-foreground">
        {message.content}
      </p>
    );
  }
  const agent = message.sender_type === "agent";
  return (
    <article className="flex items-start gap-2.5">
      <PersonAvatar
        name={message.sender_name}
        kind={agent ? "agent" : "human"}
        color={color}
        avatar={avatar}
        href={agent ? `#/agents/${message.sender_id}` : undefined}
        busy={presence?.working}
      />
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={agent ? "text-sm font-medium text-machine" : "text-sm font-medium"}>{message.sender_name}</span>
          {agent && presence?.signature ? (
            <span className="max-w-48 truncate text-[11px] text-muted-foreground">「{presence.signature}」</span>
          ) : null}
          {agent ? (
            <Badge variant="outline" className="rounded-sm font-mono text-[10px] text-machine">
              虚拟员工
            </Badge>
          ) : null}
          <span className="font-mono text-[11px] text-muted-foreground">#{message.seq}</span>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">{clockOf(message.created_at)}</span>
          {message.sender_id === me ? <span className="text-[11px] text-muted-foreground">我</span> : null}
        </header>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
          <MentionText content={message.content} names={names} />
        </p>
        <DeliveryChips deliveries={message.deliveries} />
        {message.error ? <p className="mt-1 text-xs text-destructive">这条的回执出错：{message.error}</p> : null}
      </div>
    </article>
  );
}
