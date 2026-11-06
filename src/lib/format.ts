import type { I18n } from "./i18n";

// 这几个函数把「一个时刻/一段字节」变成给用户看的一句话，所以它们必须知道用哪种语言说：
// 相对时间要进字典（"5 分钟前" 和 "vor 5 Minuten" 不是同一个句式），日期与钟点要走 Intl，
// 否则切了语言之后正文是英文、时间戳还是中文的「刚刚」。
let timeFormatters = new Map<string, Intl.DateTimeFormat>();
let secondFormatters = new Map<string, Intl.DateTimeFormat>();
let dayFormatters = new Map<string, Intl.DateTimeFormat>();

function clockFormat(intl: string): Intl.DateTimeFormat {
  let hit = timeFormatters.get(intl);
  if (!hit) {
    hit = new Intl.DateTimeFormat(intl, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    timeFormatters.set(intl, hit);
  }
  return hit;
}

function clockSecondsFormat(intl: string): Intl.DateTimeFormat {
  let hit = secondFormatters.get(intl);
  if (!hit) {
    hit = new Intl.DateTimeFormat(intl, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    secondFormatters.set(intl, hit);
  }
  return hit;
}

function dayFormat(intl: string): Intl.DateTimeFormat {
  let hit = dayFormatters.get(intl);
  if (!hit) {
    hit = new Intl.DateTimeFormat(intl, { month: "numeric", day: "numeric" });
    dayFormatters.set(intl, hit);
  }
  return hit;
}

export function timeAgo(i18n: I18n, iso: string | null | undefined): string {
  if (!iso) return "—";
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return "—";
  const diff = Date.now() - stamp;
  if (diff < 45_000) return i18n.t("format.justNow");
  if (diff < 3_600_000) return i18n.tf("format.minutesAgo", { n: Math.round(diff / 60_000) });
  if (diff < 86_400_000) return i18n.tf("format.hoursAgo", { n: Math.round(diff / 3_600_000) });
  const date = new Date(stamp);
  const hhmm = clockFormat(i18n.intl).format(date);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return i18n.tf("format.todayAt", { time: hhmm });
  return `${dayFormat(i18n.intl).format(date)} ${hhmm}`;
}

export function clockOf(i18n: I18n, iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return (withSeconds ? clockSecondsFormat(i18n.intl) : clockFormat(i18n.intl)).format(date);
}

export function byteSize(i18n: I18n, bytes: number): string {
  // 单位是 SI 写法、不译；小数点跟着 locale 走（德语是 1,5 KB）。
  if (bytes < 1024) return `${i18n.number(bytes)} B`;
  if (bytes < 1024 * 1024) return `${i18n.number(Number((bytes / 1024).toFixed(1)))} KB`;
  return `${i18n.number(Number((bytes / 1024 / 1024).toFixed(1)))} MB`;
}

/** UUID 只露首尾，中间的群成员自己认不出也不需要认。 */
export function shortUuid(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function initials(i18n: I18n, name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return i18n.t("format.unknownInitial");
  // 拉丁名取前两个字母更像人名缩写，其余文字（含中日韩）取首个字。
  return trimmed.slice(0, trimmed.length > 2 && /[A-Za-z]/.test(trimmed[0]) ? 2 : 1).toUpperCase();
}
