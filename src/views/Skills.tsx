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
import { useI18n } from "../lib/i18n";
import type { I18n } from "../lib/i18n";

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

const sourceLabel = (i18n: I18n, skill: Skill) => (
  skill.always_on ? i18n.t("skill.srcBuiltIn") : skill.source === "remote" ? i18n.t("skill.srcRemoteSnapshot") : skill.is_public ? i18n.t("skill.srcPublic") : i18n.t("skill.srcPrivate")
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
  const i18n = useI18n();
  return (
    <NativeSelect
      className="h-7 w-full text-[11px]"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <NativeSelectOption value="">{i18n.t("skill.installTo")}</NativeSelectOption>
      {agents.map((agent) => (
        <NativeSelectOption key={agent.id} value={agent.id}>{agent.name}</NativeSelectOption>
      ))}
      {agents.length > 1 ? (
        <NativeSelectOption value={ALL_AGENTS}>{i18n.tf("skill.allExistingAgents", { n: agents.length })}</NativeSelectOption>
      ) : null}
      {agents.length ? (
        <NativeSelectOption value={ALL_AGENTS_FUTURE}>{i18n.t("skill.allAgentsAndFuture")}</NativeSelectOption>
      ) : null}
    </NativeSelect>
  );
}

export function SkillsPanel({ userId }: { userId: string }) {
  const i18n = useI18n();
  const [tab, setTab] = useState<"local" | "remote">("local");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [localQuery, setLocalQuery] = useState("");
  const [remoteQuery, setRemoteQuery] = useState("");

  useEffect(() => {
    void get<{ ok: true; items: Agent[] }>("agents.list")
      .then((result) => setAgents(result.items))
      .catch((error) => toast.error(describeError(i18n, error)));
  }, []);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-1">
        {([["local", "skill.tabLocal"], ["remote", "skill.tabRemote"]] as const).map(([id, labelKey]) => (
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
            {i18n.t(labelKey)}
          </button>
        ))}
        <p className="ml-auto max-w-[520px] text-[11px] leading-relaxed text-muted-foreground">
          {i18n.t("skill.panelHint")}
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
  const i18n = useI18n();
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
      toast.error(describeError(i18n, error));
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
      toast.error(describeError(i18n, error));
    }
  }

  async function install(skill: Skill, target: string) {
    setBusy(skill.id);
    try {
      const result = await post<InstallOutcome & { ok: true }>("skills.install", {
        skill_id: skill.id,
        ...installScope(target),
      });
      toast.success(i18n.tf("skill.installToast", { name: skill.name, detail: describeInstall(i18n, result) }));
      await load(query);
    } catch (error) {
      toast.error(describeError(i18n, error));
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
      toast.success(i18n.t("skill.downloadedMd"));
      await load(query);
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy("");
    }
  }

  async function setDefault(skill: Skill, isDefault: boolean) {
    setBusy(skill.id);
    try {
      await post<{ ok: true; skill: Skill }>("skills.setDefault", { skill_id: skill.id, is_default: isDefault });
      toast.success(isDefault ? i18n.t("skill.becameDefault") : i18n.t("skill.defaultCancelled"));
      await load(query);
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy("");
    }
  }

  async function upload() {
    if (!draft.name.trim() || !draft.summary.trim() || !draft.body.trim()) {
      toast.error(i18n.t("skill.needNameSummaryBody"));
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
      toast.success(result.install ? i18n.tf("skill.uploadInstallToast", { detail: describeInstall(i18n, result.install) }) : i18n.t("skill.uploadedOnly"));
      setUploadOpen(false);
      setDraft({ ...EMPTY, target: draft.target });
      await load(query);
    } catch (error) {
      toast.error(describeError(i18n, error));
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
          placeholder={i18n.t("skill.searchLocalPlaceholder")}
          className="h-8 w-52 text-xs"
        />
        <p className="font-mono text-[10px] text-muted-foreground">{i18n.tf("skill.itemCount", { n: items.length })}</p>
        <Button
          size="sm"
          className="ml-auto h-8 rounded-full text-xs"
          onClick={() => setUploadOpen((current) => !current)}
        >
          {uploadOpen ? i18n.t("skill.collapseUpload") : i18n.t("skill.uploadSkill")}
        </Button>
      </div>

      {uploadOpen ? (
        <section className="ws-surface grid gap-3 rounded-xl bg-card p-3.5">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_110px_96px]">
            <Field label={i18n.t("skill.nameLabel")}>
              <TextInput
                value={draft.name}
                maxLength={60}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder={i18n.t("skill.namePlaceholder")}
                className="h-8 text-xs"
              />
            </Field>
            <Field label={i18n.t("skill.summaryLabel")}>
              <TextInput
                value={draft.summary}
                maxLength={300}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
                placeholder={i18n.t("skill.summaryPlaceholder")}
                className="h-8 text-xs"
              />
            </Field>
            <Field label={i18n.t("skill.categoryLabel")}>
              <TextInput
                value={draft.category}
                maxLength={20}
                onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                className="h-8 text-xs"
              />
            </Field>
            <Field label={i18n.t("skill.versionLabel")}>
              <TextInput
                value={draft.version}
                maxLength={24}
                onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                placeholder="1.0.0"
                className="h-8 font-mono text-xs"
              />
            </Field>
          </div>
          <Field label={i18n.t("skill.bodyLabel")} hint={i18n.t("skill.bodyHint")}>
            <Textarea
              rows={7}
              value={draft.body}
              maxLength={20000}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              placeholder={i18n.t("skill.bodyPlaceholder")}
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
              {i18n.t("skill.publishLabel")}
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                className="size-3.5"
                style={{ accentColor: "var(--signal)" }}
                checked={draft.is_default}
                onChange={(event) => setDraft({ ...draft, is_default: event.target.checked })}
              />
              {i18n.t("skill.autoInstallLabel")}
            </label>
            <span className="text-[11px] leading-relaxed text-muted-foreground">
              {draft.is_public ? i18n.t("skill.publicDefaultNote") : i18n.t("skill.privateDefaultNote")}
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
                {busy === "upload" ? i18n.t("skill.uploading") : i18n.t("skill.upload")}
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
                {sourceLabel(i18n, skill)}
              </Badge>
              {!skill.always_on && skill.is_default ? (
                <Badge variant="secondary" className={cn(chip, "shrink-0")}>{i18n.t("skill.defaultBadge")}</Badge>
              ) : null}
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {open[skill.id] ? i18n.t("common.collapse") : i18n.t("skill.details")}
              </span>
            </button>
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{skill.summary}</p>
            {open[skill.id] ? (
              <div className="grid gap-2">
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 font-sans text-[11px] leading-relaxed scrollbar-thin">
                  {skill.always_on
                    ? i18n.t("skill.alwaysOnBodyNote")
                    : bodies[skill.id] ?? i18n.t("skill.bodyLoading")}
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
                    {i18n.t("skill.setDefaultFuture")}
                  </label>
                ) : null}
              </div>
            ) : null}
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
              {skill.always_on ? (
                <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{i18n.t("skill.alwaysOnShort")}</span>
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
                  {busy === skill.id ? i18n.t("skill.processing") : i18n.t("skill.install")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 rounded-full px-2 text-[11px]"
                disabled={busy === skill.id}
                onClick={() => void download(skill)}
              >
                {i18n.t("skill.download")}
              </Button>
            </div>
            <p className="font-mono text-[10px] text-muted-foreground">
              {i18n.tf("skill.stats", { installs: skill.installs, downloads: skill.downloads, ago: timeAgo(i18n, skill.created_at) })}
            </p>
          </article>
        ))}
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">{i18n.t("skill.localEmpty")}</p>
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
  const i18n = useI18n();
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
      toast.error(describeError(i18n, error));
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
      toast.error(i18n.t("skill.needSourceFields"));
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
        toast.warning(i18n.tf("skill.registrySavedUnreachable", { name: result.registry.name, reason: describeCode(i18n, result.probe.error) }));
      } else {
        toast.success(i18n.tf("skill.addedAndRead", { n: result.probe.items.length }));
      }
      setDraft({ name: "", index_url: "" });
      setSourceId(result.registry.id);
      await load();
    } catch (error) {
      toast.error(describeError(i18n, error));
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
      if (result.probe.error) toast.warning(describeCode(i18n, result.probe.error));
      else toast.success(i18n.tf("skill.readCount", { n: result.probe.items.length }));
      await load();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy("");
    }
  }

  async function toggleRegistry(registry: SkillRegistry, enabled: boolean) {
    setBusy(registry.id);
    try {
      await post<{ ok: true; registry: SkillRegistry }>("registries.update", { id: registry.id, enabled });
      toast.success(enabled ? i18n.tf("skill.sourceEnabled", { name: registry.name }) : i18n.tf("skill.sourceDisabled", { name: registry.name }));
      await load();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy("");
    }
  }

  async function removeRegistry(registry: SkillRegistry) {
    if (!window.confirm(i18n.tf("skill.removeSourceConfirm", { name: registry.name }))) return;
    setBusy(registry.id);
    try {
      await post<{ ok: true }>("registries.remove", { id: registry.id });
      toast.success(i18n.t("skill.sourceDeleted"));
      if (sourceId === registry.id) setSourceId("");
      await load();
    } catch (error) {
      toast.error(describeError(i18n, error));
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
        i18n.tf("skill.remoteInstallToast", {
          name: result.skill.name,
          version: result.skill.version ?? i18n.t("skill.unknownVersion"),
          detail: describeInstall(i18n, result.install),
        }),
      );
      await load();
    } catch (error) {
      toast.error(describeError(i18n, error));
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
      toast.success(
        i18n.tf("skill.updateToast", {
          name: item.name,
          from: result.from_version || i18n.t("skill.unknownVersion"),
          to: result.to_version || i18n.t("skill.unknownVersion"),
        }),
      );
      await load();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy("");
    }
  }

  const skippedSources = sources.filter((source) => source.skipped.length);
  // 「index 长这样：…」中间夹着等宽示例段，拆不成整句，按 {0} 切开再插回去。
  const exampleParts = i18n.tp("skill.indexExampleNote");

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={i18n.t("skill.searchRemotePlaceholder")}
          className="h-8 w-56 text-xs"
        />
        <NativeSelect
          className="h-8 w-44 text-xs"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
        >
          <NativeSelectOption value="">{i18n.t("skill.allEnabledSources")}</NativeSelectOption>
          {registries.map((registry) => (
            <NativeSelectOption key={registry.id} value={registry.id}>
              {registry.name}{registry.enabled ? "" : i18n.t("skill.disabledSuffix")}
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
          {loading ? i18n.t("skill.fetching") : i18n.t("common.refresh")}
        </Button>
        <p className="font-mono text-[10px] text-muted-foreground">{i18n.tf("skill.itemCount", { n: items.length })}</p>
        <Button
          size="sm"
          className="ml-auto h-8 rounded-full text-xs"
          onClick={() => setManageOpen((current) => !current)}
        >
          {manageOpen ? i18n.t("skill.collapseSources") : i18n.tf("skill.sourcesToggle", { n: registries.length })}
        </Button>
      </div>

      {sources.length ? (
        <div className="flex flex-wrap gap-1.5">
          {sources.map((source) => (
            <span
              key={source.id}
              title={source.error
                ? describeCode(i18n, source.error)
                : source.skipped.length
                  ? skippedNote(i18n, source.skipped)
                  : source.index_url}
              className={cn(
                "max-w-full truncate rounded-full border px-2 py-0.5 text-[10px] leading-4",
                source.error ? "border-machine/40 bg-machine-soft text-machine" : "text-muted-foreground",
              )}
            >
              {source.name} · {source.error ? i18n.t("skill.unreachable") : i18n.tf("skill.itemCount", { n: source.skill_count })}
              {source.skipped.length ? ` · ${i18n.tf("skill.skippedCount", { n: source.skipped.length })}` : ""}
              {source.skills_at ? ` · ${timeAgo(i18n, source.skills_at)}` : ""}
            </span>
          ))}
        </div>
      ) : null}

      {manageOpen ? (
        <section className="ws-surface grid gap-3 rounded-xl bg-card p-3.5">
          <div className="grid gap-3 md:grid-cols-[minmax(0,0.6fr)_minmax(0,1.6fr)_auto] md:items-end">
            <Field label={i18n.t("skill.sourceNameLabel")}>
              <TextInput
                value={draft.name}
                maxLength={40}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder={i18n.t("skill.sourceNamePlaceholder")}
                className="h-8 text-xs"
              />
            </Field>
            <Field
              label={i18n.t("skill.indexUrlLabel")}
              hint={i18n.t("skill.indexUrlHint")}
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
              {busy === "add" ? i18n.t("skill.fetching") : i18n.t("skill.addAndFetch")}
            </Button>
          </div>
          <p className="break-all text-[11px] leading-relaxed text-muted-foreground">
            {exampleParts[0]}
            <span className="font-mono">
              {" {\"schema\":1,\"skills\":[{\"slug\":\"release-check\",\"name\":\"发布检查\",\"summary\":\"…\",\"version\":\"1.2.0\",\"body_url\":\"release-check.md\"}]} "}
            </span>
            {exampleParts[1]}
          </p>

          <div className="grid gap-1.5">
            {registries.map((registry) => (
              <div key={registry.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2">
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm">{registry.name}</span>
                    {registry.enabled ? null : <Badge variant="secondary" className={chip}>{i18n.t("skill.disabledBadge")}</Badge>}
                    {registry.last_error ? (
                      <Badge
                        variant="secondary"
                        className={cn(chip, "border-machine/40 bg-machine-soft text-machine")}
                      >
                        {describeCode(i18n, registry.last_error)}
                      </Badge>
                    ) : null}
                  </span>
                  <span
                    className="block truncate font-mono text-[10.5px] text-muted-foreground"
                    title={registry.index_url}
                  >
                    {hostOf(registry.index_url)} · {i18n.tf("skill.itemCount", { n: registry.skill_count })}
                    {registry.skills_at ? ` · ${timeAgo(i18n, registry.skills_at)}` : ` · ${i18n.t("skill.notFetched")}`}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full px-2.5 text-[11px]"
                  disabled={busy === registry.id}
                  onClick={() => void refreshRegistry(registry)}
                >
                  {i18n.t("skill.retest")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-full px-2 text-[11px]"
                  disabled={busy === registry.id}
                  onClick={() => void toggleRegistry(registry, !registry.enabled)}
                >
                  {registry.enabled ? i18n.t("skill.disable") : i18n.t("skill.enable")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-full px-2 text-[11px] text-destructive"
                  disabled={busy === registry.id}
                  onClick={() => void removeRegistry(registry)}
                >
                  {i18n.t("common.delete")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-full px-2 text-[11px]"
                  onClick={() => setSourceId(registry.id)}
                >
                  {i18n.t("skill.onlyThisSource")}
                </Button>
              </div>
            ))}
            {!registries.length ? (
              <p className="text-xs text-muted-foreground">
                {i18n.t("skill.noSourcesYet")}
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
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">v{item.version || i18n.t("skill.unknownVersion")}</span>
                <Badge variant="secondary" className={cn(chip, "shrink-0")}>{item.category}</Badge>
                <Badge variant="secondary" className={cn(chip, "shrink-0")}>{item.registry_name}</Badge>
                {item.installed_skill_id ? (
                  <Badge
                    variant="secondary"
                    className={cn(chip, "shrink-0", item.update_available && "bg-signal/12 text-signal")}
                  >
                    {item.update_available
                      ? i18n.tf("skill.updateAvailableBadge", { version: item.installed_version || i18n.t("skill.unknownVersion") })
                      : i18n.tf("skill.installedBadge", { version: item.installed_version || i18n.t("skill.unknownVersion") })}
                  </Badge>
                ) : null}
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {open[key] ? i18n.t("common.collapse") : i18n.t("skill.details")}
                </span>
              </button>
              <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {item.summary || i18n.t("skill.noSummaryNote")}
              </p>
              {open[key] ? (
                <div className="grid gap-1 break-all rounded-lg bg-muted/40 p-2.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
                  <span>slug · {item.slug}</span>
                  <span>
                    {item.size ? byteSize(i18n, item.size) : i18n.t("skill.sizeUnknown")} ·{" "}
                    {item.updated_at ? i18n.tf("skill.sourceUpdatedAgo", { ago: timeAgo(i18n, item.updated_at) }) : i18n.t("skill.noUpdatedAt")}
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
                  {busy === key ? i18n.t("skill.processing") : item.installed_skill_id ? i18n.t("skill.reinstall") : i18n.t("skill.install")}
                </Button>
                {item.update_available && item.installed_skill_id ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 rounded-full bg-signal/12 px-2.5 text-[11px] text-signal"
                    disabled={busy === key}
                    onClick={() => void update(item)}
                  >
                    {i18n.t("skill.update")}
                  </Button>
                ) : null}
                <a
                  href={item.body_url}
                  target="_blank"
                  rel="noreferrer"
                  title={i18n.t("skill.openBodyTitle")}
                  className="shrink-0 px-2 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  {i18n.t("skill.downloadLink")}
                </a>
              </div>
            </article>
          );
        })}
      </div>

      {!loading && !items.length ? (
        registries.length ? (
          <Notice tone="warn">
            {i18n.t("skill.noRemoteSkillsNote")}
          </Notice>
        ) : (
          <Notice>
            {i18n.t("skill.getStartedNote")}
          </Notice>
        )
      ) : null}

      {skippedSources.length ? (
        <Notice tone="warn">
          {i18n.tf("skill.skippedIntro", {
            list: i18n.list(
              skippedSources.map((source) =>
                i18n.tf("skill.skippedItem", { name: source.name, note: skippedNote(i18n, source.skipped) }),
              ),
            ),
          })}
          {i18n.t("skill.skippedRules")}
        </Notice>
      ) : null}
    </div>
  );
}
