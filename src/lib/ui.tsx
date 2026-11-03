// 跨视图复用的小件：头像、@ 高亮、复制、字段容器、派发状态、消息贴图。
import { useEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { describeError, get } from "../api";
import type { Attachment, Delivery } from "../types";
import { AVATAR_PRESETS, avatarPresetDataUrl, presetPreviewUrl } from "./avatars";
import { initials } from "./format";

export type Kind = "human" | "agent" | "system";

/** 头像：有自定义图片就显示图片，否则用名字首字；虚拟员工可点进详情页，在忙时右下角转圈。 */
export function PersonAvatar({
  name,
  kind,
  color,
  avatar,
  className,
  href,
  busy,
  title,
}: {
  name: string;
  kind: Kind;
  color?: string;
  avatar?: string | null;
  className?: string;
  href?: string;
  busy?: boolean;
  title?: string;
}) {
  const base =
    "grid size-8 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-semibold select-none";
  const face = avatar ? (
    <img src={avatar} alt="" draggable={false} className="size-full object-cover" />
  ) : (
    initials(name)
  );
  const avatarNode =
    kind === "agent" ? (
      <span
        className={cn(base, "ring-2 ring-offset-2 ring-offset-background", className)}
        style={{ background: "var(--machine-soft)", color: "var(--machine)", "--tw-ring-color": color ?? "var(--machine)" } as CSSProperties}
        title="虚拟员工"
      >
        {face}
      </span>
    ) : kind === "system" ? (
      <span className={cn(base, "bg-muted text-muted-foreground", className)} title="系统">
        ⚙
      </span>
    ) : (
      <span className={cn(base, "bg-signal-soft text-signal", className)} title="真实员工">
        {face}
      </span>
    );
  if (!href && !busy) return avatarNode;
  return (
    <span className="relative inline-flex shrink-0">
      {href ? (
        <a
          href={href}
          title={title ?? "查看员工详情"}
          className="inline-flex shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          onClick={(event) => event.stopPropagation()}
        >
          {avatarNode}
        </a>
      ) : avatarNode}
      {busy ? (
        <span
          aria-label="正在处理任务"
          title="正在处理任务"
          className="pointer-events-none absolute -right-0.5 -bottom-0.5 size-2.5 animate-spin rounded-full border-2 border-machine border-t-transparent bg-background"
        />
      ) : null}
    </span>
  );
}

const AVATAR_SIZE = 128;

/** 浏览器端裁成 128×128 的 WebP data URL；库里只存这个字符串。 */
export async function toAvatarDataUrl(file: File) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas_unavailable");
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    );
    return canvas.toDataURL("image/webp", 0.86);
  } finally {
    bitmap.close();
  }
}

