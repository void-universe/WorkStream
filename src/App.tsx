// 应用外壳：会话恢复、hash 路由、顶部导航条，主区按路由挂载视图。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { api, get, getToken, post, setToken, type Agent } from "./api";
import type { Stream, User, Vm } from "./types";
import { navigate, useHashRoute } from "./lib/route";
import { unseenMentionCount } from "./lib/mentions";
import { applyTabBadge } from "./lib/tabBadge";
import { readBrandMode, writeBrandMode, type BrandMode } from "./lib/brand";
import { applyTheme, onSystemThemeChange, readThemeMode, resolvedTheme, type ThemeMode } from "./lib/theme";
import {
  I18nContext,
  applyDocumentLocale,
  createI18n,
  isCompleteLang,
  readStoredLang,
  readLangPending,
  markLangPending,
  clearLangPending,
  resolveInitialLang,
  useI18n,
  writeStoredLang,
  type LocaleId,
} from "./lib/i18n";
import { PersonAvatar } from "./lib/ui";
import { AuthView, VerifyView } from "./views/Auth";
import { LanguageGate } from "./views/LanguageStep";
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
  const [lang, setLang] = useState<LocaleId>(() => resolveInitialLang());
  // 没在这台设备上选过语言，第一次进来就先问一次；账户里带回来的偏好也会把这一步跳过去。
  const [langChosen, setLangChosen] = useState(() => readStoredLang() !== null);
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [vms, setVms] = useState<Vm[]>([]);
  const [unread, setUnread] = useState(0);
  const [mentionTick, setMentionTick] = useState(0);
  const [invites, setInvites] = useState(0);

  const i18n = useMemo(() => createI18n(lang), [lang]);
  const langPushed = useRef(false);
  // 语言门上亲手选过：登录后要把它推给账户，而不是让账户里的旧值把刚选的顶回去。
  const langPickedHere = useRef(false);
  const adoptedUser = useRef<string | null>(null);

  useEffect(() => {
    const paint = () => setTheme((current) => applyTheme(current));
    paint();
    return onSystemThemeChange(() => {
      if (readThemeMode() === "system") paint();
    });
  }, []);

  useEffect(() => {
    applyDocumentLocale(lang);
  }, [lang]);

  // 换语言同时落三处：这台设备的偏好、<html> 的 lang、账户偏好。
  // 少落一处就会出现「在这台机器上好了，换设备又回去了」，而没有任何报错会指出这种落差。
  const chooseLang = useCallback(
    (next: LocaleId, signedIn: boolean) => {
      setLang(next);
      setLangChosen(true);
      writeStoredLang(next);
      applyDocumentLocale(next);
      if (!signedIn) return;
      void post<{ ok: true; user: User }>("auth.patch", { prefs: { lang: next } })
        .then((result) => setUser(result.user))
        .catch(() => {
          /* 后端没收下时本机已经生效，下次登录会再推一次；这里报错只会打断正在改界面的那一下 */
        });
    },
    [],
  );

  // 主题和语言同构：本机、<html>、账户三处一起写。只写本机的话，登录态下账户里那个值
  // 会在下次冷启动把它顶回去——注册时就种了 theme: "system"，所以这不是边角情况。
  const chooseTheme = useCallback((next: ThemeMode, signedIn: boolean) => {
    setTheme(next);
    applyTheme(next);
    if (!signedIn) return;
    void post<{ ok: true; user: User }>("auth.patch", { prefs: { theme: next } })
      .then((result) => setUser(result.user))
      .catch(() => {
        /* 同上：本机已经生效，落库失败不打断这一切换 */
      });
  }, []);

  // 账户偏好 > 本机偏好：设备是新的、登录是老账号时，语言（和主题）应该跟着账户回来，
  // 而不是让每台设备各说各话。每个账户只认一次，否则用户在这台设备上改的偏好
  // 会被下一次 auth.patch 回来的旧值顶回去——那是「改了没生效」里最难查的一种。
  useEffect(() => {
    if (!user) {
      adoptedUser.current = null;
      return;
    }
    if (adoptedUser.current === user.id) return;
    adoptedUser.current = user.id;
    const prefs = user.prefs ?? {};
    const pickedHere = langPickedHere.current || readLangPending();
    if (isCompleteLang(prefs.lang)) {
      if (pickedHere) {
        // 刚在这台设备上亲手选过：账户里的旧值不许把它盖回去，反过来把这次选择推上去。
        if (prefs.lang !== lang) void post("auth.patch", { prefs: { lang } }).catch(() => {});
        clearLangPending();
      } else if (prefs.lang !== lang) {
        setLang(prefs.lang);
        writeStoredLang(prefs.lang);
      }
      setLangChosen(true);
    } else if (!langPushed.current) {
      langPushed.current = true;
      void post("auth.patch", { prefs: { lang } }).catch(() => {
        langPushed.current = false;
      });
    }
    if (prefs.theme && prefs.theme !== theme) {
      setTheme(prefs.theme);
      applyTheme(prefs.theme);
    }
    // 这个 effect 只读挂载时那一次的语言和主题：把它们放进依赖，用户在这台设备上手动切换
    // 会立刻被账户里的旧值顶回来，等于「改了没生效」。
  }, [user]);

  // 有人在群里 @ 我：标题栏加计数、favicon 加黄点。浏览器不给网页改标签颜色的口子，
  // 能做的只有这两处；它和群边框用同一份本机水位，打开那个群计数就跟着掉。
  const unseenMentions = useMemo(
    () => (user ? unseenMentionCount(streams) : 0),
    [streams, user, mentionTick],
  );
  useEffect(() => {
    applyTabBadge(unseenMentions);
  }, [unseenMentions]);
  useEffect(() => {
    const bump = () => setMentionTick((tick) => tick + 1);
    window.addEventListener("workstream:mentions-seen", bump);
    return () => window.removeEventListener("workstream:mentions-seen", bump);
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

  // 分支都在 body() 里，主区外面只留一个 Toaster：四个出口各挂一份同样的 Toaster，
  // 迟早会有一份和其余三份参数不一样。
  function body() {
    if (user === undefined) {
      return (
        <div className="grid min-h-dvh place-items-center">
          <p className="text-sm text-muted-foreground">{i18n.t("shell.restoring")}</p>
        </div>
      );
    }

    // 邮件里的验证链接是落地页，不该被选语言这一步挡住。
    if (section === "verify") return <VerifyView token={route.query.get("token") ?? ""} />;

    if (!langChosen) {
      return (
        <LanguageGate
          onDone={(next) => {
            langPickedHere.current = true;
            markLangPending();
            chooseLang(next, user !== null);
          }}
        />
      );
    }

    if (user === null || section === "login") {
      return (
        <AuthView
          onSignedIn={async (nextUser, token) => {
            setUser(nextUser);
            if (token) setToken(token);
            await refreshAll();
            if (!window.location.hash || window.location.hash === "#/login") window.location.hash = "#/";
          }}
        />
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
        onThemeChange={(mode) => chooseTheme(mode, true)}
        brand={brand}
        onBrandChange={(mode) => {
          setBrand(mode);
          writeBrandMode(mode);
        }}
        lang={lang}
        onLangChange={(next) => chooseLang(next, true)}
      />
    ) : (
      <StreamsView streams={streams} agents={agents} vms={vms} user={user} onRefresh={refreshAll} />
    );

    return (
      <div className="flex h-dvh flex-col">
        <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border/60 bg-background/80 px-3 backdrop-blur-xl">
          <a href="#/" className="flex shrink-0 items-center gap-2" title={i18n.t("nav.streamBoard")}>
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
            <TopNavLink href="/" label={i18n.t("nav.stream")} active={!section || !!streamId} />
            <TopNavLink href="/agents" label={i18n.t("nav.agents")} count={agents.length} active={section === "agents"} />
            <TopNavLink href="/market" label={i18n.t("nav.market")} active={section === "market"} />
            <TopNavLink href="/scheduler" label={i18n.t("nav.scheduler")} active={section === "scheduler"} />
            <TopNavLink href="/inbox" label={i18n.t("nav.inbox")} count={unread} active={section === "inbox"} />
            <TopNavLink href="/vms" label={i18n.t("nav.vms")} count={vms.length} active={section === "vms"} />
            <TopNavLink href="/about" label={i18n.t("nav.settings")} alert={invites > 0} active={section === "about" || section === "settings"} />
          </nav>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-full px-2.5 text-xs text-muted-foreground hover:text-foreground"
              title={resolvedTheme(theme) === "dark" ? i18n.t("shell.toLight") : i18n.t("shell.toDark")}
              onClick={() => {
                const next: ThemeMode = resolvedTheme(theme) === "dark" ? "light" : "dark";
                chooseTheme(next, true);
              }}
            >
              {resolvedTheme(theme) === "dark" ? i18n.t("shell.chipLight") : i18n.t("shell.chipDark")}
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
              {i18n.t("shell.logout")}
            </Button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">{view}</main>
      </div>
    );
  }

  return (
    <I18nContext.Provider value={i18n}>
      {body()}
      <Toaster position="top-center" theme={resolvedTheme(theme)} richColors closeButton />
    </I18nContext.Provider>
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
  const i18n = useI18n();
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
      {alert ? <span className="size-1.5 rounded-full bg-signal" title={i18n.t("nav.invitesAlert")} /> : null}
    </a>
  );
}
