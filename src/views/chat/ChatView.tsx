// 群聊主视图：时间线 + @ 派发输入框 + 右侧操作面板。
// 站点 Function 不能常驻后台，所以时间片推进由这里的轮询驱动（标签页切到后台时自动停）。
import { messageRendererFor } from "../../lib/messageRenderers";
import "../../lib/renderers/markdown-message";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderIcon, MegaphoneIcon, SettingsIcon, TerminalIcon, UsersIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeError, get, type Agent } from "../../api";
import type { AgentPresence, Message, Presented, StreamDetail, User, Vm } from "../../types";
import { cn } from "@/lib/utils";
import { shortUuid, timeAgo } from "../../lib/format";
import { markMentionSeen } from "../../lib/mentions";
import { CopyChip, DeliveryChips, MentionText, MessageImages, PersonAvatar, PresentedCards } from "../../lib/ui";
import { Composer, mentionablesOf, type SendResult } from "./Composer";
import { FilesSection, MembersPanel, SettingsPanel } from "./Panels";
import { TerminalPane } from "./TerminalPane";
import { useI18n, type MsgKey } from "../../lib/i18n";

type TickResult = {
  ok: true;
  ran: { mail_id: string; agent_id: string; stream_id: string; status?: string; error?: string }[];
  queued: number;
  budget?: number;
  since: number;
};

type MessagesResult = {
  ok: true;
  items: Message[];
  has_more: boolean;
  oldest_seq: number | null;
  presence?: AgentPresence[];
};

const PAGE = 60;

/** 右侧抽屉的三个页面；虚拟机、MCP 等低频项收进群设置的「高级设置」。 */
type DrawerTab = "members" | "files" | "settings";

const DRAWER_TABS: { value: DrawerTab; labelKey: MsgKey; titleKey: MsgKey }[] = [
  { value: "members", labelKey: "role.member", titleKey: "chat.membersTitle" },
  { value: "files", labelKey: "chat.filesTitle", titleKey: "chat.filesTitle" },
  { value: "settings", labelKey: "nav.settings", titleKey: "chat.settingsTitle" },
];

