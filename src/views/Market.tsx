// Market 页外壳：技能 / 插件两个标签。标签写进 hash（#/market/plugins），
// 从别处链接过来或刷新都能落在对应标签上。
import { navigate } from "../lib/route";
import { cn } from "@/lib/utils";
import { PluginsPanel } from "./Plugins";
import { SkillsPanel } from "./Skills";

const TABS: [string, string, string][] = [
  ["skills", "技能", "员工学会怎么做"],
  ["plugins", "插件", "员工能用什么工具"],
];

export function MarketView({ tab, userId }: { tab: string; userId: string }) {
  const active = TABS.some(([id]) => id === tab) ? tab : "skills";

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 scrollbar-thin">
      <div className="mx-auto grid w-full max-w-[1180px] gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Market</h1>
            <p className="text-xs text-muted-foreground">
              技能教会员工怎么做，插件给员工一双能碰外部世界的手。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {TABS.map(([id, label, hint]) => (
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
                {label}
                <span className={cn("ml-1.5 text-[10px]", active === id ? "opacity-70" : "opacity-60")}>{hint}</span>
              </button>
            ))}
          </div>
        </div>

        {active === "skills" ? <SkillsPanel userId={userId} /> : <PluginsPanel />}
      </div>
    </div>
  );
}
