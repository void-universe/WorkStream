// Stream flow 的缓存命中口径：从轨迹里的模型步算出「这一组轮次喂进去多少 token、其中多少命中前缀缓存」。
//
// 为什么单独成一个 .mjs 而不是留在 StreamFlow.tsx：命中率是后端「模型可见的必须可复原」那条契约在界面上的
// 读数，口径错了等于给用户报一个假的省钱比例。它要能被 dev/smoke.mjs import 进来钉成断言，而 .tsx 在 Node
// 里加载不了。

/** 一组模型轮的 token 用量：rounds 是全部模型轮，reported 只算上游同时回报了输入与命中数的那些。 */
export const newUsage = () => ({ rounds: 0, reported: 0, input: 0, cached: 0 });

/**
 * 累加一个群里若干封信的模型轮用量。
 * 只把「输入和命中缓存两个数都回报了」的轮放进分母：被插话掐断的轮在末尾用量块之前就断了，
 * QCA 和演示后端压根不回报用量——把它们当 0% 命中会把真实水平算低，宁可不进统计。
 * 子桶比总数还大那种不可信的数不在这里再筛：落库前已经按不回报收成 null 了（functions/agents.mjs
 * 的 normalizeUsage），这里再判一次等于同一条口径住两个家。
 * @param {{ rounds: number, reported: number, input: number, cached: number }} usage
 * @param {{ kind: string, input_tokens: number | string | null, cached_tokens: number | string | null }[]} steps
 */
export function tallyUsage(usage, steps) {
  for (const step of steps) {
    if (step.kind !== "model") continue;
    usage.rounds += 1;
    if (step.input_tokens === null || step.cached_tokens === null) continue;
    const input = Number(step.input_tokens);
    const cached = Number(step.cached_tokens);
    if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(cached)) continue;
    usage.reported += 1;
    usage.input += input;
    usage.cached += cached;
  }
}

/** 按 token 加权，不是每轮百分比的平均：长轮次对成本的影响本来就更该占大头。 */
export const hitRateOf = (usage) =>
  usage.reported && usage.input > 0 ? `${Math.round((usage.cached / usage.input) * 100)}%` : "—";
