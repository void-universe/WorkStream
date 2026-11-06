// 设置与关于：显示名、主题、界面语言、@ 接收通道、替身班表、改口令，以及产品说明与版权。
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { describeError, get, post, setToken, type User } from "../api";
import type { Agent } from "../types";
import type { BrandMode } from "../lib/brand";
import { LOCALES, useI18n, type LocaleId } from "../lib/i18n";
import { type ThemeMode } from "../lib/theme";
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

/** 后端只认 ISO 时刻；datetime-local 给的是本地墙上时间，直接 slice 会把 UTC 当本地用。 */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : "");

export function AboutView({
  user,
  onUserChanged,
  theme,
  onThemeChange,
  brand,
  onBrandChange,
  lang,
  onLangChange,
}: {
  user: User;
  onUserChanged: (user: User) => void;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  brand: BrandMode;
  onBrandChange: (mode: BrandMode) => void;
  lang: LocaleId;
  onLangChange: (lang: LocaleId) => void;
}) {
  const i18n = useI18n();
  const [displayName, setDisplayName] = useState(user.display_name);
  const [avatar, setAvatar] = useState(user.avatar ?? "");
  const [realEmail, setRealEmail] = useState(user.prefs?.notify_real_email ?? false);
  const [delegateMode, setDelegateMode] = useState<"off" | "now" | "window">(
    user.delegate?.agent_id ? (user.delegate.start_at ? "window" : "now") : "off",
  );
  const [delegateAgent, setDelegateAgent] = useState(user.delegate?.agent_id ?? "");
  const [delegateStart, setDelegateStart] = useState(toLocalInput(user.delegate?.start_at ?? null));
  const [delegateEnd, setDelegateEnd] = useState(toLocalInput(user.delegate?.end_at ?? null));
  const [myAgents, setMyAgents] = useState<Agent[]>([]);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [meta, setMeta] = useState<Meta | null>(null);

  useEffect(() => {
    void get<Meta>("site.meta").then(setMeta).catch(() => setMeta(null));
    void get<{ ok: true; items: Agent[] }>("agents.list")
      .then((result) => setMyAgents(result.items))
      .catch(() => setMyAgents([]));
  }, []);

  async function saveProfile() {
    try {
      const result = await post<{ ok: true; user: User }>("auth.patch", {
        display_name: displayName,
        avatar,
        prefs: { theme, notify_real_email: realEmail },
      });
      onUserChanged(result.user);
      toast.success(i18n.t("about.toastProfileSaved"));
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  async function saveDelegate() {
    if (delegateMode !== "off" && !delegateAgent) {
      toast.error(i18n.t("about.toastNeedDelegateAgent"));
      return;
    }
    if (delegateMode === "window") {
      if (!delegateStart && !delegateEnd) {
        toast.error(i18n.t("about.toastNeedBoundary"));
        return;
      }
      if (delegateStart && delegateEnd && new Date(delegateEnd) <= new Date(delegateStart)) {
        toast.error(i18n.t("about.toastEndAfterStart"));
        return;
      }
    }
    try {
      await post("delegate.set", {
        mode: delegateMode,
        agent_id: delegateMode === "off" ? null : delegateAgent,
        start_at: delegateMode === "window" ? fromLocalInput(delegateStart) : null,
        end_at: delegateMode === "window" ? fromLocalInput(delegateEnd) : null,
      });
      onUserChanged({
        ...user,
        delegate: {
          agent_id: delegateMode === "off" ? null : delegateAgent,
          start_at: delegateMode === "window" && delegateStart ? new Date(delegateStart).toISOString() : null,
          end_at: delegateMode === "window" && delegateEnd ? new Date(delegateEnd).toISOString() : null,
        },
      });
      toast.success(i18n.t("about.toastDelegateSaved"));
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  async function changePassword() {
    if (next.length < 8) {
      // 长度门槛是代码里的那道校验，句子里的数走参数，别让各语言字典各抄一遍 8。
      toast.error(i18n.tf("about.toastShortPassword", { n: 8 }));
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
      toast.error(describeError(i18n, error));
    }
  }

  const delegateName = myAgents.find((agent) => agent.id === user.delegate?.agent_id)?.name ?? null;

  // 「登记时刻」原来写死 zh-CN，切了语言后正文换了、时间戳还是中文句式；改走当前 locale 的 Intl。
  const fullStamp = (iso: string) =>
    new Intl.DateTimeFormat(i18n.intl, { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }).format(new Date(iso));

  // 步骤 2 中间要夹一个 <code> 演示端点，拆不成整句，按 {0} 切开交给 JSX 拼。
  const step2Parts = i18n.tp("about.step2");

  /** 已保存的班表现在是什么状态，用服务端同一把尺子算：时段外就该显示「没在替」，不能报正在替。 */
  function delegateSummary() {
    const saved = user.delegate;
    if (!saved?.agent_id || !delegateName) return i18n.t("about.delegateNoneNow");
    const startedAt = Date.parse(saved.start_at ?? "");
    const endedAt = Date.parse(saved.end_at ?? "");
    const at = Date.now();
    const running = (!Number.isFinite(startedAt) || at >= startedAt) && (!Number.isFinite(endedAt) || at < endedAt);
    const span = `${saved.start_at ? fullStamp(saved.start_at) : i18n.t("about.delegateImmediate")} → ${
      saved.end_at ? fullStamp(saved.end_at) : i18n.t("about.delegateUnlimited")
    }`;
    return i18n.tf("about.delegateSummary", {
      name: delegateName,
      span,
      state: running ? i18n.t("about.delegateRunning") : i18n.t("about.delegateIdle"),
    });
  }

  return (
    <div className="mx-auto grid h-full w-full max-w-3xl min-h-0 gap-4 overflow-y-auto p-4 scrollbar-thin md:p-6">
      <h1 className="text-lg font-semibold tracking-tight">{i18n.t("about.title")}</h1>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{i18n.t("about.accountTitle")}</CardTitle>
          <CardDescription className="text-xs">{i18n.t("about.accountDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Field label={i18n.t("about.avatarLabel")} hint={i18n.t("about.avatarHint")}>
            <AvatarPicker name={displayName || i18n.t("about.meFallback")} kind="human" avatar={avatar} onChange={setAvatar} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={i18n.t("about.displayNameLabel")} htmlFor="profile-name">
              <TextInput id="profile-name" value={displayName} maxLength={24} onChange={(event) => setDisplayName(event.target.value)} className="h-8 text-xs" />
            </Field>
            <Field label={i18n.t("about.emailLabel")} hint={user.email_verified ? i18n.t("about.emailVerified") : i18n.t("about.emailUnverified")}>
              <Input value={user.email} readOnly className="h-8 text-xs font-mono" />
            </Field>
            <Field label={i18n.t("about.themeLabel")}>
              <NativeSelect
                className="h-8 text-xs"
                value={theme}
                onChange={(event) => onThemeChange(event.target.value as ThemeMode)}
              >
                <NativeSelectOption value="system">{i18n.t("about.themeSystem")}</NativeSelectOption>
                <NativeSelectOption value="light">{i18n.t("about.themeLight")}</NativeSelectOption>
                <NativeSelectOption value="dark">{i18n.t("about.themeDark")}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field label={i18n.t("lang.changeLabel")} hint={i18n.t("lang.settingsHint")}>
              {/* 语言选项一律用各自的语言写自己的名字：界面已经换成德语后，这一项仍然认得出选哪个。 */}
              <NativeSelect
                className="h-8 text-xs"
                value={lang}
                onChange={(event) => onLangChange(event.target.value as LocaleId)}
              >
                {LOCALES.filter((locale) => locale.complete).map((locale) => (
                  <NativeSelectOption key={locale.id} value={locale.id}>
                    {locale.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field label={i18n.t("about.realEmailLabel")} hint={i18n.t("about.realEmailHint")}>
              <div className="flex h-8 items-center">
                <Switch checked={realEmail} onCheckedChange={setRealEmail} />
              </div>
            </Field>
            <Field label={i18n.t("about.brandLabel")} hint={i18n.t("about.brandHint")}>
              <NativeSelect className="h-8 text-xs" value={brand} onChange={(event) => onBrandChange(event.target.value as BrandMode)}>
                <NativeSelectOption value="embed">{i18n.t("about.brandEmbed")}</NativeSelectOption>
                <NativeSelectOption value="block">{i18n.t("about.brandBlock")}</NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>
          <Button size="sm" className="justify-self-start text-xs" onClick={() => void saveProfile()}>
            {i18n.t("about.saveProfile")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{i18n.t("about.delegateTitle")}</CardTitle>
          <CardDescription className="text-xs">{i18n.t("about.delegateDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={i18n.t("about.delegateAgentLabel")} htmlFor="delegate-agent" hint={i18n.t("about.delegateAgentHint")}>
              <NativeSelect
                id="delegate-agent"
                className="h-8 text-xs"
                value={delegateAgent}
                onChange={(event) => setDelegateAgent(event.target.value)}
              >
                <NativeSelectOption value="">{i18n.t("about.delegateNone")}</NativeSelectOption>
                {myAgents.map((agent) => (
                  <NativeSelectOption key={agent.id} value={agent.id}>
                    {agent.name} · {(agent.backend ?? "openai") === "qca" ? i18n.t("about.backendCloud") : "API"}
                    {agent.status === "paused" ? ` · ${i18n.t("about.pausedSuffix")}` : ""}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field label={i18n.t("about.delegateModeLabel")} htmlFor="delegate-mode">
              <NativeSelect
                id="delegate-mode"
                className="h-8 text-xs"
                value={delegateMode}
                onChange={(event) => setDelegateMode(event.target.value as "off" | "now" | "window")}
              >
                <NativeSelectOption value="off">{i18n.t("about.delegateModeOff")}</NativeSelectOption>
                <NativeSelectOption value="now">{i18n.t("about.delegateModeNow")}</NativeSelectOption>
                <NativeSelectOption value="window">{i18n.t("about.delegateModeWindow")}</NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>
          {delegateMode === "window" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={i18n.t("about.delegateFrom")} htmlFor="delegate-start">
                <Input
                  id="delegate-start"
                  type="datetime-local"
                  value={delegateStart}
                  onChange={(event) => setDelegateStart(event.target.value)}
                  className="h-8 text-xs font-mono"
                />
              </Field>
              <Field label={i18n.t("about.delegateTo")} htmlFor="delegate-end" hint={i18n.t("about.delegateRangeHint")}>
                <Input
                  id="delegate-end"
                  type="datetime-local"
                  value={delegateEnd}
                  onChange={(event) => setDelegateEnd(event.target.value)}
                  className="h-8 text-xs font-mono"
                />
              </Field>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="text-xs" onClick={() => void saveDelegate()}>
              {i18n.t("about.saveDelegate")}
            </Button>
            <span className="text-xs text-muted-foreground">{delegateSummary()}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{i18n.t("about.passwordTitle")}</CardTitle>
          <CardDescription className="text-xs">{i18n.t("about.passwordDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label={i18n.t("about.currentPasswordLabel")} htmlFor="pwd-current">
            <Input id="pwd-current" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} className="h-8 text-xs" />
          </Field>
          <Field label={i18n.t("about.newPasswordLabel")} htmlFor="pwd-next">
            <Input id="pwd-next" type="password" value={next} onChange={(event) => setNext(event.target.value)} className="h-8 text-xs" />
          </Field>
          <Button size="sm" variant="outline" className="justify-self-start text-xs" onClick={() => void changePassword()} disabled={!current || !next}>
            {i18n.t("about.updatePassword")}
          </Button>
        </CardContent>
      </Card>

      <Separator />

      <section className="grid gap-3">
        <h2 className="text-sm font-semibold">{i18n.t("about.howItWorksTitle")}</h2>
        <ol className="grid gap-2 text-sm leading-relaxed text-muted-foreground">
          {/* 「N · 」序号在四种语言里写法相同，留在版式里；进字典的只有正文。 */}
          <li>1 · {i18n.t("about.step1")}</li>
          <li>
            2 · {step2Parts[0]}
            <code className="font-mono text-xs">demo://local</code>
            {step2Parts[1]}
          </li>
          <li>3 · {i18n.t("about.step3")}</li>
          <li>4 · {i18n.t("about.step4")}</li>
          <li>5 · {i18n.t("about.step5")}</li>
          <li>6 · {i18n.t("about.step6")}</li>
          <li>7 · {i18n.t("about.step7")}</li>
          <li>8 · {i18n.t("about.step8")}</li>
          <li>9 · {i18n.t("about.step9")}</li>
        </ol>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">{i18n.t("about.runtimeTitle")}</CardTitle>
            <CardDescription className="text-xs">{i18n.t("about.runtimeDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-0 sm:grid-cols-2">
            <StatRow
              label={i18n.t("about.statStorage")}
              value={meta ? (meta.storage_mode === "platform" ? i18n.t("about.storagePlatform") : i18n.t("about.storageDatabase")) : i18n.t("about.loading")}
              tone="muted"
            />
            <StatRow
              label={i18n.t("about.statSmtp")}
              value={meta?.smtp ? i18n.t("about.smtpConfigured") : i18n.t("about.smtpNotConfigured")}
              tone={meta?.smtp ? "signal" : "muted"}
            />
            <StatRow
              label={i18n.t("about.statDataKey")}
              value={meta ? (meta.data_key === "secret" ? i18n.t("about.keyFromSecret") : i18n.t("about.keyFromDatabase")) : "—"}
              tone="muted"
            />
            <StatRow label={i18n.t("about.statLocalDev")} value={meta?.local_dev ? i18n.t("about.yes") : i18n.t("about.no")} tone="muted" />
            <StatRow label={i18n.t("about.statServerTime")} value={meta ? fullStamp(meta.server_time) : "—"} tone="muted" />
          </CardContent>
        </Card>

        <Notice tone="warn">{i18n.t("about.boundaryNotice")}</Notice>

        <div className="grid gap-1 py-2 text-center">
          <p className="text-sm font-medium">WorkStream</p>
          <p className="text-xs text-muted-foreground">copy right www.void-universe.com</p>
        </div>
      </section>
    </div>
  );
}
