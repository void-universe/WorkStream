// 群聊右侧的操作面板：成员与 @ 派发、群文件、群设置、授权虚拟机、MCP 端点。
import { useEffect, useState, type ReactNode } from "react";
import {
  DownloadIcon,
  EyeIcon,
  FileCodeIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, describeError, get, post } from "../../api";
import type { Agent } from "../../types";
import { byteSize, timeAgo } from "../../lib/format";
import { defaultFlashColors, readStreamFlash, saveFlashColors, type FlashColors, type FlashScene } from "../../lib/flash";
import { CopyButton, CopyChip, Notice, PersonAvatar, RoleBadge, SectionTitle, TextInput } from "../../lib/ui";
// 只 import 清单文件：内置渲染器是在那里被登记进注册表的，直接 import fileRenderers 会拿到一张空表。
import { renderGroupFile } from "../../lib/renderers/index.mjs";
import type { AgentPresence, DelegateStatus, GroupFile, Member, Presented, Request, StreamDetail, Vm } from "../../types";

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

/** 服务端回的原因码，原样翻译成人话；没见过的码就照实贴出来，不编一个好听的说法。 */
const DELEGATE_REASONS: Record<string, string> = {
  not_enabled: "全局班表没开替身",
  no_agent: "还没选替身员工",
  agent_missing: "那位虚拟员工已被删除",
  agent_not_owned: "只能用自己的虚拟员工当替身",
  agent_paused: "替身员工已停用",
  agent_not_in_stream: "替身员工不在这个群，把 ta 拉进群才会生效",
  not_started: "还没到班表的时段",
  expired: "班表时段已过",
  stream_off: "本群已关掉替身",
};

function delegateStatusText(status: DelegateStatus) {
  if (status.active) return `现在由「${status.agent_name}」在本群替你接 @。`;
  const reason = status.reason ? DELEGATE_REASONS[status.reason] ?? status.reason : "原因未知";
  return `本群现在没有替身：${reason}。`;
}