/** 头像选择：预览 + 上传/更换/移除 + 内置默认头像，选定后一律回调 128×128 的 data URL。 */
export function AvatarPicker({
  name,
  kind,
  color,
  avatar,
  onChange,
}: {
  name: string;
  kind: Kind;
  color?: string;
  avatar?: string | null;
  onChange: (next: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  const [presetBusy, setPresetBusy] = useState("");

  async function pick(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("选一张图片文件（PNG / JPEG / WebP）。");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error("图片不要超过 8MB。");
      return;
    }
    setWorking(true);
    try {
      onChange(await toAvatarDataUrl(file));
    } catch {
      toast.error("这张图读不出来，换一张试试。");
    } finally {
      setWorking(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  // 默认头像不占仓库图片：SVG 画在代码里，点下去才在浏览器烤成 WebP，跟上传那条路同一个字段。
  async function usePreset(preset: (typeof AVATAR_PRESETS)[number]) {
    setPresetBusy(preset.key);
    try {
      onChange(await avatarPresetDataUrl(preset.svg));
    } catch {
      toast.error("这个默认头像没生成出来，换一个或自己上传。");
    } finally {
      setPresetBusy("");
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2.5">
        <PersonAvatar name={name || "?"} kind={kind} color={color} avatar={avatar} className="size-12 text-sm" />
        <div className="grid gap-1">
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={working}
              onClick={() => inputRef.current?.click()}
            >
              {working ? "处理中…" : avatar ? "换头像" : "上传头像"}
            </Button>
            {avatar ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => onChange("")}
              >
                移除
              </Button>
            ) : null}
          </div>
          <p className="text-[11px] text-muted-foreground">PNG / JPEG / WebP，裁成 128×128 存库，不超过 8MB。</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">没图就挑一个：</span>
        {AVATAR_PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            title={preset.label}
            aria-label={preset.label}
            disabled={working || presetBusy !== ""}
            onClick={() => void usePreset(preset)}
            className={cn(
              "size-7 shrink-0 overflow-hidden rounded-full ring-1 ring-inset ring-black/10 transition",
              "hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
              "disabled:opacity-50",
              presetBusy === preset.key ? "opacity-40" : "",
            )}
          >
            <img src={presetPreviewUrl(preset.svg)} alt="" draggable={false} className="size-full object-cover" />
          </button>
        ))}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => void pick(event.target.files?.[0])}
      />
    </div>
  );
}

const DELIVERY_TONES: Record<Delivery["status"], { label: string; className: string }> = {
  queued: { label: "未读", className: "bg-signal-soft text-signal" },
  running: { label: "处理中", className: "bg-machine-soft text-machine" },
  done: { label: "已读", className: "bg-muted text-muted-foreground" },
  failed: { label: "处理失败", className: "bg-destructive/10 text-destructive" },
  cancelled: { label: "已取消", className: "bg-muted/70 text-muted-foreground" },
};

