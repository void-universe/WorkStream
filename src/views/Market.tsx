// Market：一张目录页（技能 / 员工 / 插件三张入口卡）加三个分区页。
// 分区写进 hash（#/market/staff），从别处链过来或刷新都落在同一处；
// 目录卡上的数字只报读到的，读不到就说「未上报」，不拿 0 冒充。
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Plug, Sparkles, Users } from "lucide-react";
import { get } from "../api";
import { timeAgo } from "../lib/format";
import { useI18n, type MsgKey } from "../lib/i18n";
import { STAFF_PRESETS } from "../lib/staffPresets";
import type { Plugin, Skill, SkillRegistry } from "../types";
import { PluginsPanel } from "./Plugins";
import { SkillsPanel } from "./Skills";
import { StaffPanel } from "./Staff";

type SectionId = "skills" | "staff" | "plugins";

const SECTIONS: { id: SectionId; title: MsgKey; hint: MsgKey }[] = [
  { id: "skills", title: "market.skills", hint: "market.skillsHint" },
  { id: "staff", title: "market.staff", hint: "market.staffHint" },
  { id: "plugins", title: "market.plugins", hint: "market.pluginsHint" },
];

export function MarketView({ tab, userId }: { tab: string; userId: string }) {
  const section = SECTIONS.find((entry) => entry.id === tab) ?? null;
  return section ? <MarketSection section={section} userId={userId} /> : <MarketDirectory />;
}

function MarketShell({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 scrollbar-thin">
      <div className="mx-auto grid w-full max-w-[1180px] gap-3">{children}</div>
    </div>
  );
}

type Facts = {
  ready: boolean;
  skills: number | null;
  sources: number | null;
  plugins: number | null;
  skillsAt: string | null;
  pluginsAt: string | null;
};

/** 最近一次改动就代表这一区在动：所有条目里最新的 updated_at。 */
function newest<T extends { updated_at?: string }>(rows: T[]): string | null {
  let best: string | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const at = Date.parse(row.updated_at ?? "");
    if (Number.isFinite(at) && at > bestAt) {
      bestAt = at;
      best = row.updated_at ?? null;
    }
  }
  return best;
}

function MarketDirectory() {
  const i18n = useI18n();
  const [facts, setFacts] = useState<Facts>({
    ready: false, skills: null, sources: null, plugins: null, skillsAt: null, pluginsAt: null,
  });

  useEffect(() => {
    let alive = true;
    void Promise.allSettled([
      get<{ ok: true; items: Skill[] }>("skills.market"),
      get<{ ok: true; items: SkillRegistry[] }>("registries.list"),
      get<{ ok: true; items: Plugin[] }>("plugins.list"),
    ]).then(([skills, sources, plugins]) => {
      if (!alive) return;
      setFacts({
        ready: true,
        skills: skills.status === "fulfilled" ? skills.value.items.length : null,
        sources: sources.status === "fulfilled" ? sources.value.items.length : null,
        plugins: plugins.status === "fulfilled" ? plugins.value.items.length : null,
        skillsAt: skills.status === "fulfilled" ? newest(skills.value.items) : null,
        pluginsAt: plugins.status === "fulfilled" ? newest(plugins.value.items) : null,
      });
    });
    return () => {
      alive = false;
    };
  }, []);

  const count = (value: number | null, key: MsgKey) =>
    value === null ? i18n.t("market.unknown") : i18n.tf(key, { n: value });

  const cards = [
    {
      id: "skills" as const,
      icon: Sparkles,
      title: i18n.t("market.skills"),
      hint: i18n.t("market.skillsHint"),
      facts: [
        count(facts.skills, "market.countSkills"),
        count(facts.sources, "market.countSources"),
      ].join(" · "),
      at: facts.skillsAt,
    },
    {
      id: "staff" as const,
      icon: Users,
      title: i18n.t("market.staff"),
      hint: i18n.t("market.staffHint"),
      facts: i18n.tf("market.countPresets", { n: STAFF_PRESETS.length }),
      at: null,
    },
    {
      id: "plugins" as const,
      icon: Plug,
      title: i18n.t("market.plugins"),
      hint: i18n.t("market.pluginsHint"),
      facts: count(facts.plugins, "market.countPlugins"),
      at: facts.pluginsAt,
    },
  ];

  return (
    <MarketShell>
      <div className="grid gap-0.5">
        <h1 className="text-lg font-semibold tracking-tight">Market</h1>
        <p className="text-xs text-muted-foreground">{i18n.t("market.subtitle")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <a
              key={card.id}
              href={`#/market/${card.id}`}
              className="ws-surface group flex min-w-0 flex-col gap-2 rounded-xl bg-card p-4 transition-colors hover:border-signal/60"
            >
              <div className="flex items-center gap-2">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{card.title}</span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{card.hint}</p>
              <p className="mt-auto text-[11px] leading-relaxed text-muted-foreground">
                {facts.ready ? card.facts : null}
                {facts.ready && card.at ? ` · ${i18n.tf("market.updatedAt", { time: timeAgo(i18n, card.at) })}` : null}
              </p>
            </a>
          );
        })}
      </div>
    </MarketShell>
  );
}

function MarketSection({
  section,
  userId,
}: {
  section: { id: SectionId; title: MsgKey; hint: MsgKey };
  userId: string;
}) {
  const i18n = useI18n();
  return (
    <MarketShell>
      <div className="grid gap-1">
        <a
          href="#/market"
          className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          {i18n.t("market.back")}
        </a>
        <h1 className="text-lg font-semibold tracking-tight">{i18n.t(section.title)}</h1>
        <p className="text-xs text-muted-foreground">{i18n.t(section.hint)}</p>
      </div>
      {section.id === "skills" ? <SkillsPanel userId={userId} /> : section.id === "staff" ? <StaffPanel /> : <PluginsPanel />}
    </MarketShell>
  );
}
