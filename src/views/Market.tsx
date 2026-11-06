// Market 页外壳：技能 / 插件两个标签。标签写进 hash（#/market/plugins），
// 从别处链接过来或刷新都能落在对应标签上。
import { navigate } from "../lib/route";
import { cn } from "@/lib/utils";
import { useI18n, type MsgKey } from "../lib/i18n";
import { PluginsPanel } from "./Plugins";
import { SkillsPanel } from "./Skills";

const TABS: [string, MsgKey, MsgKey][] = [
  ["skills", "market.skills", "market.skillsHint"],
  ["plugins", "market.plugins", "market.pluginsHint"],
];

export function MarketView({ tab, userId }: { tab: string; userId: string }) {
  const i18n = useI18n();
  const active = TABS.some(([id]) => id === tab) ? tab : "skills";

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 scrollbar-thin">
      <div className="mx-auto grid w-full max-w-[1180px] gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Market</h1>
            <p className="text-xs text-muted-foreground">{i18n.t("market.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {TABS.map(([id, labelKey, hintKey]) => (
              <button
                key={id}
                type="button"
                onClick={() => navigate(`/market/${id}`)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  active === id
                    ? "border-transparent bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {i18n.t(labelKey)}
                <span className={cn("ml-1.5 text-[10px]", active === id ? "opacity-70" : "opacity-60")}>{i18n.t(hintKey)}</span>
              </button>
            ))}
          </div>
        </div>

        {active === "skills" ? <SkillsPanel userId={userId} /> : <PluginsPanel />}
      </div>
    </div>
  );
}
