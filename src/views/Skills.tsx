// Market 的「技能」标签：本地市场 + 远端技能源两份清单。
// 卡片默认收起——名字、一行摘要、一条安装栏；正文和版本明细点开才展开。
// 安装落点三选一：某个员工 / 全部现有员工 / 现有 + 以后新建的员工（最后一种等于把技能标成默认）。
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { describeCode, describeError, get, post, type Agent } from "../api";
import type { InstallOutcome, RegistrySummary, RemoteSkill, Skill, SkillRegistry } from "../types";
import { byteSize, timeAgo } from "../lib/format";
import { ALL_AGENTS, ALL_AGENTS_FUTURE, describeInstall, installScope, skippedNote } from "../lib/skills";
import { Field, Notice, TextInput } from "../lib/ui";

type Draft = {
  name: string;
  summary: string;
  category: string;
  version: string;
  body: string;
  is_public: boolean;
  is_default: boolean;
  target: string;
};

const EMPTY: Draft = {
  name: "",
  summary: "",
  category: "协作",
  version: "",
  body: "",
  is_public: true,
  is_default: false,
  target: "",
};

const sourceLabel = (skill: Skill) => (
  skill.always_on ? "内置" : skill.source === "remote" ? "远端快照" : skill.is_public ? "公开" : "仅自己"
);

const card = "ws-surface ws-surface-hover flex min-w-0 flex-col gap-2 rounded-xl bg-card p-3.5";
const chip = "rounded-full border px-1.5 py-0 text-[10px] leading-4 font-normal";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 安装落点下拉。只有一个员工时不摆「全部现有」——那是同一条，看着碍事。 */
function InstallPicker({
  agents,
  value,
  onChange,
  disabled,
}: {
  agents: Agent[];
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <NativeSelect
      className="h-7 w-full text-[11px]"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <NativeSelectOption value="">装到…</NativeSelectOption>
      {agents.map((agent) => (
        <NativeSelectOption key={agent.id} value={agent.id}>{agent.name}</NativeSelectOption>
      ))}
      {agents.length > 1 ? (
        <NativeSelectOption value={ALL_AGENTS}>全部 {agents.length} 个现有员工</NativeSelectOption>
      ) : null}
      {agents.length ? (
        <NativeSelectOption value={ALL_AGENTS_FUTURE}>现有 + 以后新建的员工</NativeSelectOption>
      ) : null}
    </NativeSelect>
  );
}

export function SkillsPanel({ userId }: { userId: string }) {
  const [tab, setTab] = useState<"local" | "remote">("local");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [localQuery, setLocalQuery] = useState("");
  const [remoteQuery, setRemoteQuery] = useState("");

  useEffect(() => {
    void get<{ ok: true; items: Agent[] }>("agents.list")
      .then((result) => setAgents(result.items))
      .catch((error) => toast.error(describeError(error)));
  }, []);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-1">
        {([["local", "本地市场"], ["remote", "远端技能源"]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
              tab === id
                ? "border-transparent bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {label}
          </button>
        ))}
        <p className="ml-auto max-w-[520px] text-[11px] leading-relaxed text-muted-foreground">
          技能要装到员工才写进上下文；内置的两条平台技能对每个员工始终启用，不用安装。
        </p>
      </div>

      {tab === "local"
        ? <LocalSkills agents={agents} userId={userId} query={localQuery} setQuery={setLocalQuery} />
        : <RemoteSkills agents={agents} query={remoteQuery} setQuery={setRemoteQuery} />}
    </div>
  );
}

