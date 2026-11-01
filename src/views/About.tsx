// 设置与关于：显示名、主题、@ 接收通道、改口令，以及产品说明与版权。
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { describeError, get, post, setToken, type User } from "../api";
import type { BrandMode } from "../lib/brand";
import { applyTheme, type ThemeMode } from "../lib/theme";
import { AvatarPicker, Field, Notice, StatRow, TextInput } from "../lib/ui";

type Meta = {
  ok: true;
  name: string;
  server_time: string;
  storage_mode: "platform" | "database";
  smtp: boolean;
  data_key: "secret" | "database";
  local_dev: boolean;
};

export function AboutView({
  user,
  onUserChanged,
  theme,
  onThemeChange,
  brand,
  onBrandChange,
}: {
  user: User;
  onUserChanged: (user: User) => void;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  brand: BrandMode;
  onBrandChange: (mode: BrandMode) => void;
}) {
  const [displayName, setDisplayName] = useState(user.display_name);
  const [avatar, setAvatar] = useState(user.avatar ?? "");
  const [realEmail, setRealEmail] = useState(user.prefs?.notify_real_email ?? false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [meta, setMeta] = useState<Meta | null>(null);

  useEffect(() => {
    void get<Meta>("site.meta").then(setMeta).catch(() => setMeta(null));
  }, []);

  async function saveProfile() {
    try {
      const result = await post<{ ok: true; user: User }>("auth.patch", {
        display_name: displayName,
        avatar,
        prefs: { theme, notify_real_email: realEmail },
      });
      onUserChanged(result.user);
      toast.success("资料已保存");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function changePassword() {
    if (next.length < 8) {
      toast.error("新口令至少 8 位。");
      return;
    }
    try {
      const result = await post<{ ok: true; note: string }>("auth.password", { current_password: current, new_password: next });
      toast.success(result.note);
      setCurrent("");
      setNext("");
      // 服务端把这台设备的会话一并过期了，不留着一个注定 401 的令牌。
      setToken("");
      window.dispatchEvent(new CustomEvent("workstream:signed-out"));
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  return (
    <div className="mx-auto grid h-full w-full max-w-3xl min-h-0 gap-4 overflow-y-auto p-4 scrollbar-thin md:p-6">
      <h1 className="text-lg font-semibold tracking-tight">设置与关于</h1>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">账号</CardTitle>
          <CardDescription className="text-xs">群里 @ 你用的就是这个名字；真实邮箱通道需要在虚拟邮箱页切换。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Field label="头像" hint="显示在群聊、成员列表与顶部导航；点「保存资料」后生效。">
            <AvatarPicker name={displayName || "我"} kind="human" avatar={avatar} onChange={setAvatar} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="显示名" htmlFor="profile-name">
              <TextInput id="profile-name" value={displayName} maxLength={24} onChange={(event) => setDisplayName(event.target.value)} className="h-8 text-xs" />
            </Field>
            <Field label="邮箱" hint={user.email_verified ? "已验证" : "未验证：真实邮箱通道暂时不可用"}>
              <Input value={user.email} readOnly className="h-8 text-xs font-mono" />
            </Field>
            <Field label="主题">
              <NativeSelect
                className="h-8 text-xs"
                value={theme}
                onChange={(event) => {
                  const mode = event.target.value as ThemeMode;
                  onThemeChange(mode);
                  applyTheme(mode);
                }}
              >
                <NativeSelectOption value="system">跟随系统</NativeSelectOption>
                <NativeSelectOption value="light">明亮</NativeSelectOption>
                <NativeSelectOption value="dark">暗色</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field label="真实邮箱同步通知" hint="打开后，重要通知在接了 SMTP 中继时会同时发到你的邮箱。">
              <div className="flex h-8 items-center">
                <Switch checked={realEmail} onCheckedChange={setRealEmail} />
              </div>
            </Field>
            <Field label="品牌标样式" hint="嵌入式：透明底 + 跟随主题的字色（暗色白字、亮色黑字）。">
              <NativeSelect className="h-8 text-xs" value={brand} onChange={(event) => onBrandChange(event.target.value as BrandMode)}>
                <NativeSelectOption value="embed">嵌入式 · 透明底（默认）</NativeSelectOption>
                <NativeSelectOption value="block">实心块</NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>
          <Button size="sm" className="justify-self-start text-xs" onClick={() => void saveProfile()}>
            保存资料
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">改口令</CardTitle>
          <CardDescription className="text-xs">改完所有设备的会话都会立刻失效，包括这台，需要重新登录。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label="当前口令" htmlFor="pwd-current">
            <Input id="pwd-current" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} className="h-8 text-xs" />
          </Field>
          <Field label="新口令" htmlFor="pwd-next">
            <Input id="pwd-next" type="password" value={next} onChange={(event) => setNext(event.target.value)} className="h-8 text-xs" />
          </Field>
          <Button size="sm" variant="outline" className="justify-self-start text-xs" onClick={() => void changePassword()} disabled={!current || !next}>
            更新口令
          </Button>
        </CardContent>
      </Card>

      <Separator />

      <section className="grid gap-3">
        <h2 className="text-sm font-semibold">WorkStream 是怎么运转的</h2>
        <ol className="grid gap-2 text-sm leading-relaxed text-muted-foreground">
          <li>1 · 真实员工用邮箱注册，验证链接在开发态直接显示在站内收件箱里，接上 SMTP 中继后就真发。</li>
          <li>2 · 每个虚拟员工自带 OpenAI 兼容 base URL 与独立 API Key；Key 用 AES-GCM 加密入库，接口与浏览器永远拿不到原文。想先跑通流程可以用内置的 <code className="font-mono text-xs">demo://local</code> 演示端点。</li>
          <li>3 · 群有一个 UUID：拿到 UUID 可以申请进群（群主/管理员审批），也可以只接受邮箱邀请；管理员能拉人和踢人，群主能移交与提升管理员。</li>
          <li>4 · 群里 @ 虚拟员工 = 往 ta 的邮箱落一封任务；@ 真实员工 = 按 ta 选的通道（虚拟邮箱或真实邮箱）投递通知。</li>
          <li>5 · 虚拟员工按 FIFO 取件，跨群按权重切时间片（默认均分，权重由群主/管理员在群成员面板确认），一次 tick 用最大余数法分槽；没有实时抢占，所以单个任务会跑完再让位，整体保持均衡。</li>
          <li>6 · 记忆分两段：员工自己的 common，以及每个群单独的 per-stream。窗口超过预算时按群压缩成一条 summary 记忆并记录覆盖到的消息序号，更早的历史通过 MCP 回查。</li>
          <li>7 · MCP 有两层：员工跑任务时的内部工具循环（search_history / read_window / list_files / read_file / get_context），以及对外的 JSON-RPC 端点，用群主生成的群钥匙访问。</li>
          <li>8 · 办公虚拟机可以登记多台并按群授权，群创建时也能直接绑定；边栏函数没有 TCP 套接字，因此提供的是端口连通探测而不是真 SSH 会话。</li>
        </ol>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">运行时状态</CardTitle>
            <CardDescription className="text-xs">这些是服务端当场报的，不是写死的话术。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-0 sm:grid-cols-2">
            <StatRow label="群文件存放" value={meta ? (meta.storage_mode === "platform" ? "平台 Storage" : "数据库文本列") : "读取中…"} tone="muted" />
            <StatRow label="SMTP 中继" value={meta?.smtp ? "已配置" : "未配置（信件留站内）"} tone={meta?.smtp ? "signal" : "muted"} />
            <StatRow label="主密钥来源" value={meta ? (meta.data_key === "secret" ? "站点 Secret" : "库内生成") : "—"} tone="muted" />
            <StatRow label="本地开发模式" value={meta?.local_dev ? "是" : "否"} tone="muted" />
            <StatRow label="服务器时间" value={meta ? new Date(meta.server_time).toLocaleString("zh-CN", { hour12: false }) : "—"} tone="muted" />
          </CardContent>
        </Card>

        <Notice tone="warn">
          边界说明：库表开放给站点 Function 读写，权限在函数层按会话判定；如果有绕过站点直连数据库的路径，应用层鉴权就不成立，
          这条边界还没有在部署环境里做过渗透验证。虚拟员工的 Key 与虚拟机凭据均为密文存储、只在使用时解密。
        </Notice>

        <div className="grid gap-1 py-2 text-center">
          <p className="text-sm font-medium">WorkStream</p>
          <p className="text-xs text-muted-foreground">copy right www.void-universe.com</p>
        </div>
      </section>
    </div>
  );
}
