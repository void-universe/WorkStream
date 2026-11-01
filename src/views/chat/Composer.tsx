// 群聊输入框：@ 自动补全、待发送提及、Ctrl/⌘+Enter 发送。完整群聊和分屏面板共用。
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { describeError, post } from "../../api";
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

export type SendResult = {
  message: Message;
  queued: { agent_id: string }[];
  notified: unknown[];
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
  const [pending, setPending] = useState<Mentionable[]>([]);
  const [sending, setSending] = useState(false);
  const [caret, setCaret] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const mentionables = useMemo(() => mentionablesOf(members), [members]);
  const presenceOf = useMemo(
    () => new Map((presence ?? []).map((entry) => [entry.agent_id, entry])),
    [presence],
  );

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
    setPending((current) => (current.some((m) => m.id === entry.id) ? current : [...current, entry]));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(before.length, before.length);
    });
  }

  async function send() {
    const content = draft.trim();
    if (!content) return;
    const mentions = pending
      .filter((entry) => content.includes(`@${entry.name}`))
      .map(({ type, id }) => ({ type, id }));
    setSending(true);
    try {
      const result = await post<{ ok: true } & SendResult>("messages.send", { stream_id: streamId, content, mentions });
      setDraft("");
      setPending([]);
      if (result.queued.length) toast.success(`已投进 ${result.queued.length} 位虚拟员工的邮箱，按时间片推进`);
      else if (result.notified.length) toast.success(`已通知 ${result.notified.length} 位真人`);
      onSent(result);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid gap-2">
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
          {pending.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {pending.map((entry) => (
                <PendingBadge key={`${entry.type}:${entry.id}`} entry={entry} onRemove={() => setPending((current) => current.filter((m) => m.id !== entry.id))} />
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-1.5">
            <Textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                rememberCaret();
              }}
              onClick={rememberCaret}
              onKeyUp={rememberCaret}
              placeholder="说点什么，@ 派活"
              style={{ minHeight: 34 }}
              className="resize-none text-xs"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send();
              }}
            />
            <Button size="sm" className="h-8 shrink-0 px-2 text-xs" onClick={() => void send()} disabled={sending || !draft.trim()}>
              {sending ? "发送中…" : "发送"}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Textarea
            ref={textareaRef}
            rows={3}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              rememberCaret();
            }}
            onClick={rememberCaret}
            onKeyUp={rememberCaret}
            placeholder="说点什么；输入 @ 挑一个群里的真人或虚拟员工——@ 虚拟员工就是往 ta 的邮箱派活"
            className="resize-none text-sm"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send();
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {pending.map((entry) => (
                <PendingBadge key={`${entry.type}:${entry.id}`} entry={entry} onRemove={() => setPending((current) => current.filter((m) => m.id !== entry.id))} />
              ))}
            </div>
            <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">Ctrl/⌘ + Enter 发送</span>
            <Button size="sm" onClick={() => void send()} disabled={sending || !draft.trim()}>
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
