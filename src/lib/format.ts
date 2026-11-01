export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return "—";
  const diff = Date.now() - stamp;
  if (diff < 45_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  const date = new Date(stamp);
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return `今天 ${hhmm}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${hhmm}`;
}

export function clockOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** UUID 只露首尾，中间的群成员自己认不出也不需要认。 */
export function shortUuid(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "？";
  return trimmed.slice(0, trimmed.length > 2 && /[A-Za-z]/.test(trimmed[0]) ? 2 : 1).toUpperCase();
}
