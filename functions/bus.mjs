/**
 * 同进程插话总线：写 meta 的一方（messages.send / scheduler.interrupt）在落库的同时点火，
 * 正在跑的任务下一次问 watch 立刻拿到信号，preempt 不再等轮询周期。
 * 多实例部署点不火时由 DB 轮询兜底，语义不变。
 */
const bus = new Map();

export function armInterrupt(mailId, wake) {
  bus.set(mailId, wake);
}

export function disarmInterrupt(mailId) {
  bus.delete(mailId);
}

export function fireInterrupt(mailId) {
  const wake = bus.get(mailId);
  if (wake) wake();
  return Boolean(wake);
}