/** 分组列表容器：行与行之间用发丝线分隔。 */
function ListGroup({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-card/50">{children}</div>;
}

/** 设置类列表行：左侧标题与说明，右侧控件。 */
function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    // 控件是 shrink-0 的：窄容器里三个控件一起上，就会把说明文字挤成一列竖排的字。
    // 所以文字块给下限（basis-40）、装不下时控件整排换到第二行，控件自己那排再按 max-w-full 折行。
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-xs font-medium">{label}</p>
        {hint ? <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="ml-auto flex w-max max-w-full shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

export function MembersPanel({ detail, myAgents, reload, presence }: Props & { presence?: AgentPresence[] }) {
  const role = detail.my_role;
  const members = detail.members;
  const agents = members.filter((member) => member.agent);
  const presenceOf = new Map((presence ?? []).map((entry) => [entry.agent_id, entry]));
  const inGroup = new Set(agents.map((m) => m.agent?.id));
  const candidates = myAgents.filter((a) => !inGroup.has(a.id));
  const pending = detail.requests.filter((request) => request.status === "pending").length;
  const [inviteEmail, setInviteEmail] = useState("");
  const [pickAgent, setPickAgent] = useState("");

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 [&>*]:min-w-0">
      <section className="grid gap-1.5">
        <SectionTitle>群成员 · {members.length}</SectionTitle>
        <div className="grid grid-cols-4 gap-1 rounded-xl border border-border/60 bg-card/50 p-3">
          {members.map((member) => (
            <MemberTile
              key={member.membership_id}
              detail={detail}
              member={member}
              presence={member.agent ? presenceOf.get(member.agent.id) : undefined}
              reload={reload}
            />
          ))}
        </div>
        {agents.length ? (
          <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
            虚拟员工在本群的忙碌程度、处理时间轴和群权重，点头像进详情页看。
          </p>
        ) : null}
        <div className="grid gap-2">
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
          {candidates.length ? (
            <div className="flex items-center gap-2">
              <NativeSelect className="h-8 flex-1 text-xs" value={pickAgent} onChange={(event) => setPickAgent(event.target.value)}>
                <NativeSelectOption value="">拉一位我的虚拟员工进群…</NativeSelectOption>
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
        </div>
        {!isLeader(role) ? <Notice>只有群主和管理员能拉人、踢人和审批申请。</Notice> : null}
      </section>

      {pending ? <RequestsSection detail={detail} reload={reload} /> : null}
    </div>
  );
}

/** 一格成员：头像、名字后跟一个真人/虚拟标签；身份细节点头像进详情页看。 */
function MemberTile({
  detail,
  member,
  presence,
  reload,
}: {
  detail: StreamDetail;
  member: Member;
  presence?: AgentPresence;
  reload: () => Promise<void>;
}) {
  const agent = member.agent;
  const leader = isLeader(detail.my_role);
  const name = member.display_name ?? agent?.name ?? "?";
  const canRemove = member.role !== "owner" && (agent ? detail.my_role === "owner" : leader);
  return (
    <div className="group/tile relative flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-2 hover:bg-muted/60">
      <PersonAvatar
        name={name}
        kind={agent ? "agent" : "human"}
        color={agent?.color}
        avatar={presence?.avatar ?? agent?.avatar ?? member.avatar}
        href={agent ? `#/agents/${agent.id}` : undefined}
        busy={presence?.working}
        className="size-11 text-sm"
        title={agent ? `${agent.name} · ${agent.model}` : `${name} · ${member.email}`}
      />
      <p className="flex w-full min-w-0 items-center justify-center gap-1">
        <span className="min-w-0 truncate text-[11px]">{name}</span>
        <span
          className={cn(
            "shrink-0 rounded-sm border px-1 text-[9px] leading-4",
            agent ? "border-machine/30 text-machine" : "border-border text-muted-foreground",
          )}
        >
          {agent ? "虚拟" : "真人"}
        </span>
      </p>
      {member.role !== "member" ? <RoleBadge role={member.role} /> : null}
      {leader && canRemove ? (
        <div className="absolute inset-x-0 bottom-0 hidden flex-col items-center gap-0.5 rounded-lg bg-background/95 py-1 shadow-sm group-hover/tile:flex group-focus-within/tile:flex">
          {!agent ? (
            <Button
              size="xs"
              variant="ghost"
              className="h-5 px-1 text-[10px]"
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
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            className="h-5 px-1 text-[10px] text-destructive"
            onClick={() =>
              void run("streams.members.remove", { stream_id: detail.stream.id, membership_id: member.membership_id }, "已移出群", reload)
            }
          >
            移出
          </Button>
        </div>
      ) : null}
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
    <section className="grid gap-1.5">
      <SectionTitle
        aside={
          <Button size="xs" variant="ghost" onClick={() => void refresh()}>
            刷新
          </Button>
        }
      >
        入群记录
      </SectionTitle>
      {list.length === 0 ? <p className="px-1 text-[11px] text-muted-foreground">没有待处理的申请。</p> : null}
      {list.length ? (
        <ListGroup>
          {list.map((request) => (
            <div key={request.id} className="flex items-center gap-2 px-3 py-2">
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
                    size="xs"
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
                    size="xs"
                    variant="ghost"
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
        </ListGroup>
      ) : null}
    </section>
  );
}

function OwnerTools({ detail, humans, reload }: { detail: StreamDetail; humans: Member[]; reload: () => Promise<void> }) {
  const [target, setTarget] = useState("");
  const others = humans.filter((m) => m.role !== "owner");
  return (
    <section className="grid gap-1.5">
      <SectionTitle>群主工具</SectionTitle>
      <ListGroup>
        <Row label="移交群主" hint="移交前不能退群。">
          <NativeSelect className="h-8 w-32 text-xs" value={target} onChange={(event) => setTarget(event.target.value)}>
            <NativeSelectOption value="">移交给…</NativeSelectOption>
            {others.map((member) => (
              <NativeSelectOption key={member.membership_id} value={member.membership_id}>
                {member.display_name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            size="xs"
            variant="outline"
            disabled={!target}
            onClick={() => {
              void run("streams.transfer", { stream_id: detail.stream.id, membership_id: target }, "群主已移交", reload);
              setTarget("");
            }}
          >
            移交
          </Button>
        </Row>
        <Row label="退出这个群" hint="停用群只关闭入口，历史消息按保留策略留在库中。">
          <Button
            size="xs"
            variant="ghost"
            className="text-destructive"
            onClick={() =>
              void run("streams.leave", { stream_id: detail.stream.id }, "已退群", async () => {
                window.location.hash = "#/";
              })
            }
          >
            退群
          </Button>
        </Row>
      </ListGroup>
    </section>
  );
}

/** 群公告：钉钉把它放在群设置里，不占聊天区。管理者可就地编辑。 */
function AnnouncementSection({ detail, reload }: Pick<Props, "detail" | "reload">) {
  const leader = isLeader(detail.my_role);
  const published = detail.stream.announcement.trim();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(detail.stream.announcement);
  useEffect(() => setValue(detail.stream.announcement), [detail.stream.announcement]);

  return (
    <section className="grid gap-1.5">
      <SectionTitle>群公告</SectionTitle>
      <ListGroup>
        <Row
          label="公告内容"
          hint={published ? <span className="whitespace-pre-wrap text-foreground/80">{published}</span> : "还没有群公告。"}
        >
          {leader ? (
            <Button size="xs" variant="outline" onClick={() => setEditing((current) => !current)}>
              {editing ? "收起" : published ? "编辑" : "发布"}
            </Button>
          ) : null}
        </Row>
        {published ? (
          <Row label="发布时间" hint="公告会注入每个员工的本群上下文。">
            <span className="font-mono text-[11px] text-muted-foreground">{timeAgo(detail.stream.announcement_at)}</span>
          </Row>
        ) : null}
        {leader && editing ? (
          <div className="grid gap-2 px-3 pb-3">
            <Textarea
              rows={4}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="如：周五 18:00 前定稿，逾期顺延。"
              className="text-xs"
            />
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                onClick={() => {
                  void run("streams.announcement", { stream_id: detail.stream.id, content: value }, "公告已发布", reload).then((ok) => {
                    if (ok) setEditing(false);
                  });
                }}
              >
                发布公告
              </Button>
              {published ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setValue("");
                    void run("streams.announcement", { stream_id: detail.stream.id, content: "" }, "公告已清空", reload).then((ok) => {
                      if (ok) setEditing(false);
                    });
                  }}
                >
                  清空
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </ListGroup>
    </section>
  );
}

type Rendered = Awaited<ReturnType<typeof renderGroupFile>>;
type Preview = { file: GroupFile; loading: boolean; content: string; signedUrl?: string; error: string; rendered: Rendered };

export function FilesSection({ detail, reload, focus }: Props & { focus?: Presented | null }) {
  const [files, setFiles] = useState<GroupFile[]>(detail.files);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  // 返回这次列表拿到的行（失败返回 null），交付卡片定位原件时要靠它决定要不要再报一句"文件不在了"。
  async function refresh(): Promise<GroupFile[] | null> {
    try {
      const result = await get<{ ok: true; items: GroupFile[] }>("files.list", { stream_id: detail.stream.id });
      setFiles(result.items);
      return result.items;
    } catch (error) {
      toast.error(describeError(error));
      return null;
    }
  }

  useEffect(() => {
    void refresh();
  }, [detail.stream.id]);

  // 从交付卡片点进来：按 id 在群文件里找到原件，直接打开预览。
  // 本地列表可能是上传/删除之前的，找不到时先刷一次再找；刷过还没有才说原件不在了。
  useEffect(() => {
    if (!focus) return;
    let stopped = false;
    const open = async (rows: GroupFile[] | null) => {
      const found = rows?.find((row) => row.id === focus.file_id);
      if (found) {
        void openPreview(found);
        return;
      }
      const again = await refresh();
      if (stopped) return;
      const refreshed = again?.find((row) => row.id === focus.file_id);
      if (refreshed) void openPreview(refreshed);
      else if (again) toast.error(`交付卡片指向的「${focus.name}」已不在群文件里。`);
    };
    void open(files);
    return () => {
      stopped = true;
    };
  }, [focus]);

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
    setPreview({ file, loading: true, content: "", error: "", rendered: null });
    try {
      const result = await get<{ ok: true; name: string; content_type: string; content?: string; signed_url?: string }>(
        "files.get",
        { id: file.id },
      );
      const content = result.content ?? "";
      // 怎么显示交给渲染器注册表：没人接住就是 null，下面照旧落回纯文本，不在这张表里加扩展名判断。
      const rendered = result.signed_url ? null : await renderGroupFile({
        name: result.name,
        content_type: result.content_type,
        content,
      });
      setPreview((current) =>
        current && current.file.id === file.id
          ? { file, loading: false, content, signedUrl: result.signed_url, error: "", rendered }
          : current,
      );
    } catch (error) {
      setPreview((current) =>
        current && current.file.id === file.id
          ? { file, loading: false, content: "", error: describeError(error), rendered: null }
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
    <section className="grid min-w-0 gap-1.5">
      <SectionTitle
        aside={
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="rounded-full px-1.5 py-0 font-mono text-[10px]">{files.length}</Badge>
            <Button size="xs" variant="ghost" onClick={() => setUploadOpen((current) => !current)}>
              {uploadOpen ? "收起上传" : "上传"}
            </Button>
          </div>
        }
      >
        文件列表
      </SectionTitle>
      <ListGroup>
      {files.length === 0 ? (
        <p className="px-3 py-3 text-xs leading-relaxed text-muted-foreground">还没有文件。纪要、清单、脚本片段都可以直接贴进来。</p>
      ) : (
        <div>
          <div className="grid gap-0.5 p-1.5">
            {files.map((file) => (
              <div key={file.id} className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-accent/60">
                <FileGlyph name={file.name} />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  title="在线预览"
                  onClick={() => void openPreview(file)}
                >
                  <p className="truncate text-xs font-medium">{file.name}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {byteSize(file.size_bytes)} · {file.uploaded_name ?? "成员"} · {timeAgo(file.created_at)}
                  </p>
                </button>
                <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <Button size="icon-xs" variant="ghost" title="预览" onClick={() => void openPreview(file)}>
                    <EyeIcon />
                  </Button>
                  <Button size="icon-xs" variant="ghost" title="下载" onClick={() => void download(file)}>
                    <DownloadIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-destructive"
                    title="删除"
                    onClick={() =>
                      void run("files.delete", { id: file.id }, "已删除", async () => {
                        await refresh();
                        await reload();
                      })
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {uploadOpen ? (
        <div className="grid gap-2 p-2.5">
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
              accept=".txt,.md,.json,.csv,.log,.yaml,.yml,.ts,.js,.py,.sql,.drawio,.xml"
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
      </ListGroup>

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
          ) : preview?.rendered?.view.kind === "svg" ? (
            <div className="grid min-w-0 gap-1.5">
              {/* markup 由渲染器自己生成：标签文本出图前逐字转义过，所以这里塞进 DOM 的不是群里的原文。 */}
              <div
                className="max-h-[55vh] overflow-auto rounded-md border bg-muted/30 p-3"
                dangerouslySetInnerHTML={{ __html: preview.rendered.view.markup }}
              />
              <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
                {preview.rendered.view.summary} · 结构预览（{preview.rendered.rendererId}）：只画节点与连线，样式和坐标精度不还原
              </p>
            </div>
          ) : preview?.rendered?.view.kind === "text" ? (
            <pre className="max-h-[55vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {preview.rendered.view.text || "（空文件）"}
            </pre>
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
    </section>
  );
}

/** 按扩展名挑图标：代码 / 表格 / 文本三档，其余走通用文件图标。 */
function FileGlyph({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const Icon = ext === "csv" ? FileSpreadsheetIcon : ["ts", "tsx", "js", "jsx", "py", "sql", "json", "yaml", "yml"].includes(ext) ? FileCodeIcon : FileTextIcon;
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
      <Icon className="size-4" />
    </span>
  );
}

export function SettingsPanel({ detail, myAgents, myVms, reload }: Props) {
  const [name, setName] = useState(detail.stream.name);
  const [contextChars, setContextChars] = useState(detail.stream.context_chars);
  const [joinPolicy, setJoinPolicy] = useState(detail.stream.join_policy);
  const [delegateMode, setDelegateMode] = useState(detail.my_delegate.mode);
  const [delegateAgent, setDelegateAgent] = useState(detail.my_delegate.agent_id ?? "");
  const [advanced, setAdvanced] = useState(false);
  const owner = detail.my_role === "owner";
  const leader = isLeader(detail.my_role);

  return (
    <div className="grid gap-4">
      <AnnouncementSection detail={detail} reload={reload} />

      <section className="grid gap-1.5">
        <SectionTitle>群身份</SectionTitle>
        <ListGroup>
          <Row label="群名" hint="改名将同步到所有成员的 Stream 面板。">
            <TextInput id="stream-name" value={name} onChange={(event) => setName(event.target.value)} className="h-8 w-32 text-xs" disabled={!leader} />
            <Button
              size="xs"
              variant="outline"
              disabled={!leader || !name.trim()}
              onClick={() => void run("streams.rename", { stream_id: detail.stream.id, name }, "群名已更新", reload)}
            >
              改名
            </Button>
          </Row>
          <Row
            label="群 UUID"
            hint={
              <>
                拿到这串的人可以申请进群；改成「仅邀请」后只认邮箱邀请。
                <CopyChip
                  value={detail.stream.id}
                  title="点一下复制完整群 UUID"
                  className="mt-1 block max-w-full truncate text-left text-foreground/80"
                />
              </>
            }
          >
            {null}
          </Row>
          <Row label="进群方式">
            <NativeSelect className="h-8 w-40 text-xs" value={joinPolicy} disabled={!owner} onChange={(event) => setJoinPolicy(event.target.value as "request" | "invite_only")}>
              <NativeSelectOption value="request">凭 UUID 申请审批</NativeSelectOption>
              <NativeSelectOption value="invite_only">只接受邮箱邀请</NativeSelectOption>
            </NativeSelect>
            <Button size="xs" variant="outline" disabled={!owner} onClick={() => void run("streams.settings", { stream_id: detail.stream.id, join_policy: joinPolicy }, "进群方式已更新", reload)}>
              保存
            </Button>
          </Row>
        </ListGroup>
      </section>

      <section className="grid gap-1.5">
        <SectionTitle>本群替身</SectionTitle>
        <ListGroup>
          <Row
            label="替身覆盖"
            hint={
              <>
                班表在「设置 → 替身」里排，对所有群生效；这里只决定本群跟不跟。
                {delegateStatusText(detail.my_delegate)}
              </>
            }
          >
            <NativeSelect
              className="h-8 w-32 text-xs"
              value={delegateMode}
              onChange={(event) => setDelegateMode(event.target.value as "inherit" | "on" | "off")}
            >
              <NativeSelectOption value="inherit">跟随全局班表</NativeSelectOption>
              <NativeSelectOption value="on">只在本群开</NativeSelectOption>
              <NativeSelectOption value="off">本群关掉</NativeSelectOption>
            </NativeSelect>
            {delegateMode === "on" ? (
              <NativeSelect className="h-8 w-28 text-xs" value={delegateAgent} onChange={(event) => setDelegateAgent(event.target.value)}>
                <NativeSelectOption value="">用全局那位</NativeSelectOption>
                {myAgents.map((agent) => (
                  <NativeSelectOption key={agent.id} value={agent.id}>
                    {agent.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void run(
                  "delegate.stream",
                  { stream_id: detail.stream.id, mode: delegateMode, agent_id: delegateMode === "on" ? delegateAgent || null : null },
                  "本群替身已更新",
                  reload,
                )
              }
            >
              保存
            </Button>
          </Row>
        </ListGroup>
      </section>

      <section className="grid gap-1.5">
        <SectionTitle
          aside={
            <Button size="xs" variant="ghost" onClick={() => setAdvanced((current) => !current)}>
              {advanced ? "收起" : "展开"}
            </Button>
          }
        >
          高级设置
        </SectionTitle>
        {advanced ? (
          <div className="grid gap-4">
            <ListGroup>
              <Row label="上下文预算（字符）" hint={`窗口超预算就按群压缩成摘要记忆，历史靠 MCP 回查。中文约 1 字≈1 token，256K 窗口的模型填 20 万够用。当前 ${detail.stream.context_chars}。`}>
                <Input
                  id="context-chars"
                  type="number"
                  min={2000}
                  max={2000000}
                  step={20000}
                  value={contextChars}
                  disabled={!owner}
                  onChange={(event) => setContextChars(Number(event.target.value))}
                  className="h-8 w-24 text-xs"
                />
                <Button size="xs" variant="outline" disabled={!owner} onClick={() => void run("streams.settings", { stream_id: detail.stream.id, context_chars: contextChars }, "预算已更新", reload)}>
                  保存
                </Button>
              </Row>
            </ListGroup>

            <div className="grid gap-1.5">
              <SectionTitle>闪烁颜色</SectionTitle>
              <FlashColorSettings streamId={detail.stream.id} />
            </div>

            <VmsPanel detail={detail} myAgents={[]} myVms={myVms} reload={reload} />

            <McpPanel detail={detail} myAgents={[]} myVms={myVms} reload={reload} />

            {owner ? (
              <div className="grid gap-1.5">
                <OwnerTools detail={detail} humans={detail.members.filter((member) => member.type === "human")} reload={reload} />
                <ListGroup>
                  <Row label="停用这个群" hint="只关闭入口，历史消息按保留策略留在库中。">
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() =>
                        void run("streams.delete", { stream_id: detail.stream.id }, "群已停用", async () => {
                          window.location.hash = "#/";
                        })
                      }
                    >
                      停用
                    </Button>
                  </Row>
                </ListGroup>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
            上下文预算、闪烁颜色、授权虚拟机、群历史 MCP、移交群主与停用群都收在这里。
          </p>
        )}
      </section>
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
    <ListGroup>
      {FLASH_SCENES.map((scene) => {
        const overridden = Boolean(colors[scene.key]);
        const value = colors[scene.key] ?? defaults[scene.key];
        return (
          <div key={scene.key} className="flex items-center gap-2.5 px-3 py-2.5">
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
              <Button size="xs" variant="ghost" onClick={() => update(scene.key, null)}>
                默认
              </Button>
            ) : null}
          </div>
        );
      })}
    </ListGroup>
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
      <section className="grid gap-1.5">
        <SectionTitle
          aside={
            <Button size="xs" variant="ghost" onClick={() => void reload()}>
              刷新
            </Button>
          }
        >
          授权的办公虚拟机 · {detail.vms.length}
        </SectionTitle>
        {detail.vms.length === 0 ? <Notice>这个群还没绑定虚拟机。建群时就能带上，也可以现在补。</Notice> : null}
        {detail.vms.length ? (
          <ListGroup>
            {detail.vms.map((vm) => (
              <div key={vm.grant_id} className="flex items-center gap-2.5 px-3 py-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <ServerIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm">
                    {vm.label}
                    <Badge variant={vm.level === "sudo" ? "default" : "secondary"} className="rounded-full px-1.5 py-0 text-[10px] font-normal">
                      {vm.level === "sudo" ? "sudo" : "普通"}
                    </Badge>
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {vm.username ? `${vm.username}@` : ""}
                    {vm.host}:{vm.port}
                    {vm.workdir ? ` · ${vm.workdir}` : ""}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {vm.last_probe
                      ? `连通探测：${vm.last_probe.reachable ? "可达" : "不可达"}（${timeAgo(vm.last_probe.checked_at)}）· ${vm.last_probe.note}`
                      : "还没探测过。"}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  className="shrink-0 text-destructive"
                  disabled={!canGrant}
                  onClick={() => void run("streams.vms.revoke", { stream_id: detail.stream.id, grant_id: vm.grant_id }, "已解除授权", reload)}
                >
                  解除
                </Button>
              </div>
            ))}
          </ListGroup>
        ) : null}
      </section>

      <section className="grid gap-1.5">
        <SectionTitle>授权到群</SectionTitle>
        <ListGroup>
          <Row label="把我的企业虚拟机授权给这个群" hint="只能授权自己登记的虚拟机；等级决定群里虚拟员工拿到的凭据用途。">
            <NativeSelect className="h-8 w-32 text-xs" value={pick} onChange={(event) => setPick(event.target.value)} disabled={!available.length}>
              <NativeSelectOption value="">{available.length ? "选择虚拟机…" : "没有可授权"}</NativeSelectOption>
              {available.map((vm) => (
                <NativeSelectOption key={vm.id} value={vm.id}>
                  {vm.label} · {vm.host}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect className="h-8 w-20 text-xs" value={level} onChange={(event) => setLevel(event.target.value as "member" | "sudo")}>
              <NativeSelectOption value="member">普通</NativeSelectOption>
              <NativeSelectOption value="sudo">sudo</NativeSelectOption>
            </NativeSelect>
            <Button
              size="xs"
              variant="outline"
              disabled={!canGrant || !pick}
              onClick={() => {
                void run("streams.vms.grant", { stream_id: detail.stream.id, vm_id: pick, level }, "虚拟机已授权", reload);
                setPick("");
              }}
            >
              授权
            </Button>
          </Row>
        </ListGroup>
        {!canGrant ? <Notice>授权到群由群主或管理员操作。</Notice> : null}
      </section>
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
      <section className="grid gap-1.5">
        <SectionTitle>群历史 MCP 端点</SectionTitle>
        <ListGroup>
          <Row
            label="端点"
            hint={
              <>
                {`当前状态：${detail.stream.mcp_key_set ? "已设置（库里只存 SHA-256 散列）" : "未设置"}`}
                <code className="mt-1 block truncate font-mono text-[11px] text-foreground/80">{endpoint}</code>
              </>
            }
          >
            <CopyButton value={endpoint} />
          </Row>
          <Row label="群钥匙" hint="外部 Agent 凭这把钥匙回查历史、读写群文件与公告；钥匙只显示一次。">
            <Button
              size="xs"
              variant="outline"
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
              size="xs"
              variant="ghost"
              className="text-destructive"
              disabled={!owner || !detail.stream.mcp_key_set}
              onClick={() => void run("streams.mcpkey.clear", { stream_id: detail.stream.id }, "钥匙已清除", reload)}
            >
              清除
            </Button>
          </Row>
        </ListGroup>
        {!owner ? <Notice>只有群主能生成或清除这把钥匙。</Notice> : null}
      </section>

      {key ? (
        <div className="grid gap-2 rounded-xl border border-machine/40 bg-machine-soft p-3">
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

      <section className="grid gap-1.5">
        <SectionTitle>对外可调用的工具</SectionTitle>
        <div className="flex flex-wrap gap-1 rounded-xl border border-border/60 bg-card/50 px-3 py-2.5">
          {[
            "search_history", "read_window", "get_context", "get_announcement",
            "list_files", "read_file", "upload_file", "delete_file",
            "send_message", "invite_member", "set_announcement", "list_skills", "read_skill",
          ].map((name) => (
            <code key={name} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{name}</code>
          ))}
        </div>
        <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
          虚拟员工跑任务走内部工具；同一端点对外开成 JSON-RPC MCP。参数与示例见内置技能「DevStream 群文件与公告」。
        </p>
      </section>
    </div>
  );
}
