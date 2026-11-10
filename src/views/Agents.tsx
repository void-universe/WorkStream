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
import { useI18n, type MsgKey } from "../lib/i18n";

type AgentDetail = {
  ok: true;
  agent: Agent;
  common_memory: Memory[];
  skills: Skill[];
  streams: { stream_id: string; role: string; joined_at: string }[];
  queue: MailItem[];
};

type Backend = "openai" | "qca" | "stream";

/** agents.test 的回报。规范对接那一档多带一组发现事实：走哪一档是问出来的，不是猜的，
 *  所以这一组要照原样上屏（`speaks_spec` 缺席即"这次不是规范对接那一档的自检"）。 */
type TestResult = {
  reachable: boolean;
  ms: number;
  reply?: string | null;
  mode?: string;
  error?: string;
  speaks_spec?: boolean;
  stored?: boolean;
  profile?: string;
  spec?: string | null;
  profiles?: string[];
  models?: string[] | null;
  code?: string | null;
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
  backend: Backend;
  qca_agent_id: string;
  /** 切走之前那个自建端点地址，切回自建时还给他，不用重新手打。 */
  prev_openai_url: string;
};

/** 云端 Agent 的默认 API 地址（CN 区）；换区或私有部署就在字段里改成对应 origin。 */
const QCA_ORIGIN = "https://api.qoder.com.cn";

/** 云端 Agent 那一档不认模型名，档案里存这个占位值；切走时要认得它才敢覆盖用户真填的模型。 */
const QCA_MODEL = "云端 Agent";

/** 切后端只换该换的：演示地址与云端地址互相预置，令牌一律留空让用户重填——
 *  三种后端的凭据不是一类东西，服务端也会拦"换了后端却没给新凭据"。 */
