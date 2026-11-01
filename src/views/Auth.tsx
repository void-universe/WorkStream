// 邮箱注册 / 登录 / 验证链接落地页。开发态把验证链接直接显示出来（站点内收件箱也有一封）。
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, describeError, setToken, type User } from "../api";
import { readBrandMode } from "../lib/brand";
import { CopyButton, Field, Notice, TextInput } from "../lib/ui";

type RegisterResult = { ok: true; user: User; verify_link: string };
type LoginResult = { ok: true; token: string; user: User };
type VerifyResult = { ok: true; email: string; display_name: string };

export function AuthView({ onSignedIn }: { onSignedIn: (user: User, token?: string) => void }) {
  const [tab, setTab] = useState("login");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [verifyLink, setVerifyLink] = useState("");

  async function submit(kind: "login" | "register") {
    if (!email.trim() || !password) {
      toast.error("邮箱和口令都要填。");
      return;
    }
    setBusy(true);
    try {
      if (kind === "login") {
        const result = await api<LoginResult>("auth.login", { body: { email, password } });
        setToken(result.token);
        onSignedIn(result.user, result.token);
        toast.success(`欢迎回来，${result.user.display_name}`);
        return;
      }
      const result = await api<RegisterResult>("auth.register", {
        body: { email, password, display_name: displayName },
      });
      setVerifyLink(result.verify_link);
      toast.success("账号已建好，先点验证链接激活邮箱。");
    } catch (error) {
      toast.error(describeError(error));
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
        <p className="text-sm text-muted-foreground">
          真实员工与虚拟员工共用一个群：@ 一下就把活儿派进对方的虚拟邮箱，时间片并行推进。
        </p>
      </header>

      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="login">登录</TabsTrigger>
          <TabsTrigger value="register">注册</TabsTrigger>
        </TabsList>

        <TabsContent value="login">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">用邮箱登录</CardTitle>
              <CardDescription className="text-xs">会话保持 30 天，换口令后所有会话都会失效并需要重新登录。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field label="邮箱" htmlFor="login-email">
                <TextInput
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                />
              </Field>
              <Field label="口令" htmlFor="login-password">
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
                {busy ? "正在登录…" : "进入工作台"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="register">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">注册真实员工</CardTitle>
              <CardDescription className="text-xs">邮箱验证后即可创建虚拟员工、拉群和派活。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field label="姓名 / 花名" htmlFor="register-name" hint="群里 @ 你就是这个名字，控制在 24 字以内。">
                <TextInput
                  id="register-name"
                  value={displayName}
                  maxLength={24}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="如：李工"
                />
              </Field>
              <Field label="邮箱" htmlFor="register-email">
                <TextInput
                  id="register-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                />
              </Field>
              <Field label="口令" htmlFor="register-password" hint="至少 8 位；服务端只存 PBKDF2 派生值。">
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
                {busy ? "正在注册…" : "注册并发送验证链接"}
              </Button>
              {verifyLink ? (
                <div className="grid gap-2">
                  <Notice>
                    当前没接 SMTP 中继，验证链接直接显示在这里，同时也存进了站内收件箱。接上
                    <code className="mx-1 font-mono">WORKSTREAM_SMTP_URL</code>
                    后会真发邮件。
                  </Notice>
                  <div className="flex items-center gap-2">
                    <Button size="sm" asChild>
                      <a href={verifyLink}>现在去验证</a>
                    </Button>
                    <CopyButton value={verifyLink} label="链接" />
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <p className="text-center text-xs text-muted-foreground">copy right www.void-universe.com</p>
    </main>
  );
}

export function VerifyView({ token }: { token: string }) {
  const [state, setState] = useState<{ phase: "idle" | "busy" | "done" | "error"; message: string }>({
    phase: "idle",
    message: "",
  });

  async function run() {
    setState({ phase: "busy", message: "" });
    try {
      const result = await api<VerifyResult>("auth.verify", { body: { token } });
      setState({ phase: "done", message: `${result.email}（${result.display_name}）已验证。` });
    } catch (error) {
      setState({ phase: "error", message: describeError(error) });
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">验证邮箱</CardTitle>
          <CardDescription className="text-xs">
            {token ? `令牌 ${token.slice(0, 10)}…` : "这条链接里没有令牌，请回到站内收件箱重新点。"}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {state.phase === "idle" ? (
            <Button onClick={() => void run()}>确认验证</Button>
          ) : null}
          {state.phase === "busy" ? <p className="text-sm text-muted-foreground">处理中…</p> : null}
          {state.phase === "done" ? (
            <>
              <Notice>{state.message}</Notice>
              <Button asChild>
                <a href="#/login">去登录</a>
              </Button>
            </>
          ) : null}
          {state.phase === "error" ? <Notice tone="warn">{state.message}</Notice> : null}
        </CardContent>
      </Card>
    </main>
  );
}
