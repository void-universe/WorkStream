// 虚拟员工：独立 Key 与 OpenAI 兼容地址、两级 memory（common / per-stream）、连通测试与队列。
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { describeCode, describeError, get, post, type Agent } from "../api";
import type {
  AgentPresenceDetail,
  MailItem,
  Memory,
  RemoteSkill,
  Skill,
  SkillUpdateIssue,
  SkillUpdateRow,
  Stream,
} from "../types";
import { shortUuid, timeAgo } from "../lib/format";
import { navigate } from "../lib/route";
import { AvatarPicker, Field, Notice, PersonAvatar, SectionTitle, TextInput } from "../lib/ui";
import { StreamFlow } from "./agents/StreamFlow";

type AgentDetail = {
  ok: true;
  agent: Agent;
  common_memory: Memory[];
  skills: Skill[];
  streams: { stream_id: string; role: string; joined_at: string }[];
  queue: MailItem[];
};

type Draft = {
  id?: string;
  name: string;
  role: string;
  signature: string;
  avatar: string;
  api_base_url: string;
  api_key: string;
  api_key_tail?: string;
  model: string;
  system_prompt: string;
  context_chars: number;
  status: "active" | "paused";
};

const EMPTY: Draft = {
  name: "",
  role: "",
  signature: "",
  avatar: "",
  api_base_url: "demo://local",
  api_key: "demo",
  model: "demo",
  system_prompt: "",
  context_chars: 200000,
  status: "active",
};

/** 搜索结果里的一个可装条目：本地行和远端条目归成同一个形状，装的动作各自走自己的接口。 */
type SkillHit = {
  key: string;
  name: string;
  summary: string;
  category: string;
  version: string;
  origin: string;
  installedHere: boolean;
  install: () => Promise<void>;
};