function switchBackend(current: Draft, next: Backend): Draft {
  if (next === current.backend) return current;
  const kept = current.model === QCA_MODEL || !current.model ? "demo" : current.model;
  return {
    ...current,
    backend: next,
    // 切到云端就填 Cloud Agents 的 origin：留着自建端点的地址只会让人拿 PAT 去打 deepseek。
    // 切回自建时把切走前那个地址还回去，没存过才回演示端点。
    // 切到规范对接要清空：这一档保存前必须发一次真实的发现请求，预置演示端点只会换来一句
    // stream_needs_real_origin——空字段比一个填好了却不能用的地址更容易看懂。
    api_base_url: next === "qca" ? QCA_ORIGIN : next === "stream" ? "" : (current.prev_openai_url || "demo://local"),
    prev_openai_url: next === "openai" ? "" : (current.backend === "openai" ? current.api_base_url : current.prev_openai_url),
    model: next === "qca" ? QCA_MODEL : kept,
    api_key: "",
  };
}

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
  backend: "openai",
  qca_agent_id: "",
  prev_openai_url: "demo://local",
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
  const i18n = useI18n();
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
      toast.error(describeError(i18n, error));
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
        if (alive) setPresenceError(describeError(i18n, error));
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
      backend: agent.backend === "qca" ? "qca" : agent.backend === "stream" ? "stream" : "openai",
      qca_agent_id: agent.qca_agent_id ?? "",
      prev_openai_url: (agent.backend ?? "openai") === "openai" ? agent.api_base_url : "",
    });
    void (async () => {
      try {
        setDetail(await get<AgentDetail>("agents.get", { id: selected }));
        setMemories(await loadMemories(selected));
      } catch (error) {
        toast.error(describeError(i18n, error));
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

  // 「自动写一条 summary」在句子里夹着 <code>，拆不成整句，所以按 {0} 切两段、中间自己塞。
  const memoryParts = i18n.tp("agent.memoryNotice");

  // 三种后端各自一整套字段文案。取词必须写字面量键：改成变量取词，字典那道静态对账就看不见了。
  const streamProfile = agents.find((item) => item.id === draft.id)?.stream_profile ?? null;
  const copy = draft.backend === "qca"
    ? {
        urlLabel: i18n.t("agent.qcaUrlLabel"),
        urlHint: i18n.t("agent.qcaUrlHint"),
        modelLabel: i18n.t("agent.qcaModelLabel"),
        modelHint: i18n.t("agent.qcaModelHint"),
        keyLabel: i18n.t("agent.patLabel"),
        keyHint: i18n.t("agent.patHint"),
        keyPlaceholder: "pt-…",
        notice: i18n.t("agent.qcaNotice"),
        signatureHint: i18n.t("agent.signatureQcaHint"),
        systemHint: i18n.t("agent.systemQcaHint"),
      }
    : draft.backend === "stream"
      ? {
          urlLabel: i18n.t("agent.streamUrlLabel"),
          urlHint: i18n.t("agent.streamUrlHint"),
          modelLabel: i18n.t("agent.streamModelLabel"),
          modelHint: i18n.t("agent.streamModelHint"),
          keyLabel: i18n.t("agent.streamKeyLabel"),
          keyHint: i18n.t("agent.streamKeyHint"),
          keyPlaceholder: draft.id ? i18n.t("agent.keyKeepPlaceholder") : "",
          notice: i18n.t("agent.streamNotice"),
          // 专属档的工具在对方那侧，我们的 set_signature 发不过去：这两句要按档案里那一格的结论换措辞，
          // 不能一律照分时档说"员工自己也能改"。
          signatureHint: streamProfile === "dedicated" ? i18n.t("agent.signatureStreamHint") : i18n.t("agent.signatureHint"),
          systemHint: streamProfile === "dedicated" ? i18n.t("agent.systemStreamHint") : i18n.t("agent.systemHint"),
        }
      : {
          urlLabel: i18n.t("agent.openaiUrlLabel"),
          urlHint: i18n.t("agent.openaiUrlHint"),
          modelLabel: i18n.t("agent.modelLabel"),
          modelHint: i18n.t("agent.modelHint"),
          keyLabel: "API Key",
          keyHint: i18n.t("agent.keyHint"),
          keyPlaceholder: draft.id ? i18n.t("agent.keyKeepPlaceholder") : "sk-…",
          notice: "",
          signatureHint: i18n.t("agent.signatureHint"),
          systemHint: i18n.t("agent.systemHint"),
        };

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
          if (alive) toast.error(describeError(i18n, error));
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
      toast.error(describeError(i18n, error));
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
        origin: skill.source === "remote" ? i18n.t("agent.originSnapshot") : skill.is_public ? i18n.t("agent.originMarket") : i18n.t("agent.originPrivate"),
        installedHere: installedIds.has(skill.id),
        install: async () => {
          const result = await post<{ ok: true; added?: number; already?: number; duplicate?: boolean }>(
            "skills.install", { skill_id: skill.id, agent_id: selected });
          toast.success(result.duplicate || result.added === 0
            ? i18n.tf("agent.skillAlreadyHere", { name: skill.name })
            : i18n.tf("agent.skillInstalled", { name: skill.name }));
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
        toast.success(i18n.tf("agent.skillSnapshotInstalled", { name: result.skill.name, version: result.skill.version ?? "—" }));
      },
    }));
    return [...local, ...remote];
  }, [skillSearch, marketSkills, remoteHits, installedIds, selected, i18n]);

  async function runInstall(hit: SkillHit) {
    if (!selected || hit.installedHere) return;
    setSkillBusy(hit.key);
    try {
      await hit.install();
      await refreshDetail();
      setSkillSearch("");
      setRemoteHits([]);
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setSkillBusy("");
    }
  }

  async function save() {
    if (!draft.name.trim() || !draft.role.trim()) {
      toast.error(i18n.t("agent.needNameRole"));
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
        backend: draft.backend,
        ...(draft.backend === "qca" ? { qca_agent_id: draft.qca_agent_id.trim() } : {}),
      };
      if (draft.id) {
        body.id = draft.id;
        if (draft.api_key.trim()) body.api_key = draft.api_key.trim();
        await post("agents.update", body);
        toast.success(i18n.t("agent.saved"));
      } else {
        if (!draft.api_key.trim()) {
          toast.error(draft.backend === "qca"
            ? i18n.t("agent.needKeyQca")
            : draft.backend === "stream" ? i18n.t("agent.needKeyStream") : i18n.t("agent.needKeyOpenai"));
          return;
        }
        body.api_key = draft.api_key.trim();
        const created = await post<{ ok: true; agent: Agent }>("agents.create", body);
        toast.success(i18n.t("agent.created"));
        setSelected(created.agent.id);
        navigate(`/agents/${created.agent.id}`);
      }
      await refreshList();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    if (!draft.id) {
      toast.error(i18n.t("agent.testNeedSave"));
      return;
    }
    setBusy(true);
    try {
      const result = await post<{ ok: true; result: TestResult }>("agents.test", { id: draft.id });
      const facts = result.result;
      if (!facts.reachable) {
        // 自检失败那一格回的是错误码，不是句子：直接塞进 {error} 就是「出错了：stream_unauthorized」这种给用户看内部标识的界面。
        toast.error(i18n.tf("agent.testFail", { error: facts.error ? describeCode(i18n, facts.error) : i18n.t("panel.unknown"), ms: facts.ms }));
      } else if (facts.speaks_spec === undefined) {
        toast.success(i18n.tf("agent.testOk", { ms: facts.ms, mode: facts.mode ?? "", reply: facts.reply ?? "" }));
      } else {
        // 档位是那台 server 自己答出来的事实，照原样报——尤其是「没答上描述符、退回 OpenAI 兼容」这一条：
        // 界面只说"连通了"，用户会以为对方实现了规范，等到下一轮群工具一个也发不出去时找不到原因。
        const lines = facts.speaks_spec
          ? [
              i18n.tf("agent.testStreamModels", { models: facts.models?.length ? facts.models.join(", ") : "—" }),
              facts.stored ? i18n.t("agent.testStreamStored") : i18n.t("agent.testStreamUnstored"),
            ]
          : [i18n.tf("agent.testStreamFallback", { reason: facts.code ? describeCode(i18n, facts.code) : i18n.t("panel.unknown") })];
        if (facts.reply) lines.push(facts.reply);
        toast.success(i18n.tf("agent.testStreamSpec", {
          spec: facts.speaks_spec ? (facts.spec ?? "—") : "—",
          profiles: facts.profiles?.length ? facts.profiles.join(", ") : "—",
          profile: facts.profile ?? "—",
          ms: facts.ms,
        }), { description: lines.join(" · ") });
      }
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft.id) return;
    try {
      await post("agents.delete", { id: draft.id });
      toast.success(i18n.t("common.deleted"));
      setSelected("");
      setPresence(null);
      navigate("/agents");
      await refreshList();
    } catch (error) {
      toast.error(describeError(i18n, error));
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
      toast.success(i18n.t("agent.memoryWritten"));
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  async function refreshDetail() {
    if (!selected) return;
    try {
      setDetail(await get<AgentDetail>("agents.get", { id: selected }));
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  async function uninstallSkill(skill: Skill) {
    if (!selected) return;
    try {
      await post<{ ok: true }>("skills.uninstall", { skill_id: skill.id, agent_id: selected });
      toast.success(i18n.t("agent.skillUninstalled"));
      await refreshDetail();
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  async function updateSkill(skill: Skill) {
    setSkillBusy(skill.id);
    try {
      const result = await post<{ ok: true; skill: Skill; from_version: string; to_version: string }>(
        "skills.remoteUpdate", { skill_id: skill.id });
      toast.success(i18n.tf("agent.skillUpdated", { name: skill.name, from: result.from_version || "—", to: result.to_version || "—" }));
      await refreshDetail();
    } catch (error) {
      toast.error(describeError(i18n, error));
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
              {i18n.t("agent.new")}
            </Button>
          }
        >
          {i18n.tf("agent.rosterTitle", { n: agents.length })}
        </SectionTitle>
        <div className="grid gap-1.5">
          {agents.length === 0 ? <p className="text-xs text-muted-foreground">{i18n.t("agent.rosterEmpty")}</p> : null}
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
                  {agent.backend === "qca" ? i18n.t("agent.qcaModel") : agent.model} · {agent.status === "paused" ? i18n.t("agent.pausedShort") : i18n.t("agent.onDuty")}
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
              <h2 className="text-sm font-semibold">{draft.id ? i18n.tf("agent.editTitle", { name: draft.name }) : i18n.t("agent.createTitle")}</h2>
              <div className="flex gap-2">
                {draft.id ? (
                  <>
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => void testConnection()} disabled={busy}>
                      {i18n.t("agent.testButton")}
                    </Button>
                    <Button size="sm" variant="outline" className="text-xs text-destructive hover:text-destructive" onClick={() => void remove()}>
                      {i18n.t("common.delete")}
                    </Button>
                  </>
                ) : null}
                <Button size="sm" className="text-xs" onClick={() => void save()} disabled={busy}>
                  {busy ? i18n.t("agent.saving") : i18n.t("agent.saveProfile")}
                </Button>
              </div>
            </div>

            <Field label={i18n.t("agent.avatarLabel")} hint={i18n.t("agent.avatarHint")}>
              <AvatarPicker
                name={draft.name || i18n.t("agent.newAgentName")}
                kind="agent"
                color={agents.find((item) => item.id === draft.id)?.color}
                avatar={draft.avatar}
                onChange={(next) => setDraft((current) => ({ ...current, avatar: next }))}
              />
            </Field>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label={i18n.t("agent.nameLabel")} htmlFor="agent-name">
                <TextInput id="agent-name" value={draft.name} maxLength={48} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={i18n.t("agent.namePlaceholder")} className="h-8 text-xs" />
              </Field>
              <Field label={i18n.t("agent.roleLabel")} htmlFor="agent-role" hint={i18n.t("agent.roleHint")}>
                <TextInput id="agent-role" value={draft.role} maxLength={400} onChange={(event) => setDraft({ ...draft, role: event.target.value })} placeholder={i18n.t("agent.rolePlaceholder")} className="h-8 text-xs" />
              </Field>
              <Field label={i18n.t("agent.backendLabel")} htmlFor="agent-backend" hint={i18n.t("agent.backendHint")}>
                <NativeSelect
                  id="agent-backend"
                  className="h-8 text-xs"
                  value={draft.backend}
                  onChange={(event) => setDraft((current) => switchBackend(current, event.target.value as Backend))}
                >
                  <NativeSelectOption value="openai">{i18n.t("agent.backendOpenai")}</NativeSelectOption>
                  <NativeSelectOption value="qca">{i18n.t("agent.backendQca")}</NativeSelectOption>
                  <NativeSelectOption value="stream">{i18n.t("agent.backendStream")}</NativeSelectOption>
                </NativeSelect>
              </Field>
              {draft.backend === "qca" ? (
                <Field label={i18n.t("agent.qcaIdLabel")} htmlFor="agent-qca" hint={i18n.t("agent.qcaIdHint")}>
                  <TextInput id="agent-qca" value={draft.qca_agent_id} onChange={(event) => setDraft({ ...draft, qca_agent_id: event.target.value })} placeholder="agent_…" className="h-8 font-mono text-xs" />
                </Field>
              ) : null}
              <Field label={copy.urlLabel} htmlFor="agent-base" hint={copy.urlHint}>
                <TextInput id="agent-base" value={draft.api_base_url} onChange={(event) => setDraft({ ...draft, api_base_url: event.target.value })} placeholder={draft.backend === "stream" ? "https://" : undefined} className="h-8 font-mono text-xs" />
              </Field>
              <Field label={copy.modelLabel} htmlFor="agent-model" hint={copy.modelHint}>
                <TextInput id="agent-model" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} className="h-8 font-mono text-xs" />
              </Field>
              <Field label={copy.keyLabel} htmlFor="agent-key" hint={copy.keyHint}>
                <Input id="agent-key" type="password" value={draft.api_key} onChange={(event) => setDraft({ ...draft, api_key: event.target.value })} placeholder={copy.keyPlaceholder} className="h-8 text-xs" />
              </Field>
              <Field label={i18n.t("agent.contextLabel")} htmlFor="agent-context" hint={i18n.t("agent.contextHint")}>
                <Input id="agent-context" type="number" min={2000} max={2000000} step={20000} value={draft.context_chars} onChange={(event) => setDraft({ ...draft, context_chars: Number(event.target.value) })} className="h-8 text-xs" />
              </Field>
            </div>

            {copy.notice ? <Notice tone="info">{copy.notice}</Notice> : null}

            <Field label={i18n.t("agent.signatureLabel")} htmlFor="agent-signature" hint={copy.signatureHint}>
              <TextInput
                id="agent-signature"
                value={draft.signature}
                maxLength={120}
                onChange={(event) => setDraft({ ...draft, signature: event.target.value })}
                placeholder={i18n.t("agent.signaturePlaceholder")}
                className="h-8 text-xs"
              />
            </Field>

            <Field label={i18n.t("agent.systemLabel")} htmlFor="agent-system" hint={copy.systemHint}>
              <Textarea id="agent-system" rows={3} value={draft.system_prompt} onChange={(event) => setDraft({ ...draft, system_prompt: event.target.value })} className="text-xs" />
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <Field label={i18n.t("agent.statusLabel")}>
                <NativeSelect className="h-8 text-xs" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as "active" | "paused" })}>
                  <NativeSelectOption value="active">{i18n.t("agent.onDuty")}</NativeSelectOption>
                  <NativeSelectOption value="paused">{i18n.t("agent.pauseWork")}</NativeSelectOption>
                </NativeSelect>
              </Field>
              <div className="flex items-end gap-2 pb-0.5">
                {draft.backend === "openai" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs"
                    onClick={() => setDraft({ ...draft, api_base_url: "demo://local", model: "demo", api_key: draft.api_key || "demo" })}
                  >
                    {i18n.t("agent.useDemo")}
                  </Button>
                ) : null}
                {draft.id ? <p className="text-xs text-muted-foreground">{draft.api_key ? i18n.t("agent.backendSwitchNote") : i18n.tf("agent.keyTail", { tail: draft.api_key_tail ?? "—" })}</p> : null}
              </div>
            </div>
          </CardContent>
        </Card>

        <AgentPresenceStrip detail={presence} error={presenceError} />
        {presence ? <StreamFlow detail={presence} /> : null}

        {detail ? (
          <Tabs defaultValue="memory" className="min-h-0">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="memory" className="text-xs">{i18n.t("agent.tabMemory")}</TabsTrigger>
              <TabsTrigger value="skills" className="text-xs">{i18n.t("market.skills")}</TabsTrigger>
              <TabsTrigger value="groups" className="text-xs">{i18n.t("agent.tabGroups")}</TabsTrigger>
              <TabsTrigger value="queue" className="text-xs">{i18n.t("agent.tabQueue")}</TabsTrigger>
            </TabsList>

            <TabsContent value="memory" className="grid gap-3 pt-3">
              <Notice>
                {memoryParts[0]}
                <code className="mx-1 font-mono">summary</code>
                {memoryParts[1]}
              </Notice>
              <div className="flex flex-wrap items-end gap-2">
                <Field label={i18n.t("agent.memoryScopeLabel")}>
                  <NativeSelect className="h-8 text-xs" value={memoryScope} onChange={(event) => setMemoryScope(event.target.value as "common" | "stream")}>
                    <NativeSelectOption value="common">common</NativeSelectOption>
                    <NativeSelectOption value="stream">per-stream</NativeSelectOption>
                  </NativeSelect>
                </Field>
                {memoryScope === "stream" ? (
                  <Field label={i18n.t("agent.memoryStreamLabel")}>
                    <NativeSelect className="h-8 w-40 text-xs" value={memoryStream} onChange={(event) => setMemoryStream(event.target.value)}>
                      <NativeSelectOption value="">{i18n.t("agent.memoryStreamPlaceholder")}</NativeSelectOption>
                      {detail.streams.map((row) => (
                        <NativeSelectOption key={row.stream_id} value={row.stream_id}>
                          {streamNames.get(row.stream_id) ?? shortUuid(row.stream_id)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                ) : null}
                <div className="min-w-56 flex-1">
                  <Field label={i18n.t("agent.memoryContentLabel")}>
                    <TextInput value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} placeholder={i18n.t("agent.memoryContentPlaceholder")} className="h-8 text-xs" />
                  </Field>
                </div>
                <Button size="sm" className="h-8 text-xs" disabled={!memoryDraft.trim() || (memoryScope === "stream" && !memoryStream)} onClick={() => void addMemory()}>
                  {i18n.t("agent.memoryWrite")}
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
                        {memory.covers_through_seq ? ` · ${i18n.tf("agent.coversThrough", { n: memory.covers_through_seq })}` : ""}
                        {memory.source === "engine" ? ` · ${i18n.t("agent.autoCompressed")}` : ""} · {timeAgo(i18n, memory.created_at)}
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
                            toast.error(describeError(i18n, error));
                          }
                        })();
                      }}
                    >
                      {i18n.t("common.delete")}
                    </Button>
                  </div>
                ))}
              </div>
              <Button size="sm" variant="ghost" className="justify-self-start text-xs" onClick={() => void loadMemories(selected).then(setMemories)}>
                {i18n.t("agent.commonOnly")}
              </Button>
            </TabsContent>

            <TabsContent value="skills" className="grid gap-3 pt-3">
              <Notice>{i18n.t("agent.skillsNotice")}</Notice>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={skillSearch}
                  onChange={(event) => setSkillSearch(event.target.value)}
                  placeholder={i18n.t("agent.skillSearchPlaceholder")}
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
                    {skillBusy === "check" ? i18n.t("agent.checkingVersions") : i18n.t("agent.recheckVersions")}
                  </Button>
                ) : null}
                {updateCheckedAt ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {i18n.tf("agent.checkedAt", { time: timeAgo(i18n, updateCheckedAt) })}
                  </span>
                ) : null}
                <a href="#/market/skills" className="ml-auto text-xs text-signal hover:underline">
                  {i18n.t("agent.toMarket")}
                </a>
              </div>

              {skillSearch.trim().length >= 2 && skillHits.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {i18n.tf("agent.skillNoResults", { query: skillSearch.trim() })}
                </p>
              ) : null}
              {skillHits.length > 0 ? (
                <div className="ws-surface grid gap-1.5 rounded-xl bg-card p-3">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {i18n.tf("agent.skillResultsFor", { name: detail.agent.name })}
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
                        {hit.installedHere ? i18n.t("agent.installed") : skillBusy === hit.key ? i18n.t("agent.installing") : i18n.t("agent.install")}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}

              {updateIssues.length > 0 ? (
                <Notice tone="warn">
                  {i18n.tf("agent.updateIssuesNote", {
                    list: i18n.list(updateIssues.map((issue) => i18n.tf("agent.updateIssueItem", { name: issue.name, reason: describeCode(i18n, issue.reason) }))),
                  })}
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
                              {i18n.t("agent.badgeBuiltIn")}
                            </Badge>
                          ) : skill.is_default ? (
                            <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                              {i18n.t("agent.badgeDefault")}
                            </Badge>
                          ) : null}
                          {skill.source === "remote" ? (
                            <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal">
                              {i18n.t("agent.badgeRemoteSnapshot")}
                            </Badge>
                          ) : null}
                          {row?.update_available ? (
                            <Badge variant="secondary" className="rounded-full bg-machine-soft px-1.5 py-0 text-[10px] leading-4 font-normal text-machine">
                              {i18n.tf("agent.badgeUpdatable", { version: row.latest_version })}
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
                        <span className="text-[11px] text-muted-foreground">{i18n.t("agent.alwaysOn")}</span>
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
                              {skillBusy === skill.id ? i18n.t("agent.updating") : i18n.t("agent.update")}
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-destructive"
                            disabled={skillBusy === skill.id}
                            onClick={() => void uninstallSkill(skill)}
                          >
                            {i18n.t("agent.uninstall")}
                          </Button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </TabsContent>

            <TabsContent value="groups" className="grid gap-1.5 pt-3">
              {detail.streams.length === 0 ? <p className="text-xs text-muted-foreground">{i18n.t("agent.noGroups")}</p> : null}
              {detail.streams.map((row) => {
                const name = streamNames.get(row.stream_id) ?? shortUuid(row.stream_id);
                const live = presence?.streams.find((item) => item.stream_id === row.stream_id);
                return (
                  <div key={row.stream_id} className="relative flex items-center gap-2 rounded-md border px-2.5 py-2 text-sm hover:bg-muted/50">
                    {/* 整行即入口：透明铺底按钮接点击，权重控件浮在它之上。 */}
                    <a
                      href={`#/stream/${row.stream_id}`}
                      aria-label={i18n.tf("agent.enterGroupAria", { name })}
                      className="absolute inset-0 z-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                    />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{row.role}</span>
                    {live && (live.queued || live.running) ? (
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {i18n.tf("agent.lineQueuedRunning", { queued: live.queued, running: live.running })}
                      </span>
                    ) : null}
                    {live ? <span className="relative z-10"><WeightField agentId={detail.agent.id} streamId={row.stream_id} streamName={name} weight={live.weight} /></span> : null}
                  </div>
                );
              })}
            </TabsContent>

            <TabsContent value="queue" className="grid gap-1.5 pt-3">
              {detail.queue.length === 0 ? <p className="text-xs text-muted-foreground">{i18n.t("agent.queueEmpty")}</p> : null}
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
                    {i18n.tf("agent.mailWeightSlice", { weight: item.priority, slices: item.slice_count })}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{timeAgo(i18n, item.created_at)}</span>
                  {item.error ? <span className="text-[11px] text-destructive">{item.error}</span> : null}
                </div>
              ))}
            </TabsContent>
          </Tabs>
        ) : (
          <p className="text-xs text-muted-foreground">{i18n.t("agent.pickOrCreate")}</p>
        )}
          </>
        )}
      </section>
    </div>
  );
}