/** 相邻消息间隔超过这个毫秒数才插一条居中的时间分隔。 */
const TIME_GAP_MS = 5 * 60_000;

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
  const i18n = useI18n();
  const [detail, setDetail] = useState<StreamDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [presence, setPresence] = useState<AgentPresence[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef(0);
  const messageKeyRef = useRef("");
  const sinceRef = useRef(0);
  const stickRef = useRef(true);
  const tickRef = useRef(false);
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  // 点交付卡片时想直接看的那份文件：抽屉打开到「群文件」页后由 FilesSection 接着预览它。
  const [fileFocus, setFileFocus] = useState<Presented | null>(null);
  // 终端记住的是虚拟机 id 而不是那行数据：授权撤销或地址改完，下一次读群现场就要跟上，
  // 不能拿一份旧快照继续往已消失的网关里写字节。
  const [termId, setTermId] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    try {
      setDetail(await get<StreamDetail>("streams.get", { id: streamId }));
      setLoadError("");
    } catch (error) {
      setLoadError(describeError(i18n, error));
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
      setLoadError(describeError(i18n, error));
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

  // 每 5 秒：先把时间片丢出去（不阻塞下面的读），再读最新消息。
  // tick 跑完后再补一次读，让“处理中 → 已读”尽快落到界面。
  useEffect(() => {
    let stopped = false;
    const timer = window.setInterval(async () => {
      if (stopped || document.hidden) return;
      const tickPromise = runTick();
      try {
        const latest = await get<MessagesResult>("messages.list", { stream_id: streamId, limit: PAGE });
        if (stopped) return;
        const changed = applyLatest(latest);
        const tick = await tickPromise;
        if (stopped || !tick) return;
        const seqChanged = changed && tick.ran.some((item) => item.stream_id === streamId);
        if (seqChanged) void loadDetail();
        const after = await get<MessagesResult>("messages.list", { stream_id: streamId, limit: PAGE });
        if (stopped) return;
        applyLatest(after);
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

  // 直接打开某个群（深链或从面板点进来）也算看过：把本机水位推到窗口里最新的那条 @ 我。
  useEffect(() => {
    let newest = 0;
    for (const message of messages) {
      if (!(message.mentions ?? []).some((entry) => entry.type === "human" && entry.id === user.id)) continue;
      newest = Math.max(newest, Number(message.seq) || 0);
    }
    if (newest) markMentionSeen(streamId, newest);
  }, [messages, streamId, user.id]);

  const mentionables = useMemo(() => mentionablesOf(detail?.members ?? []), [detail]);
  // @所有人 的正文标记也要着色：它是正文里的 @，不是某个成员的名字。
  const everyoneName = i18n.t("composer.everyone");
  const names = useMemo(() => [...mentionables.map((entry) => entry.name), everyoneName], [mentionables, everyoneName]);
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
  // 替身代答的气泡要标出替的是谁：消息里只有 user id，名字按成员目录补。
  const humanNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of detail?.members ?? []) {
      if (member.type === "human" && member.id && member.display_name) map.set(member.id, member.display_name);
    }
    return map;
  }, [detail]);

  async function afterSent(result: SendResult) {
    setMessages((current) => [...current, result.message]);
    lastSeqRef.current = result.message.seq;
    messageKeyRef.current = messageKey([...messages, result.message]);
    await runTick();
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
      toast.error(describeError(i18n, error));
    }
  }

  if (loadError && !detail) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button variant="outline" className="justify-self-center" onClick={() => void loadDetail()}>
            {i18n.t("chat.retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (!detail) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">{i18n.t("chat.opening")}</div>;
  }

  const reload = loadDetail;
  // 只有填了网关地址的虚拟机才进得了终端：没地址的行点了只会拿到一句「连不上」，不如不让它点。
  const termVms = detail.vms.filter((vm) => vm.gateway_url);
  const termVm = termVms.find((vm) => vm.id === termId) ?? null;
  // 抽屉是盖在聊天区上的，和终端重叠；点开终端就把它收起来，别让两块面板叠着互相看不见。
  const openTerminal = (vmId: string) => {
    setTermId(vmId);
    setDrawer(null);
    setFileFocus(null);
  };
  // 交付卡片整块可点：点开直接看到群文件里那份原件，不用同事自己按名字去列表里翻。
  const openPresented = (item: Presented) => {
    setFileFocus(item);
    setDrawer("files");
  };
  const agentColors = new Map<string, string>();
  for (const agent of myAgents) if (agent.color) agentColors.set(agent.id, agent.color);
  for (const member of detail.members) {
    if (member.type === "agent" && member.agent?.id && member.agent.color) agentColors.set(member.agent.id, member.agent.color);
  }

  return (
    <div className={cn("relative grid h-full min-h-0 grid-cols-1", termVm && "lg:grid-cols-[minmax(0,1fr)_minmax(340px,54%)]")}>
      <section className="relative flex min-h-0 flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
          <h1 className="text-base font-semibold tracking-tight">{detail.stream.name}</h1>
          <CopyChip value={detail.stream.id} display={shortUuid(detail.stream.id)} title={i18n.t("chat.uuidCopyTitle")} />
          <span className="text-xs text-muted-foreground">{i18n.tf("chat.memberCount", { n: detail.members.length })}</span>
          <span className="ml-auto flex items-center gap-0.5">
            {detail.stream.announcement.trim() ? (
              <Button size="icon-sm" variant="ghost" title={i18n.t("chat.announcementTitle")} onClick={() => setDrawer("settings")}>
                <MegaphoneIcon className="size-4 text-machine" />
              </Button>
            ) : null}
            <Button size="icon-sm" variant="ghost" title={i18n.t("chat.membersTitle")} onClick={() => setDrawer("members")}>
              <UsersIcon className="size-4" />
            </Button>
            {termVms.length ? (
              <Button
                size="icon-sm"
                variant={termVm ? "secondary" : "ghost"}
                title={i18n.t("chat.terminalTitle")}
                onClick={() => {
                  setTermId(termVm ? null : termVms[0].id);
                  setDrawer(null);
                }}
              >
                <TerminalIcon className={cn("size-4", termVm && "text-machine")} />
              </Button>
            ) : null}
            <Button size="icon-sm" variant="ghost" title={i18n.t("chat.filesTitle")} onClick={() => setDrawer("files")}>
              <FolderIcon className="size-4" />
            </Button>
            <Button size="icon-sm" variant="ghost" title={i18n.t("chat.settingsTitle")} onClick={() => setDrawer("settings")}>
              <SettingsIcon className="size-4" />
            </Button>
          </span>
        </header>

        <div
          ref={scrollerRef}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4 scrollbar-thin"
          style={{ overflowAnchor: "none" }}
        >
          <div className="grid gap-4">
            {hasMore ? (
              <Button size="sm" variant="ghost" className="justify-self-center text-xs" onClick={() => void loadEarlier()}>
                {i18n.t("chat.loadEarlier")}
              </Button>
            ) : null}
            {messages.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">{i18n.t("chat.emptyHint")}</p>
            ) : null}
            {messages.map((message, index) => {
              const previous = messages[index - 1];
              const system = message.sender_type === "system" || message.kind === "system";
              const showTime =
                !system && (!previous || Date.parse(message.created_at) - Date.parse(previous.created_at) > TIME_GAP_MS);
              return (
                <Fragment key={message.id}>
                  {showTime ? (
                    <p className="text-center text-[11px] text-muted-foreground">{timeAgo(i18n, message.created_at)}</p>
                  ) : null}
                  <MessageRow
                    message={message}
                    names={names}
                    me={user.id}
                    humanNames={humanNames}
                    color={agentColors.get(message.sender_id)}
                    avatar={
                      presenceMap.get(message.sender_id)?.avatar ??
                      avatarMap.get(message.sender_id) ??
                      (message.sender_id === user.id ? user.avatar : null)
                    }
                    presence={message.sender_type === "agent" ? presenceMap.get(message.sender_id) : undefined}
                    onOpenFile={openPresented}
                  />
                </Fragment>
              );
            })}
          </div>
        </div>

        <footer className="border-t px-4 py-3">
          <Composer streamId={streamId} members={detail.members} presence={presence} onSent={(result) => void afterSent(result)} />
        </footer>

        {drawer ? (
          <aside className="absolute inset-y-0 right-0 z-30 flex w-[400px] max-w-[88%] flex-col border-l bg-background shadow-[-16px_0_28px_-24px_rgba(0,0,0,0.45)]">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
                {i18n.t(DRAWER_TABS.find((tab) => tab.value === drawer)!.titleKey)}
              </h2>
              <Button size="icon-xs" variant="ghost" title={i18n.t("common.close")} onClick={() => { setDrawer(null); setFileFocus(null); }}>
                <XIcon className="size-4" />
              </Button>
            </div>
            <Tabs
              value={drawer}
              onValueChange={(value) => {
                setDrawer(value as DrawerTab);
                // 换了标签页就不再是"从卡片跳过来"，别下一次点开群文件时冒出上次那份的预览。
                setFileFocus(null);
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabsList className="mx-3 mt-3 h-8 w-auto shrink-0 justify-start gap-0 self-start rounded-none bg-transparent p-0">
                {DRAWER_TABS.map((tab) => (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    className={cn(
                      "rounded-none border-b-2 border-transparent px-2 text-xs data-[state=active]:border-signal data-[state=active]:bg-transparent",
                    )}
                  >
                    {i18n.t(tab.labelKey)}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin">
                <TabsContent value="members" className="mt-0">
                  <MembersPanel detail={detail} myAgents={myAgents} myVms={myVms} reload={reload} presence={presence} />
                </TabsContent>
                <TabsContent value="files" className="mt-0">
                  <FilesSection detail={detail} myAgents={myAgents} myVms={myVms} reload={reload} focus={fileFocus} />
                </TabsContent>
                <TabsContent value="settings" className="mt-0">
                  <SettingsPanel detail={detail} myAgents={myAgents} myVms={myVms} reload={reload} onOpenTerminal={openTerminal} />
                </TabsContent>
              </div>
            </Tabs>
          </aside>
        ) : null}

      </section>

      {termVm ? (
        // 宽窗口是真分屏（左聊天右终端，输入框不被盖住，才能一边敲 dmesg 一边发消息）；
        // 窄容器里半栏终端没法用，改成整块盖住聊天，关掉就回到群——
        // 两种尺寸都不要求用户去猜现在在跟哪一层打交道。
        <aside className="absolute inset-0 z-20 min-h-0 lg:static lg:z-auto lg:min-w-[340px]">
          <TerminalPane vms={termVms} vmId={termVm.id} onPick={openTerminal} onClose={() => setTermId(null)} />
        </aside>
      ) : null}
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
  humanNames,
  onOpenFile,
}: {
  message: Message;
  names: string[];
  me: string;
  color?: string;
  avatar?: string | null;
  presence?: AgentPresence;
  humanNames: Map<string, string>;
  onOpenFile: (item: Presented) => void;
}) {
  const i18n = useI18n();
  if (message.sender_type === "system" || message.kind === "system") {
    return <p className="py-0.5 text-center text-[11px] leading-relaxed text-muted-foreground">{message.content}</p>;
  }
  const agent = message.sender_type === "agent";
  const mine = message.sender_id === me;
  return (
    <article className={cn("group flex items-start gap-2.5", mine && "flex-row-reverse")}>
      <PersonAvatar
        name={message.sender_name}
        kind={agent ? "agent" : "human"}
        color={color}
        avatar={avatar}
        href={agent ? `#/agents/${message.sender_id}` : undefined}
        busy={presence?.working}
      />
      <div className={cn("flex min-w-0 max-w-[81%] flex-col items-start gap-1", mine && "items-end")}>
        {mine ? null : (
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1">
            <span className={cn("text-xs font-medium", agent && "text-machine")}>{message.sender_name}</span>
            {agent ? (
              <Badge variant="outline" className="rounded-full px-1.5 py-0 font-mono text-[10px] font-normal text-machine">
                {i18n.t("ui.kindAgentShort")}
              </Badge>
            ) : null}
            {message.on_behalf_of ? (
              <Badge variant="outline" className="rounded-full border-signal/50 px-1.5 py-0 text-[10px] font-normal text-signal">
                {i18n.tf("chat.onBehalfBadge", { name: humanNames.get(message.on_behalf_of) ?? i18n.t("chat.formerMember") })}
              </Badge>
            ) : null}
            {agent && presence?.signature ? (
              <span className="max-w-40 truncate text-[11px] text-muted-foreground">{i18n.tf("chat.signatureQuote", { signature: presence.signature })}</span>
            ) : null}
          </header>
        )}
        {message.content || message.attachments?.length ? (
          <div
            className={cn(
              "rounded-[10px] px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
              mine ? "bg-signal-soft" : "border border-border/50 bg-card",
            )}
          >
            <MessageImages attachments={message.attachments} />
            {(() => {
              const renderer = messageRendererFor(message);
              return renderer
                ? renderer.render({ message, mentions: names })
                : <MentionText content={message.content} names={names} />;
            })()}
          </div>
        ) : null}
        {/* 只交了文件、正文空着的回合：气泡不渲染，交付卡片就是这条消息的全部内容。 */}
        <PresentedCards items={message.presented} onOpen={onOpenFile} />
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-1">
          {message.mentions.some((entry) => entry.type === "all") ? (
            <Badge variant="outline" className="rounded-full px-1.5 py-0 text-[10px] font-normal">
              @{i18n.t("chat.everyoneChip")}
            </Badge>
          ) : null}
          <DeliveryChips deliveries={message.deliveries} dense />
          <span className="font-mono text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-70">
            #{message.seq}
          </span>
        </div>
        {message.error ? <p className="px-1 text-xs text-destructive">{i18n.tf("chat.receiptError", { error: message.error })}</p> : null}
      </div>
    </article>
  );
}
