// 技能安装的落点：Market 和员工详情页共用同一套取值，避免两边各写一遍分支。
import type { InstallOutcome, RegistrySkipped } from "../types";

/** 安装目标下拉里的两个特殊值：其余值都是具体员工 id。 */
export const ALL_AGENTS = "__all";
export const ALL_AGENTS_FUTURE = "__future";

/** 把下拉选中值翻译成后端要的 installScope。 */
export function installScope(target: string): Record<string, unknown> {
  if (target === ALL_AGENTS) return { all_agents: true };
  if (target === ALL_AGENTS_FUTURE) return { all_agents: true, include_future: true };
  return { agent_id: target };
}

/** 选了"含未来新建"就意味着这条被标成默认技能，之后每个新员工都自动带上。 */
export const installsFutureAgents = (target: string) => target === ALL_AGENTS_FUTURE;

const SKIPPED_REASON: Record<string, string> = {
  invalid_slug: "slug 不合法",
  invalid_name: "名称不合法",
  duplicate_slug: "slug 重复",
  invalid_body_url: "正文地址不合法",
  over_limit: "超出单源 200 条上限",
};

export const skippedReason = (reason: string) => SKIPPED_REASON[reason] ?? reason;

/** 源上被跳过的条目：只在数量上提示，具体原因写在 title 里，别占列表位置。 */
export function skippedNote(items: RegistrySkipped[]): string {
  if (!items.length) return "";
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = skippedReason(item.reason);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${label} ${count} 条`).join("，");
}

export function describeInstall(install: InstallOutcome): string {
  if (install.always_on) return "内置技能对每个员工始终生效，不用安装";
  if (!install.added) return `${install.already} 个员工本来就装了`;
  return `新装 ${install.added} 个员工${install.already ? `，${install.already} 个已装过` : ""}`;
}