const MAIL_TONE: Record<MailItem["status"], { labelKey: MsgKey; className: string }> = {
  queued: { labelKey: "deliver.queued", className: "bg-signal/12 text-signal" },
  running: { labelKey: "deliver.running", className: "bg-machine/12 text-machine" },
  done: { labelKey: "deliver.done", className: "bg-muted text-muted-foreground" },
  failed: { labelKey: "deliver.failed", className: "bg-destructive/10 text-destructive" },
  cancelled: { labelKey: "deliver.cancelled", className: "bg-muted text-muted-foreground" },
};

function MailBadge({ status }: { status: MailItem["status"] }) {
  const i18n = useI18n();
  const tone = MAIL_TONE[status] ?? MAIL_TONE.done;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] leading-4 ${tone.className}`}>
      {status === "running" ? (
        <span className="size-2 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />
      ) : null}
      {i18n.t(tone.labelKey)}
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
  const i18n = useI18n();
  const [value, setValue] = useState(weight);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(weight), [weight]);
  const dirty = value !== weight;

  async function save() {
    setBusy(true);
    try {
      await post("scheduler.weight", { stream_id: streamId, agent_id: agentId, weight: value });
      toast.success(i18n.tf("agent.weightSaved", { name: streamName, weight: value }));
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{i18n.t("agent.weightLabel")}</span>
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
          {i18n.t("agent.save")}
        </Button>
      ) : null}
    </span>
  );
}

/** 主人视角的实时现场：正在处理哪条、还排着几封。 */
function AgentPresenceStrip({ detail, error }: { detail: AgentPresenceDetail | null; error: string }) {
  const i18n = useI18n();
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
              {i18n.t("deliver.running")}
            </Badge>
          ) : (
            <Badge variant="secondary" className="rounded-sm text-[11px] font-normal">{i18n.t("agent.idle")}</Badge>
          )}
          {current ? (
            <span className="min-w-0 truncate text-xs">
              {currentItem?.stream_name ?? i18n.t("agent.unknownStream")} · {i18n.tf("agent.atSequence", { n: current.seq || "—" })}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{i18n.t("agent.noActiveTask")}</span>
          )}
          {queued ? <Badge variant="secondary" className="rounded-sm font-mono text-[11px]">{i18n.tf("agent.queuedCount", { n: queued })}</Badge> : null}
          <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            {current?.started_at ? <span>{i18n.tf("agent.startedAt", { time: timeAgo(i18n, current.started_at) })}</span> : null}
            <span className="inline-flex items-center gap-1">
              <span className="size-1.5 animate-pulse rounded-full bg-signal" aria-hidden />
              {i18n.t("agent.autoRefresh")}
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
  const i18n = useI18n();
  if (!detail) {
    return error ? (
      <Notice>{error}</Notice>
    ) : (
      <p className="text-xs text-muted-foreground">{i18n.t("agent.guestLoading")}</p>
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
                {profile.status === "paused" ? i18n.t("agent.pauseWork") : i18n.t("agent.onDuty")}
              </Badge>
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{profile.role}</p>
            {profile.signature ? <p className="mt-1 text-xs text-muted-foreground">「{profile.signature}」</p> : null}
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              {i18n.tf("agent.guestOwnerLine", { owner: owner.display_name, time: timeAgo(i18n, profile.created_at) })}
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
                  {i18n.t("deliver.running")}
                </Badge>
                <span className="min-w-0 truncate text-sm">
                  {currentItem?.stream_name ?? i18n.t("agent.unknownStream")} · {i18n.tf("agent.atSequence", { n: current.seq || "—" })}
                </span>
                {current.started_at ? <span className="text-[11px] text-muted-foreground">{i18n.tf("agent.startedAt", { time: timeAgo(i18n, current.started_at) })}</span> : null}
              </>
            ) : (
              <span className="text-sm text-muted-foreground">{i18n.t("agent.idleNow")}</span>
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
                  {row.queued ? <Badge variant="secondary" className="rounded-sm font-mono text-[10px]">{i18n.tf("agent.queuedCount", { n: row.queued })}</Badge> : null}
                  {row.running ? <Badge className="rounded-sm font-mono text-[10px]">{i18n.tf("agent.runningCount", { n: row.running })}</Badge> : null}
                  <span className="text-xs text-signal">{i18n.t("agent.enterArrow")}</span>
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
            <h3 className="text-sm font-semibold">{i18n.t("agent.recentMail")}</h3>
            <span className="text-[11px] text-muted-foreground">{i18n.t("agent.sharedOnly")}</span>
          </div>
          {detail.queue.length === 0 ? <p className="text-xs text-muted-foreground">{i18n.t("agent.guestMailEmpty")}</p> : null}
          {detail.queue.slice(0, 20).map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded-md border px-2.5 py-2">
              <MailBadge status={item.status} />
              <span className="min-w-0 flex-1 truncate text-xs">
                {item.stream_name} · #{item.seq || "—"} {item.preview}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(i18n, item.created_at)}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        {i18n.t("agent.guestPrivacy")}
      </p>
    </div>
  );
}