function LocalSkills({
  agents,
  userId,
  query,
  setQuery,
}: {
  agents: Agent[];
  userId: string;
  query: string;
  setQuery: (next: string) => void;
}) {
  const [items, setItems] = useState<Skill[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [uploadOpen, setUploadOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState("");

  const load = useCallback(async (needle: string) => {
    try {
      const market = await get<{ ok: true; items: Skill[] }>("skills.market", { q: needle || undefined });
      setItems(market.items);
    } catch (error) {
      toast.error(describeError(error));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), 180);
    return () => window.clearTimeout(timer);
  }, [query, load]);

  async function toggle(skill: Skill) {
    const next = !open[skill.id];
    setOpen((current) => ({ ...current, [skill.id]: next }));
    if (!next || bodies[skill.id] !== undefined || skill.always_on) return;
    try {
      const result = await get<{ ok: true; skill: Skill }>("skills.get", { id: skill.id });
      setBodies((current) => ({ ...current, [skill.id]: result.skill.body ?? "" }));
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function install(skill: Skill, target: string) {
    setBusy(skill.id);
    try {
      const result = await post<InstallOutcome & { ok: true }>("skills.install", {
        skill_id: skill.id,
        ...installScope(target),
      });
      toast.success(`${skill.name}：${describeInstall(result)}`);
      await load(query);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy("");
    }
  }

  async function download(skill: Skill) {
    setBusy(skill.id);
    try {
      const result = await post<{ ok: true; skill: Skill }>("skills.download", { id: skill.id });
      const body = result.skill.body ?? "";
      const file = new Blob([`# ${result.skill.name}\n\n${result.skill.summary}\n\n${body}\n`], {
        type: "text/markdown;charset=utf-8",
      });
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${result.skill.name}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
      setBodies((current) => ({ ...current, [skill.id]: body }));
      toast.success("已下载 .md 文件");
      await load(query);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy("");
    }
  }

  async function setDefault(skill: Skill, isDefault: boolean) {
    setBusy(skill.id);
    try {
      await post<{ ok: true; skill: Skill }>("skills.setDefault", { skill_id: skill.id, is_default: isDefault });
      toast.success(isDefault ? "以后新建的员工会自动装上这条" : "已取消自动安装");
      await load(query);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy("");
    }
  }

  async function upload() {
    if (!draft.name.trim() || !draft.summary.trim() || !draft.body.trim()) {
      toast.error("技能名、摘要和正文都要填。");
      return;
    }
    setBusy("upload");
    try {
      const result = await post<{ ok: true; skill: Skill; install: InstallOutcome | null }>("skills.upload", {
        name: draft.name.trim(),
        summary: draft.summary.trim(),
        category: draft.category.trim() || "协作",
        version: draft.version.trim() || undefined,
        body: draft.body.trim(),
        is_public: draft.is_public,
        is_default: draft.is_default,
        ...(draft.target ? installScope(draft.target) : {}),
      });
      toast.success(result.install ? `已上传并安装：${describeInstall(result.install)}` : "技能已上传");
      setUploadOpen(false);
      setDraft({ ...EMPTY, target: draft.target });
      await load(query);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称、摘要或分类…"
          className="h-8 w-52 text-xs"
        />
        <p className="font-mono text-[10px] text-muted-foreground">{items.length} 条</p>
        <Button
          size="sm"
          className="ml-auto h-8 rounded-full text-xs"
          onClick={() => setUploadOpen((current) => !current)}
        >
          {uploadOpen ? "收起上传" : "上传技能"}
        </Button>
      </div>

      {uploadOpen ? (
        <section className="ws-surface grid gap-3 rounded-xl bg-card p-3.5">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_110px_96px]">
            <Field label="技能名">
              <TextInput
                value={draft.name}
                maxLength={60}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="如：发布检查清单"
                className="h-8 text-xs"
              />
            </Field>
            <Field label="一句话摘要">
              <TextInput
                value={draft.summary}
                maxLength={300}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
                placeholder="这个技能让员工学会什么"
                className="h-8 text-xs"
              />
            </Field>
            <Field label="分类">
              <TextInput
                value={draft.category}
                maxLength={20}
                onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                className="h-8 text-xs"
              />
            </Field>
            <Field label="版本">
              <TextInput
                value={draft.version}
                maxLength={24}
                onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                placeholder="1.0.0"
                className="h-8 font-mono text-xs"
              />
            </Field>
          </div>
          <Field label="技能正文" hint="写给虚拟员工看的操作说明；会和内置技能一起进入上下文，带方案示例更好用。">
            <Textarea
              rows={7}
              value={draft.body}
              maxLength={20000}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              placeholder={"# 发布检查清单\n1. 备份数据库\n2. 灰度 10%\n3. 观察 30 分钟后全量"}
              className="text-xs"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                className="size-3.5"
                style={{ accentColor: "var(--signal)" }}
                checked={draft.is_public}
                onChange={(event) => setDraft({ ...draft, is_public: event.target.checked })}
              />
              公开到市场
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                className="size-3.5"
                style={{ accentColor: "var(--signal)" }}
                checked={draft.is_default}
                onChange={(event) => setDraft({ ...draft, is_default: event.target.checked })}
              />
              新员工自动安装
            </label>
            <span className="text-[11px] leading-relaxed text-muted-foreground">
              {draft.is_public ? "公开的默认技能对所有人生成的新员工生效" : "私有的默认技能只对我自己新建的员工生效"}
            </span>
            <div className="flex min-w-[240px] flex-1 flex-wrap items-center justify-end gap-1.5">
              <div className="min-w-[180px] flex-1">
                <InstallPicker
                  agents={agents}
                  value={draft.target}
                  onChange={(next) => setDraft({ ...draft, target: next })}
                />
              </div>
              <Button
                size="sm"
                className="h-8 rounded-full text-xs"
                disabled={busy === "upload"}
                onClick={() => void upload()}
              >
                {busy === "upload" ? "上传中…" : "上传"}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      <div className="grid content-start gap-2 sm:grid-cols-2">
        {items.map((skill) => (
          <article key={skill.id} className={card}>
            <button
              type="button"
              onClick={() => void toggle(skill)}
              aria-expanded={Boolean(open[skill.id])}
              className="flex min-w-0 items-center gap-1.5 text-left"
            >
              <h2 className="min-w-0 truncate text-sm font-semibold">{skill.name}</h2>
              {skill.version ? (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">v{skill.version}</span>
              ) : null}
              <Badge variant="secondary" className={cn(chip, "shrink-0")}>{skill.category}</Badge>
              <Badge
                variant="secondary"
                className={cn(chip, "shrink-0", skill.always_on && "bg-signal/12 text-signal")}
              >
                {sourceLabel(skill)}
              </Badge>
              {!skill.always_on && skill.is_default ? (
                <Badge variant="secondary" className={cn(chip, "shrink-0")}>默认</Badge>
              ) : null}
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {open[skill.id] ? "收起" : "详情"}
              </span>
            </button>
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{skill.summary}</p>
            {open[skill.id] ? (
              <div className="grid gap-2">
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 font-sans text-[11px] leading-relaxed scrollbar-thin">
                  {skill.always_on
                    ? "内置技能随每轮回复注入上下文，正文不在这里展开；要完整用法可以在群里让员工 list_skills。"
                    : bodies[skill.id] ?? "正文读取中…"}
                </pre>
                {skill.owner_id === userId && !skill.always_on ? (
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      className="size-3.5"
                      style={{ accentColor: "var(--signal)" }}
                      checked={skill.is_default}
                      disabled={busy === skill.id}
                      onChange={(event) => void setDefault(skill, event.target.checked)}
                    />
                    以后新建的员工自动安装这条
                  </label>
                ) : null}
              </div>
            ) : null}
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
              {skill.always_on ? (
                <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">对每个员工始终启用，不用装</span>
              ) : (
                <div className="min-w-0 flex-1">
                  <InstallPicker
                    agents={agents}
                    value={targets[skill.id] ?? ""}
                    onChange={(next) => setTargets({ ...targets, [skill.id]: next })}
                  />
                </div>
              )}
              {skill.always_on ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full px-2.5 text-[11px]"
                  disabled={!targets[skill.id] || busy === skill.id}
                  onClick={() => void install(skill, targets[skill.id] ?? "")}
                >
                  {busy === skill.id ? "处理中…" : "安装"}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 rounded-full px-2 text-[11px]"
                disabled={busy === skill.id}
                onClick={() => void download(skill)}
              >
                下载
              </Button>
            </div>
            <p className="font-mono text-[10px] text-muted-foreground">
              安装 {skill.installs} · 下载 {skill.downloads} · {timeAgo(skill.created_at)}
            </p>
          </article>
        ))}
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">没有匹配的技能。换个关键词，或上传一个新的。</p>
        ) : null}
      </div>
    </div>
  );
}

const remoteKey = (item: RemoteSkill) => `${item.registry_id}:${item.slug}`;

function RemoteSkills({
  agents,
  query,
  setQuery,
}: {
  agents: Agent[];
  query: string;
  setQuery: (next: string) => void;
}) {
  const [items, setItems] = useState<RemoteSkill[]>([]);
  const [sources, setSources] = useState<RegistrySummary[]>([]);
  const [registries, setRegistries] = useState<SkillRegistry[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", index_url: "" });
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [remote, owned] = await Promise.all([
        get<{ ok: true; items: RemoteSkill[]; registries: RegistrySummary[] }>("skills.remoteList", {
          q: query || undefined,
          registry_id: sourceId || undefined,
        }),
        get<{ ok: true; items: SkillRegistry[]; limit: number }>("registries.list"),
      ]);
      setItems(remote.items);
      setSources(remote.registries);
      setRegistries(owned.items);
      setManageOpen((current) => current || !owned.items.length);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [query, sourceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function addRegistry() {
    if (!draft.name.trim() || !draft.index_url.trim()) {
      toast.error("源名称和 index 地址都要填。");
      return;
    }
    setBusy("add");
    try {
      const result = await post<{
        ok: true;
        registry: SkillRegistry;
        probe: { items: unknown[]; skipped: unknown[]; error: string | null };
      }>("registries.add", { name: draft.name.trim(), index_url: draft.index_url.trim() });
      if (result.probe.error) {
        toast.warning(`已存下「${result.registry.name}」，但连不上：${describeCode(result.probe.error)}`);
      } else {
        toast.success(`已添加，读到 ${result.probe.items.length} 条技能`);
      }
      setDraft({ name: "", index_url: "" });
      setSourceId(result.registry.id);
      await load();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy("");
    }
  }

  async function refreshRegistry(registry: SkillRegistry) {
    setBusy(registry.id);
    try {
      const result = await post<{ ok: true; probe: { items: unknown[]; error: string | null } }>(
        "registries.refresh",
        { id: registry.id },
      );
      if (result.probe.error) toast.warning(describeCode(result.probe.error));
      else toast.success(`读到 ${result.probe.items.length} 条技能`);
      await load();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy("");
    }
  }

  async function toggleRegistry(registry: SkillRegistry, enabled: boolean) {
    setBusy(registry.id);
    try {
      await post<{ ok: true; registry: SkillRegistry }>("registries.update", { id: registry.id, enabled });
      toast.success(enabled ? `已启用 ${registry.name}` : `已停用 ${registry.name}`);
      await load();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy("");
    }
  }

  async function removeRegistry(registry: SkillRegistry) {
    if (!window.confirm(`删掉技能源「${registry.name}」？已经抄到本地的技能会留下，员工继续用。`)) return;
    setBusy(registry.id);
    try {
      await post<{ ok: true }>("registries.remove", { id: registry.id });
      toast.success("已删除技能源");
      if (sourceId === registry.id) setSourceId("");
      await load();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy("");
    }
  }

  async function install(item: RemoteSkill, target: string) {
    const key = remoteKey(item);
    setBusy(key);
    try {
      const result = await post<{ ok: true; skill: Skill; install: InstallOutcome }>("skills.remoteInstall", {
        registry_id: item.registry_id,
        slug: item.slug,
        ...installScope(target),
      });
      toast.success(
        `${result.skill.name} v${result.skill.version ?? "—"} 已抄成本地快照 · ${describeInstall(result.install)}`,
      );
      await load();
    } catch (error) {
      toast.error(describeError(error));
      await load();
    } finally {
      setBusy("");
    }
  }

  async function update(item: RemoteSkill) {
    if (!item.installed_skill_id) return;
    const key = remoteKey(item);
    setBusy(key);
    try {
      const result = await post<{ ok: true; skill: Skill; from_version: string; to_version: string }>(
        "skills.remoteUpdate",
        { skill_id: item.installed_skill_id },
      );
      toast.success(`${item.name}：v${result.from_version || "—"} → v${result.to_version || "—"}`);
      await load();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy("");
    }
  }

  const skippedSources = sources.filter((source) => source.skipped.length);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称、简介、slug 或源…"
          className="h-8 w-56 text-xs"
        />
        <NativeSelect
          className="h-8 w-44 text-xs"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
        >
          <NativeSelectOption value="">全部启用的源</NativeSelectOption>
          {registries.map((registry) => (
            <NativeSelectOption key={registry.id} value={registry.id}>
              {registry.name}{registry.enabled ? "" : "（已停用）"}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 rounded-full text-xs"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "拉取中…" : "刷新"}
        </Button>
        <p className="font-mono text-[10px] text-muted-foreground">{items.length} 条</p>
        <Button
          size="sm"
          className="ml-auto h-8 rounded-full text-xs"
          onClick={() => setManageOpen((current) => !current)}
        >
          {manageOpen ? "收起技能源" : `技能源 · ${registries.length}`}
        </Button>
      </div>

      {sources.length ? (
        <div className="flex flex-wrap gap-1.5">
          {sources.map((source) => (
            <span
              key={source.id}
              title={source.error
                ? describeCode(source.error)
                : source.skipped.length
                  ? skippedNote(source.skipped)
                  : source.index_url}
              className={cn(
                "max-w-full truncate rounded-full border px-2 py-0.5 text-[10px] leading-4",
                source.error ? "border-machine/40 bg-machine-soft text-machine" : "text-muted-foreground",
              )}
            >
              {source.name} · {source.error ? "连不上" : `${source.skill_count} 条`}
              {source.skipped.length ? ` · 跳过 ${source.skipped.length}` : ""}
              {source.skills_at ? ` · ${timeAgo(source.skills_at)}` : ""}
            </span>
          ))}
        </div>
      ) : null}

      {manageOpen ? (
        <section className="ws-surface grid gap-3 rounded-xl bg-card p-3.5">
          <div className="grid gap-3 md:grid-cols-[minmax(0,0.6fr)_minmax(0,1.6fr)_auto] md:items-end">
            <Field label="源名称">
              <TextInput
                value={draft.name}
                maxLength={40}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="如：团队的技能库"
                className="h-8 text-xs"
              />
            </Field>
            <Field
              label="index JSON 地址"
              hint="正文必须和 index 同源；服务端只读源、不写源，线上只收 https，本机调试才放行内网地址。"
            >
              <TextInput
                value={draft.index_url}
                maxLength={300}
                onChange={(event) => setDraft({ ...draft, index_url: event.target.value })}
                placeholder="https://example.com/skills/index.json"
                className="h-8 font-mono text-xs"
              />
            </Field>
            <Button
              size="sm"
              className="h-8 rounded-full text-xs"
              disabled={busy === "add"}
              onClick={() => void addRegistry()}
            >
              {busy === "add" ? "拉取中…" : "添加并拉取"}
            </Button>
          </div>
          <p className="break-all text-[11px] leading-relaxed text-muted-foreground">
            index 长这样：
            <span className="font-mono">
              {" {\"schema\":1,\"skills\":[{\"slug\":\"release-check\",\"name\":\"发布检查\",\"summary\":\"…\",\"version\":\"1.2.0\",\"body_url\":\"release-check.md\"}]} "}
            </span>
            ；单个源最多 200 条、每人最多 8 个源。
          </p>

          <div className="grid gap-1.5">
            {registries.map((registry) => (
              <div key={registry.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2">
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm">{registry.name}</span>
                    {registry.enabled ? null : <Badge variant="secondary" className={chip}>已停用</Badge>}
                    {registry.last_error ? (
                      <Badge
                        variant="secondary"
                        className={cn(chip, "border-machine/40 bg-machine-soft text-machine")}
                      >
                        {describeCode(registry.last_error)}
                      </Badge>
                    ) : null}
                  </span>
                  <span
                    className="block truncate font-mono text-[10.5px] text-muted-foreground"
                    title={registry.index_url}
                  >
                    {hostOf(registry.index_url)} · {registry.skill_count} 条
                    {registry.skills_at ? ` · ${timeAgo(registry.skills_at)}` : " · 还没拉到"}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full px-2.5 text-[11px]"
                  disabled={busy === registry.id}
                  onClick={() => void refreshRegistry(registry)}
                >
                  重测
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-full px-2 text-[11px]"
                  disabled={busy === registry.id}
                  onClick={() => void toggleRegistry(registry, !registry.enabled)}
                >
                  {registry.enabled ? "停用" : "启用"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-full px-2 text-[11px] text-destructive"
                  disabled={busy === registry.id}
                  onClick={() => void removeRegistry(registry)}
                >
                  删除
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-full px-2 text-[11px]"
                  onClick={() => setSourceId(registry.id)}
                >
                  只看这个源
                </Button>
              </div>
            ))}
            {!registries.length ? (
              <p className="text-xs text-muted-foreground">
                还没有技能源。填一个能公开访问的 index JSON，就能把团队仓库当市场用。
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="grid content-start gap-2 sm:grid-cols-2">
        {items.map((item) => {
          const key = remoteKey(item);
          const target = targets[key] ?? "";
          return (
            <article key={key} className={card}>
              <button
                type="button"
                onClick={() => setOpen((current) => ({ ...current, [key]: !current[key] }))}
                aria-expanded={Boolean(open[key])}
                className="flex min-w-0 items-center gap-1.5 text-left"
              >
                <h2 className="min-w-0 truncate text-sm font-semibold">{item.name}</h2>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">v{item.version || "—"}</span>
                <Badge variant="secondary" className={cn(chip, "shrink-0")}>{item.category}</Badge>
                <Badge variant="secondary" className={cn(chip, "shrink-0")}>{item.registry_name}</Badge>
                {item.installed_skill_id ? (
                  <Badge
                    variant="secondary"
                    className={cn(chip, "shrink-0", item.update_available && "bg-signal/12 text-signal")}
                  >
                    {item.update_available
                      ? `可更新（本地 v${item.installed_version || "—"}）`
                      : `已装 v${item.installed_version || "—"}`}
                  </Badge>
                ) : null}
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {open[key] ? "收起" : "明细"}
                </span>
              </button>
              <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {item.summary || "源上没写简介。"}
              </p>
              {open[key] ? (
                <div className="grid gap-1 break-all rounded-lg bg-muted/40 p-2.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
                  <span>slug · {item.slug}</span>
                  <span>
                    {item.size ? byteSize(item.size) : "大小未知"} ·{" "}
                    {item.updated_at ? `源上更新 ${timeAgo(item.updated_at)}` : "源上没写更新时间"}
                  </span>
                  <a href={item.body_url} target="_blank" rel="noreferrer" className="text-signal hover:underline">
                    {hostOf(item.body_url)}/{item.slug}
                  </a>
                </div>
              ) : null}
              <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                <div className="min-w-0 flex-1">
                  <InstallPicker
                    agents={agents}
                    value={target}
                    onChange={(next) => setTargets({ ...targets, [key]: next })}
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full px-2.5 text-[11px]"
                  disabled={!target || busy === key}
                  onClick={() => void install(item, target)}
                >
                  {busy === key ? "处理中…" : item.installed_skill_id ? "再装一次" : "安装"}
                </Button>
                {item.update_available && item.installed_skill_id ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 rounded-full bg-signal/12 px-2.5 text-[11px] text-signal"
                    disabled={busy === key}
                    onClick={() => void update(item)}
                  >
                    更新
                  </Button>
                ) : null}
                <a
                  href={item.body_url}
                  target="_blank"
                  rel="noreferrer"
                  title="在新标签打开源上的正文"
                  className="shrink-0 px-2 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  下载 link
                </a>
              </div>
            </article>
          );
        })}
      </div>

      {!loading && !items.length ? (
        registries.length ? (
          <Notice tone="warn">
            这些源上此刻没有可用技能：连不上的源已经在上面标出原因，其余多半是搜索词太窄或条目格式不合。
          </Notice>
        ) : (
          <Notice>
            还没有技能源。点右上角「技能源」填一个 index JSON 地址——比如在 GitHub 上开一个 skills 仓，
            把清单文件的 raw 地址贴进来；装的时候正文会抄一份到本地并记下版本，源之后怎么改都不影响在用的员工。
          </Notice>
        )
      ) : null}

      {skippedSources.length ? (
        <Notice tone="warn">
          源上有条目被跳过：{skippedSources.map((source) => `${source.name}（${skippedNote(source.skipped)}）`).join("、")}。
          条目要 slug 小写、名称不重复、正文地址和 index 同源。
        </Notice>
      ) : null}
    </div>
  );
}
