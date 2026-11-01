// Supabase SDK 的薄封装：统一错误码映射、行读写与单行比较并写（CAS）。
// 每一次读写都带上应用层已经校验过的过滤条件；数据库策略只决定运行时可达性。
import { Halt, now } from "./util.mjs";

const SAFE = /^[a-z_][a-z0-9_]*$/;
const assert = (table) => {
  if (!SAFE.test(table)) throw new Halt("invalid_table", 500);
  return table;
};

const mapError = (result, fallback) => {
  if (!result.error) return null;
  const code = typeof result.error.code === "string" && /^[A-Z0-9]{5}$/.test(result.error.code)
    ? result.error.code
    : null;
  return { code: code ?? fallback };
};

function table(client, name) {
  const table = assert(name);
  const failure = `${table}_request_failed`;
  const apply = (builder, pairs) => {
    let out = builder;
    for (const [column, value] of pairs) {
      if (Array.isArray(value)) out = out.in(column, value);
      else out = out.eq(column, value);
    }
    return out;
  };
  const guarded = (pairs, columns) => {
    if (!pairs.length) throw new Halt("unfiltered_query", 500);
    let builder = client.from(table).select(columns);
    for (const [column, value] of pairs) {
      builder = Array.isArray(value) ? builder.in(column, value) : builder.eq(column, value);
    }
    return builder;
  };
  return {
    table,
    /** 有界列表：pairs 必须非空，columns 为显式列。 */
    async list(pairs, { columns = "*", order = null, limit = 300, range = null } = {}) {
      let builder = guarded(pairs, columns);
      if (order) {
        builder = Array.isArray(order)
          ? builder.order(order[0], order[1] ?? { ascending: true })
          : builder.order(order);
      }
      if (range) builder = builder.range(range[0], range[1]);
      const result = await (limit === null ? builder : builder.limit(limit));
      const problem = mapError(result, "P0001");
      if (problem) throw new Halt(failure, 503, problem);
      return Array.isArray(result.data) ? result.data : [];
    },
    async first(pairs, { columns = "*", order = null } = {}) {
      const rows = await this.list(pairs, { columns, order, limit: 1 });
      return rows[0] ?? null;
    },
    async byId(id, { columns = "*" } = {}) {
      return this.first([["id", id]], { columns });
    },
    async total(pairs, { columns = "id" } = {}) {
      let builder = client.from(table).select(columns, { count: "exact" });
      builder = apply(builder, pairs);
      const result = await builder.limit(1);
      if (mapError(result, "P0001") || !Number.isSafeInteger(result.count) || result.count < 0) {
        throw new Halt(failure, 503, mapError(result, "P0001") ?? { code: "count_unavailable" });
      }
      return result.count;
    },
    async insert(values, { columns = "*" } = {}) {
      const result = await client.from(table).insert(values).select(columns).maybeSingle();
      const problem = mapError(result, "P0001");
      if (problem) throw new Halt(failure, 503, problem);
      return result.data ?? null;
    },
    async insertMany(rows, { columns = "*" } = {}) {
      const result = await client.from(table).insert(rows).select(columns);
      const problem = mapError(result, "P0001");
      if (problem) throw new Halt(failure, 503, problem);
      return Array.isArray(result.data) ? result.data : [];
    },
    async upsert(values, { onConflict, columns = "*" } = {}) {
      const result = await client.from(table)
        .upsert(values, onConflict ? { onConflict } : undefined).select(columns).maybeSingle();
      const problem = mapError(result, "P0001");
      if (problem) throw new Halt(failure, 503, problem);
      return result.data ?? null;
    },
    /** 不带返回行的写：返回真实受影响行数，未知结果一律抛出。 */
    async patch(pairs, values, { returning = false } = {}) {
      if (!pairs.length) throw new Halt("unfiltered_write", 500);
      let builder = client.from(table).update({ ...values });
      builder = apply(builder, pairs);
      const result = returning ? await builder.select("id").maybeSingle() : await builder;
      const problem = mapError(result, "P0001");
      if (problem) throw new Halt(failure, 503, problem);
      if (returning) return result.data?.id ?? null;
      return true;
    },
    /** 单行比较并写：条件命中且写回成功返回 id，否则 null（说明被抢先）。 */
    async claim(pairs, values, { stamp = true } = {}) {
      return this.patch(pairs, stamp ? { ...values, updated_at: now() } : values, { returning: true });
    },
    async remove(pairs) {
      if (!pairs.length) throw new Halt("unfiltered_write", 500);
      let builder = client.from(table).delete();
      builder = apply(builder, pairs);
      const result = await builder.select("id").maybeSingle();
      const problem = mapError(result, "P0001");
      if (problem) throw new Halt(failure, 503, problem);
      return result.data?.id ?? null;
    },
  };
}

export const store = (client) => new Proxy({}, {
  get(_target, key) {
    if (key === "client") return client;
    if (typeof key !== "string") return undefined;
    return table(client, key);
  },
});
