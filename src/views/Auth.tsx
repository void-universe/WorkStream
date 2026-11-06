// 邮箱注册 / 登录 / 验证链接落地页。开发态把验证链接直接显示出来（站点内收件箱也有一封）。
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, describeError, setToken, type User } from "../api";
import { readBrandMode } from "../lib/brand";
import { useI18n } from "../lib/i18n";
import { CopyButton, Field, Notice, TextInput } from "../lib/ui";

type RegisterResult = { ok: true; user: User; verify_link: string };
type LoginResult = { ok: true; token: string; user: User };
type VerifyResult = { ok: true; email: string; display_name: string };

export function AuthView({ onSignedIn }: { onSignedIn: (user: User, token?: string) => void }) {
  const i18n = useI18n();
  const [tab, setTab] = useState("login");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [verifyLink, setVerifyLink] = useState("");
  // 这句话中间要夹一个 <code> 环境变量名。按 {0} 切开交给 JSX 拼，变量名的落点就跟着各语言自己的语序走，
  // 而不是被组件里写死的位置绑死在中文句法上。
  const smtpParts = i18n.tp("auth.smtpNotice");

  async function submit(kind: "login" | "register") {
    if (!email.trim() || !password) {
      toast.error(i18n.t("auth.needBoth"));
      return;
    }
    setBusy(true);
    try {
      if (kind === "login") {
        const result = await api<LoginResult>("auth.login", { body: { email, password } });
        setToken(result.token);
        onSignedIn(result.user, result.token);
        toast.success(i18n.tf("auth.welcomeBack", { name: result.user.display_name }));
        return;
      }
      const result = await api<RegisterResult>("auth.register", {
        body: { email, password, display_name: displayName },
      });
      setVerifyLink(result.verify_link);
      toast.success(i18n.t("auth.accountCreated"));
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 px-5 py-10">
      <header className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <span
            className={`grid size-8 place-items-center rounded-lg font-mono text-xs font-bold ${
              readBrandMode() === "embed" ? "bg-transparent text-foreground" : "bg-foreground text-background"
            }`}
          >
            {">_"}
          </span>
          <h1 className="text-xl font-semibold tracking-tight">WorkStream</h1>
        </div>
        <p className="text-sm text-muted-foreground">{i18n.t("auth.tagline")}</p>
      </header>

      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="login">{i18n.t("auth.loginTab")}</TabsTrigger>
          <TabsTrigger value="register">{i18n.t("auth.registerTab")}</TabsTrigger>
        </TabsList>

        <TabsContent value="login">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{i18n.t("auth.loginTitle")}</CardTitle>
              <CardDescription className="text-xs">{i18n.t("auth.loginDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field label={i18n.t("auth.email")} htmlFor="login-email">
                <TextInput
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                />
              </Field>
              <Field label={i18n.t("auth.password")} htmlFor="login-password">
                <TextInput
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submit("login");
                  }}
                />
              </Field>
              <Button onClick={() => void submit("login")} disabled={busy}>
                {busy ? i18n.t("auth.signingIn") : i18n.t("auth.enter")}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="register">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{i18n.t("auth.registerTitle")}</CardTitle>
              <CardDescription className="text-xs">{i18n.t("auth.registerDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field label={i18n.t("auth.name")} htmlFor="register-name" hint={i18n.t("auth.nameHint")}>
                <TextInput
                  id="register-name"
                  value={displayName}
                  maxLength={24}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={i18n.t("auth.namePlaceholder")}
                />
              </Field>
              <Field label={i18n.t("auth.email")} htmlFor="register-email">
                <TextInput
                  id="register-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                />
              </Field>
              <Field label={i18n.t("auth.password")} htmlFor="register-password" hint={i18n.t("auth.passwordHint")}>
                <TextInput
                  id="register-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submit("register");
                  }}
                />
              </Field>
              <Button onClick={() => void submit("register")} disabled={busy}>
                {busy ? i18n.t("auth.registering") : i18n.t("auth.registerButton")}
              </Button>
              {verifyLink ? (
                <div className="grid gap-2">
                  <Notice>
                    {smtpParts[0]}
                    <code className="mx-1 font-mono">WORKSTREAM_SMTP_URL</code>
                    {smtpParts[1]}
                  </Notice>
                  <div className="flex items-center gap-2">
                    <Button size="sm" asChild>
                      <a href={verifyLink}>{i18n.t("auth.verifyNow")}</a>
                    </Button>
                    <CopyButton value={verifyLink} label={i18n.t("auth.copyLinkLabel")} />
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <p className="text-center text-xs text-muted-foreground">{i18n.t("auth.copyright")}</p>
    </main>
  );
}

export function VerifyView({ token }: { token: string }) {
  const i18n = useI18n();
  const [state, setState] = useState<{ phase: "idle" | "busy" | "done" | "error"; message: string }>({
    phase: "idle",
    message: "",
  });

  async function run() {
    setState({ phase: "busy", message: "" });
    try {
      const result = await api<VerifyResult>("auth.verify", { body: { token } });
      setState({ phase: "done", message: i18n.tf("verify.verified", { email: result.email, name: result.display_name }) });
    } catch (error) {
      setState({ phase: "error", message: describeError(i18n, error) });
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{i18n.t("verify.title")}</CardTitle>
          <CardDescription className="text-xs">
            {token ? i18n.tf("verify.tokenHint", { token: token.slice(0, 10) }) : i18n.t("verify.noToken")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {state.phase === "idle" ? (
            <Button onClick={() => void run()}>{i18n.t("verify.confirm")}</Button>
          ) : null}
          {state.phase === "busy" ? <p className="text-sm text-muted-foreground">{i18n.t("verify.processing")}</p> : null}
          {state.phase === "done" ? (
            <>
              <Notice>{state.message}</Notice>
              <Button asChild>
                <a href="#/login">{i18n.t("verify.goLogin")}</a>
              </Button>
            </>
          ) : null}
          {state.phase === "error" ? <Notice tone="warn">{state.message}</Notice> : null}
        </CardContent>
      </Card>
    </main>
  );
}
