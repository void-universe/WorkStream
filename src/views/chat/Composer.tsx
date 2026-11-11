// 群聊输入框：@ 自动补全、待发送提及、贴图、Ctrl/⌘+Enter 发送。完整群聊和分屏面板共用。
import { useMemo, useRef, useState, type ClipboardEvent } from "react";
import { toast } from "sonner";
import { AtSign, PaperclipIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { describeError, post } from "../../api";
import { shrinkImages, type PickedImage } from "../../lib/image";
import { useI18n } from "../../lib/i18n";
import { PersonAvatar } from "../../lib/ui";
import type { AgentPresence, Member, Message } from "../../types";

export type Mentionable = { type: "human" | "agent"; id: string; name: string; color?: string; avatar?: string | null };
/** 补全列表与待发送 chip 共用的一种形状；@所有人 没有 id，收件人在服务端发送时展开。 */
export type MentionRow = Mentionable | { type: "all"; id: "all"; name: string };

export function mentionablesOf(members: Member[]): Mentionable[] {
  return members
    .map((member) =>
      member.type === "human"
        ? { type: "human" as const, id: member.id ?? "", name: member.display_name ?? "", avatar: member.avatar }
        : {
            type: "agent" as const,
            id: member.agent?.id ?? "",
            name: member.agent?.name ?? "",
            color: member.agent?.color,
            avatar: member.agent?.avatar,
          },
    )
    .filter((entry) => entry.id && entry.name);
}

const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @ 后面必须断词才算提及，否则打 @小 会把 @小审 一起认下来。 */
const mentionRe = (name: string) => new RegExp(`@${escapeName(name)}(?=$|[\\s\\p{P}])`, "u");

export type SendResult = {
  message: Message;
  queued: { agent_id: string }[];
  notified: unknown[];
  interrupted?: { agent_id: string }[];
};

export function Composer({
  streamId,
  members,
  presence,
  compact = false,
  onSent,
}: {
  streamId: string;
  members: Member[];
  presence?: AgentPresence[];
  compact?: boolean;
  onSent: (result: SendResult) => void;
}) {
  const i18n = useI18n();
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PickedImage[]>([]);
  const [sending, setSending] = useState(false);
  const [reading, setReading] = useState(false);
  const [caret, setCaret] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const mentionables = useMemo(() => mentionablesOf(members), [members]);
  const presenceOf = useMemo(
    () => new Map((presence ?? []).map((entry) => [entry.agent_id, entry])),
    [presence],
  );
  const nameOf = useMemo(() => new Map(mentionables.map((entry) => [entry.id, entry.name])), [mentionables]);
  // 正在跑任务、且是我雇的员工——只有主人能叫停或插话 ta 手上这条活。
  const steerable = useMemo(
    () => (presence ?? []).filter((entry) => entry.working && entry.owned_by_caller),
    [presence],
  );
  // @所有人 也是打出来的：认正文，不要求先点按钮；只有群里有员工时才摆出来，空群广播没有收件人。
  const everyone: MentionRow = { type: "all", id: "all", name: i18n.t("composer.everyone") };
  const canBroadcast = useMemo(() => mentionables.some((entry) => entry.type === "agent"), [mentionables]);
  const broadcastOn = mentionRe(everyone.name).test(draft);
  // @ 是打出来的，不要求必须先点过补全按钮：直接从正文里认人。
  const mentioned = useMemo(() => mentionables.filter((entry) => mentionRe(entry.name).test(draft)), [mentionables, draft]);

  const token = useMemo(() => {
    const before = draft.slice(0, caret);
    const match = /(?:^|\s)@([\p{L}\p{N}_-]{0,16})$/u.exec(before);
    return match?.[1] ?? null;
  }, [draft, caret]);

  const suggestions = useMemo(() => {
    if (token === null) return [];
    const needle = token.toLowerCase();
    const crew: MentionRow[] = mentionables
      .filter((entry) => !needle || entry.name.toLowerCase().startsWith(needle));
    const everyoneMatches = canBroadcast && (!needle || everyone.name.toLowerCase().startsWith(needle));
    return [...(everyoneMatches ? [everyone] : []), ...crew].slice(0, compact ? 4 : 6);
  }, [token, mentionables, compact, canBroadcast, everyone.name]);

  function rememberCaret() {
    const element = textareaRef.current;
    if (element) setCaret(element.selectionStart);
  }

  function chooseSuggestion(entry: MentionRow) {
    const element = textareaRef.current;
    const position = element ? element.selectionStart : draft.length;
    const before = draft.slice(0, position).replace(/@([\p{L}\p{N}_-]{0,16})$/u, `@${entry.name} `);
    setDraft(before + draft.slice(position));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(before.length, before.length);
    });
  }

  function dropMention(entry: MentionRow) {
    setDraft((current) => current.replace(mentionRe(entry.name), "").replace(/ {2,}/g, " "));
  }

  /** 工具栏按钮跟"打 @ 再选人"走同一个落点：插入的仍是正文，发送时再从正文认一遍。 */
  function insertEveryone() {
    const element = textareaRef.current;
    const position = element ? element.selectionStart : draft.length;
    const token = `@${everyone.name} `;
    setDraft(draft.slice(0, position) + token + draft.slice(position));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(position + token.length, position + token.length);
    });
  }

  async function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (!files.length) return;
    if (images.length >= 4) {
      toast.info(i18n.t("composer.imageLimitReached"));
      return;
    }
    setReading(true);
    try {
      const { images: picked } = await shrinkImages(i18n, files);
      if (!picked.length) {
        toast.info(i18n.t("composer.imageTypesOnly"));
        return;
      }
      const room = 4 - images.length;
      if (picked.length > room) toast.info(i18n.tf("composer.imageLimitTrimmed", { n: room }));
      setImages((current) => [...current, ...picked.slice(0, room)]);
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setReading(false);
    }
  }

  async function send() {
    const content = draft.trim();
    if (!content && !images.length) return;
    const mentions = broadcastOn
      ? [{ type: "all" as const }]
      : mentioned.map(({ type, id }) => ({ type, id }));
    setSending(true);
    try {
      const result = await post<{ ok: true } & SendResult>("messages.send", {
        stream_id: streamId,
        content,
        mentions,
        attachments: images.map(({ name, content_type, data }) => ({ name, content_type, data })),
      });
      setDraft("");
      setImages([]);
      const steered = result.interrupted ?? [];
      if (steered.length) {
        const names = i18n.list(steered.map((row) => nameOf.get(row.agent_id) ?? i18n.t("ui.kindAgent")));
        toast.success(i18n.tf("composer.interrupted", { names }));
      } else if (result.queued.length) toast.success(i18n.tf("composer.queued", { n: result.queued.length }));
      else if (result.notified.length) toast.success(i18n.tf("composer.notified", { n: result.notified.length }));
      onSent(result);
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setSending(false);
    }
  }

  function pasteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  }

  const attach = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(event) => {
          void addFiles(event.target.files ?? []);
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={compact ? "size-8 shrink-0 p-0" : "size-9 shrink-0 p-0"}
        title={i18n.t("composer.attachTitle")}
        aria-label={i18n.t("composer.attachLabel")}
        disabled={reading || images.length >= 4}
        onClick={() => fileRef.current?.click()}
      >
        <PaperclipIcon className="size-4" />
      </Button>
    </>
  );

  // 这个按钮只往正文里写一句 @所有人；待发送 chip 和发送时的展开都从正文认，不另存一份状态。
  const broadcastButton = canBroadcast ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={compact ? "size-8 shrink-0 p-0" : "size-9 shrink-0 p-0"}
      title={i18n.t("composer.everyoneTitle")}
      aria-label={i18n.t("composer.everyoneLabel")}
      disabled={broadcastOn}
      onClick={insertEveryone}
    >
      <AtSign className="size-4" />
    </Button>
  ) : null;

  const tray = images.length ? (
    <div className="flex flex-wrap items-center gap-1.5">
      {images.map((image, index) => (
        <span key={`${image.name}:${index}`} className="relative">
          <img
            src={`data:${image.content_type};base64,${image.data}`}
            alt={image.name}
            className={compact ? "size-10 rounded-sm border object-cover" : "size-14 rounded-sm border object-cover"}
          />
          <button
            type="button"
            aria-label={i18n.tf("composer.removeImageLabel", { name: image.name })}
            title={i18n.t("composer.removeImageTitle")}
            className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-foreground text-[10px] leading-none text-background"
            onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </span>
      ))}
      {reading ? <span className="text-[11px] text-muted-foreground">{i18n.t("composer.compressing")}</span> : null}
    </div>
  ) : null;

  const canSend = sending || reading || (!draft.trim() && !images.length);

  const chips = [
    ...(broadcastOn ? [<PendingBadge key="all" entry={everyone} onRemove={() => dropMention(everyone)} />] : []),
    ...mentioned.map((entry) => (
      <PendingBadge key={`${entry.type}:${entry.id}`} entry={entry} onRemove={() => dropMention(entry)} />
    )),
  ];

  return (
    <div className="grid gap-2">
      {!compact && steerable.length ? <InterruptBar streamId={streamId} entries={steerable} /> : null}
      {suggestions.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {suggestions.map((entry) => (
            <li key={`${entry.type}:${entry.id}`}>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 px-2 text-xs"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseSuggestion(entry)}
              >
                {entry.type === "all" ? (
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                    <AtSign className="size-3" />
                  </span>
                ) : (
                  <PersonAvatar
                    name={entry.name}
                    kind={entry.type}
                    color={entry.color}
                    avatar={entry.avatar}
                    className="size-5 text-[10px]"
                    href={entry.type === "agent" ? `#/agents/${entry.id}` : undefined}
                    busy={entry.type === "agent" ? presenceOf.get(entry.id)?.working : false}
                  />
                )}
                @{entry.name}
                {entry.type === "all" ? null : (
                  <span className="text-muted-foreground">{entry.type === "agent" ? i18n.t("ui.kindAgentShort") : i18n.t("ui.kindHumanShort")}</span>
                )}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {compact ? (
        <div className="grid gap-1.5">
          {chips.length ? <div className="flex flex-wrap items-center gap-1.5">{chips}</div> : null}
          {tray}
          <div className="flex items-end gap-1.5">
            {broadcastButton}
            {attach}
            <Textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                rememberCaret();
              }}
              onPaste={pasteImages}
              onClick={rememberCaret}
              onKeyUp={rememberCaret}
              placeholder={i18n.t("composer.placeholderCompact")}
              style={{ minHeight: 34 }}
              className="resize-none text-xs"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send();
              }}
            />
            <Button size="sm" className="h-8 shrink-0 px-2 text-xs" onClick={() => void send()} disabled={canSend}>
              {sending ? i18n.t("composer.sending") : i18n.t("composer.send")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {tray}
          <Textarea
            ref={textareaRef}
            rows={3}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              rememberCaret();
            }}
            onPaste={pasteImages}
            onClick={rememberCaret}
            onKeyUp={rememberCaret}
            placeholder={i18n.t("composer.placeholder")}
            className="resize-none text-sm"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send();
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            {broadcastButton}
            {attach}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{chips}</div>
            <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{i18n.t("composer.hotkeyHint")}</span>
            <Button size="sm" onClick={() => void send()} disabled={canSend}>
              {sending ? i18n.t("composer.sending") : i18n.t("composer.send")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function PendingBadge({ entry, onRemove }: { entry: MentionRow; onRemove: () => void }) {
  return (
    <Badge
      variant={entry.type === "agent" ? "secondary" : entry.type === "all" ? "default" : "outline"}
      className="rounded-sm font-normal"
    >
      @{entry.name}
      <button type="button" className="ml-1 text-muted-foreground" onClick={onRemove}>
        ×
      </button>
    </Badge>
  );
}

/** 我的员工正在这个群里吐字时给一条短横幅：@ ta 就是插话，或者直接把这条活叫停。 */
function InterruptBar({ streamId, entries }: { streamId: string; entries: AgentPresence[] }) {
  const i18n = useI18n();
  const [stopping, setStopping] = useState<string | null>(null);
  // 员工名字要夹在句子里做成前景色元素，所以按 {0} 拆成前后两段。
  const writingParts = i18n.tp("composer.writingHint");

  async function stop(entry: AgentPresence) {
    setStopping(entry.agent_id);
    try {
      await post("scheduler.interrupt", { stream_id: streamId, agent_id: entry.agent_id });
      toast.success(i18n.tf("composer.interruptToast", { name: entry.name }));
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setStopping(null);
    }
  }

  return (
    <ul className="grid gap-1">
      {entries.map((entry) => (
        <li key={entry.agent_id} className="flex items-center gap-2 rounded-md bg-muted/70 px-2 py-1 text-xs">
          <PersonAvatar
            name={entry.name}
            kind="agent"
            color={entry.color}
            avatar={entry.avatar}
            className="size-5 shrink-0 text-[10px]"
            busy
          />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {writingParts[0]}
            <span className="text-foreground">{entry.name}</span>
            {writingParts[1]}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-[11px]"
            disabled={stopping === entry.agent_id}
            onClick={() => void stop(entry)}
          >
            {stopping === entry.agent_id ? i18n.t("composer.stopping") : i18n.t("composer.stop")}
          </Button>
        </li>
      ))}
    </ul>
  );
}
