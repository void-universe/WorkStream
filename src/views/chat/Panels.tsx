// 群聊右侧的操作面板：成员与 @ 派发、群文件、群设置、授权虚拟机、MCP 端点。
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, describeError, get, post } from "../../api";
import type { Agent } from "../../types";
import { byteSize, timeAgo } from "../../lib/format";
import { defaultFlashColors, readStreamFlash, saveFlashColors, type FlashColors, type FlashScene } from "../../lib/flash";
import { CopyButton, Field, Notice, PersonAvatar, RoleBadge, SectionTitle, TextInput } from "../../lib/ui";
import type { AgentPresence, GroupFile, Member, Request, StreamDetail, Vm } from "../../types";

type Props = {
  detail: StreamDetail;
  myAgents: Agent[];
  myVms: Vm[];
  reload: () => Promise<void>;
};

const isLeader = (role: Member["role"]) => role === "owner" || role === "admin";

async function run(action: string, body: unknown, done: string, reload: () => Promise<void>) {
  try {
    await api(action, { body });
    toast.success(done);
    await reload();
    return true;
  } catch (error) {
    toast.error(describeError(error));
    return false;
  }
}

/** 右栏的折叠卡片：标题 + 计数 + 可选操作按钮，内容可收起。 */
export function RailSection({
  title,
  meta,
  defaultOpen = false,
  aside,
  children,
}: {
  title: string;
  meta?: ReactNode;
  defaultOpen?: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-border/60 bg-card/50">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2 px-2.5">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 py-2.5 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform duration-200", !open && "-rotate-90")} />
            <span className="truncate">{title}</span>
            {meta}
          </CollapsibleTrigger>
          {aside}
        </div>
        <CollapsibleContent>
          <div className="px-2.5 pb-2.5">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

export function MembersPanel({ detail, myAgents, reload, presence }: Props & { presence?: AgentPresence[] }) {
  const role = detail.my_role;
  const humans = detail.members.filter((m) => m.type === "human");
  const agents = detail.members.filter((m) => m.type === "agent");
  const presenceOf = new Map((presence ?? []).map((entry) => [entry.agent_id, entry]));
  const inGroup = new Set(agents.map((m) => m.agent?.id));
  const candidates = myAgents.filter((a) => !inGroup.has(a.id));
  const [inviteEmail, setInviteEmail] = useState("");
  const [pickAgent, setPickAgent] = useState("");

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 [&>*]:min-w-0">
      <section className="grid gap-2">
        <SectionTitle>真实员工 · {humans.length}</SectionTitle>
        {humans.map((member) => (
          <div key={member.membership_id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <PersonAvatar name={member.display_name ?? "?"} kind="human" avatar={member.avatar} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{member.display_name}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{member.email}</p>
            </div>
            <RoleBadge role={member.role} />
            {isLeader(role) && member.role !== "owner" ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    void run(
                      "streams.members.promote",
                      {
                        stream_id: detail.stream.id,
                        membership_id: member.membership_id,
                        role: member.role === "admin" ? "member" : "admin",
                      },
                      member.role === "admin" ? "已降为成员" : "已提升为管理员",
                      reload,
                    )
                  }
                >
                  {member.role === "admin" ? "降为成员" : "升为管理"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-destructive"
                  onClick={() =>
                    void run("streams.members.remove", { stream_id: detail.stream.id, membership_id: member.membership_id }, "已移出群", reload)
                  }
                >
                  移出
                </Button>
              </>
            ) : null}
          </div>
        ))}
        <div className="flex items-center gap-2">
          <TextInput
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            placeholder="同事邮箱，邀请 ta 进群"
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 text-xs"
            disabled={!isLeader(role) || !inviteEmail.includes("@")}
            onClick={() => {
              void run("streams.invite", { stream_id: detail.stream.id, email: inviteEmail }, "邀请信已投递", reload);
              setInviteEmail("");
            }}
          >
            邀请
          </Button>
        </div>
        {!isLeader(role) ? <Notice>只有群主和管理员能拉人、踢人和审批申请。</Notice> : null}
      </section>

      <Separator />

      <section className="grid gap-2">
        <SectionTitle>虚拟员工 · {agents.length}</SectionTitle>
        {agents.length === 0 ? <Notice>这个群还没有虚拟员工，@ 不到人。</Notice> : null}
        {agents.map((member) => {
          const agent = member.agent;
          if (!agent) return null;
          return <AgentSlice key={member.membership_id} detail={detail} agent={agent} presence={presenceOf.get(agent.id)} />;
        })}
        {candidates.length ? (
          <div className="flex items-center gap-2">
            <NativeSelect className="h-8 flex-1 text-xs" value={pickAgent} onChange={(event) => setPickAgent(event.target.value)}>
              <NativeSelectOption value="">挑一个我的虚拟员工拉进群…</NativeSelectOption>
              {candidates.map((agent) => (
                <NativeSelectOption key={agent.id} value={agent.id}>
                  {agent.name} · {agent.model}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 text-xs"
              disabled={!pickAgent}
              onClick={() => {
                void run("streams.agents.add", { stream_id: detail.stream.id, agent_id: pickAgent }, "虚拟员工已进群", reload);
                setPickAgent("");
              }}
            >
              拉入
            </Button>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">虚拟员工必须是某个真实员工的，主人不在群里就拉不进来。</p>
      </section>

      <RequestsSection detail={detail} reload={reload} />

      {role === "owner" ? <OwnerTools detail={detail} humans={humans} reload={reload} /> : null}
    </div>
  );
}

function AgentSlice({ detail, agent, presence }: { detail: StreamDetail; agent: Agent; presence?: AgentPresence }) {
  const [weight, setWeight] = useState(1);
  const leader = isLeader(detail.my_role);
  return (
    <div className="grid gap-2 rounded-lg border p-2.5">
      <div className="flex items-center gap-2.5">
        <PersonAvatar
          name={agent.name}
          kind="agent"
          color={agent.color}
          avatar={presence?.avatar ?? agent.avatar}
          href={`#/agents/${agent.id}`}
          busy={presence?.working}
        />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 truncate text-sm">
            {agent.name}
            {agent.status === "paused" ? <span className="text-xs text-muted-foreground">已暂停</span> : null}
            {presence?.working ? (
              <Badge variant="secondary" className="gap-1 rounded-full bg-machine-soft px-1.5 py-0 text-[10px] font-normal text-machine">
                <span aria-hidden className="size-1.5 animate-spin rounded-full border border-current border-t-transparent" />
                处理中
              </Badge>
            ) : presence?.queued ? (
              <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] font-normal">
                排队 {presence.queued}
              </Badge>
            ) : null}
          </p>
          {presence?.signature ? <p className="truncate text-[11px] text-muted-foreground">「{presence.signature}」</p> : null}
          <p className="truncate font-mono text-xs text-muted-foreground">
            {agent.model} · key {agent.api_key_tail}
          </p>
        </div>
        <Badge variant="outline" className="rounded-sm font-mono text-[11px]">
          {agent.owner_id === detail.stream.owner_id ? "群主的" : "组员自带"}
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">时间片权重</span>
        <input
          type="range"
          min={1}
          max={20}
          value={weight}
          disabled={!leader}
          onChange={(event) => setWeight(Number(event.target.value))}
          className="h-1 flex-1 accent-[var(--signal)]"
        />
        <span className="w-6 text-right font-mono text-xs tabular-nums">{weight}</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={!leader}
          onClick={() =>
            void run("scheduler.weight", { stream_id: detail.stream.id, agent_id: agent.id, weight }, `已把 ${agent.name} 在本群的优先级设为 ${weight}`, async () => {})
          }
        >
          确认
        </Button>
      </div>
      {!leader ? <p className="text-xs text-muted-foreground">优先级由群主或管理员确认，默认均分。</p> : null}
    </div>
  );
}

function RequestsSection({ detail, reload }: { detail: StreamDetail; reload: () => Promise<void> }) {
  const [items, setItems] = useState<Request[] | null>(null);
  const list = items ?? detail.requests;

  async function refresh() {
    try {
      const result = await get<{ ok: true; items: Request[] }>("streams.requests", { stream_id: detail.stream.id });
      setItems(result.items);
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  if (!isLeader(detail.my_role)) return null;
  return (
    <section className="grid gap-2">
      <SectionTitle
        aside={
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => void refresh()}>
            刷新
          </Button>
        }
      >
        入群记录
      </SectionTitle>
      {list.length === 0 ? <p className="text-xs text-muted-foreground">没有待处理的申请。</p> : null}
      {list.map((request) => (
        <div key={request.id} className="flex items-center gap-2 rounded-md border px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs">
              {request.applicant_name ?? request.applicant_email ?? (request.kind === "agent" ? "虚拟员工" : "未知")}
              <span className="ml-1.5 text-muted-foreground">
                {request.kind === "human" ? "申请进群" : request.kind === "invite" ? "被邀请" : "借用虚拟员工"}
              </span>
            </p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {request.status} · {timeAgo(request.created_at)}
            </p>
          </div>
          {request.status === "pending" ? (
            <>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  void run("streams.decide", { request_id: request.id, approve: true }, "已通过", async () => {
                    setItems(null);
                    await reload();
                  })
                }
              >
                通过
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  void run("streams.decide", { request_id: request.id, approve: false }, "已拒绝", async () => {
                    setItems(null);
                    await reload();
                  })
                }
              >
                拒绝
              </Button>
            </>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function OwnerTools({ detail, humans, reload }: { detail: StreamDetail; humans: Member[]; reload: () => Promise<void> }) {
  const [target, setTarget] = useState("");
  const others = humans.filter((m) => m.role !== "owner");
  return (
    <section className="grid gap-2">
      <Separator />
      <SectionTitle>群主工具</SectionTitle>
      <div className="flex items-center gap-2">
        <NativeSelect className="h-8 flex-1 text-xs" value={target} onChange={(event) => setTarget(event.target.value)}>
          <NativeSelectOption value="">把群移交给…</NativeSelectOption>
          {others.map((member) => (
            <NativeSelectOption key={member.membership_id} value={member.membership_id}>
              {member.display_name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 text-xs"
          disabled={!target}
          onClick={() => {
            void run("streams.transfer", { stream_id: detail.stream.id, membership_id: target }, "群主已移交", reload);
            setTarget("");
          }}
        >
          移交
        </Button>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="justify-self-start text-xs"
        onClick={() =>
          void run("streams.leave", { stream_id: detail.stream.id }, "已退群", async () => {
            window.location.hash = "#/";
          })
        }
      >
        退出这个群
      </Button>
      <p className="text-xs text-muted-foreground">移交前不能退群；停用群只关闭入口，历史消息按保留策略留在库中。</p>
    </section>
  );
}

export function AnnouncementSection({ detail, reload }: Props) {
  const leader = isLeader(detail.my_role);
  const published = detail.stream.announcement.trim();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(detail.stream.announcement);
  useEffect(() => setValue(detail.stream.announcement), [detail.stream.announcement]);

  return (
    <RailSection
      title="群公告"
      defaultOpen={Boolean(published)}
      meta={
        <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] font-normal">
          {published ? "已发布" : "未发布"}
        </Badge>
      }
      aside={
        leader ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-1.5 text-[11px]"
            onClick={() => setEditing((current) => !current)}
          >
            {editing ? "收起" : "编辑"}
          </Button>
        ) : null
      }
    >
      {published ? (
        <p className="whitespace-pre-wrap text-xs leading-relaxed">{published}</p>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          还没有公告。写一句本群的节奏或截止时间，虚拟员工用 get_announcement 能读到。
        </p>
      )}
      {published ? (
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">更新于 {timeAgo(detail.stream.announcement_at)}</p>
      ) : null}
      {leader && editing ? (
        <div className="mt-2 grid gap-2">
          <Textarea
            rows={3}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="如：周五 18:00 前定稿，逾期顺延。"
            className="text-xs"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                void run("streams.announcement", { stream_id: detail.stream.id, content: value }, "公告已发布", reload)
                  .then((ok) => { if (ok) setEditing(false); });
              }}
            >
              发布公告
            </Button>
            {published ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => {
                  setValue("");
                  void run("streams.announcement", { stream_id: detail.stream.id, content: "" }, "公告已清空", reload)
                    .then((ok) => { if (ok) setEditing(false); });
                }}
              >
                清空
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        公告会注入每个员工的本群上下文；MCP 用 get_announcement / set_announcement 读写。
      </p>
    </RailSection>
  );
}

type Preview = { file: GroupFile; loading: boolean; content: string; signedUrl?: string; error: string };

export function FilesSection({ detail, reload }: Props) {
  const [files, setFiles] = useState<GroupFile[]>(detail.files);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  async function refresh() {
    try {
      const result = await get<{ ok: true; items: GroupFile[] }>("files.list", { stream_id: detail.stream.id });
      setFiles(result.items);
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  useEffect(() => {
    void refresh();
  }, [detail.stream.id]);

  async function pickFile(file: File) {
    if (file.size > 400_000) {
      toast.error("群文件走文本入库，先限制在 400KB 以内。");
      return;
    }
    setContent(await file.text());
    if (!name) setName(file.name);
  }

  async function upload() {
    if (!name.trim() || !content) {
      toast.error("文件名和内容都要有。");
      return;
    }
    setBusy(true);
    try {
      await post("files.upload", { stream_id: detail.stream.id, name: name.trim(), content, content_type: "text/plain" });
      toast.success("已上传并在群里播报");
      setName("");
      setContent("");
      setUploadOpen(false);
      await refresh();
      await reload();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function openPreview(file: GroupFile) {
    setPreview({ file, loading: true, content: "", error: "" });
    try {
      const result = await get<{ ok: true; name: string; content_type: string; content?: string; signed_url?: string }>(
        "files.get",
        { id: file.id },
      );
      setPreview((current) =>
        current && current.file.id === file.id
          ? { file, loading: false, content: result.content ?? "", signedUrl: result.signed_url, error: "" }
          : current,
      );
    } catch (error) {
      setPreview((current) =>
        current && current.file.id === file.id
          ? { file, loading: false, content: "", error: describeError(error) }
          : current,
      );
    }
  }

  async function download(file: GroupFile) {
    try {
      const result = await get<{ ok: true; name: string; content?: string; signed_url?: string }>("files.get", { id: file.id });
      if (result.signed_url) {
        window.open(result.signed_url, "_blank", "noopener");
        return;
      }
      const blob = new Blob([result.content ?? ""], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  return (
    <RailSection
      title="群文件"
      defaultOpen
      meta={<Badge variant="secondary" className="rounded-full px-1.5 py-0 font-mono text-[10px]">{files.length}</Badge>}
      aside={
        <Button size="sm" variant="ghost" className="h-6 shrink-0 px-1.5 text-[11px]" onClick={() => setUploadOpen((current) => !current)}>
          {uploadOpen ? "收起上传" : "上传"}
        </Button>
      }
    >
      {files.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">还没有文件。纪要、清单、脚本片段都可以直接贴进来。</p>
      ) : (
        <ScrollArea className="max-h-56">
          <div className="grid gap-1">
            {files.map((file) => (
              <div key={file.id} className="flex items-center gap-1 rounded-md border px-2 py-1.5">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  title="在线预览"
                  onClick={() => void openPreview(file)}
                >
                  <p className="truncate text-xs hover:underline">{file.name}</p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {byteSize(file.size_bytes)} · {file.uploaded_name ?? "成员"} · {timeAgo(file.created_at)}
                  </p>
                </button>
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => void openPreview(file)}>
                  预览
                </Button>
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => void download(file)}>
                  下载
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px] text-destructive"
                  onClick={() =>
                    void run("files.delete", { id: file.id }, "已删除", async () => {
                      await refresh();
                      await reload();
                    })
                  }
                >
                  删除
                </Button>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      {uploadOpen ? (
        <div className="mt-2 grid gap-2">
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="文件名，如：验收清单.md"
            className="h-7 text-xs"
          />
          <Textarea
            rows={4}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="粘贴文本内容，或从下面选一个本地文件读进来。"
            className="text-xs font-mono"
          />
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept=".txt,.md,.json,.csv,.log,.yaml,.yml,.ts,.js,.py,.sql"
              className="min-w-0 flex-1 text-[11px] file:mr-2 file:rounded file:border file:border-border file:bg-muted file:px-2 file:py-0.5 file:text-[11px]"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void pickFile(file);
              }}
            />
            <Button size="sm" className="h-7 shrink-0 text-xs" onClick={() => void upload()} disabled={busy}>
              {busy ? "上传中…" : "上传到群"}
            </Button>
          </div>
        </div>
      ) : null}

      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        点文件名在线预览；MCP 用 list_files / read_file / upload_file / delete_file 操作同一批文件。
      </p>

      <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate text-base">{preview?.file.name}</DialogTitle>
            <DialogDescription className="font-mono text-[11px]">
              {preview ? `${byteSize(preview.file.size_bytes)} · ${preview.file.content_type} · ${preview.file.uploaded_name ?? "成员"} · ${timeAgo(preview.file.created_at)}` : ""}
            </DialogDescription>
          </DialogHeader>
          {preview?.loading ? (
            <p className="text-sm text-muted-foreground">正在读取…</p>
          ) : preview?.error ? (
            <Notice>{preview.error}</Notice>
          ) : preview?.signedUrl ? (
            <a href={preview.signedUrl} target="_blank" rel="noopener" className="text-sm text-signal underline">
              这个文件在对象存储里，点这里打开下载链接
            </a>
          ) : (
            <pre className="max-h-[55vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {preview?.content || "（空文件）"}
            </pre>
          )}
          <DialogFooter>
            {preview ? (
              <Button size="sm" variant="outline" onClick={() => void download(preview.file)}>
                下载
              </Button>
            ) : null}
            <Button size="sm" onClick={() => setPreview(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </RailSection>
  );
}

export function SettingsPanel({ detail, reload }: Props) {
  const [name, setName] = useState(detail.stream.name);
  const [contextChars, setContextChars] = useState(detail.stream.context_chars);
  const [joinPolicy, setJoinPolicy] = useState(detail.stream.join_policy);
  const owner = detail.my_role === "owner";
  const leader = isLeader(detail.my_role);

  return (
    <div className="grid gap-4">
      <SectionTitle>群身份</SectionTitle>
      <div className="flex items-center gap-2 rounded-md border px-2.5 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{detail.stream.id}</code>
        <CopyButton value={detail.stream.id} label="UUID" />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        拿到这串 UUID 的人可以申请进群；改成「仅邀请」后就不再接受申请，只认邮箱邀请。
      </p>

      <Field label="群名" htmlFor="stream-name">
        <div className="flex gap-2">
          <TextInput id="stream-name" value={name} onChange={(event) => setName(event.target.value)} className="h-8 text-xs" disabled={!leader} />
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 text-xs"
            disabled={!leader || !name.trim()}
            onClick={() => void run("streams.rename", { stream_id: detail.stream.id, name }, "群名已更新", reload)}
          >
            改名
          </Button>
        </div>
      </Field>

      <Field label="群公告">
        <Notice>公告在上方「群公告」卡片里发布或清空；虚拟员工通过 get_context / get_announcement 读取。</Notice>
      </Field>

      <Separator />
      <SectionTitle>闪烁颜色</SectionTitle>
      <FlashColorSettings streamId={detail.stream.id} />

      <Separator />
      <SectionTitle>上下文预算与进群方式</SectionTitle>
      <Field label="上下文预算（字符）" htmlFor="context-chars" hint={`窗口超预算就按群压缩成摘要记忆，历史靠 MCP 回查。当前 ${detail.stream.context_chars}。`}>
        <div className="flex gap-2">
          <Input
            id="context-chars"
            type="number"
            min={2000}
            max={200000}
            step={1000}
            value={contextChars}
            disabled={!owner}
            onChange={(event) => setContextChars(Number(event.target.value))}
            className="h-8 text-xs"
          />
          <Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" disabled={!owner} onClick={() => void run("streams.settings", { stream_id: detail.stream.id, context_chars: contextChars }, "预算已更新", reload)}>
            保存
          </Button>
        </div>
      </Field>
      <Field label="进群方式">
        <div className="flex gap-2">
          <NativeSelect className="h-8 flex-1 text-xs" value={joinPolicy} disabled={!owner} onChange={(event) => setJoinPolicy(event.target.value as "request" | "invite_only")}>
            <NativeSelectOption value="request">凭 UUID 申请，群主/管理员审批</NativeSelectOption>
            <NativeSelectOption value="invite_only">只接受邮箱邀请</NativeSelectOption>
          </NativeSelect>
          <Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" disabled={!owner} onClick={() => void run("streams.settings", { stream_id: detail.stream.id, join_policy: joinPolicy }, "进群方式已更新", reload)}>
            保存
          </Button>
        </div>
      </Field>

      {owner ? (
        <>
          <Separator />
          <Button
            size="sm"
            variant="outline"
            className="justify-self-start text-destructive hover:text-destructive"
            onClick={() =>
              void run("streams.delete", { stream_id: detail.stream.id }, "群已停用", async () => {
                window.location.hash = "#/";
              })
            }
          >
            停用这个群
          </Button>
        </>
      ) : null}
    </div>
  );
}

const FLASH_SCENES: { key: FlashScene; label: string; hint: string }[] = [
  { key: "queued", label: "被 @ 排队", hint: "有任务在等时间片：默认黄色，闪得较快" },
  { key: "live", label: "正在推进", hint: "虚拟员工刚领到任务：默认绿色，闪得较缓" },
];

function FlashColorSettings({ streamId }: { streamId: string }) {
  const [colors, setColors] = useState(() => readStreamFlash(streamId));
  const [defaults] = useState(defaultFlashColors);

  function update(scene: FlashScene, value: string | null) {
    const next: FlashColors = { ...colors };
    if (value) next[scene] = value;
    else delete next[scene];
    setColors(next);
    saveFlashColors(streamId, next);
  }

  return (
    <div className="grid gap-2.5">
      <p className="text-xs leading-relaxed text-muted-foreground">
        只影响这台设备上 Stream 面板的群边框；频率固定（排队快、推进缓），颜色按群单独设置。
      </p>
      {FLASH_SCENES.map((scene) => {
        const overridden = Boolean(colors[scene.key]);
        const value = colors[scene.key] ?? defaults[scene.key];
        return (
          <div key={scene.key} className="flex items-center gap-2.5 rounded-md border px-2.5 py-2">
            <span className="size-6 shrink-0 rounded border border-border" style={{ backgroundColor: value }} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">{scene.label}</p>
              <p className="text-[11px] text-muted-foreground">{scene.hint}</p>
            </div>
            <input
              type="color"
              aria-label={`${scene.label}的闪烁颜色`}
              value={value}
              onChange={(event) => update(scene.key, event.target.value)}
              className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
            {overridden ? (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => update(scene.key, null)}>
                默认
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function VmsPanel({ detail, myVms, reload }: Props) {
  const [level, setLevel] = useState<"member" | "sudo">("member");
  const [pick, setPick] = useState("");
  const granted = new Set(detail.vms.map((vm) => vm.id));
  const available = myVms.filter((vm) => !granted.has(vm.id));
  const canGrant = isLeader(detail.my_role);

  return (
    <div className="grid gap-4">
      <SectionTitle
        aside={
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => void reload()}>
            刷新
          </Button>
        }
      >
        授权的办公虚拟机 · {detail.vms.length}
      </SectionTitle>
      {detail.vms.length === 0 ? <Notice>这个群还没绑定虚拟机。建群时就能带上，也可以现在补。</Notice> : null}
      {detail.vms.map((vm) => (
        <div key={vm.grant_id} className="grid gap-1.5 rounded-lg border p-2.5">
          <div className="flex items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted font-mono text-[11px]">VM</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{vm.label}</p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {vm.username ? `${vm.username}@` : ""}
                {vm.host}:{vm.port}
                {vm.workdir ? ` · ${vm.workdir}` : ""}
              </p>
            </div>
            <Badge variant={vm.level === "sudo" ? "default" : "secondary"} className="rounded-sm font-normal">
              {vm.level === "sudo" ? "sudo" : "普通"}
            </Badge>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" disabled={!canGrant} onClick={() => void run("streams.vms.revoke", { stream_id: detail.stream.id, grant_id: vm.grant_id }, "已解除授权", reload)}>
              解除
            </Button>
          </div>
          {vm.last_probe ? (
            <p className="text-xs text-muted-foreground">
              连通探测：{vm.last_probe.reachable ? "可达" : "不可达"}（{timeAgo(vm.last_probe.checked_at)}）· {vm.last_probe.note}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">还没探测过。</p>
          )}
        </div>
      ))}

      <Separator />
      <Field label="把我的企业虚拟机授权给这个群" hint="只能授权自己登记的虚拟机；等级决定群里虚拟员工拿到的凭据用途。">
        <div className="flex gap-2">
          <NativeSelect className="h-8 flex-1 text-xs" value={pick} onChange={(event) => setPick(event.target.value)} disabled={!available.length}>
            <NativeSelectOption value="">{available.length ? "选择虚拟机…" : "没有可授权的虚拟机"}</NativeSelectOption>
            {available.map((vm) => (
              <NativeSelectOption key={vm.id} value={vm.id}>
                {vm.label} · {vm.host}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect className="h-8 w-24 text-xs" value={level} onChange={(event) => setLevel(event.target.value as "member" | "sudo")}>
            <NativeSelectOption value="member">普通</NativeSelectOption>
            <NativeSelectOption value="sudo">sudo</NativeSelectOption>
          </NativeSelect>
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 text-xs"
            disabled={!canGrant || !pick}
            onClick={() => {
              void run("streams.vms.grant", { stream_id: detail.stream.id, vm_id: pick, level }, "虚拟机已授权", reload);
              setPick("");
            }}
          >
            授权
          </Button>
        </div>
      </Field>
      {!canGrant ? <Notice>授权到群由群主或管理员操作。</Notice> : null}
      <p className="text-xs leading-relaxed text-muted-foreground">
        边栏函数没有 TCP 套接字，这里做的是登记 + 按群授权 + 端口连通探测；真正的 SSH 会话执行需要一台常驻 runner，属于后续能力。
      </p>
    </div>
  );
}

export function McpPanel({ detail, reload }: Props) {
  const owner = detail.my_role === "owner";
  const [key, setKey] = useState("");
  const [curl, setCurl] = useState("");
  const endpoint = `${window.location.origin}/functions/v1/app?action=mcp`;

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 [&>*]:min-w-0">
      <SectionTitle>群历史 MCP 端点</SectionTitle>
      <Notice>
        虚拟员工在群里跑任务时先走内部工具（search_history / read_window / list_files / read_file / upload_file / get_context）。
        同一个端点也对外开成 JSON-RPC MCP，外部 Agent 用这把群钥匙就能回查历史、读写群文件与公告。
      </Notice>
      <div className="grid gap-1.5 rounded-md border px-2.5 py-2">
        <p className="text-[11px] font-medium text-muted-foreground">对外可调用的工具</p>
        <div className="flex flex-wrap gap-1">
          {[
            "search_history", "read_window", "get_context", "get_announcement",
            "list_files", "read_file", "upload_file", "delete_file",
            "send_message", "invite_member", "set_announcement", "list_skills", "read_skill",
          ].map((name) => (
            <code key={name} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{name}</code>
          ))}
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          参数与示例见内置技能「DevStream 群文件与公告」，每个虚拟员工默认都能读到。
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="text-xs"
          disabled={!owner}
          onClick={() => {
            void (async () => {
              try {
                const result = await post<{ ok: true; key: string; curl: string }>("streams.mcpkey.rotate", { stream_id: detail.stream.id });
                setKey(result.key);
                setCurl(result.curl.replace("$ORIGIN", window.location.origin));
                toast.success("已生成新的群 MCP 钥匙（只显示这一次）");
                await reload();
              } catch (error) {
                toast.error(describeError(error));
              }
            })();
          }}
        >
          {detail.stream.mcp_key_set ? "轮换钥匙" : "生成钥匙"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-xs text-destructive"
          disabled={!owner || !detail.stream.mcp_key_set}
          onClick={() => void run("streams.mcpkey.clear", { stream_id: detail.stream.id }, "钥匙已清除", reload)}
        >
          清除
        </Button>
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">端点</span>
          <code className="w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">{endpoint}</code>
          <CopyButton value={endpoint} />
        </div>
        <p className="text-xs text-muted-foreground">当前状态：{detail.stream.mcp_key_set ? "已设置（库里只存 SHA-256 散列）" : "未设置"}</p>
      </div>
      {key ? (
        <div className="grid gap-2 rounded-lg border border-machine/40 bg-machine-soft p-3">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-machine">{key}</code>
            <CopyButton value={key} label="钥匙" />
          </div>
          <Progress value={100} className="h-0.5 bg-machine/30" />
          <p className="text-xs text-machine">离开页面就再也看不到这串了，现在存进你自己的密钥管理。</p>
          {curl ? (
            <>
              <pre className="max-h-32 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed">{curl}</pre>
              <CopyButton value={curl} label="curl" className="justify-self-start" />
            </>
          ) : null}
        </div>
      ) : null}
      {!owner ? <Notice>只有群主能生成或清除这把钥匙。</Notice> : null}
    </div>
  );
}
