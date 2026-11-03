// 应用外壳：会话恢复、hash 路由、顶部导航条，主区按路由挂载视图。
import { useCallback, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { api, get, getToken, post, setToken, type Agent } from "./api";
import type { Stream, User, Vm } from "./types";
import { navigate, useHashRoute } from "./lib/route";
import { readBrandMode, writeBrandMode, type BrandMode } from "./lib/brand";
import { applyTheme, onSystemThemeChange, readThemeMode, resolvedTheme, type ThemeMode } from "./lib/theme";
import { PersonAvatar } from "./lib/ui";
import { AuthView, VerifyView } from "./views/Auth";
import { ChatView } from "./views/chat/ChatView";
import { StreamsView } from "./views/Streams";
import { AgentsView } from "./views/Agents";
import { MarketView } from "./views/Market";
import { SchedulerView } from "./views/Scheduler";
import { InboxView } from "./views/Inbox";
import { VmsView } from "./views/Vms";
import { AboutView } from "./views/About";

type StreamList = { ok: true; items: Stream[] };

export default function App() {
  const route = useHashRoute();
  const [theme, setTheme] = useState<ThemeMode>(() => readThemeMode());
  const [brand, setBrand] = useState<BrandMode>(() => readBrandMode());
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [vms, setVms] = useState<Vm[]>([]);
  const [unread, setUnread] = useState(0);
  const [invites, setInvites] = useState(0);

  useEffect(() => {
    const paint = () => setTheme((current) => applyTheme(current));
    paint();
    return onSystemThemeChange(() => {
      if (readThemeMode() === "system") paint();
    });
  }, []);

  const refreshAll = useCallback(async () => {
    const tasks = await Promise.allSettled([
      get<StreamList>("streams.mine"),
      get<{ ok: true; items: Agent[] }>("agents.list"),
      get<{ ok: true; items: Vm[] }>("vms.list"),
      get<{ ok: true; items: { read_at: string | null }[] }>("inbox.list", { limit: 60 }),
      get<{ ok: true; items: unknown[] }>("streams.invites.mine"),
    ]);
    const [streamResult, agentResult, vmResult, inboxResult, inviteResult] = tasks;
    if (streamResult.status === "fulfilled") setStreams(streamResult.value.items);
    if (agentResult.status === "fulfilled") setAgents(agentResult.value.items);
    if (vmResult.status === "fulfilled") setVms(vmResult.value.items);
    if (inboxResult.status === "fulfilled") setUnread(inboxResult.value.items.filter((item) => !item.read_at).length);
    if (inviteResult.status === "fulfilled") setInvites(inviteResult.value.items.length);
    if (streamResult.status === "rejected") {
      const reason = streamResult.reason;
      if (reason instanceof Error && "code" in reason && (reason as { code?: string }).code === "login_required") setUser(null);
    }
  }, []);

  // 冷启动：有 token 就续会话。
  useEffect(() => {
    if (!getToken()) {
      setUser(null);
      return;
    }
    void (async () => {
      try {
        const result = await api<{ ok: true; user: User }>("auth.me");
        setUser(result.user);
        await refreshAll();
      } catch {
        setToken("");
        setUser(null);
      }
    })();
  }, [refreshAll]);

  useEffect(() => {
    const onSignedOut = () => setUser(null);
    window.addEventListener("workstream:signed-out", onSignedOut);
    return () => window.removeEventListener("workstream:signed-out", onSignedOut);
  }, []);

  // 停留在应用里时轻量刷新导航计数。
  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshAll();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [user, refreshAll]);

  const streamId = route.segments[0] === "stream" ? route.segments[1] ?? "" : "";
  const section = route.segments[0];
  const focusAgentId = section === "agents" ? route.segments[1] ?? "" : "";

  if (user === undefined) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <p className="text-sm text-muted-foreground">正在恢复会话…</p>
        <Toaster position="top-center" theme={resolvedTheme(theme)} />
      </div>
    );
  }

  if (section === "verify") {
    return (
      <>
        <VerifyView token={route.query.get("token") ?? ""} />
        <Toaster position="top-center" theme={resolvedTheme(theme)} />
      </>
    );
  }

  if (user === null || section === "login") {
    return (
      <>
        <AuthView
          onSignedIn={async (nextUser, token) => {
            setUser(nextUser);
            if (token) setToken(token);
            await refreshAll();
            if (!window.location.hash || window.location.hash === "#/login") window.location.hash = "#/";
          }}
        />
        <Toaster position="top-center" theme={resolvedTheme(theme)} />
      </>
    );
  }

  const view = streamId ? (
    <ChatView key={streamId} streamId={streamId} user={user} myAgents={agents} myVms={vms} />
  ) : section === "agents" ? (
    <AgentsView onChanged={refreshAll} focusAgentId={focusAgentId} />
  ) : section === "market" ? (
    <MarketView tab={route.segments[1] ?? ""} userId={user.id} />
  ) : section === "scheduler" ? (
    <SchedulerView />
  ) : section === "inbox" ? (
    <InboxView user={user} onUserChanged={setUser} />
  ) : section === "vms" ? (
    <VmsView />
  ) : section === "about" || section === "settings" ? (
    <AboutView
      user={user}
      onUserChanged={setUser}
      theme={theme}
      onThemeChange={setTheme}
      brand={brand}
      onBrandChange={(mode) => {
        setBrand(mode);
        writeBrandMode(mode);
      }}
    />
  ) : (
    <StreamsView streams={streams} agents={agents} vms={vms} user={user} onRefresh={refreshAll} />
  );

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border/60 bg-background/80 px-3 backdrop-blur-xl">
        <a href="#/" className="flex shrink-0 items-center gap-2" title="Stream 面板">
          <span
            className={`grid size-7 place-items-center rounded-lg font-mono text-[11px] font-bold transition-colors duration-200 ${
              brand === "embed" ? "bg-transparent text-foreground" : "bg-foreground text-background"
            }`}
          >
            {">_"}
          </span>
          <span className="hidden text-[13px] font-semibold tracking-tight sm:inline">WorkStream</span>
        </a>

        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TopNavLink href="/" label="Stream" active={!section || !!streamId} />
          <TopNavLink href="/agents" label="虚拟员工" count={agents.length} active={section === "agents"} />
          <TopNavLink href="/market" label="Market" active={section === "market"} />
          <TopNavLink href="/scheduler" label="调度台" active={section === "scheduler"} />
          <TopNavLink href="/inbox" label="虚拟邮箱" count={unread} active={section === "inbox"} />
          <TopNavLink href="/vms" label="办公虚拟机" count={vms.length} active={section === "vms"} />
          <TopNavLink href="/about" label="设置" alert={invites > 0} active={section === "about" || section === "settings"} />
        </nav>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-full px-2.5 text-xs text-muted-foreground hover:text-foreground"
            title={resolvedTheme(theme) === "dark" ? "切到亮色" : "切到暗色"}
            onClick={() => {
              const next: ThemeMode = resolvedTheme(theme) === "dark" ? "light" : "dark";
              setTheme(next);
              applyTheme(next);
            }}
          >
            {resolvedTheme(theme) === "dark" ? "☀ 亮" : "☾ 暗"}
          </Button>
          <span className="hidden items-center gap-2 md:flex">
            <PersonAvatar name={user.display_name} kind="human" avatar={user.avatar} className="size-7 text-[11px]" />
            <span className="grid max-w-40 leading-tight">
              <span className="truncate text-xs font-medium">{user.display_name}</span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">{user.email}</span>
            </span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-full px-2.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              void post("auth.logout", {}).catch(() => {});
              setToken("");
              setUser(null);
              navigate("/");
            }}
          >
            退出
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">{view}</main>
      <Toaster position="top-center" theme={resolvedTheme(theme)} richColors closeButton />
    </div>
  );
}

function TopNavLink({
  href,
  label,
  count,
  alert,
  active,
}: {
  href: string;
  label: string;
  count?: number;
  alert?: boolean;
  active: boolean;
}) {
  return (
    <a
      href={`#${href}`}
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition-colors duration-200 ${
        active
          ? "ws-pill-active bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      }`}
    >
      {label}
      {count ? (
        <span
          className={`rounded-full px-1.5 font-mono text-[10px] leading-4 ${
            active ? "bg-foreground/8 text-foreground/70" : "bg-foreground/5 text-muted-foreground"
          }`}
        >
          {count}
        </span>
      ) : null}
      {alert ? <span className="size-1.5 rounded-full bg-signal" title="有待处理的邀请" /> : null}
    </a>
  );
}
