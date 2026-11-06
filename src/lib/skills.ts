// 技能安装的落点：Market 和员工详情页共用同一套取值，避免两边各写一遍分支。
import type { InstallOutcome, RegistrySkipped } from "../types";
import type { I18n, MsgKey } from "./i18n";

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

// 跳过原因存键引用：纯函数不在模块级拿字典，i18n 由调用方作参数传进来。
const SKIPPED_REASON: Record<string, MsgKey> = {
  invalid_slug: "skill.reasonInvalidSlug",
  invalid_name: "skill.reasonInvalidName",
  duplicate_slug: "skill.reasonDuplicateSlug",
  invalid_body_url: "skill.reasonInvalidBodyUrl",
  over_limit: "skill.reasonOverLimit",
};

export const skippedReason = (i18n: I18n, reason: string) => {
  const key = SKIPPED_REASON[reason];
  return key ? i18n.t(key) : reason;
};

/** 源上被跳过的条目：只在数量上提示，具体原因写在 title 里，别占列表位置。 */
export function skippedNote(i18n: I18n, items: RegistrySkipped[]): string {
  if (!items.length) return "";
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = skippedReason(i18n, item.reason);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return i18n.list(
    [...counts.entries()].map(([label, count]) => i18n.tf("skill.skippedItemNote", { label, count })),
  );
}

export function describeInstall(i18n: I18n, install: InstallOutcome): string {
  if (install.always_on) return i18n.t("skill.installAlwaysOn");
  if (!install.added) return i18n.tf("skill.installAlreadyOnly", { already: install.already });
  if (install.already) {
    return i18n.tf("skill.installAddedWithAlready", { added: install.added, already: install.already });
  }
  return i18n.tf("skill.installAdded", { added: install.added });
}