/** 一条 @ 消息在每位虚拟员工邮箱里的状态：未读 / 处理中 / 已读 / 失败。 */
export function DeliveryChips({ deliveries, dense = false }: { deliveries?: Delivery[]; dense?: boolean }) {
  const rows = deliveries ?? [];
  if (!rows.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {rows.map((row) => {
        const tone = DELIVERY_TONES[row.status] ?? DELIVERY_TONES.done;
        return (
          <span
            key={row.agent_id}
            title={`${row.agent_name} · ${tone.label}${row.error ? ` · ${row.error}` : ""}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-1.5 py-0 font-normal",
              dense ? "text-[10px]" : "text-[11px]",
              tone.className,
            )}
          >
            {row.status === "running" ? (
              <span aria-hidden className="size-1.5 animate-spin rounded-full border border-current border-t-transparent" />
            ) : null}
            <span className="max-w-24 truncate">{row.agent_name}</span>
            <span className="opacity-80">{tone.label}</span>
          </span>
        );
      })}
    </div>
  );
}

export function RoleBadge({ role }: { role: "owner" | "admin" | "member" }) {
  const label = role === "owner" ? "群主" : role === "admin" ? "管理员" : "成员";
  return (
    <Badge
      variant="secondary"
      className={cn(
        "rounded-full px-1.5 py-0 text-[10px] leading-4 font-normal",
        role === "owner" && "bg-signal/12 text-signal",
      )}
    >
      {label}
    </Badge>
  );
}

/** 把正文里的 @名字 上底色；names 只取本群已知的显示名。 */
export function MentionText({ content, names }: { content: string; names: string[] }) {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!sorted.length) return <>{content}</>;
  const pattern = sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(@(?:${pattern}))`, "g");
  const parts = content.split(re);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("@") && sorted.some((n) => part === `@${n}`) ? (
          <span key={index} className="rounded-sm bg-signal/15 px-0.5 font-medium text-signal">
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

const thumbCache = new Map<string, string>();

/** 消息贴图：列表里只带引用，缩略图渲染这一条时才去拉原图字节；模块级缓存避免翻页重复拉。 */
export function MessageImages({ attachments, dense = false }: { attachments?: Attachment[]; dense?: boolean }) {
  const [open, setOpen] = useState<Attachment | null>(null);
  if (!attachments?.length) return null;
  return (
    <>
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {attachments.map((file) => (
          <Thumb key={file.file_id} file={file} dense={dense} onOpen={() => setOpen(file)} />
        ))}
      </div>
      {open ? <Lightbox file={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function Thumb({ file, dense, onOpen }: { file: Attachment; dense: boolean; onOpen: () => void }) {
  const [data, setData] = useState<string | null>(thumbCache.get(file.file_id) ?? null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (data) return;
    let alive = true;
    get<{ ok: true; attachment: { data: string } }>("messages.attachment", { id: file.file_id })
      .then((result) => {
        if (!alive) return;
        thumbCache.set(file.file_id, result.attachment.data);
        setData(result.attachment.data);
      })
      .catch((reason) => {
        if (alive) setError(describeError(reason));
      });
    return () => {
      alive = false;
    };
  }, [file.file_id, data]);

  if (error) {
    return (
      <span className="grid max-w-40 rounded-md border border-destructive/40 px-2 py-1 text-[11px] leading-snug text-destructive">
        {file.name}：{error}
      </span>
    );
  }
  if (!data) {
    return (
      <span
        className={cn("animate-pulse rounded-md bg-muted", dense ? "size-16" : "size-20")}
        role="img"
        aria-label={`${file.name} 加载中`}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${file.name} · 点开看原图`}
      className="overflow-hidden rounded-md border border-border/60"
    >
      <img
        src={`data:${file.content_type};base64,${data}`}
        alt={file.name}
        draggable={false}
        className={cn("object-cover", dense ? "size-16" : "size-20")}
      />
    </button>
  );
}

function Lightbox({ file, onClose }: { file: Attachment; onClose: () => void }) {
  const src = thumbCache.get(file.file_id);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!src) return null;
  return (
    // 遮罩盖住整屏，点空白或 Esc 关掉；图片本身拦住冒泡，免得误触。
    <div
      role="dialog"
      aria-label={file.name}
      className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4"
      onClick={onClose}
    >
      <figure className="grid justify-items-center gap-2" onClick={(event) => event.stopPropagation()}>
        <img
          src={`data:${file.content_type};base64,${src}`}
          alt={file.name}
          draggable={false}
          className="max-h-[80vh] max-w-full rounded-md object-contain"
        />
        <figcaption className="max-w-full truncate text-xs text-white/80">{file.name}</figcaption>
      </figure>
    </div>
  );
}

export async function copyText(value: string, hint = "已复制") {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(hint);
    return true;
  } catch {
    toast.error("浏览器拒绝了剪贴板访问，请手动选中复制。");
    return false;
  }
}

/** 点一下就复制的行内码片：群 UUID 这类要转给别人去搜的串，不值得再多一个按钮。 */
export function CopyChip({
  value,
  display,
  title = "点一下复制",
  className,
}: {
  value: string;
  display?: string;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
      className={cn(
        "shrink-0 cursor-copy rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
        className,
      )}
    >
      {copied ? "已复制 ✓" : (display ?? value)}
    </button>
  );
}

export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn("h-7 gap-1 px-2 text-xs", className)}
      onClick={() => void copyText(value)}
    >
      复制{label ? ` ${label}` : ""}
    </Button>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <Input {...props} />;
}

export function StatRow({ label, value, tone }: { label: string; value: ReactNode; tone?: "signal" | "machine" | "muted" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          tone === "signal" && "text-signal",
          tone === "machine" && "text-machine",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <p
      className={cn(
        "rounded-md border px-3 py-2 text-xs leading-relaxed",
        tone === "warn"
          ? "border-machine/40 bg-machine-soft text-machine"
          : "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 pb-2">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</h2>
      {aside}
    </div>
  );
}
