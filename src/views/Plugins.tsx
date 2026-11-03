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

const STATUS_LABEL: Record<string, string> = {
  ready: "就绪",
  error: "连不上",
  untested: "未检测",
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
  const [items, setItems] = useState<Plugin[]>([]);
  const [limit, setLimit] = useState(12);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await get<{ ok: true; items: Plugin[]; limit: number }>("plugins.list");
      setItems(result.items);
      setLimit(result.limit);
    } catch (error) {
      toast.error(describeError(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!draft.name.trim() || !draft.endpoint.trim()) {
      toast.error("插件名和 MCP 地址都要填。");
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
        toast.warning(`已保存，但连不上：${describeCode(result.probe_error)}`);
      } else {
        toast.success(`已接入 ${result.plugin.name}`);
      }
      await load();
    } catch (error) {
      toast.error(describeError(error));
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
      const skipped = result.skipped?.length ? `，跳过 ${result.skipped.length} 个` : "";
      toast.success(`读到 ${result.tools.length} 个工具${skipped}`);
      await load();
    } catch (error) {
      toast.error(describeError(error));
      await load();
    } finally {
      setBusy("");
    }
  }

  async function toggle(plugin: Plugin, enabled: boolean) {
    setBusy(plugin.id);
    try {
      await post<{ ok: true }>("plugins.update", { id: plugin.id, enabled });
      toast.success(enabled ? `已启用 ${plugin.name}` : `已停用 ${plugin.name}`);
      await load();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy("");
    }
  }

  async function remove(plugin: Plugin) {
    if (!window.confirm(`删掉插件「${plugin.name}」？它带进来的工具会立刻从员工清单里消失。`)) return;
    setBusy(plugin.id);
    try {
      await post<{ ok: true }>("plugins.remove", { id: plugin.id });
      toast.success("已删除");
      await load();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="max-w-[620px] text-xs leading-relaxed text-muted-foreground">
          接一个标准 MCP 服务，它 <span className="font-mono">tools/list</span> 出来的工具会并进你名下所有虚拟员工的工具清单；
          员工调用插件工具照样落进 Stream flow 的轨迹。工具名与内置工具重名时内置优先，插件那条会被跳过。
        </p>
        <Button
          size="sm"
          className="h-8 rounded-full text-xs"
          onClick={() => setAddOpen((current) => !current)}
        >
          {addOpen ? "收起" : "接入插件"}
        </Button>
      </div>

      {addOpen ? (
        <section className="ws-surface grid gap-3 rounded-xl bg-card p-3.5">
          <div className="grid gap-3 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
            <Field label="插件名">
              <TextInput
                value={draft.name}
                maxLength={40}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="如：天气查询"
                className="h-8 text-xs"
              />
            </Field>
            <Field label="MCP 地址" hint="标准 JSON-RPC over HTTP；线上只收 https，本机调试才放行内网地址。">
              <TextInput
                value={draft.endpoint}
                maxLength={300}
                onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                placeholder="https://example.com/mcp"
                className="h-8 text-xs"
              />
            </Field>
            <Field label="令牌（可选）" hint="填了就用 Bearer 头发出去，服务端只存密文，界面只回尾号。">
              <TextInput
                value={draft.token}
                maxLength={400}
                onChange={(event) => setDraft({ ...draft, token: event.target.value })}
                placeholder="留空表示这个服务不需要鉴权"
                className="h-8 text-xs"
                type="password"
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="h-8 rounded-full text-xs" disabled={busy === "add"} onClick={() => void add()}>
              {busy === "add" ? "连接中…" : "接入并检测"}
            </Button>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              连不上也会先存下来，标成「连不上」，之后可以重新检测。
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
                {STATUS_LABEL[plugin.status] ?? plugin.status}
              </Badge>
              <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                {plugin.enabled ? "已启用" : "已停用"}
              </Badge>
              {plugin.auth_tail ? (
                <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                  令牌 {plugin.auth_tail}
                </Badge>
              ) : null}
            </div>
            <p className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground" title={plugin.endpoint}>
              {hostOf(plugin.endpoint)}
            </p>
            {plugin.status === "error" && plugin.last_error ? (
              <p className="text-[11px] leading-relaxed text-destructive">{describeCode(plugin.last_error)}</p>
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
              <p className="text-[11px] text-muted-foreground">还没有读到工具。</p>
            )}
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-full px-2.5 text-[11px]"
                disabled={busy === plugin.id}
                onClick={() => void probe(plugin)}
              >
                {busy === plugin.id ? "检测中…" : "重新检测"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 rounded-full px-2 text-[11px]"
                disabled={busy === plugin.id}
                onClick={() => void toggle(plugin, !plugin.enabled)}
              >
                {plugin.enabled ? "停用" : "启用"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 rounded-full px-2 text-[11px] text-destructive"
                disabled={busy === plugin.id}
                onClick={() => void remove(plugin)}
              >
                删除
              </Button>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                {plugin.tool_count} 工具{plugin.tools_at ? ` · ${timeAgo(plugin.tools_at)}` : ""}
              </span>
            </div>
          </article>
        ))}
        {!items.length ? (
          <Notice>还没有接插件。点右上角「接入插件」填一个标准 MCP 地址；想现成的服务可以去 DSH 插件目录翻（见下方说明）。</Notice>
        ) : null}
      </div>

      <section className="ws-surface grid gap-1.5 rounded-xl bg-card p-3.5">
        <h3 className="text-xs font-semibold">用插件前要知道的三件事</h3>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          1. 插件的工具名和说明会原样进入模型上下文，等于把一段外部文案喂给你的员工——只接你信任的来源。
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          2. 工具是账号级的：接一次，你名下所有员工在所有群里都能调用；不想让某个员工用，就先停用这条连接器。
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          3. 上限每人 {limit} 条、每条最多带 24 个工具；调用超时 60 秒，回包超过 512KB 直接判失败，不会拖垮整轮回复。
          现成的 MCP 服务可以在{" "}
          <a
            href="https://awesome-dsh-plugin.com/zh/"
            target="_blank"
            rel="noreferrer"
            className="text-signal hover:underline"
          >
            DSH 插件目录
          </a>
          {" "}里找，WorkStream 这边不做二次分发，接的是服务本身。
        </p>
      </section>
    </div>
  );
}
