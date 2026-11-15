// 登录失败计数：进程内的滑动窗口。
//
// 为什么不做分布式限流：目标只是挡住单机爆破与"错误口令把 PBKDF2 打满 CPU"这两件事，
// 单进程自托管是常态；多实例部署时每个实例各算各的，上限按实例数放大，这一点写在指南里，
// 不假装它是全局限流。
export function createThrottle({ windowMs = 300_000, max = 10, now = () => Date.now() } = {}) {
  const buckets = new Map();
  const limit = Math.max(1, Math.floor(max));
  const span = Math.max(1000, Math.floor(windowMs));

  const live = (key, at) => {
    const list = (buckets.get(key) ?? []).filter((stamp) => at - stamp < span);
    if (list.length) buckets.set(key, list);
    else buckets.delete(key);
    return list;
  };

  return {
    /** 还能不能试：不能试就给出还要等多久（毫秒）。 */
    check(key) {
      const at = now();
      const list = live(key, at);
      if (list.length < limit) return { allowed: true, retryAfterMs: 0, used: list.length, limit };
      return { allowed: false, retryAfterMs: Math.max(1, span - (at - list[0])), used: list.length, limit };
    },
    /** 记一次失败。 */
    fail(key) {
      const at = now();
      const list = live(key, at);
      list.push(at);
      buckets.set(key, list);
      // 键会随（IP, 账号）组合增长；超过阈值就整体清一遍过期桶，避免长期进程里无界膨胀。
      if (buckets.size > 10_000) {
        for (const [name, stamps] of buckets) {
          if (!stamps.some((stamp) => at - stamp < span)) buckets.delete(name);
        }
      }
      return list.length;
    },
    /** 一次成功就把这个键的账清掉：本人不该被自己的历史拖住。 */
    pass(key) {
      buckets.delete(key);
    },
    size() {
      return buckets.size;
    },
    clear() {
      buckets.clear();
    },
  };
}

/** 限流键：同一账号在不同 IP 上各算各的，同一 IP 换账号也各算各的。 */
export const throttleKey = (request, email) => {
  const forwarded = String(request?.headers?.get?.("x-forwarded-for") ?? "").split(",")[0].trim();
  const ip = forwarded || String(request?.headers?.get?.("x-real-ip") ?? "").trim() || "local";
  return `${ip}|${email}`;
};
