// 群聊右侧的操作面板：成员与 @ 派发、群文件、群设置、授权虚拟机、MCP 端点。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DownloadIcon,
  EyeIcon,
  FileCodeIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  ServerIcon,
  TerminalIcon,
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
import { renderMarkdown } from "../../lib/renderers/markdown-message";
import type { AgentPresence, DelegateStatus, GroupFile, Member, Presented, Request, StreamDetail, Vm } from "../../types";
import { useI18n, type I18n, type MsgKey } from "../../lib/i18n";

type Props = {
  detail: StreamDetail;
  myAgents: Agent[];
  myVms: Vm[];
  reload: () => Promise<void>;
  // 「点开这台虚拟机的终端」：只有群现场知道终端面板开在哪，所以由 ChatView 传下来。
  onOpenTerminal?: (vmId: string) => void;
};

const isLeader = (role: Member["role"]) => role === "owner" || role === "admin";

async function run(i18n: I18n, action: string, body: unknown, done: string, reload: () => Promise<void>) {
  try {
    await api(action, { body });
    toast.success(done);
    await reload();
    return true;
  } catch (error) {
    toast.error(describeError(i18n, error));
    return false;
  }
}

/** 服务端回的原因码，原样翻译成人话；没见过的码就照实贴出来，不编一个好听的说法。 */
const DELEGATE_REASONS: Record<string, MsgKey> = {
  not_enabled: "panel.delegateReasonNotEnabled",
  no_agent: "panel.delegateReasonNoAgent",
  agent_missing: "panel.delegateReasonAgentMissing",
  agent_not_owned: "panel.delegateReasonAgentNotOwned",
  agent_paused: "panel.delegateReasonAgentPaused",
  agent_not_in_stream: "panel.delegateReasonAgentNotInStream",
  not_started: "panel.delegateReasonNotStarted",
  expired: "panel.delegateReasonExpired",
  stream_off: "panel.delegateReasonStreamOff",
};