export function AgentsView({ onChanged, focusAgentId = "" }: { onChanged: () => Promise<void>; focusAgentId?: string }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [presence, setPresence] = useState<AgentPresenceDetail | null>(null);
  const [presenceError, setPresenceError] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [marketSkills, setMarketSkills] = useState<Skill[]>([]);
  const [remoteHits, setRemoteHits] = useState<RemoteSkill[]>([]);
  const [skillSearch, setSkillSearch] = useState("");
  const [updates, setUpdates] = useState<SkillUpdateRow[]>([]);
  const [updateIssues, setUpdateIssues] = useState<SkillUpdateIssue[]>([]);
  const [updateCheckedAt, setUpdateCheckedAt] = useState("");
  const [skillBusy, setSkillBusy] = useState("");
  const [busy, setBusy] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memoryScope, setMemoryScope] = useState<"common" | "stream">("common");
  const [memoryStream, setMemoryStream] = useState("");

  const refreshList = useCallback(async () => {
    try {
      const result = await get<{ ok: true; items: Agent[] }>("agents.list");
      setAgents(result.items);
      setSelected((current) => current || result.items[0]?.id || "");
      await onChanged();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setListLoaded(true);
    }
  }, [onChanged]);

  useEffect(() => {
    void refreshList();
    void get<{ ok: true; items: Stream[] }>("streams.mine").then((result) => setStreams(result.items)).catch(() => {});
    void get<{ ok: true; items: Skill[] }>("skills.market")
      .then((result) => setMarketSkills(result.items))
      .catch(() => {});
  }, [refreshList]);

  // 头像点进来带着 #/agents/<id>，直接落到这位员工的详情。
  useEffect(() => {
    if (focusAgentId) setSelected(focusAgentId);
  }, [focusAgentId]);

  const owned = selected ? agents.find((item) => item.id === selected) ?? null : null;
  const isGuest = Boolean(selected) && listLoaded && !owned;

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setPresence(null);
      setPresenceError("");
      return;
    }
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const next = await get<AgentPresenceDetail>("agents.presence", { agent_id: selected });
        if (!alive) return;
        setPresence(next);
        setPresenceError("");
      } catch (error) {
        if (alive) setPresenceError(describeError(error));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [selected]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    const agent = agents.find((item) => item.id === selected);
    if (!agent) return;
    setDraft({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      signature: agent.signature ?? "",
      avatar: agent.avatar ?? "",
      api_base_url: agent.api_base_url,
      api_key: "",
      api_key_tail: agent.api_key_tail,
      model: agent.model,
      system_prompt: agent.system_prompt,
      context_chars: agent.context_chars,
      status: agent.status,
    });
    void (async () => {
      try {
        setDetail(await get<AgentDetail>("agents.get", { id: selected }));
        setMemories(await loadMemories(selected));
      } catch (error) {
        toast.error(describeError(error));
      }
    })();
  }, [selected, agents]);

  const streamNames = useMemo(() => new Map(streams.map((stream) => [stream.id, stream.name])), [streams]);
  const installedIds = useMemo(
    () => new Set((detail?.skills ?? []).map((skill) => skill.id)),
    [detail],
  );
  const hasRemoteSkills = useMemo(
    () => (detail?.skills ?? []).some((skill) => skill.source_registry_id),
    [detail],
  );
  const updateById = useMemo(() => new Map(updates.map((row) => [row.skill_id, row])), [updates]);

  // 技能区搜索：本地市场在内存里过滤，远端源要现拉，所以起词后才发请求。
  useEffect(() => {
    const needle = skillSearch.trim();
    if (needle.length < 2) {
      setRemoteHits([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void get<{ ok: true; items: RemoteSkill[] }>("skills.remoteList", { q: needle })
        .then((result) => {
          if (alive) setRemoteHits(result.items);
        })
        .catch((error) => {
          if (alive) toast.error(describeError(error));
        });
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [skillSearch]);

  // 装了远端快照就自动比一次版本，界面上才知道该不该冒「更新」按钮。
  const checkUpdates = useCallback(async (agentId: string) => {
    setSkillBusy("check");
    try {
      const result = await get<{ ok: true; items: SkillUpdateRow[]; unavailable: SkillUpdateIssue[]; checked_at: string }>(
        "skills.checkUpdates",
        { agent_id: agentId },
      );
      setUpdates(result.items);
      setUpdateIssues(result.unavailable);
      setUpdateCheckedAt(result.checked_at);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setSkillBusy("");
    }
  }, []);

  useEffect(() => {
    if (!selected || !hasRemoteSkills) {
      setUpdates([]);
      setUpdateIssues([]);
      setUpdateCheckedAt("");
      return;
    }
    void checkUpdates(selected);
  }, [selected, hasRemoteSkills, detail, checkUpdates]);

  async function loadMemories(agentId: string, scope?: "common" | "stream", streamId?: string): Promise<Memory[]> {
    const result = await get<{ ok: true; items: Memory[] }>("agents.memory.list", {
      agent_id: agentId,
      scope,
      stream_id: streamId,
    });
    return result.items;
  }

  const skillHits: SkillHit[] = useMemo(() => {
    const needle = skillSearch.trim().toLowerCase();
    if (needle.length < 2) return [];
    // 远端源搜到的条目优先：同一源+slug 的本地快照不再单独列，否则一条技能出现两行、装的还是不同版本。
    const remoteKeys = new Set(remoteHits.map((item) => `${item.registry_id}:${item.slug}`));
    const local = marketSkills
      .filter((skill) => !skill.always_on
        && !remoteKeys.has(`${skill.source_registry_id}:${skill.source_slug}`)
        && [skill.name, skill.summary, skill.category]
          .some((value) => String(value ?? "").toLowerCase().includes(needle)))
      .map((skill): SkillHit => ({
        key: `local:${skill.id}`,
        name: skill.name,
        summary: skill.summary,
        category: skill.category,
        version: skill.version ?? "",
        origin: skill.source === "remote" ? "本地快照" : skill.is_public ? "本地市场" : "仅自己",
        installedHere: installedIds.has(skill.id),
        install: async () => {
          const result = await post<{ ok: true; added?: number; already?: number; duplicate?: boolean }>(
            "skills.install", { skill_id: skill.id, agent_id: selected });
          toast.success(result.duplicate || result.added === 0 ? `${skill.name} 已经在这位员工身上` : `已装上 ${skill.name}`);
        },
      }));
    const remote = remoteHits.map((item): SkillHit => ({
      key: `remote:${item.registry_id}:${item.slug}`,
      name: item.name,
      summary: item.summary,
      category: item.category,
      version: item.version,
      origin: item.registry_name,
      installedHere: Boolean(item.installed_skill_id) && installedIds.has(item.installed_skill_id as string),
      install: async () => {
        const result = await post<{ ok: true; skill: Skill }>("skills.remoteInstall", {
          registry_id: item.registry_id, slug: item.slug, agent_id: selected,
        });
        toast.success(`已抄成快照装上 ${result.skill.name} v${result.skill.version ?? "—"}`);
      },
    }));
    return [...local, ...remote];
  }, [skillSearch, marketSkills, remoteHits, installedIds, selected]);

  async function runInstall(hit: SkillHit) {
    if (!selected || hit.installedHere) return;
    setSkillBusy(hit.key);
    try {
      await hit.install();
      await refreshDetail();
      setSkillSearch("");
      setRemoteHits([]);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setSkillBusy("");
    }
  }

  async function save() {
    if (!draft.name.trim() || !draft.role.trim()) {
      toast.error("名字和岗位描述都要填。");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        role: draft.role.trim(),
        signature: draft.signature.trim(),
        avatar: draft.avatar,
        model: draft.model.trim(),
        system_prompt: draft.system_prompt,
        context_chars: Number(draft.context_chars),
        api_base_url: draft.api_base_url.trim(),
        status: draft.status,
      };
      if (draft.id) {
        body.id = draft.id;
        if (draft.api_key.trim()) body.api_key = draft.api_key.trim();
        await post("agents.update", body);
        toast.success("已保存");
      } else {
        if (!draft.api_key.trim()) {
          toast.error("新建虚拟员工要有 Key；想先试流程就用演示端点。");
          return;
        }
        body.api_key = draft.api_key.trim();
        const created = await post<{ ok: true; agent: Agent }>("agents.create", body);
        toast.success("虚拟员工已建档");
        setSelected(created.agent.id);
        navigate(`/agents/${created.agent.id}`);
      }
      await refreshList();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    if (!draft.id) {
      toast.error("先保存，再测连通——Key 只在服务端解得开。");
      return;
    }
    setBusy(true);
    try {
      const result = await post<{ ok: true; result: { reachable: boolean; ms: number; reply?: string; mode?: string; error?: string } }>(
        "agents.test",
        { id: draft.id },
      );
      if (result.result.reachable) toast.success(`通了，${result.result.ms}ms · ${result.result.mode ?? ""} ${result.result.reply ?? ""}`);
      else toast.error(`没通（${result.result.error}）：${result.result.ms}ms`);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft.id) return;
    try {
      await post("agents.delete", { id: draft.id });
      toast.success("已删除");
      setSelected("");
      setPresence(null);
      navigate("/agents");
      await refreshList();
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function addMemory() {
    if (!memoryDraft.trim() || !selected) return;
    try {
      await post("agents.memory.put", {
        agent_id: selected,
        content: memoryDraft.trim(),
        scope: memoryScope,
        stream_id: memoryScope === "stream" ? memoryStream : undefined,
        kind: "note",
      });
      setMemoryDraft("");
      setMemories(await loadMemories(selected));
      toast.success("记忆已写入");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function refreshDetail() {
    if (!selected) return;
    try {
      setDetail(await get<AgentDetail>("agents.get", { id: selected }));
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function uninstallSkill(skill: Skill) {
    if (!selected) return;
    try {
      await post<{ ok: true }>("skills.uninstall", { skill_id: skill.id, agent_id: selected });
      toast.success("技能已卸载");
      await refreshDetail();
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function updateSkill(skill: Skill) {
    setSkillBusy(skill.id);
    try {
      const result = await post<{ ok: true; skill: Skill; from_version: string; to_version: string }>(
        "skills.remoteUpdate", { skill_id: skill.id });
      toast.success(`${skill.name}：v${result.from_version || "—"} → v${result.to_version || "—"}`);
      await refreshDetail();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setSkillBusy("");
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 xl:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-b p-4 scrollbar-thin xl:border-b-0 xl:border-r">
        <SectionTitle
          aside={
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => {
                setDraft(EMPTY);
                setSelected("");
                setDetail(null);
                setPresence(null);
                navigate("/agents");
              }}
            >
              新建
            </Button>
          }
        >
          我的虚拟员工 · {agents.length}
        </SectionTitle>
        <div className="grid gap-1.5">
          {agents.length === 0 ? <p className="text-xs text-muted-foreground">还没有虚拟员工。右边填一份档案就能开工。</p> : null}
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => {
                setSelected(agent.id);
                navigate(`/agents/${agent.id}`);
              }}
              className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                selected === agent.id ? "bg-muted" : "hover:bg-muted/50"
              }`}
            >
              <PersonAvatar
                name={agent.name}
                kind="agent"
                color={agent.color}
                avatar={agent.avatar}
                busy={selected === agent.id ? Boolean(presence?.current) : false}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{agent.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {agent.model} · {agent.status === "paused" ? "已暂停" : "在岗"}
                </span>
                {agent.signature ? (
                  <span className="block truncate text-[11px] text-muted-foreground">「{agent.signature}」</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="min-h-0 overflow-y-auto p-4 scrollbar-thin">
        {isGuest ? (
          <GuestProfile detail={presence} error={presenceError} />
        ) : (
          <>
            <Card className="mb-4">
          <CardContent className="grid gap-4 pt-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{draft.id ? `编辑 · ${draft.name}` : "新建虚拟员工"}</h2>
              <div className="flex gap-2">
                {draft.id ? (
                  <>
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => void testConnection()} disabled={busy}>
                      连通测试
                    </Button>
                    <Button size="sm" variant="outline" className="text-xs text-destructive hover:text-destructive" onClick={() => void remove()}>
                      删除
                    </Button>
                  </>
                ) : null}
                <Button size="sm" className="text-xs" onClick={() => void save()} disabled={busy}>
                  {busy ? "保存中…" : "保存档案"}
                </Button>
              </div>
            </div>

            <Field label="头像" hint="群聊、成员列表与员工页都会用这张图；不设就用名字首字。">
              <AvatarPicker
                name={draft.name || "新员工"}
                kind="agent"
                color={agents.find((item) => item.id === draft.id)?.color}
                avatar={draft.avatar}
                onChange={(next) => setDraft((current) => ({ ...current, avatar: next }))}
              />
            </Field>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="名字" htmlFor="agent-name">
                <TextInput id="agent-name" value={draft.name} maxLength={48} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="如：小审" className="h-8 text-xs" />
              </Field>
              <Field label="岗位描述" htmlFor="agent-role" hint="写清 ta 负责什么、交付什么，群里 @ ta 时这就是任务背景。">
                <TextInput id="agent-role" value={draft.role} maxLength={400} onChange={(event) => setDraft({ ...draft, role: event.target.value })} placeholder="如：负责验收清单整理与回归项跟踪" className="h-8 text-xs" />
              </Field>
              <Field label="OpenAI 兼容 base URL" htmlFor="agent-base" hint="线上必须是 https，且不能指向内网/元数据地址。">
                <TextInput id="agent-base" value={draft.api_base_url} onChange={(event) => setDraft({ ...draft, api_base_url: event.target.value })} className="h-8 font-mono text-xs" />
              </Field>
              <Field label="模型名" htmlFor="agent-model" hint="演示端点（demo://local）固定填 demo，可在没 Key 时把整条流程跑通。">
                <TextInput id="agent-model" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} className="h-8 font-mono text-xs" />
              </Field>
              <Field label="API Key" htmlFor="agent-key" hint="AES-GCM 加密后入库，接口与浏览器都拿不到原文；留空表示不更换。">
                <Input id="agent-key" type="password" value={draft.api_key} onChange={(event) => setDraft({ ...draft, api_key: event.target.value })} placeholder={draft.id ? "留空保持原 Key" : "sk-…"} className="h-8 text-xs" />
              </Field>
              <Field label="上下文预算（字符）" htmlFor="agent-context" hint="单轮能带进模型的字符上限，和群预算取较小值。中文约 1 字≈1 token、英文约 4 字符≈1 token：256K 窗口的模型填 20 万，百万窗口的可以拉到 200 万。">
                <Input id="agent-context" type="number" min={2000} max={2000000} step={20000} value={draft.context_chars} onChange={(event) => setDraft({ ...draft, context_chars: Number(event.target.value) })} className="h-8 text-xs" />
              </Field>
            </div>

            <Field label="个性签名" htmlFor="agent-signature" hint="群里头像旁的一行小字；员工自己也能用 set_signature 工具改。留空则不显示。">
              <TextInput
                id="agent-signature"
                value={draft.signature}
                maxLength={120}
                onChange={(event) => setDraft({ ...draft, signature: event.target.value })}
                placeholder="如：验收清单控，交付前必跑回归"
                className="h-8 text-xs"
              />
            </Field>

            <Field label="系统提示词" htmlFor="agent-system" hint="决定 ta 的语气、边界和什么时候该用 MCP 回查历史。">
              <Textarea id="agent-system" rows={3} value={draft.system_prompt} onChange={(event) => setDraft({ ...draft, system_prompt: event.target.value })} className="text-xs" />
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <Field label="状态">
                <NativeSelect className="h-8 text-xs" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as "active" | "paused" })}>
                  <NativeSelectOption value="active">在岗</NativeSelectOption>
                  <NativeSelectOption value="paused">暂停接活</NativeSelectOption>
                </NativeSelect>
              </Field>
              <div className="flex items-end gap-2 pb-0.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={() => setDraft({ ...draft, api_base_url: "demo://local", model: "demo", api_key: draft.api_key || "demo" })}
                >
                  用演示端点填空
                </Button>
                {draft.id ? <p className="text-xs text-muted-foreground">Key 尾号 {draft.api_key_tail ?? "—"}</p> : null}
              </div>
            </div>
          </CardContent>
        </Card>

        <AgentPresenceStrip detail={presence} error={presenceError} />
        {presence ? <StreamFlow detail={presence} /> : null}

        {detail ? (
          <Tabs defaultValue="memory" className="min-h-0">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="memory" className="text-xs">记忆</TabsTrigger>
              <TabsTrigger value="skills" className="text-xs">技能</TabsTrigger>
              <TabsTrigger value="groups" className="text-xs">所在群</TabsTrigger>
              <TabsTrigger value="queue" className="text-xs">邮箱队列</TabsTrigger>
            </TabsList>

            <TabsContent value="memory" className="grid gap-3 pt-3">
              <Notice>
                两段记忆：common 跟着员工走，per-stream 只在这个群里生效。窗口超预算时系统会自动写一条
                <code className="mx-1 font-mono">summary</code>并把覆盖点记在 covers_through_seq 上。
              </Notice>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="写入范围">
                  <NativeSelect className="h-8 text-xs" value={memoryScope} onChange={(event) => setMemoryScope(event.target.value as "common" | "stream")}>
                    <NativeSelectOption value="common">common</NativeSelectOption>
                    <NativeSelectOption value="stream">per-stream</NativeSelectOption>
                  </NativeSelect>
                </Field>
                {memoryScope === "stream" ? (
                  <Field label="群">
                    <NativeSelect className="h-8 w-40 text-xs" value={memoryStream} onChange={(event) => setMemoryStream(event.target.value)}>
                      <NativeSelectOption value="">选择群…</NativeSelectOption>
                      {detail.streams.map((row) => (
                        <NativeSelectOption key={row.stream_id} value={row.stream_id}>
                          {streamNames.get(row.stream_id) ?? shortUuid(row.stream_id)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                ) : null}
                <div className="min-w-56 flex-1">
                  <Field label="内容">
                    <TextInput value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} placeholder="如：交付前先跑一遍验收清单" className="h-8 text-xs" />
                  </Field>
                </div>
                <Button size="sm" className="h-8 text-xs" disabled={!memoryDraft.trim() || (memoryScope === "stream" && !memoryStream)} onClick={() => void addMemory()}>
                  写入
                </Button>
              </div>
              <div className="grid gap-1.5">
                {memories.map((memory) => (
                  <div key={memory.id} className="flex items-start gap-2 rounded-md border px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-relaxed">{memory.content}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                        {memory.scope} · {memory.kind}
                        {memory.stream_id ? ` · ${streamNames.get(memory.stream_id) ?? shortUuid(memory.stream_id)}` : ""}
                        {memory.covers_through_seq ? ` · 覆盖到 #${memory.covers_through_seq}` : ""}
                        {memory.source === "engine" ? " · 自动压缩" : ""} · {timeAgo(memory.created_at)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-destructive"
                      onClick={() => {
                        void (async () => {
                          try {
                            await post("agents.memory.delete", { id: memory.id, agent_id: selected });
                            setMemories(await loadMemories(selected));
                          } catch (error) {
                            toast.error(describeError(error));
                          }
                        })();
                      }}
                    >
                      删除
                    </Button>
                  </div>
                ))}
              </div>
              <Button size="sm" variant="ghost" className="justify-self-start text-xs" onClick={() => void loadMemories(selected).then(setMemories)}>
                只看 common
              </Button>
            </TabsContent>

            <TabsContent value="skills" className="grid gap-3 pt-3">
              <Notice>
                技能会作为操作说明写进这个员工的上下文；内置的「WorkStream 平台技能」与
                「DevStream 群文件与公告」始终启用，
                带「默认」标记的公共技能在建档时已自动安装。这里搜到的技能只装给当前这一位。
              </Notice>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={skillSearch}
                  onChange={(event) => setSkillSearch(event.target.value)}
                  placeholder="搜本地市场和远端技能源…"
                  className="h-8 w-60 text-xs"
                />
                {hasRemoteSkills ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-full text-xs"
                    disabled={skillBusy === "check"}
                    onClick={() => void checkUpdates(selected)}
                  >
                    {skillBusy === "check" ? "比对中…" : "复查版本"}
                  </Button>
                ) : null}
                {updateCheckedAt ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    版本自查于 {timeAgo(updateCheckedAt)}
                  </span>
                ) : null}
                <a href="#/market/skills" className="ml-auto text-xs text-signal hover:underline">
                  要装给多个员工 → Market
                </a>
              </div>

              {skillSearch.trim().length >= 2 && skillHits.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  本地市场和远端技能源里都没有「{skillSearch.trim()}」。换个关键词，或到 Market
                  的远端技能源里先加一个源。
                </p>
              ) : null}
              {skillHits.length > 0 ? (
                <div className="ws-surface grid gap-1.5 rounded-xl bg-card p-3">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    搜索结果 · 只装给 {detail.agent.name}
                  </p>
                  {skillHits.map((hit) => (
                    <div key={hit.key} className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2">
                      {/* overflow-hidden 让 nowrap 的摘要不再把栅格列撑出视口。 */}
                      <span className="min-w-0 flex-1 overflow-hidden">
                        <span className="flex flex-wrap items-center gap-1.5 text-sm">
                          <span className="truncate">{hit.name}</span>
                          {hit.version ? (
                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">v{hit.version}</span>
                          ) : null}
                          <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                            {hit.origin}
                          </Badge>
                        </span>
                        <span className="line-clamp-2 text-[11px] text-muted-foreground">{hit.summary}</span>
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 rounded-full px-2.5 text-[11px]"
                        disabled={hit.installedHere || (skillBusy !== "" && skillBusy !== "check")}
                        onClick={() => void runInstall(hit)}
                      >
                        {hit.installedHere ? "已装" : skillBusy === hit.key ? "安装中…" : "安装"}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}

              {updateIssues.length > 0 ? (
                <Notice tone="warn">
                  {updateIssues.map((issue) => `${issue.name}（${describeCode(issue.reason)}）`).join("；")}
                  —— 这些远端技能暂时比不了版本，源恢复后再复查。
                </Notice>
              ) : null}

              <div className="grid gap-1.5">
                {(detail.skills ?? []).map((skill) => {
                  const row = updateById.get(skill.id);
                  return (
                    <div key={skill.id} className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2">
                      <span className="min-w-0 flex-1 overflow-hidden">
                        <span className="flex flex-wrap items-center gap-1.5 text-sm">
                          <span className="truncate">{skill.name}</span>
                          {skill.always_on ? (
                            <Badge variant="secondary" className="rounded-full bg-signal/12 px-1.5 py-0 text-[10px] leading-4 font-normal text-signal">
                              内置
                            </Badge>
                          ) : skill.is_default ? (
                            <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                              默认
                            </Badge>
                          ) : null}
                          {skill.source === "remote" ? (
                            <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                              远端快照
                            </Badge>
                          ) : null}
                          {row?.update_available ? (
                            <Badge variant="secondary" className="rounded-full bg-machine-soft px-1.5 py-0 text-[10px] leading-4 font-normal text-machine">
                              可更新 v{row.latest_version}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="line-clamp-2 text-[11px] text-muted-foreground">{skill.summary}</span>
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">{skill.category}</span>
                      {skill.version ? (
                        <span className="font-mono text-[11px] text-muted-foreground">v{skill.version}</span>
                      ) : null}
                      {skill.always_on ? (
                        <span className="text-[11px] text-muted-foreground">始终启用</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          {row?.update_available && skill.source_registry_id ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 rounded-full px-2.5 text-[11px]"
                              disabled={skillBusy !== "" && skillBusy !== "check"}
                              onClick={() => void updateSkill(skill)}
                            >
                              {skillBusy === skill.id ? "更新中…" : "更新"}
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-destructive"
                            disabled={skillBusy === skill.id}
                            onClick={() => void uninstallSkill(skill)}
                          >
                            卸载
                          </Button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </TabsContent>

            <TabsContent value="groups" className="grid gap-1.5 pt-3">
              {detail.streams.length === 0 ? <p className="text-xs text-muted-foreground">还没进过任何群。</p> : null}
              {detail.streams.map((row) => {
                const name = streamNames.get(row.stream_id) ?? shortUuid(row.stream_id);
                const live = presence?.streams.find((item) => item.stream_id === row.stream_id);
                return (
                  <div key={row.stream_id} className="relative flex items-center gap-2 rounded-md border px-2.5 py-2 text-sm hover:bg-muted/50">
                    {/* 整行即入口：透明铺底按钮接点击，权重控件浮在它之上。 */}
                    <a
                      href={`#/stream/${row.stream_id}`}
                      aria-label={`进入群聊 ${name}`}
                      className="absolute inset-0 z-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                    />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{row.role}</span>
                    {live && (live.queued || live.running) ? (
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        排队 {live.queued} · 运行 {live.running}
                      </span>
                    ) : null}
                    {live ? <span className="relative z-10"><WeightField agentId={detail.agent.id} streamId={row.stream_id} streamName={name} weight={live.weight} /></span> : null}
                  </div>
                );
              })}
            </TabsContent>

            <TabsContent value="queue" className="grid gap-1.5 pt-3">
              {detail.queue.length === 0 ? <p className="text-xs text-muted-foreground">邮箱是空的。群里 @ ta 就会落一封任务进来。</p> : null}
              {detail.queue.map((item) => (
                <div key={item.id} className="flex items-center gap-2 rounded-md border px-2.5 py-2">
                  <Badge
                    variant={item.status === "running" ? "default" : item.status === "failed" ? "destructive" : "secondary"}
                    className="rounded-sm font-mono text-[11px]"
                  >
                    {item.status}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {streamNames.get(item.stream_id) ?? shortUuid(item.stream_id)}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    权重 {item.priority} · 时间片 {item.slice_count}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{timeAgo(item.created_at)}</span>
                  {item.error ? <span className="text-[11px] text-destructive">{item.error}</span> : null}
                </div>
              ))}
            </TabsContent>
          </Tabs>
        ) : (
          <p className="text-xs text-muted-foreground">选一个虚拟员工，或填一份新档案。</p>
        )}
          </>
        )}
      </section>
    </div>
  );
}

const MAIL_TONE: Record<MailItem["status"], { label: string; className: string }> = {
  queued: { label: "未读", className: "bg-signal/12 text-signal" },
  running: { label: "处理中", className: "bg-machine/12 text-machine" },
  done: { label: "已读", className: "bg-muted text-muted-foreground" },
  failed: { label: "处理失败", className: "bg-destructive/10 text-destructive" },
  cancelled: { label: "已取消", className: "bg-muted text-muted-foreground" },
};

function MailBadge({ status }: { status: MailItem["status"] }) {
  const tone = MAIL_TONE[status] ?? MAIL_TONE.done;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] leading-4 ${tone.className}`}>
      {status === "running" ? (
        <span className="size-2 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />
      ) : null}
      {tone.label}
    </span>
  );
}

/** 本群时间片权重：默认 1 即均分；调到 1–20 需要在这个群里是群主或管理员，否则后端会挡。 */
function WeightField({
  agentId,
  streamId,
  streamName,
  weight,
}: {
  agentId: string;
  streamId: string;
  streamName: string;
  weight: number;
}) {
  const [value, setValue] = useState(weight);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(weight), [weight]);
  const dirty = value !== weight;

  async function save() {
    setBusy(true);
    try {
      await post("scheduler.weight", { stream_id: streamId, agent_id: agentId, weight: value });
      toast.success(`「${streamName}」的权重已设为 ${value}`);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">本群权重</span>
      <Input
        type="number"
        min={1}
        max={20}
        value={value}
        disabled={busy}
        onChange={(event) => setValue(Number(event.target.value))}
        className="h-7 w-14 text-xs"
      />
      {dirty ? (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void save()}>
          保存
        </Button>
      ) : null}
    </span>
  );
}

/** 主人视角的实时现场：正在处理哪条、还排着几封。 */
function AgentPresenceStrip({ detail, error }: { detail: AgentPresenceDetail | null; error: string }) {
  if (error && !detail) return <Notice>{error}</Notice>;
  if (!detail) return null;
  const current = detail.current;
  const currentItem = current ? detail.queue.find((item) => item.id === current.mail_id) ?? null : null;
  const queued = detail.queue.filter((item) => item.status === "queued").length;
  return (
    <Card className="mb-4">
      <CardContent className="grid gap-2 pt-5 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          {current ? (
            <Badge className="gap-1.5 rounded-sm bg-machine/12 text-[11px] font-normal text-machine">
              <span className="size-2 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />
              处理中
            </Badge>
          ) : (
            <Badge variant="secondary" className="rounded-sm text-[11px] font-normal">空闲</Badge>
          )}
          {current ? (
            <span className="min-w-0 truncate text-xs">
              {currentItem?.stream_name ?? "未知群"} · 第 #{current.seq || "—"} 条
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">邮箱里没有进行中的任务。</span>
          )}
          {queued ? <Badge variant="secondary" className="rounded-sm font-mono text-[11px]">排队 {queued}</Badge> : null}
          <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            {current?.started_at ? <span>开始于 {timeAgo(current.started_at)}</span> : null}
            <span className="inline-flex items-center gap-1">
              <span className="size-1.5 animate-pulse rounded-full bg-signal" aria-hidden />
              每 5 秒自动刷新
            </span>
          </span>
        </div>
        {current?.preview ? (
          <p className="truncate text-xs text-muted-foreground">{current.preview}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** 非主人视角：只显示群成员本就可见的资料与共同群里的现场，不碰 Key、提示词与记忆。 */
function GuestProfile({ detail, error }: { detail: AgentPresenceDetail | null; error: string }) {
  if (!detail) {
    return error ? (
      <Notice>{error}</Notice>
    ) : (
      <p className="text-xs text-muted-foreground">正在读取现场…</p>
    );
  }
  const { profile, owner } = detail;
  const current = detail.current;
  const currentItem = current ? detail.queue.find((item) => item.id === current.mail_id) ?? null : null;
  return (
    <div className="grid gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-start gap-4 pt-6">
          <PersonAvatar name={profile.name} kind="agent" color={profile.color} avatar={profile.avatar} className="size-12 text-sm" busy={Boolean(current)} />
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
              {profile.name}
              <Badge variant={profile.status === "paused" ? "secondary" : "outline"} className="rounded-sm text-[10px] font-normal">
                {profile.status === "paused" ? "暂停接活" : "在岗"}
              </Badge>
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{profile.role}</p>
            {profile.signature ? <p className="mt-1 text-xs text-muted-foreground">「{profile.signature}」</p> : null}
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              主人 {owner.display_name} · 建档于 {timeAgo(profile.created_at)}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-2 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            {current ? (
              <>
                <Badge className="gap-1.5 rounded-sm bg-machine/12 text-[11px] font-normal text-machine">
                  <span className="size-2 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />
                  处理中
                </Badge>
                <span className="min-w-0 truncate text-sm">
                  {currentItem?.stream_name ?? "未知群"} · 第 #{current.seq || "—"} 条
                </span>
                {current.started_at ? <span className="text-[11px] text-muted-foreground">开始于 {timeAgo(current.started_at)}</span> : null}
              </>
            ) : (
              <span className="text-sm text-muted-foreground">现在空闲。</span>
            )}
          </div>
          {current?.preview ? <p className="truncate text-xs text-muted-foreground">{current.preview}</p> : null}
          {detail.streams.length === 0 ? null : (
            <div className="mt-1 grid gap-1.5">
              {detail.streams.map((row) => (
                <a
                  key={row.stream_id}
                  href={`#/stream/${row.stream_id}`}
                  className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-sm transition-colors hover:bg-muted/50"
                >
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  {row.queued ? <Badge variant="secondary" className="rounded-sm font-mono text-[10px]">排队 {row.queued}</Badge> : null}
                  {row.running ? <Badge className="rounded-sm font-mono text-[10px]">运行 {row.running}</Badge> : null}
                  <span className="text-xs text-signal">进入 →</span>
                </a>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <StreamFlow detail={detail} />

      <Card>
        <CardContent className="grid gap-1.5 pt-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">最近的邮箱动态</h3>
            <span className="text-[11px] text-muted-foreground">只含你们共同所在的群</span>
          </div>
          {detail.queue.length === 0 ? <p className="text-xs text-muted-foreground">共同群里的邮箱还是空的。</p> : null}
          {detail.queue.slice(0, 20).map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded-md border px-2.5 py-2">
              <MailBadge status={item.status} />
              <span className="min-w-0 flex-1 truncate text-xs">
                {item.stream_name} · #{item.seq || "—"} {item.preview}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(item.created_at)}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        员工档案归主人所有；这里只展示群成员本就能看到的信息，不包含 API Key、系统提示词与记忆。
      </p>
    </div>
  );
}
