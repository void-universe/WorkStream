// 上游用量对象 → 我们要落库的四个数。
//
// 为什么单独成一个模块：两条出网通道（自建 OpenAI 兼容端点、Stream Server 的 shared 档）
// 收到的是同一种用量块，口径必须是同一份。住在 agents.mjs 里时 stream.mjs 拿不到它——
// agents.mjs 要 import stream.mjs 来挂路由，反过来 import 就成了环。
/**
 * 缺字段就留 null，不拿 0 冒充"没用 token"。total 不落：它等于 input + output，没有哪一列需要它。
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pick = (...values) => values.find((value) => Number.isFinite(Number(value))) ?? null;
  const input = pick(raw.prompt_tokens);
  const output = pick(raw.completion_tokens);
  // cached/reasoning 是总数的子桶：各家口径不一，子桶比总数还大就是这份数不可信。
  // 按"不回报"收成 null——界面上的命中率与思考占比才不会算出超过 100%，也不会把它投进分母。
  const subset = (part, whole) => (part === null || whole === null || part > whole ? null : part);
  return {
    input,
    output,
    cached: subset(pick(raw.prompt_tokens_details?.cached_tokens), input),
    reasoning: subset(pick(raw.completion_tokens_details?.reasoning_tokens), output),
  };
}
