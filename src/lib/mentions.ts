// 「有人在群里 @ 我」的本机已读水位：黄心跳只在这条水位之后的新 @ 上重新亮。
// 按群存 seq，不占服务端字段——看清没看清是本机的事，换台机器再亮一次也不亏。
const KEY = "workstream.mentions.seen";

export function readSeenMentions(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const result: Record<string, number> = {};
    for (const [streamId, value] of Object.entries(raw)) {
      if (!streamId || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) continue;
      result[streamId] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function markMentionSeen(streamId: string, seq: number) {
  if (!streamId || !Number.isSafeInteger(seq) || seq <= 0) return;
  const all = readSeenMentions();
  if ((all[streamId] ?? 0) >= seq) return;
  all[streamId] = seq;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 存不下就只在本次会话里记住：下次打开会再亮一次，不算错。
  }
  // 标题栏与 favicon 跟着清掉：看过之后还挂着 (1) 比不提醒更糟。
  window.dispatchEvent(new CustomEvent("workstream:mentions-seen"));
}

/** 有多少个群里有我还没看的 @：标题栏计数与 favicon 黄点用它，和边框用的是同一份水位。 */
export function unseenMentionCount(streams: { id: string; mentioned_seq?: number | null }[]): number {
  const seen = readSeenMentions();
  let count = 0;
  for (const stream of streams) {
    const seq = stream.mentioned_seq ?? 0;
    if (seq > (seen[stream.id] ?? 0)) count += 1;
  }
  return count;
}