function delegateStatusText(i18n: I18n, status: DelegateStatus) {
  if (status.active) return i18n.tf("panel.delegateActive", { name: status.agent_name ?? i18n.t("panel.unknown") });
  const reason = status.reason ? (DELEGATE_REASONS[status.reason] ? i18n.t(DELEGATE_REASONS[status.reason]) : status.reason) : i18n.t("panel.delegateReasonUnknown");
  return i18n.tf("panel.delegateInactive", { reason });
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
  const i18n = useI18n();
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
        <SectionTitle>{i18n.tf("panel.membersTitle", { n: members.length })}</SectionTitle>
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
            {i18n.t("panel.membersHint")}
          </p>
        ) : null}
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <TextInput
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder={i18n.t("panel.invitePlaceholder")}
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 text-xs"
              disabled={!isLeader(role) || !inviteEmail.includes("@")}
              onClick={() => {
                void run(i18n, "streams.invite", { stream_id: detail.stream.id, email: inviteEmail }, i18n.t("panel.toastInvited"), reload);
                setInviteEmail("");
              }}
            >
              {i18n.t("panel.invite")}
            </Button>
          </div>
          {candidates.length ? (
            <div className="flex items-center gap-2">
              <NativeSelect className="h-8 flex-1 text-xs" value={pickAgent} onChange={(event) => setPickAgent(event.target.value)}>
                <NativeSelectOption value="">{i18n.t("panel.pickAgentPlaceholder")}</NativeSelectOption>
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
                  void run(i18n, "streams.agents.add", { stream_id: detail.stream.id, agent_id: pickAgent }, i18n.t("panel.toastAgentJoined"), reload);
                  setPickAgent("");
                }}
              >
                {i18n.t("panel.addAgent")}
              </Button>
            </div>
          ) : null}
        </div>
        {!isLeader(role) ? <Notice>{i18n.t("panel.leaderOnlyNotice")}</Notice> : null}
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
  const i18n = useI18n();
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
          {agent ? i18n.t("ui.kindAgentShort") : i18n.t("ui.kindHumanShort")}
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
                void run(i18n, 
                  "streams.members.promote",
                  {
                    stream_id: detail.stream.id,
                    membership_id: member.membership_id,
                    role: member.role === "admin" ? "member" : "admin",
                  },
                  member.role === "admin" ? i18n.t("panel.toastDemoted") : i18n.t("panel.toastPromoted"),
                  reload,
                )
              }
            >
              {member.role === "admin" ? i18n.t("panel.demote") : i18n.t("panel.promote")}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            className="h-5 px-1 text-[10px] text-destructive"
            onClick={() =>
              void run(i18n, "streams.members.remove", { stream_id: detail.stream.id, membership_id: member.membership_id }, i18n.t("panel.toastRemoved"), reload)
            }
          >
            {i18n.t("panel.remove")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RequestsSection({ detail, reload }: { detail: StreamDetail; reload: () => Promise<void> }) {
  const i18n = useI18n();
  const [items, setItems] = useState<Request[] | null>(null);
  const list = items ?? detail.requests;

  async function refresh() {
    try {
      const result = await get<{ ok: true; items: Request[] }>("streams.requests", { stream_id: detail.stream.id });
      setItems(result.items);
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  if (!isLeader(detail.my_role)) return null;
  return (
    <section className="grid gap-1.5">
      <SectionTitle
        aside={
          <Button size="xs" variant="ghost" onClick={() => void refresh()}>
            {i18n.t("common.refresh")}
          </Button>
        }
      >
        {i18n.t("panel.requestsTitle")}
      </SectionTitle>
      {list.length === 0 ? <p className="px-1 text-[11px] text-muted-foreground">{i18n.t("panel.requestsEmpty")}</p> : null}
      {list.length ? (
        <ListGroup>
          {list.map((request) => (
            <div key={request.id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs">
                  {request.applicant_name ?? request.applicant_email ?? (request.kind === "agent" ? i18n.t("ui.kindAgent") : i18n.t("panel.unknown"))}
                  <span className="ml-1.5 text-muted-foreground">
                    {request.kind === "human" ? i18n.t("panel.kindRequest") : request.kind === "invite" ? i18n.t("panel.kindInvite") : i18n.t("panel.kindBorrow")}
                  </span>
                </p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {request.status} · {timeAgo(i18n, request.created_at)}
                </p>
              </div>
              {request.status === "pending" ? (
                <>
                  <Button
                    size="xs"
                    onClick={() =>
                      void run(i18n, "streams.decide", { request_id: request.id, approve: true }, i18n.t("panel.toastApproved"), async () => {
                        setItems(null);
                        await reload();
                      })
                    }
                  >
                    {i18n.t("panel.approve")}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void run(i18n, "streams.decide", { request_id: request.id, approve: false }, i18n.t("panel.toastRejected"), async () => {
                        setItems(null);
                        await reload();
                      })
                    }
                  >
                    {i18n.t("panel.reject")}
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
  const i18n = useI18n();
  const [target, setTarget] = useState("");
  const others = humans.filter((m) => m.role !== "owner");
  return (
    <section className="grid gap-1.5">
      <SectionTitle>{i18n.t("panel.ownerToolsTitle")}</SectionTitle>
      <ListGroup>
        <Row label={i18n.t("panel.transferLabel")} hint={i18n.t("panel.transferHint")}>
          <NativeSelect className="h-8 w-32 text-xs" value={target} onChange={(event) => setTarget(event.target.value)}>
            <NativeSelectOption value="">{i18n.t("panel.transferPick")}</NativeSelectOption>
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
              void run(i18n, "streams.transfer", { stream_id: detail.stream.id, membership_id: target }, i18n.t("panel.toastTransferred"), reload);
              setTarget("");
            }}
          >
            {i18n.t("panel.transfer")}
          </Button>
        </Row>
        <Row label={i18n.t("panel.leaveLabel")} hint={i18n.t("panel.leaveHint")}>
          <Button
            size="xs"
            variant="ghost"
            className="text-destructive"
            onClick={() =>
              void run(i18n, "streams.leave", { stream_id: detail.stream.id }, i18n.t("panel.toastLeft"), async () => {
                window.location.hash = "#/";
              })
            }
          >
            {i18n.t("panel.leave")}
          </Button>
        </Row>
      </ListGroup>
    </section>
  );
}

/** 群公告：钉钉把它放在群设置里，不占聊天区。管理者可就地编辑。 */
function AnnouncementSection({ detail, reload }: Pick<Props, "detail" | "reload">) {
  const i18n = useI18n();
  const leader = isLeader(detail.my_role);
  const published = detail.stream.announcement.trim();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(detail.stream.announcement);
  useEffect(() => setValue(detail.stream.announcement), [detail.stream.announcement]);

  return (
    <section className="grid gap-1.5">
      <SectionTitle>{i18n.t("chat.announcementTitle")}</SectionTitle>
      <ListGroup>
        <Row
          label={i18n.t("panel.announcementLabel")}
          hint={published ? <span className="whitespace-pre-wrap text-foreground/80">{published}</span> : i18n.t("panel.announcementEmpty")}
        >
          {leader ? (
            <Button size="xs" variant="outline" onClick={() => setEditing((current) => !current)}>
              {editing ? i18n.t("common.collapse") : published ? i18n.t("common.edit") : i18n.t("panel.publish")}
            </Button>
          ) : null}
        </Row>
        {published ? (
          <Row label={i18n.t("panel.announcementAtLabel")} hint={i18n.t("panel.announcementAtHint")}>
            <span className="font-mono text-[11px] text-muted-foreground">{timeAgo(i18n, detail.stream.announcement_at)}</span>
          </Row>
        ) : null}
        {leader && editing ? (
          <div className="grid gap-2 px-3 pb-3">
            <Textarea
              rows={4}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={i18n.t("panel.announcementPlaceholder")}
              className="text-xs"
            />
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                onClick={() => {
                  void run(i18n, "streams.announcement", { stream_id: detail.stream.id, content: value }, i18n.t("panel.toastAnnouncementPublished"), reload).then((ok) => {
                    if (ok) setEditing(false);
                  });
                }}
              >
                {i18n.t("panel.publishAnnouncement")}
              </Button>
              {published ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setValue("");
                    void run(i18n, "streams.announcement", { stream_id: detail.stream.id, content: "" }, i18n.t("panel.toastAnnouncementCleared"), reload).then((ok) => {
                      if (ok) setEditing(false);
                    });
                  }}
                >
                  {i18n.t("panel.clear")}
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
  const i18n = useI18n();
  const [files, setFiles] = useState<GroupFile[]>(detail.files);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [currentDir, setCurrentDir] = useState("");

  // 返回这次列表拿到的行（失败返回 null），交付卡片定位原件时要靠它决定要不要再报一句"文件不在了"。
  async function refresh(): Promise<GroupFile[] | null> {
    try {
      const result = await get<{ ok: true; items: GroupFile[] }>("files.list", { stream_id: detail.stream.id });
      setFiles(result.items);
      return result.items;
    } catch (error) {
      toast.error(describeError(i18n, error));
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
      else if (again) toast.error(i18n.tf("panel.missingFile", { name: focus.name }));
    };
    void open(files);
    return () => {
      stopped = true;
    };
  }, [focus]);

  async function pickFile(file: File) {
    if (file.size > 400_000) {
      toast.error(i18n.t("panel.fileTooBig"));
      return;
    }
    setContent(await file.text());
    if (!name) setName(file.name);
  }

  async function upload() {
    if (!name.trim() || !content) {
      toast.error(i18n.t("panel.fileNeedBoth"));
      return;
    }
    setBusy(true);
    try {
      await post("files.upload", { stream_id: detail.stream.id, path: currentDir, name: name.trim(), content, content_type: "text/plain" });
      toast.success(i18n.t("panel.toastUploaded"));
      setName("");
      setContent("");
      setUploadOpen(false);
      await refresh();
      await reload();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy(false);
    }
  }

  async function openPreview(file: GroupFile) {
    setPreview({ file, loading: true, content: "", error: "", rendered: null });
    try {
      const result = await get<{ ok: true; name: string; content_type: string; content?: string; signed_url?: string; url?: string }>(
        "files.get",
        { id: file.id },
      );
      const content = result.content ?? "";
      const remote = result.signed_url ?? result.url;
      // 怎么显示交给渲染器注册表：没人接住就是 null，下面照旧落回纯文本，不在这张表里加扩展名判断。
      const rendered = await renderGroupFile({
        name: result.name,
        content_type: result.content_type,
        content,
        url: remote,
      });
      setPreview((current) =>
        current && current.file.id === file.id
          ? { file, loading: false, content, signedUrl: remote, error: "", rendered }
          : current,
      );
    } catch (error) {
      setPreview((current) =>
        current && current.file.id === file.id
          ? { file, loading: false, content: "", error: describeError(i18n, error), rendered: null }
          : current,
      );
    }
  }

  async function download(file: GroupFile) {
    try {
      const result = await get<{ ok: true; name: string; content?: string; signed_url?: string; url?: string }>("files.get", { id: file.id });
      const remote = result.signed_url ?? result.url;
      if (remote) {
        window.open(remote, "_blank", "noopener");
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
      toast.error(describeError(i18n, error));
    }
  }

  const fullOf = (file: GroupFile) => (file.path ? `${file.path}/${file.name}` : file.name);
  const byDir = useMemo(() => {
    const map = new Map<string, GroupFile[]>();
    for (const file of files) {
      const key = file.path ?? "";
      map.set(key, [...(map.get(key) ?? []), file]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(b.store === "dir") - Number(a.store === "dir") || a.name.localeCompare(b.name));
    }
    return map;
  }, [files]);
  const toggleCollapsed = (path: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  async function mkdir() {
    const raw = window.prompt(i18n.t("panel.newFolderPrompt"), currentDir ? `${currentDir}/` : "");
    if (raw === null || !raw.trim()) return;
    try {
      await post("files.mkdir", { stream_id: detail.stream.id, path: raw.trim() });
      setCurrentDir(raw.trim());
      await refresh();
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  const renderTree = (dir: string, depth: number): React.ReactNode =>
    (byDir.get(dir) ?? []).map((file) => {
      const full = fullOf(file);
      const isDir = file.store === "dir";
      const open = !collapsed.has(full);
      return (
        <div key={file.id}>
          <div className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-accent/60" style={{ paddingLeft: `${6 + depth * 14}px` }}>
            {isDir ? (
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => {
                  setCurrentDir(full);
                  if (!open) toggleCollapsed(full);
                }}
              >
                <span className="w-3 shrink-0 text-[10px] text-muted-foreground">{open ? "▾" : "▸"}</span>
                <span className="truncate text-xs font-medium">{file.name}/</span>
              </button>
            ) : (
              <>
                <FileGlyph name={file.name} />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  title={i18n.t("panel.previewOnlineTitle")}
                  onClick={() => void openPreview(file)}
                >
                  <p className="truncate text-xs font-medium">{file.name}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {byteSize(i18n, file.size_bytes)} · {file.uploaded_name ?? i18n.t("panel.memberFallback")} · {timeAgo(i18n, file.created_at)}
                  </p>
                </button>
              </>
            )}
            <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              {isDir ? null : (
                <>
                  <Button size="icon-xs" variant="ghost" title={i18n.t("panel.previewTitle")} onClick={() => void openPreview(file)}>
                    <EyeIcon />
                  </Button>
                  <Button size="icon-xs" variant="ghost" title={i18n.t("panel.download")} onClick={() => void download(file)}>
                    <DownloadIcon />
                  </Button>
                </>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                className="text-destructive"
                title={i18n.t("common.delete")}
                onClick={() =>
                  void run(i18n, "files.delete", { id: file.id }, i18n.t("common.deleted"), async () => {
                    await refresh();
                    await reload();
                  })
                }
              >
                <Trash2Icon />
              </Button>
            </div>
          </div>
          {isDir && open ? renderTree(full, depth + 1) : null}
        </div>
      );
    });

  return (
    <section className="grid min-w-0 gap-1.5">
      <SectionTitle
        aside={
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="rounded-full px-1.5 py-0 font-mono text-[10px]">{files.length}</Badge>
            <Button size="xs" variant="ghost" onClick={() => void mkdir()}>
              {i18n.t("panel.newFolder")}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setUploadOpen((current) => !current)}>
              {uploadOpen ? i18n.t("panel.collapseUpload") : i18n.t("panel.uploadLabel")}
            </Button>
          </div>
        }
      >
        {i18n.t("panel.filesTitle")}
      </SectionTitle>
      <ListGroup>
      {files.length === 0 ? (
        <p className="px-3 py-3 text-xs leading-relaxed text-muted-foreground">{i18n.t("panel.filesEmpty")}</p>
      ) : (
        <div>
          <div className="grid gap-0.5 p-1.5">
            {renderTree("", 0)}
          </div>
        </div>
      )}

      {uploadOpen ? (
        <div className="grid gap-2 p-2.5">
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={i18n.t("panel.fileNamePlaceholder")}
            className="h-7 text-xs"
          />
          <Textarea
            rows={4}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={i18n.t("panel.fileContentPlaceholder")}
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
              {busy ? i18n.t("panel.uploading") : i18n.t("panel.uploadToGroup")}
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
              {preview ? `${byteSize(i18n, preview.file.size_bytes)} · ${preview.file.content_type} · ${preview.file.uploaded_name ?? i18n.t("panel.memberFallback")} · ${timeAgo(i18n, preview.file.created_at)}` : ""}
            </DialogDescription>
          </DialogHeader>
          {preview?.loading ? (
            <p className="text-sm text-muted-foreground">{i18n.t("panel.loadingPreview")}</p>
          ) : preview?.error ? (
            <Notice>{preview.error}</Notice>
          ) : preview?.rendered?.view.kind === "pdf" ? (
            <iframe
              src={preview.rendered.view.src}
              title={preview.file.name}
              className="h-[55vh] w-full rounded-md border"
            />
          ) : preview?.signedUrl ? (
            preview.file.content_type.startsWith("image/") ? (
              <img src={preview.signedUrl} alt={preview.file.name} className="max-h-[55vh] w-auto rounded-md border" />
            ) : preview.file.content_type.startsWith("video/") ? (
              <video src={preview.signedUrl} controls className="max-h-[55vh] w-full rounded-md border" />
            ) : (
              <a href={preview.signedUrl} target="_blank" rel="noopener" className="text-sm text-signal underline">
                {i18n.t("panel.signedUrlHint")}
              </a>
            )
          ) : preview?.rendered?.view.kind === "svg" ? (
            <div className="grid min-w-0 gap-1.5">
              {/* markup 由渲染器自己生成：标签文本出图前逐字转义过，所以这里塞进 DOM 的不是群里的原文。 */}
              <div
                className="max-h-[55vh] overflow-auto rounded-md border bg-muted/30 p-3"
                dangerouslySetInnerHTML={{ __html: preview.rendered.view.markup }}
              />
              <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
                {preview.rendered.view.summary} · {i18n.tf("panel.structuralPreview", { renderer: preview.rendered.rendererId })}
              </p>
            </div>
          ) : preview?.rendered?.view.kind === "text" ? (
            <pre className="max-h-[55vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {preview.rendered.view.text || i18n.t("panel.emptyFile")}
            </pre>
          ) : preview?.rendered?.view.kind === "markdown" ? (
            <div className="max-h-[55vh] overflow-auto rounded-md border bg-muted/20 p-3 text-sm leading-relaxed">
              {renderMarkdown(preview.rendered.view.text, [])}
            </div>
          ) : preview?.rendered?.view.kind === "table" ? (
            <PreviewTable view={preview.rendered.view} />
          ) : preview?.rendered?.view.kind === "image" ? (
            <img
              src={preview.rendered.view.src}
              alt={preview.rendered.view.alt || preview.file.name}
              className="max-h-[55vh] w-auto rounded-md border"
            />
          ) : (
            <pre className="max-h-[55vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {preview?.content || i18n.t("panel.emptyFile")}
            </pre>
          )}
          <DialogFooter>
            {preview ? (
              <Button size="sm" variant="outline" onClick={() => void download(preview.file)}>
                {i18n.t("panel.download")}
              </Button>
            ) : null}
            <Button size="sm" onClick={() => setPreview(null)}>
              {i18n.t("common.close")}
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

export function SettingsPanel({ detail, myAgents, myVms, reload, onOpenTerminal }: Props) {
  const i18n = useI18n();
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
        <SectionTitle>{i18n.t("panel.identityTitle")}</SectionTitle>
        <ListGroup>
          <Row label={i18n.t("panel.streamNameLabel")} hint={i18n.t("panel.streamNameHint")}>
            <TextInput id="stream-name" value={name} onChange={(event) => setName(event.target.value)} className="h-8 w-32 text-xs" disabled={!leader} />
            <Button
              size="xs"
              variant="outline"
              disabled={!leader || !name.trim()}
              onClick={() => void run(i18n, "streams.rename", { stream_id: detail.stream.id, name }, i18n.t("panel.toastRenamed"), reload)}
            >
              {i18n.t("panel.rename")}
            </Button>
          </Row>
          <Row
            label={i18n.t("panel.uuidLabel")}
            hint={
              <>
                {i18n.t("panel.uuidHint")}
                <CopyChip
                  value={detail.stream.id}
                  title={i18n.t("panel.uuidCopyTitle")}
                  className="mt-1 block max-w-full truncate text-left text-foreground/80"
                />
              </>
            }
          >
            {null}
          </Row>
          <Row label={i18n.t("panel.joinPolicyLabel")}>
            <NativeSelect className="h-8 w-40 text-xs" value={joinPolicy} disabled={!owner} onChange={(event) => setJoinPolicy(event.target.value as "request" | "invite_only")}>
              <NativeSelectOption value="request">{i18n.t("panel.joinRequest")}</NativeSelectOption>
              <NativeSelectOption value="invite_only">{i18n.t("panel.joinInviteOnly")}</NativeSelectOption>
            </NativeSelect>
            <Button size="xs" variant="outline" disabled={!owner} onClick={() => void run(i18n, "streams.settings", { stream_id: detail.stream.id, join_policy: joinPolicy }, i18n.t("panel.toastJoinPolicySaved"), reload)}>
              {i18n.t("panel.save")}
            </Button>
          </Row>
        </ListGroup>
      </section>

      <section className="grid gap-1.5">
        <SectionTitle>{i18n.t("panel.delegateSectionTitle")}</SectionTitle>
        <ListGroup>
          <Row
            label={i18n.t("panel.delegateLabel")}
            hint={
              <>
                {i18n.t("panel.delegateHint")}{" "}
                {delegateStatusText(i18n, detail.my_delegate)}
              </>
            }
          >
            <NativeSelect
              className="h-8 w-32 text-xs"
              value={delegateMode}
              onChange={(event) => setDelegateMode(event.target.value as "inherit" | "on" | "off")}
            >
              <NativeSelectOption value="inherit">{i18n.t("panel.delegateInherit")}</NativeSelectOption>
              <NativeSelectOption value="on">{i18n.t("panel.delegateOn")}</NativeSelectOption>
              <NativeSelectOption value="off">{i18n.t("panel.delegateOff")}</NativeSelectOption>
            </NativeSelect>
            {delegateMode === "on" ? (
              <NativeSelect className="h-8 w-28 text-xs" value={delegateAgent} onChange={(event) => setDelegateAgent(event.target.value)}>
                <NativeSelectOption value="">{i18n.t("panel.delegateUseGlobal")}</NativeSelectOption>
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
                void run(i18n, 
                  "delegate.stream",
                  { stream_id: detail.stream.id, mode: delegateMode, agent_id: delegateMode === "on" ? delegateAgent || null : null },
                  i18n.t("panel.toastDelegateSaved"),
                  reload,
                )
              }
            >
              {i18n.t("panel.save")}
            </Button>
          </Row>
        </ListGroup>
      </section>

      <section className="grid gap-1.5">
        <SectionTitle
          aside={
            <Button size="xs" variant="ghost" onClick={() => setAdvanced((current) => !current)}>
              {advanced ? i18n.t("common.collapse") : i18n.t("common.expand")}
            </Button>
          }
        >
          {i18n.t("panel.advancedTitle")}
        </SectionTitle>
        {advanced ? (
          <div className="grid gap-4">
            <ListGroup>
              <Row label={i18n.t("panel.budgetLabel")} hint={i18n.tf("panel.budgetHint", { n: detail.stream.context_chars })}>
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
                <Button size="xs" variant="outline" disabled={!owner} onClick={() => void run(i18n, "streams.settings", { stream_id: detail.stream.id, context_chars: contextChars }, i18n.t("panel.toastBudgetSaved"), reload)}>
                  {i18n.t("panel.save")}
                </Button>
              </Row>
            </ListGroup>

            <div className="grid gap-1.5">
              <SectionTitle>{i18n.t("panel.flashTitle")}</SectionTitle>
              <FlashColorSettings streamId={detail.stream.id} />
            </div>

            <VmsPanel detail={detail} myAgents={[]} myVms={myVms} reload={reload} onOpenTerminal={onOpenTerminal} />

            <McpPanel detail={detail} myAgents={[]} myVms={myVms} reload={reload} />

            {owner ? (
              <div className="grid gap-1.5">
                <OwnerTools detail={detail} humans={detail.members.filter((member) => member.type === "human")} reload={reload} />
                <ListGroup>
                  <Row label={i18n.t("panel.deactivateLabel")} hint={i18n.t("panel.deactivateHint")}>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() =>
                        void run(i18n, "streams.delete", { stream_id: detail.stream.id }, i18n.t("panel.toastDeactivated"), async () => {
                          window.location.hash = "#/";
                        })
                      }
                    >
                      {i18n.t("panel.deactivate")}
                    </Button>
                  </Row>
                </ListGroup>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
            {i18n.t("panel.advancedSummary")}
          </p>
        )}
      </section>
    </div>
  );
}

const FLASH_SCENES: { key: FlashScene; labelKey: MsgKey; hintKey: MsgKey }[] = [
  { key: "mention", labelKey: "panel.flashMention", hintKey: "panel.flashMentionHint" },
  { key: "queued", labelKey: "panel.flashQueued", hintKey: "panel.flashQueuedHint" },
  { key: "live", labelKey: "panel.flashLive", hintKey: "panel.flashLiveHint" },
];

function FlashColorSettings({ streamId }: { streamId: string }) {
  const i18n = useI18n();
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
              <p className="text-xs font-medium">{i18n.t(scene.labelKey)}</p>
              <p className="text-[11px] text-muted-foreground">{i18n.t(scene.hintKey)}</p>
            </div>
            <input
              type="color"
              aria-label={i18n.tf("panel.flashColorAria", { label: i18n.t(scene.labelKey) })}
              value={value}
              onChange={(event) => update(scene.key, event.target.value)}
              className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
            {overridden ? (
              <Button size="xs" variant="ghost" onClick={() => update(scene.key, null)}>
                {i18n.t("panel.flashDefault")}
              </Button>
            ) : null}
          </div>
        );
      })}
    </ListGroup>
  );
}

export function VmsPanel({ detail, myVms, reload, onOpenTerminal }: Props) {
  const i18n = useI18n();
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
              {i18n.t("common.refresh")}
            </Button>
          }
        >
          {i18n.tf("panel.vmsTitle", { n: detail.vms.length })}
        </SectionTitle>
        {detail.vms.length === 0 ? <Notice>{i18n.t("panel.vmsEmpty")}</Notice> : null}
        {detail.vms.length ? (
          <ListGroup>
            {detail.vms.map((vm) => {
              // 只有填了网关地址的虚拟机才连得上终端；没地址的行保持可见但不假装能点，
              // title 说清缺的是哪一栏，免得用户对着一个没反应的行反复试。
              const terminal = Boolean(vm.gateway_url);
              return (
                <div key={vm.grant_id} className="flex items-center gap-2.5 px-3 py-2.5">
                  <button
                    type="button"
                    className={cn(
                      "-mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 text-left",
                      terminal ? "cursor-pointer transition-colors hover:bg-accent/60" : "cursor-default",
                    )}
                    disabled={!terminal}
                    title={terminal ? i18n.t("panel.vmOpenTerminal") : i18n.t("panel.vmNoGateway")}
                    onClick={() => onOpenTerminal?.(vm.id)}
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      {terminal ? <TerminalIcon className="size-4" /> : <ServerIcon className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-sm">
                        {vm.label}
                        <Badge variant={vm.level === "sudo" ? "default" : "secondary"} className="rounded-full px-1.5 py-0 text-[10px] font-normal">
                          {vm.level === "sudo" ? "sudo" : i18n.t("panel.levelNormal")}
                        </Badge>
                      </p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {vm.username ? `${vm.username}@` : ""}
                        {vm.host}:{vm.port}
                        {vm.workdir ? ` · ${vm.workdir}` : ""}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {vm.last_probe
                          ? i18n.tf("panel.probeResult", {
                              state: i18n.t(vm.last_probe.reachable ? "vm.reachable" : "vm.unreachable"),
                              time: timeAgo(i18n, vm.last_probe.checked_at),
                              note: vm.last_probe.note,
                            })
                          : i18n.t("panel.probeNone")}
                      </p>
                    </div>
                  </button>
                <Button
                  size="xs"
                  variant="ghost"
                  className="shrink-0 text-destructive"
                  disabled={!canGrant}
                  onClick={() => void run(i18n, "streams.vms.revoke", { stream_id: detail.stream.id, grant_id: vm.grant_id }, i18n.t("panel.toastRevoked"), reload)}
                >
                  {i18n.t("panel.revoke")}
                </Button>
              </div>
              );
            })}
          </ListGroup>
        ) : null}
      </section>

      <section className="grid gap-1.5">
        <SectionTitle>{i18n.t("panel.grantTitle")}</SectionTitle>
        <ListGroup>
          <Row label={i18n.t("panel.grantLabel")} hint={i18n.t("panel.grantHint")}>
            <NativeSelect className="h-8 w-32 text-xs" value={pick} onChange={(event) => setPick(event.target.value)} disabled={!available.length}>
              <NativeSelectOption value="">{available.length ? i18n.t("panel.grantPick") : i18n.t("panel.grantNone")}</NativeSelectOption>
              {available.map((vm) => (
                <NativeSelectOption key={vm.id} value={vm.id}>
                  {vm.label} · {vm.host}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect className="h-8 w-20 text-xs" value={level} onChange={(event) => setLevel(event.target.value as "member" | "sudo")}>
              <NativeSelectOption value="member">{i18n.t("panel.levelNormal")}</NativeSelectOption>
              <NativeSelectOption value="sudo">sudo</NativeSelectOption>
            </NativeSelect>
            <Button
              size="xs"
              variant="outline"
              disabled={!canGrant || !pick}
              onClick={() => {
                void run(i18n, "streams.vms.grant", { stream_id: detail.stream.id, vm_id: pick, level }, i18n.t("panel.toastGranted"), reload);
                setPick("");
              }}
            >
              {i18n.t("panel.grant")}
            </Button>
          </Row>
        </ListGroup>
        {!canGrant ? <Notice>{i18n.t("panel.grantNotice")}</Notice> : null}
      </section>
    </div>
  );
}

export function McpPanel({ detail, reload }: Props) {
  const i18n = useI18n();
  const owner = detail.my_role === "owner";
  const [key, setKey] = useState("");
  const [curl, setCurl] = useState("");
  const endpoint = `${window.location.origin}/functions/v1/app?action=mcp`;

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 [&>*]:min-w-0">
      <section className="grid gap-1.5">
        <SectionTitle>{i18n.t("panel.mcpTitle")}</SectionTitle>
        <ListGroup>
          <Row
            label={i18n.t("panel.endpointLabel")}
            hint={
              <>
                {i18n.tf("panel.endpointState", { state: i18n.t(detail.stream.mcp_key_set ? "panel.mcpSet" : "panel.mcpUnset") })}
                <code className="mt-1 block truncate font-mono text-[11px] text-foreground/80">{endpoint}</code>
              </>
            }
          >
            <CopyButton value={endpoint} />
          </Row>
          <Row label={i18n.t("panel.mcpKeyLabel")} hint={i18n.t("panel.mcpKeyHint")}>
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
                    toast.success(i18n.t("panel.toastKeyRotated"));
                    await reload();
                  } catch (error) {
                    toast.error(describeError(i18n, error));
                  }
                })();
              }}
            >
              {detail.stream.mcp_key_set ? i18n.t("panel.rotateKey") : i18n.t("panel.generateKey")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="text-destructive"
              disabled={!owner || !detail.stream.mcp_key_set}
              onClick={() => void run(i18n, "streams.mcpkey.clear", { stream_id: detail.stream.id }, i18n.t("panel.toastKeyCleared"), reload)}
            >
              {i18n.t("common.clear")}
            </Button>
          </Row>
        </ListGroup>
        {!owner ? <Notice>{i18n.t("panel.mcpKeyNotice")}</Notice> : null}
      </section>

      {key ? (
        <div className="grid gap-2 rounded-xl border border-machine/40 bg-machine-soft p-3">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-machine">{key}</code>
            <CopyButton value={key} label={i18n.t("panel.keyCopyLabel")} />
          </div>
          <Progress value={100} className="h-0.5 bg-machine/30" />
          <p className="text-xs text-machine">{i18n.t("panel.keyOnceNotice")}</p>
          {curl ? (
            <>
              <pre className="max-h-32 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed">{curl}</pre>
              <CopyButton value={curl} label="curl" className="justify-self-start" />
            </>
          ) : null}
        </div>
      ) : null}

      <section className="grid gap-1.5">
        <SectionTitle>{i18n.t("panel.mcpToolsTitle")}</SectionTitle>
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
          {i18n.t("panel.mcpToolsHint")}
        </p>
      </section>
    </div>
  );
}

/** CSV 预览表：只负责把切好的表头与行画出来；截断与否由渲染器给，不在这里猜。 */
function PreviewTable({ view }: { view: { head: string[]; rows: string[][]; truncated: boolean } }) {
  const i18n = useI18n();
  return (
    <div className="grid gap-1.5">
      <div className="max-h-[50vh] overflow-auto rounded-md border">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr>
              {view.head.map((cell, index) => (
                <th key={index} className="border-b bg-muted/40 px-2 py-1 text-left font-medium whitespace-nowrap">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-muted/10">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="border-b px-2 py-1 align-top">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.truncated ? <p className="text-[10px] text-muted-foreground">{i18n.t("panel.tableTruncated")}</p> : null}
    </div>
  );
}
