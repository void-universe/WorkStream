// 本机开发用的假 Supabase 客户端：不带任何凭据，只为在没有云库时跑通同一段业务代码。
// 部署后的真实数据库访问走 functions/adapter.mjs + 平台注入的 SUPABASE_* 环境。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const UNIQUE = {
  users: [["email"]],
  sessions: [["token_hash"]],
  tokens: [["token_hash"]],
  messages: [["stream_id", "seq"]],
  members: [["stream_id", "principal_type", "principal_id"]],
  stream_vms: [["stream_id", "vm_id"]],
  slice_prefs: [["agent_id", "stream_id"]],
  agent_skills: [["agent_id", "skill_id"]],
  mail: [["id"]],
  outbox: [["id"]],
  requests: [["id"]],
};

export function createFixtureClient(file) {
  const state = load(file);
  const flush = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  };

  const error = (code, message) => ({ code, message: message ?? code, hint: "local_fixture", details: null });

  class Query {
    constructor(table, mode) {
      this.table = table;
      this.mode = mode;
      this.filters = [];
      this.ors = [];
      this.orders = [];
      this.size = null;
      this.count = false;
      this.returning = null;
      this.payload = null;
      this.onConflict = null;
      this.rangePair = null;
    }

    select(columns = "*", options = {}) {
      this.returning = columns;
      this.count = options?.count === "exact";
      return this;
    }

    insert(values) {
      this.mode = "insert";
      this.payload = values;
      return this;
    }

    upsert(values, options = {}) {
      this.mode = "upsert";
      this.payload = values;
      this.onConflict = options?.onConflict ?? "id";
      return this;
    }

    update(values) {
      this.mode = "update";
      this.payload = values;
      return this;
    }

    delete() {
      this.mode = "delete";
      return this;
    }

    eq(column, value) {
      this.filters.push(([row]) => row[column] === value);
      return this;
    }

    neq(column, value) {
      this.filters.push(([row]) => row[column] !== value);
      return this;
    }

    in(column, values) {
      const set = new Set(Array.isArray(values) ? values : []);
      this.filters.push(([row]) => set.has(row[column]));
      return this;
    }

    // SQL 里 NULL 参与大小比较的结果是 unknown，那一行不会被选中；这里必须一样，
    // 否则"时钟写空表示暂停"的行会混进 `<= 现在` 的到期扫描，把 limit 的窗口占满——
    // 本地表现和线上相反，正是测试替身最坏的偏差。
    gt(column, value) {
      this.filters.push(([row]) => hasValue(row[column]) && compare(row[column], value) > 0);
      return this;
    }

    gte(column, value) {
      this.filters.push(([row]) => hasValue(row[column]) && compare(row[column], value) >= 0);
      return this;
    }

    lt(column, value) {
      this.filters.push(([row]) => hasValue(row[column]) && compare(row[column], value) < 0);
      return this;
    }

    lte(column, value) {
      this.filters.push(([row]) => hasValue(row[column]) && compare(row[column], value) <= 0);
      return this;
    }

    or(expression) {
      const terms = String(expression).split(",").map((term) => {
        const [column, operator, value] = term.split(".");
        if (operator !== "ilike") return null;
        const needle = value.replace(/^%|%$/g, "").toLowerCase();
        return ([row]) => String(row[column] ?? "").toLowerCase().includes(needle);
      }).filter(Boolean);
      if (terms.length) this.ors.push(([row]) => terms.some((term) => term([row])));
      return this;
    }

    order(column, options = {}) {
      this.orders.push({ column, ascending: options?.ascending !== false });
      return this;
    }

    limit(value) {
      this.size = Number(value);
      return this;
    }

    range(from, to) {
      this.rangePair = [from, to];
      return this;
    }

    maybeSingle() {
      return this.#run({ single: true });
    }

    single() {
      return this.#run({ single: true, strict: true });
    }

    then(resolve, reject) {
      return this.#run({}).then(resolve, reject);
    }

    #countFor(rows) {
      return rows.filter((row) => this.filters.every((filter) => filter([row]))
        && this.ors.every((test) => test([row]))).length;
    }

    async #run({ single, strict }) {
      await tick();
      const rows = state[this.table] ?? (state[this.table] = []);
      const selected = () => {
        let matched = rows.map((row, index) => [row, index]).filter(([row]) =>
          this.filters.every((filter) => filter([row])) && this.ors.every((test) => test([row])));
        for (const { column, ascending } of [...this.orders].reverse()) {
          matched.sort((a, b) => {
            const result = compare(a[0][column], b[0][column]);
            return ascending ? result : -result;
          });
        }
        if (this.rangePair) matched = matched.slice(this.rangePair[0], this.rangePair[1] + 1);
        if (Number.isFinite(this.size)) matched = matched.slice(0, this.size);
        return matched;
      };

      if (this.mode === "select" || this.mode === undefined) {
        const matched = selected();
        const total = this.count ? this.#countFor(rows) : null;
        const data = matched.map(([row]) => project(row, this.returning));
        if (single) return { data: data[0] ?? null, error: null, count: total };
        if (strict && !data.length) return { data: null, error: error("P0000"), count: total };
        return { data, error: null, count: total };
      }

      if (this.mode === "insert") {
        const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
        for (const row of incoming) {
          const clash = conflict(this.table, row, rows);
          if (clash) return { data: null, error: error("23505", `duplicate ${clash.join(",")}`) };
        }
        rows.push(...incoming.map((row) => structuredClone(row)));
        flush();
        const data = incoming.map((row) => project(row, this.returning ?? "*"));
        if (single) return { data: data[0] ?? null, error: null };
        return { data, error: null };
      }

      if (this.mode === "upsert") {
        const row = this.payload;
        const keyColumns = String(this.onConflict).split(",");
        const index = rows.findIndex((candidate) => keyColumns.every((column) => candidate[column] === row[column]));
        if (index >= 0) rows[index] = { ...rows[index], ...row };
        else rows.push(structuredClone(row));
        flush();
        return { data: project(rows[index >= 0 ? index : rows.length - 1], this.returning ?? "*"), error: null };
      }

      if (this.mode === "update") {
        const matched = selected();
        if (!matched.length && strict) return { data: null, error: error("P0000") };
        if (!matched.length && single) return { data: null, error: null };
        for (const [row] of matched) Object.assign(row, this.payload);
        flush();
        const data = matched.map(([row]) => project(row, this.returning ?? "*"));
        return single ? { data: data[0] ?? null, error: null } : { data: data.map((d) => ({ id: d.id })), error: null };
      }

      if (this.mode === "delete") {
        const matched = selected();
        const doomed = new Set(matched.map(([row]) => row));
        state[this.table] = rows.filter((row) => !doomed.has(row));
        flush();
        const data = matched.map(([row]) => project(row, this.returning ?? "id"));
        return single ? { data: data[0] ?? null, error: null } : { data, error: null };
      }

      return { data: null, error: error("P0001", "unsupported_mode") };
    }
  }

  return {
    from(table) {
      if (!SAFE.test(table)) throw new Error("invalid_table");
      state[table] ??= [];
      return new Query(table, "select");
    },
    __state: state,
    __reset() {
      for (const key of Object.keys(state)) delete state[key];
      flush();
    },
  };
}

const SAFE = /^[a-z_][a-z0-9_]*$/;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** SQL 的三值逻辑：NULL 与任何值比较都是 unknown，这一行不进结果集。 */
const hasValue = (value) => value !== null && value !== undefined;

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function conflict(table, row, rows) {
  for (const columns of UNIQUE[table] ?? []) {
    if (!columns.every((column) => row[column] !== undefined)) continue;
    const clash = rows.some((candidate) => columns.every((column) => candidate[column] === row[column]));
    if (clash) return columns;
  }
  return null;
}

function project(row, columns) {
  if (!columns || columns === "*") return structuredClone(row);
  const out = {};
  for (const column of columns.split(",")) {
    const key = column.trim().split(":")[0];
    if (key && key in row) out[key] = structuredClone(row[key]);
  }
  return out;
}

function load(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
