// Skill Market：搜索/上传/下载技能，并把技能安装到指定虚拟员工。
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { describeError, get, post, type Agent } from "../api";
import type { Skill } from "../types";
import { timeAgo } from "../lib/format";
import { Field, TextInput } from "../lib/ui";

type Draft = {
  name: string;
  summary: string;
  category: string;
  body: string;
  is_public: boolean;
  is_default: boolean;
  agent_id: string;
};

const EMPTY: Draft = {
  name: "",
  summary: "",
  category: "协作",
  body: "",
  is_public: true,
  is_default: false,
  agent_id: "",
};

const sourceLabel = (skill: Skill) => (skill.always_on ? "内置" : skill.is_public ? "公开" : "仅自己");

export function SkillsView() {
  const [items, setItems] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Skill | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [uploadOpen, setUploadOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (needle: string) => {
    try {
      const [market, agentList] = await Promise.all([
        get<{ ok: true; items: Skill[] }>("skills.market", { q: needle || undefined }),
        get<{ ok: true; items: Agent[] }>("agents.list"),
      ]);
      setItems(market.items);
      setAgents(agentList.items);
      setSelectedId((current) => (
        market.items.some((item) => item.id === current) ? current : market.items[0]?.id ?? ""
      ));
      setTargets((current) => {
        const next = { ...current };
        for (const item of market.items) {
          if (!next[item.id]) next[item.id] = agentList.items[0]?.id ?? "";
        }
        return next;
      });
    } catch (error) {
      toast.error(describeError(error));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), 180);
    return () => window.clearTimeout(timer);
  }, [query, load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void get<{ ok: true; skill: Skill }>("skills.get", { id: selectedId })
      .then((result) => {
        if (!cancelled) setDetail(result.skill);
      })
      .catch((error) => {
        if (!cancelled) toast.error(describeError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function refreshDetail(skillId: string) {
    const result = await get<{ ok: true; skill: Skill }>("skills.get", { id: skillId });
    setDetail(result.skill);
  }

  async function install(skill: Skill, agentId: string) {
    if (!agentId) {
      toast.error("先在“虚拟员工”页建一个员工。");
      return;
    }
    try {
      const result = await post<{ ok: true; duplicate?: boolean; always_on?: boolean }>("skills.install", {
        skill_id: skill.id,
        agent_id: agentId,
      });
      const name = agents.find((agent) => agent.id === agentId)?.name ?? "员工";
      toast.success(result.duplicate ? `${name} 已经装过这个技能` : `已安装到 ${name}`);
      await load(query);
      if (selectedId === skill.id) await refreshDetail(skill.id);
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function download(skill: Skill) {
    try {
      const result = await post<{ ok: true; skill: Skill }>("skills.download", { id: skill.id });
      const body = result.skill.body ?? detail?.body ?? "";
      const file = new Blob([`# ${result.skill.name}\n\n${result.skill.summary}\n\n${body}\n`], {
        type: "text/markdown;charset=utf-8",
      });
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${result.skill.name}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success("已下载 .md 文件");
      await load(query);
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function upload() {
    if (!draft.name.trim() || !draft.summary.trim() || !draft.body.trim()) {
      toast.error("技能名、摘要和正文都要填。");
      return;
    }
    setBusy(true);
    try {
      const result = await post<{ ok: true; skill: Skill }>("skills.upload", {
        name: draft.name.trim(),
        summary: draft.summary.trim(),
        category: draft.category.trim() || "协作",
        body: draft.body.trim(),
        is_public: draft.is_public,
        is_default: draft.is_default && draft.is_public,
        agent_id: draft.agent_id || undefined,
      });
      toast.success("技能已上传");
      setUploadOpen(false);
      setDraft({ ...EMPTY, agent_id: draft.agent_id });
      await load(query);
      setSelectedId(result.skill.id);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 scrollbar-thin">
      <div className="mx-auto grid w-full max-w-[1180px] gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Skill Market</h1>
            <p className="text-xs text-muted-foreground">
              安装到指定虚拟员工；内置的「WorkStream 平台技能」与「DevStream 群文件与公告」默认对每个员工可见。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称、摘要或分类…"
              className="h-8 w-52 text-xs"
            />
            <Button
              size="sm"
              className="h-8 rounded-full text-xs"
              onClick={() => setUploadOpen((current) => !current)}
            >
              {uploadOpen ? "收起上传" : "上传技能"}
            </Button>
          </div>
        </div>

        {uploadOpen ? (
          <section className="ws-surface grid gap-3 rounded-xl bg-card p-3.5">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_120px]">
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
                  onChange={(event) => setDraft({ ...draft, is_public: event.target.checked, is_default: false })}
                />
                公开到市场
              </label>
              <label className={`flex items-center gap-1.5 text-xs ${draft.is_public ? "" : "opacity-50"}`}>
                <input
                  type="checkbox"
                  className="size-3.5"
                  style={{ accentColor: "var(--signal)" }}
                  checked={draft.is_default}
                  disabled={!draft.is_public}
                  onChange={(event) => setDraft({ ...draft, is_default: event.target.checked })}
                />
                作为新员工默认技能
              </label>
              <NativeSelect
                className="h-8 w-48 text-xs"
                value={draft.agent_id}
                onChange={(event) => setDraft({ ...draft, agent_id: event.target.value })}
              >
                <NativeSelectOption value="">上传后不安装</NativeSelectOption>
                {agents.map((agent) => (
                  <NativeSelectOption key={agent.id} value={agent.id}>安装到 {agent.name}</NativeSelectOption>
                ))}
              </NativeSelect>
              <Button
                size="sm"
                className="ml-auto h-8 rounded-full text-xs"
                disabled={busy}
                onClick={() => void upload()}
              >
                {busy ? "上传中…" : "上传技能"}
              </Button>
            </div>
          </section>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="grid content-start gap-2 sm:grid-cols-2">
            {items.map((skill) => {
              const target = targets[skill.id] ?? "";
              return (
                <article
                  key={skill.id}
                  className="ws-surface ws-surface-hover flex min-w-0 flex-col gap-2 rounded-xl bg-card p-3.5"
                  style={selectedId === skill.id
                    ? { borderColor: "color-mix(in srgb, var(--signal) 45%, transparent)" }
                    : undefined}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h2 className="min-w-0 truncate text-sm font-semibold">{skill.name}</h2>
                    <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                      {skill.category}
                    </Badge>
                    <Badge
                      variant="secondary"
                      className={`rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal ${
                        skill.always_on ? "bg-signal/12 text-signal" : ""
                      }`}
                    >
                      {sourceLabel(skill)}
                    </Badge>
                    {!skill.always_on && skill.is_default ? (
                      <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                        默认
                      </Badge>
                    ) : null}
                  </div>
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{skill.summary}</p>
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                    <div className="min-w-0 flex-1">
                      <NativeSelect
                        className="h-7 w-full text-[11px]"
                        value={target}
                        disabled={skill.always_on}
                        onChange={(event) => setTargets({ ...targets, [skill.id]: event.target.value })}
                      >
                        <NativeSelectOption value="">选员工…</NativeSelectOption>
                        {agents.map((agent) => (
                          <NativeSelectOption key={agent.id} value={agent.id}>{agent.name}</NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 rounded-full px-2.5 text-[11px]"
                      disabled={skill.always_on || !target}
                      onClick={() => void install(skill, target)}
                    >
                      {skill.always_on ? "默认启用" : "安装"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 rounded-full px-2 text-[11px]"
                      onClick={() => setSelectedId(skill.id)}
                    >
                      查看
                    </Button>
                  </div>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    安装 {skill.installs} · 下载 {skill.downloads} · {timeAgo(skill.created_at)}
                  </p>
                </article>
              );
            })}
            {items.length === 0 ? (
              <p className="text-xs text-muted-foreground">没有匹配的技能。换个关键词，或上传一个新的。</p>
            ) : null}
          </div>

          <aside className="self-start lg:sticky lg:top-3">
            <div className="ws-surface grid gap-3 rounded-xl bg-card p-3.5">
              {detail ? (
                <>
                  <div className="grid gap-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h2 className="text-sm font-semibold">{detail.name}</h2>
                      <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                        {detail.category}
                      </Badge>
                      {detail.always_on ? (
                        <Badge
                          variant="secondary"
                          className="rounded-full bg-signal/12 px-1.5 py-0 text-[10px] leading-4 font-normal text-signal"
                        >
                          内置
                        </Badge>
                      ) : detail.is_default ? (
                        <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                          默认
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{detail.summary}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <div className="min-w-0 flex-1">
                      <NativeSelect
                        className="h-8 w-full text-xs"
                        value={targets[detail.id] ?? ""}
                        disabled={detail.always_on}
                        onChange={(event) => setTargets({ ...targets, [detail.id]: event.target.value })}
                      >
                        <NativeSelectOption value="">选员工…</NativeSelectOption>
                        {agents.map((agent) => (
                          <NativeSelectOption key={agent.id} value={agent.id}>{agent.name}</NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 rounded-full px-3 text-xs"
                      disabled={detail.always_on || !targets[detail.id]}
                      onClick={() => void install(detail, targets[detail.id] ?? "")}
                    >
                      {detail.always_on ? "默认启用" : "安装"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 rounded-full px-3 text-xs"
                      onClick={() => void download(detail)}
                    >
                      下载
                    </Button>
                  </div>
                  <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 font-sans text-[11px] leading-relaxed scrollbar-thin">
                    {detail.body ?? "（这个技能没有正文）"}
                  </pre>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    安装 {detail.installs} · 下载 {detail.downloads}
                    {detail.always_on ? " · 始终启用" : ""}
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">选一个技能查看全文。</p>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
