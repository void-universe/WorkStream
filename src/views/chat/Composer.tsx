// 群聊输入框：@ 自动补全、待发送提及、贴图、Ctrl/⌘+Enter 发送。完整群聊和分屏面板共用。
import { useMemo, useRef, useState, type ClipboardEvent } from "react";
import { toast } from "sonner";
import { PaperclipIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { describeError, post } from "../../api";
import { shrinkImages, type PickedImage } from "../../lib/image";
import { PersonAvatar } from "../../lib/ui";
import type { AgentPresence, Member, Message } from "../../types";

export type Mentionable = { type: "human" | "agent"; id: string; name: string; color?: string; avatar?: string | null };

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
    return mentionables
      .filter((entry) => !needle || entry.name.toLowerCase().startsWith(needle))
      .slice(0, compact ? 4 : 6);
  }, [token, mentionables, compact]);

  function rememberCaret() {
    const element = textareaRef.current;
    if (element) setCaret(element.selectionStart);
  }

  function chooseSuggestion(entry: Mentionable) {
    const element = textareaRef.current;
    const position = element ? element.selectionStart : draft.length;
    const before = draft.slice(0, position).replace(/@([\p{L}\p{N}_-]{0,16})$/u, `@${entry.name} `);
    setDraft(before + draft.slice(position));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(before.length, before.length);
    });
  }

  function dropMention(entry: Mentionable) {
    setDraft((current) => current.replace(mentionRe(entry.name), "").replace(/ {2,}/g, " "));
  }

  async function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (!files.length) return;
    if (images.length >= 4) {
      toast.info("一条消息最多带 4 张图，先撤掉一张再加。");
      return;
    }
    setReading(true);
    try {
      const { images: picked } = await shrinkImages(files);
      if (!picked.length) {
        toast.info("只支持图片或 GIF（PNG / JPEG / WebP / GIF），其它文件请传到群文件。");
        return;
      }
      const room = 4 - images.length;
      if (picked.length > room) toast.info(`一条消息最多 4 张图，这次只带上前 ${room} 张。`);
      setImages((current) => [...current, ...picked.slice(0, room)]);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setReading(false);
    }
  }

  async function send() {
    const content = draft.trim();
    if (!content && !images.length) return;
    const mentions = mentioned.map(({ type, id }) => ({ type, id }));
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
        const names = steered.map((row) => nameOf.get(row.agent_id) ?? "虚拟员工").join("、");
        toast.success(`已插话给 ${names}：会停下正在写的半截，按这条重答`);
      } else if (result.queued.length) toast.success(`已投进 ${result.queued.length} 位虚拟员工的邮箱，按时间片推进`);
      else if (result.notified.length) toast.success(`已通知 ${result.notified.length} 位真人`);
      onSent(result);
    } catch (error) {
      toast.error(describeError(error));
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
        title="贴图片或选图片，一条消息最多 4 张"
        aria-label="贴图片或选图片"
        disabled={reading || images.length >= 4}
        onClick={() => fileRef.current?.click()}
      >
        <PaperclipIcon className="size-4" />
      </Button>
    </>
  );

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
            aria-label={`撤下 ${image.name}`}
            title="撤下这张图"
            className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-foreground text-[10px] leading-none text-background"
            onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </span>
      ))}
      {reading ? <span className="text-[11px] text-muted-foreground">压图中…</span> : null}
    </div>
  ) : null;

  const canSend = sending || reading || (!draft.trim() && !images.length);

  const chips = mentioned.map((entry) => (
    <PendingBadge key={`${entry.type}:${entry.id}`} entry={entry} onRemove={() => dropMention(entry)} />
  ));

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
                <PersonAvatar
                  name={entry.name}
                  kind={entry.type}
                  color={entry.color}
                  avatar={entry.avatar}
                  className="size-5 text-[10px]"
                  href={entry.type === "agent" ? `#/agents/${entry.id}` : undefined}
                  busy={entry.type === "agent" ? presenceOf.get(entry.id)?.working : false}
                />
                {entry.name}
                <span className="text-muted-foreground">{entry.type === "agent" ? "虚拟" : "真人"}</span>
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
              placeholder="说点什么，@ 派活"
              style={{ minHeight: 34 }}
              className="resize-none text-xs"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send();
              }}
            />
            <Button size="sm" className="h-8 shrink-0 px-2 text-xs" onClick={() => void send()} disabled={canSend}>
              {sending ? "发送中…" : "发送"}
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
            placeholder="说点什么；输入 @ 挑一个群里的真人或虚拟员工——@ 虚拟员工就是往 ta 的邮箱派活，也可以直接 Ctrl+V 贴图"
            className="resize-none text-sm"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send();
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            {attach}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{chips}</div>
            <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">Ctrl/⌘ + Enter 发送</span>
            <Button size="sm" onClick={() => void send()} disabled={canSend}>
              {sending ? "发送中…" : "发送"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function PendingBadge({ entry, onRemove }: { entry: Mentionable; onRemove: () => void }) {
  return (
    <Badge variant={entry.type === "agent" ? "secondary" : "outline"} className="rounded-sm font-normal">
      @{entry.name}
      <button type="button" className="ml-1 text-muted-foreground" onClick={onRemove}>
        ×
      </button>
    </Badge>
  );
}

/** 我的员工正在这个群里吐字时给一条短横幅：@ ta 就是插话，或者直接把这条活叫停。 */
function InterruptBar({ streamId, entries }: { streamId: string; entries: AgentPresence[] }) {
  const [stopping, setStopping] = useState<string | null>(null);

  async function stop(entry: AgentPresence) {
    setStopping(entry.agent_id);
    try {
      await post("scheduler.interrupt", { stream_id: streamId, agent_id: entry.agent_id });
      toast.success(`已叫停 ${entry.name}：这条任务作废，半截回复不会发出来。`);
    } catch (error) {
      toast.error(describeError(error));
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
            <span className="text-foreground">{entry.name}</span> 正在写回复 · 再 @ ta 一次就是插话
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-[11px]"
            disabled={stopping === entry.agent_id}
            onClick={() => void stop(entry)}
          >
            {stopping === entry.agent_id ? "叫停中…" : "叫停"}
          </Button>
        </li>
      ))}
    </ul>
  );
}
