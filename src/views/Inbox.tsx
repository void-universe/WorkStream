// 虚拟邮箱：@ 通知、验证信、邀请都落在这里；接上 SMTP 中继后同一封信也会发真实邮箱。
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { describeError, get, post, type User } from "../api";
import type { InboxItem, Request } from "../types";
import { timeAgo } from "../lib/format";
import { Notice, SectionTitle } from "../lib/ui";
import { useI18n } from "../lib/i18n";

type InboxResult = { ok: true; items: InboxItem[]; smtp_relay: { configured: boolean; mode: string; note?: string } };
type InvitesResult = { ok: true; items: (Request & { stream_name: string })[] };

export function InboxView({ user, onUserChanged }: { user: User; onUserChanged: (user: User) => void }) {
  const i18n = useI18n();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [invites, setInvites] = useState<(Request & { stream_name: string })[]>([]);
  const [smtp, setSmtp] = useState(false);  const [openId, setOpenId] = useState("");
  const [channel, setChannel] = useState(user.at_channel);

  const refresh = useCallback(async () => {
    try {
      const [inbox, mine] = await Promise.all([get<InboxResult>("inbox.list", { limit: 60 }), get<InvitesResult>("streams.invites.mine")]);
      setItems(inbox.items);
      setSmtp(inbox.smtp_relay.configured);
      setInvites(mine.items);
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => setChannel(user.at_channel), [user.at_channel]);

  async function markRead(item: InboxItem) {
    setOpenId((current) => (current === item.id ? "" : item.id));
    if (item.read_at) return;
    try {
      await post("inbox.read", { id: item.id });
      await refresh();
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  async function saveChannel(next: "virtual" | "real_email") {
    try {
      const result = await post<{ ok: true; user: User }>("auth.patch", { at_channel: next });
      onUserChanged(result.user);
      setChannel(next);
      toast.success(next === "real_email" ? i18n.t("inbox.toastRealChannel") : i18n.t("inbox.toastVirtualChannel"));
    } catch (error) {
      toast.error(describeError(i18n, error));
      setChannel(user.at_channel);
    }
  }

  async function decide(request: Request, approve: boolean) {
    try {
      const action = approve ? "streams.invites.accept" : "streams.invites.decline";
      await post(action, { request_id: request.id });
      toast.success(approve ? i18n.tf("inbox.joined", { name: (request as { stream_name?: string }).stream_name ?? i18n.t("inbox.fallbackStream") }) : i18n.t("inbox.declined"));
      await refresh();
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  const unread = items.filter((item) => !item.read_at).length;

  return (
    <div className="mx-auto grid h-full w-full max-w-4xl min-h-0 gap-4 overflow-y-auto p-4 scrollbar-thin md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold tracking-tight">{i18n.t("nav.inbox")}</h1>
          <p className="text-sm text-muted-foreground">
            {i18n.tf("inbox.summary", { total: items.length, unread })} ·{" "}
            {smtp ? i18n.t("inbox.smtpOn") : i18n.t("inbox.smtpOff")}
          </p>
        </div>
        <Button size="sm" variant="outline" className="text-xs" onClick={() => void refresh()}>
          {i18n.t("common.refresh")}
        </Button>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{i18n.t("inbox.channelTitle")}</CardTitle>
          <CardDescription className="text-xs">{i18n.tf("inbox.channelHint", { env: "WORKSTREAM_SMTP_URL" })}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Switch
            checked={channel === "real_email"}
            onCheckedChange={(checked) => void saveChannel(checked ? "real_email" : "virtual")}
          />
          <NativeSelect className="h-8 w-44 text-xs" value={channel} onChange={(event) => void saveChannel(event.target.value as "virtual" | "real_email")}>
            <NativeSelectOption value="virtual">{i18n.t("inbox.channelVirtual")}</NativeSelectOption>
            <NativeSelectOption value="real_email">{i18n.t("inbox.channelReal")}</NativeSelectOption>
          </NativeSelect>
          <span className="text-xs text-muted-foreground">
            {user.email} · {user.email_verified ? i18n.t("inbox.verified") : i18n.t("inbox.unverified")}
          </span>
          {!user.email_verified ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-xs"
              onClick={() => {
                void (async () => {
                  try {
                    const result = await post<{ ok: true; verify_link: string }>("auth.resend", {});
                    toast.success(i18n.tf("inbox.verifyLink", { link: result.verify_link }));
                  } catch (error) {
                    toast.error(describeError(i18n, error));
                  }
                })();
              }}
            >
              {i18n.t("inbox.resend")}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {invites.length ? (
        <section className="grid gap-2">
          <SectionTitle>{i18n.t("inbox.invitesTitle")}</SectionTitle>
          {invites.map((request) => (
            <div key={request.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{request.stream_name}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">{timeAgo(i18n, request.created_at)}</p>
              </div>
              <Button size="sm" className="text-xs" onClick={() => void decide(request, true)}>
                {i18n.t("inbox.accept")}
              </Button>
              <Button size="sm" variant="ghost" className="text-xs" onClick={() => void decide(request, false)}>
                {i18n.t("inbox.decline")}
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      <section className="grid gap-2">
        <SectionTitle>{i18n.t("inbox.mailboxTitle")}</SectionTitle>
        {items.length === 0 ? <Notice>{i18n.t("inbox.empty")}</Notice> : null}
        {items.map((item) => (
          <article key={item.id} className={`rounded-lg border ${item.read_at ? "" : "border-signal/50 bg-signal-soft/40"}`}>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left" onClick={() => void markRead(item)}>
              <Badge variant={item.kind === "mention" ? "default" : "secondary"} className="rounded-sm text-[11px]">
                {item.kind === "mention" ? i18n.t("inbox.kindMention") : item.kind === "invite" ? i18n.t("inbox.kindInvite") : i18n.t("inbox.kindVerify")}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-sm">{item.subject}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{item.channel === "real_email" ? i18n.t("inbox.channelReal") : i18n.t("inbox.channelInApp")}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(i18n, item.created_at)}</span>
            </button>
            {openId === item.id ? (
              <div className="grid gap-2 border-t px-3 py-3">
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{item.body}</p>
                {item.link ? (
                  <Button size="sm" variant="outline" className="justify-self-start text-xs" asChild>
                    <a href={item.link}>{i18n.t("inbox.openStream")}</a>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </article>
        ))}
      </section>
    </div>
  );
}
