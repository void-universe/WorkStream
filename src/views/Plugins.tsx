// Market 的「插件」标签：接外部 MCP 服务。一条连接器 = 主人接的一个服务，
// 它 tools/list 出来的工具会并进主人名下所有虚拟员工的工具清单，调用照样落在轨迹里。
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { describeCode, describeError, get, post } from "../api";
import type { Plugin } from "../types";
import { timeAgo } from "../lib/format";
import { Field, Notice, TextInput } from "../lib/ui";
import { useI18n, type MsgKey } from "../lib/i18n";

const STATUS_LABEL: Record<string, MsgKey> = {
  ready: "plugin.statusReady",
  error: "plugin.statusError",
  untested: "plugin.statusUntested",
};

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

type Draft = { name: string; endpoint: string; token: string };
const EMPTY: Draft = { name: "", endpoint: "", token: "" };

export function PluginsPanel() {
  const i18n = useI18n();
  const [items, setItems] = useState<Plugin[]>([]);
  const [limit, setLimit] = useState(12);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState("");

  // 「它 tools/list 出来的工具」「可以在 DSH 插件目录里找」都要往句子里夹元素，
  // 按 {0} 拆成两截，中间自己塞 <span>/<a>。
  const introParts = i18n.tp("plugin.intro");
  const catalogParts = i18n.tp("plugin.tipCatalog");

  const load = useCallback(async () => {
    try {
      const result = await get<{ ok: true; items: Plugin[]; limit: number }>("plugins.list");
      setItems(result.items);
      setLimit(result.limit);
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!draft.name.trim() || !draft.endpoint.trim()) {
      toast.error(i18n.t("plugin.needNameEndpoint"));
      return;
    }
    setBusy("add");
    try {
      const result = await post<{ ok: true; plugin: Plugin; probe_error?: string | null }>("plugins.add", {
        name: draft.name.trim(),
        endpoint: draft.endpoint.trim(),
        token: draft.token.trim() || undefined,
      });
      setAddOpen(false);
      setDraft(EMPTY);
      if (result.probe_error) {
        toast.warning(i18n.tf("plugin.savedButUnreachable", { reason: describeCode(i18n, result.probe_error) }));
      } else {
        toast.success(i18n.tf("plugin.addedToast", { name: result.plugin.name }));
      }
      await load();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy("");
    }
  }

  async function probe(plugin: Plugin) {
    setBusy(plugin.id);
    try {
      const result = await post<{ ok: true; plugin: Plugin; tools: Plugin["tools"]; skipped: { name: string; reason: string }[] }>(
        "plugins.probe",
        { id: plugin.id },
      );
      // 整句两个键，而不是「主句 + 「，跳过 N 个」片段」拼接：日语把补语收进括号，语序对不齐中文。
      toast.success(
        result.skipped?.length
          ? i18n.tf("plugin.probeReadSkipped", { n: result.tools.length, skipped: result.skipped.length })
          : i18n.tf("plugin.probeRead", { n: result.tools.length }),
      );
      await load();
    } catch (error) {
      toast.error(describeError(i18n, error));
      await load();
    } finally {
      setBusy("");
    }
  }

  async function toggle(plugin: Plugin, enabled: boolean) {
    setBusy(plugin.id);
    try {
      await post<{ ok: true }>("plugins.update", { id: plugin.id, enabled });
      toast.success(enabled ? i18n.tf("plugin.enabledToast", { name: plugin.name }) : i18n.tf("plugin.disabledToast", { name: plugin.name }));
      await load();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy("");
    }
  }

  async function remove(plugin: Plugin) {
    if (!window.confirm(i18n.tf("plugin.removeConfirm", { name: plugin.name }))) return;
    setBusy(plugin.id);
    try {
      await post<{ ok: true }>("plugins.remove", { id: plugin.id });
      toast.success(i18n.t("common.deleted"));
      await load();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="max-w-[620px] text-xs leading-relaxed text-muted-foreground">
          {introParts[0]}
          <span className="font-mono">tools/list</span>
          {introParts[1]}
        </p>
        <Button
          size="sm"
          className="h-8 rounded-full text-xs"
          onClick={() => setAddOpen((current) => !current)}
        >
          {addOpen ? i18n.t("common.collapse") : i18n.t("plugin.addTitle")}
        </Button>
      </div>

      {addOpen ? (
        <section className="ws-surface grid gap-3 rounded-xl bg-card p-3.5">
          <div className="grid gap-3 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
            <Field label={i18n.t("plugin.nameLabel")}>
              <TextInput
                value={draft.name}
                maxLength={40}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder={i18n.t("plugin.namePlaceholder")}
                className="h-8 text-xs"
              />
            </Field>
            <Field label={i18n.t("plugin.endpointLabel")} hint={i18n.t("plugin.endpointHint")}>
              <TextInput
                value={draft.endpoint}
                maxLength={300}
                onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                placeholder="https://example.com/mcp"
                className="h-8 text-xs"
              />
            </Field>
            <Field label={i18n.t("plugin.tokenLabel")} hint={i18n.t("plugin.tokenHint")}>
              <TextInput
                value={draft.token}
                maxLength={400}
                onChange={(event) => setDraft({ ...draft, token: event.target.value })}
                placeholder={i18n.t("plugin.tokenPlaceholder")}
                className="h-8 text-xs"
                type="password"
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="h-8 rounded-full text-xs" disabled={busy === "add"} onClick={() => void add()}>
              {busy === "add" ? i18n.t("plugin.connecting") : i18n.t("plugin.addAndProbe")}
            </Button>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {i18n.tf("plugin.probeFailHint", { status: i18n.t("plugin.statusError") })}
            </p>
          </div>
        </section>
      ) : null}

      <div className="grid content-start gap-2 sm:grid-cols-2">
        {items.map((plugin) => (
          <article key={plugin.id} className="ws-surface flex min-w-0 flex-col gap-2 rounded-xl bg-card p-3.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <h2 className="min-w-0 truncate text-sm font-semibold">{plugin.name}</h2>
              <Badge
                variant="secondary"
                className={cn(
                  "rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal",
                  plugin.status === "ready" && "bg-signal/12 text-signal",
                  plugin.status === "error" && "bg-destructive/12 text-destructive",
                )}
              >
                {STATUS_LABEL[plugin.status] ? i18n.t(STATUS_LABEL[plugin.status]) : plugin.status}
              </Badge>
              <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                {plugin.enabled ? i18n.t("plugin.enabledBadge") : i18n.t("plugin.disabledBadge")}
              </Badge>
              {plugin.auth_tail ? (
                <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                  {i18n.tf("plugin.tokenBadge", { tail: plugin.auth_tail })}
                </Badge>
              ) : null}
            </div>
            <p className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground" title={plugin.endpoint}>
              {hostOf(plugin.endpoint)}
            </p>
            {plugin.status === "error" && plugin.last_error ? (
              <p className="text-[11px] leading-relaxed text-destructive">{describeCode(i18n, plugin.last_error)}</p>
            ) : null}
            {plugin.tools.length ? (
              <div className="flex min-w-0 flex-wrap gap-1">
                {plugin.tools.slice(0, 6).map((tool) => (
                  <span
                    key={tool.name}
                    className="max-w-full truncate rounded-full border px-1.5 py-0.5 font-mono text-[10px]"
                    title={tool.description}
                  >
                    {tool.name}
                  </span>
                ))}
                {plugin.tools.length > 6 ? (
                  <span className="rounded-full border border-dashed px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    +{plugin.tools.length - 6}
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">{i18n.t("plugin.noToolsYet")}</p>
            )}
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-full px-2.5 text-[11px]"
                disabled={busy === plugin.id}
                onClick={() => void probe(plugin)}
              >
                {busy === plugin.id ? i18n.t("plugin.probing") : i18n.t("plugin.reprobe")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 rounded-full px-2 text-[11px]"
                disabled={busy === plugin.id}
                onClick={() => void toggle(plugin, !plugin.enabled)}
              >
                {plugin.enabled ? i18n.t("plugin.disableAction") : i18n.t("plugin.enableAction")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 rounded-full px-2 text-[11px] text-destructive"
                disabled={busy === plugin.id}
                onClick={() => void remove(plugin)}
              >
                {i18n.t("common.delete")}
              </Button>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                {i18n.tf("plugin.toolsCount", { n: plugin.tool_count })}{plugin.tools_at ? ` · ${timeAgo(i18n, plugin.tools_at)}` : ""}
              </span>
            </div>
          </article>
        ))}
        {!items.length ? (
          <Notice>
            {i18n.tf("plugin.emptyNotice", { button: i18n.t("plugin.addTitle"), catalog: i18n.t("plugin.catalogName") })}
          </Notice>
        ) : null}
      </div>

      <section className="ws-surface grid gap-1.5 rounded-xl bg-card p-3.5">
        <h3 className="text-xs font-semibold">{i18n.t("plugin.tipsTitle")}</h3>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {i18n.t("plugin.tip1")}
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {i18n.t("plugin.tip2")}
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {i18n.tf("plugin.tipLimits", { limit })}{" "}
          {catalogParts[0]}
          <a
            href="https://awesome-dsh-plugin.com/zh/"
            target="_blank"
            rel="noreferrer"
            className="text-signal hover:underline"
          >
            {i18n.t("plugin.catalogName")}
          </a>
          {catalogParts[1]}
        </p>
      </section>
    </div>
  );
}
