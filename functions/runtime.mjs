// 冷启动时把站点的 env 取器绑一次：Deno 边缘运行时没有 globalThis.process，
// 而 SMTP 这类“基础设施开关”会在 deliver/smtpStatus 等多处被读到，不是一句请求上下文能传到底的。
let reader = () => undefined;

export function bindEnv(env) {
  reader = typeof env === "function" ? env : () => undefined;
}

/** 绑定的 env 优先，其次本地 Node 进程环境（开发态 harness）。 */
export function readEnv(name) {
  const bound = reader?.(name);
  if (typeof bound === "string" && bound.trim()) return bound.trim();
  const local = globalThis.process?.env?.[name];
  return typeof local === "string" ? local.trim() : "";
}

export const smtpEndpoint = () => readEnv("WORKSTREAM_SMTP_URL");
