// 用量与花费：把 run_steps 里的 token 账按时间窗聚合，命中率 = cached / input。
//
// 价格是部署数据，不是协议常量：不同供应商、不同模型、甚至同一模型的高峰/空闲时段都不同，
// 所以整张表从环境变量来（WORKSTREAM_PRICES，JSON），缺省只给一个可用的起点（DeepSeek flash 空闲价）。
// 报"花费"时把价格和计费口径一起返回，界面才能说清这个数字是怎么算出来的。
import { Halt, json, uuid } from "./util.mjs";

const WINDOWS = [
  ["5m", 5 * 60_000],
  ["1h", 60 * 60_000],
  ["all", Number.POSITIVE_INFINITY],
];

// 元 / 百万 token，单位与供应商账单一致；peak 是高峰时段倍率（北京时间周一至周五 9-12、14-18）。
const DEFAULT_PRICE = { in: 1, inCached: 0.02, out: 4, peak: 2, peakWindows: [["09:00", "12:00"], ["14:00", "18:00"]] };

function priceTable() {
  const raw = process.env.WORKSTREAM_PRICES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Halt("invalid_prices", 500);
  }
}

/** 模型名精确命中优先，其次按前缀（供应商常带 -20250101 之类的后缀）。 */
export function priceFor(model) {
  const table = priceTable();
  const key = String(model ?? "");
  const exact = table[key];
  if (exact) return exact;
  const prefix = Object.keys(table).sort((a, b) => b.length - a.length).find((name) => key.startsWith(name));
  return prefix ? table[prefix] : DEFAULT_PRICE;
}

function beijingParts(iso) {
  const date = new Date(iso);
  const local = new Date(date.getTime() + 8 * 3600_000);
  return { weekday: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** 高峰倍率：只有声明了 peak 和窗口的条目才可能翻倍。 */
export function peakFactor(price, iso) {
  if (!price?.peak || !Array.isArray(price.peakWindows) || !price.peakWindows.length) return 1;
  const { weekday, minutes } = beijingParts(iso);
  if (weekday === 0 || weekday === 6) return 1;
  for (const [from, to] of price.peakWindows) {
    const [fh, fm] = String(from).split(":").map(Number);
    const [th, tm] = String(to).split(":").map(Number);
    if (minutes >= fh * 60 + fm && minutes < th * 60 + tm) return price.peak;
  }
  return 1;
}

export function costOf(step, price) {
  const factor = peakFactor(price, step.created_at);
  const input = Number(step.input_tokens ?? 0);
  const cached = Math.min(Number(step.cached_tokens ?? 0), input);
  const output = Number(step.output_tokens ?? 0) + Number(step.reasoning_tokens ?? 0);
  const yuan = ((input - cached) * Number(price.in ?? 0) + cached * Number(price.inCached ?? 0) + output * Number(price.out ?? 0)) / 1e6;
  return { yuan: yuan * factor, input, cached, output, factor };
}

export const actions = {
  /** 某个员工在 5 分钟 / 1 小时 / 全部 三个窗口的命中率与花费（只读本人的员工）。 */
  async "agents.usage"({ db, user, params }) {
    const id = uuid(params.get("id"), "id");
    const agent = await db.agents.byId(id, { columns: "id,owner_id,model,name" });
    if (!agent) throw new Halt("agent_not_found", 404);
    if (agent.owner_id !== user.id) throw new Halt("permission_denied", 403);
    const price = priceFor(agent.model);
    const now = Date.now();
    const rows = await db.run_steps.list([["agent_id", id]], {
      columns: "input_tokens,cached_tokens,output_tokens,reasoning_tokens,created_at", limit: 2000,
    });
    const windows = {};
    for (const [name, span] of WINDOWS) {
      const picked = rows.filter((row) => now - Date.parse(row.created_at) <= span);
      let input = 0, cached = 0, output = 0, yuan = 0;
      for (const row of picked) {
        const cost = costOf(row, price);
        input += cost.input;
        cached += cost.cached;
        output += cost.output;
        yuan += cost.yuan;
      }
      windows[name] = {
        rounds: picked.length,
        input_tokens: input,
        cached_tokens: cached,
        output_tokens: output,
        hit_rate: input ? cached / input : null,
        cost_yuan: Number(yuan.toFixed(6)),
      };
    }
    return json({
      ok: true,
      agent: { id: agent.id, name: agent.name, model: agent.model },
      price,
      windows,
    });
  },
};
