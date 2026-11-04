// 迁移自检：把 sql/*.sql 的列定义和 functions/*.mjs 里真实读写的列对账。
// 本机假数据库是 JSON 存储，不会拒绝多余列，所以列名写错在本地跑不出来——这里静态拦一道。
// 用法：node dev/check-schema.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const columnName = /^[a-z_][a-z0-9_]*$/;

/* ---------- 1. 解析迁移里的表与列（按文件名顺序合并所有 sql/*.sql） ---------- */
const sql = readdirSync(join(root, "sql"))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(root, "sql", name), "utf8"))
  .join("\n");
const tables = new Map();
for (const match of sql.matchAll(/CREATE TABLE app\.(\w+) \(([\s\S]*?)\n\);/g)) {
  const [, name, body] = match;
  const columns = new Map();
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim().replace(/,$/, "");
    if (!line || /^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|CONSTRAINT)\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2 || !columnName.test(parts[0])) continue;
    columns.set(parts[0], { type: parts[1], notNull: /\bNOT NULL\b/i.test(line) });
  }
  tables.set(name, columns);
}
const problems = [];
// 后续迁移用 ALTER TABLE ... ADD COLUMN 补列；迁移 API 只允许可空、无默认值的新列。
for (const match of sql.matchAll(/ALTER TABLE app\.(\w+) ADD COLUMN (\w+) (\w+)([^;]*);/gi)) {
  const [, tableName, column, type, rest] = match;
  const columns = tables.get(tableName);
  if (!columns) {
    problems.push(`ALTER TABLE 指向迁移里没有的表：app.${tableName}`);
    continue;
  }
  columns.set(column, { type, notNull: /\bNOT NULL\b/i.test(rest) });
}

/* ---------- 2. 扫描 Function 里的 db.<table>.<method>(...) 调用 ---------- */
/** 从 openAt（'(' 的下标）开始，按括号配对取出所有实参源码。 */
function argsOf(text, openAt) {
  const args = [];
  let depth = 0, current = "", inString = null, escaped = false;
  for (let i = openAt; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) { escaped = false; current += char; continue; }
    if (char === "\\") { escaped = true; current += char; continue; }
    if (inString) {
      current += char;
      if (char === inString) inString = null;
      continue;
    }
    if ("'\"`".includes(char)) { inString = char; current += char; continue; }
    if ("([{".includes(char)) {
      depth += 1;
      if (depth === 1) continue; // 最外层括号不入片段
      current += char;
      continue;
    }
    if (")]}".includes(char)) {
      depth -= 1;
      if (depth === 0) { args.push(current); return args; }
      current += char;
      continue;
    }
    if (char === "," && depth === 1) { args.push(current); current = ""; continue; }
    current += char;
  }
  return args;
}

/** 从一个实参源码里提取列名：对象字面量的顶层键、[["col", v]] 的列、columns:"a,b"。 */
const OPTIONS = new Set(["columns", "limit", "order", "range", "returning", "stamp", "pairs", "values", "onConflict", "count"]);
function columnsOf(fragment) {
  const found = new Set();
  let dynamic = false;
  const source = fragment.trim();
  if (!source) return { found, dynamic };
  if (/^[a-z_][a-z0-9_]*$/i.test(source)) return { found, dynamic: true }; // 传变量：静态展开不了
  if (source.startsWith("{")) {
    let depth = 0, buffer = "", inString = null, escaped = false;
    const parts = [];
    for (const char of source.slice(1, source.lastIndexOf("}"))) {
      if (escaped) { escaped = false; buffer += char; continue; }
      if (char === "\\") { escaped = true; buffer += char; continue; }
      if (inString) { buffer += char; if (char === inString) inString = null; continue; }
      if ("'\"`".includes(char)) { inString = char; buffer += char; continue; }
      if ("([{".includes(char)) depth += 1;
      if (")]}".includes(char)) depth -= 1;
      if (char === "," && depth === 0) { parts.push(buffer); buffer = ""; continue; }
      buffer += char;
    }
    parts.push(buffer);
    for (const part of parts) {
      const entry = part.trim();
      if (!entry) continue;
      if (entry.startsWith("...")) { dynamic = true; continue; }
      const keyed = entry.match(/^([a-z_][a-z0-9_]*)\s*:/i);
      const shorthand = entry.match(/^([a-z_][a-z0-9_]*)$/i);
      const name = keyed?.[1] ?? shorthand?.[1];
      if (name && !OPTIONS.has(name)) found.add(name);
    }
    return { found, dynamic };
  }
  for (const pair of source.matchAll(/\[\s*"([a-z_][a-z0-9_]*)"\s*[,]]/g)) found.add(pair[1]);
  return { found, dynamic };
}

const writes = new Map();
const reads = new Map();
const dynamicWrites = new Set();
const functionDir = join(root, "functions");
const methods = {
  insert: "write", insertMany: "write", upsert: "write", patch: "write", claim: "write",
  remove: "filter", list: "read", first: "read", byId: "read", total: "read",
};

for (const file of readdirSync(functionDir).filter((name) => /\.mjs$/.test(name))) {
  const text = readFileSync(join(functionDir, file), "utf8");
  for (const match of text.matchAll(/\bdb\.([a-z_][a-z0-9_]*)\.([a-zA-Z]+)\(/g)) {
    const [, table, method] = match;
    const kind = methods[method];
    if (!kind) continue;
    const openAt = match.index + match[0].length - 1;
    const bucket = kind === "write" ? writes : reads;
    const set = bucket.get(table) ?? new Set();
    bucket.set(table, set);
    const fragments = argsOf(text, openAt);
    fragments.forEach((fragment, index) => {
      const { found, dynamic } = columnsOf(fragment);
      for (const name of found) if (columnName.test(name) && name !== "columns") set.add(name);
      const columnsString = fragment.match(/columns:\s*"([^"]*)"/)?.[1];
      if (columnsString) for (const name of columnsString.split(",")) if (columnName.test(name.trim())) set.add(name.trim());
      // 写操作的实参是变量或展开时，静态展开不了，记下来避免误报 NOT NULL。
      if (kind === "write" && dynamic) dynamicWrites.add(table);
    });
  }
  for (const match of text.matchAll(/from\("([a-z_][a-z0-9_]*)"\)/g)) {
    reads.set(match[1], reads.get(match[1]) ?? new Set());
  }
}

/* ---------- 3. 对账 ---------- */
for (const [table, set] of writes) {
  const defined = tables.get(table);
  if (!defined) { problems.push(`代码写入了迁移里没有的表：app.${table}`); continue; }
  for (const column of set) {
    if (!defined.has(column)) problems.push(`app.${table}.${column}：Function 会写/过滤，迁移里没有这一列`);
  }
  if (!dynamicWrites.has(table)) {
    for (const [column, spec] of defined) {
      if (spec.notNull && !set.has(column)) problems.push(`app.${table}.${column}：迁移声明 NOT NULL，但没有写入路径提供它`);
    }
  }
}
for (const [table, set] of reads) {
  const defined = tables.get(table);
  if (!defined) { problems.push(`代码读取了迁移里没有的表：app.${table}`); continue; }
  for (const column of set) {
    if (!defined.has(column)) problems.push(`app.${table}.${column}：Function 会读/过滤，迁移里没有这一列`);
  }
}

/* ---------- 4. 群文件渲染器清单对账 ---------- */
// 注册表是运行时的，本机假数据库与 smoke 都看不见「写了渲染器文件但没人 import」——
// 那正好是 mcp.mjs 冷启动扫「声明了但没实现」的同一类事故，这里静态拦一道。
const rendererDir = join(root, "src", "lib", "renderers");
const manifest = readFileSync(join(rendererDir, "index.mjs"), "utf8");
const rendererFiles = readdirSync(rendererDir).filter((name) => name.endsWith(".mjs") && name !== "index.mjs").sort();
for (const name of rendererFiles) {
  if (!manifest.includes(`import "./${name}"`)) {
    problems.push(`群文件渲染器 ${name} 没被 src/lib/renderers/index.mjs 引入：注册表里永远看不见它`);
  }
}
for (const match of manifest.matchAll(/import "\.\/([\w.-]+\.mjs)"/g)) {
  if (!rendererFiles.includes(match[1])) problems.push(`src/lib/renderers/index.mjs 引了不存在的渲染器：${match[1]}`);
}
// 渲染器按节点底色把 fill 写在 <text> 的属性上；CSS 作者规则优先级高于 presentation attribute，
// .ws-drawio text 里再声明一次 fill 就会把深色字悄悄盖成主题前景色——暗色主题下浅粉彩底 + 近白字等于看不见。
const sheet = readFileSync(join(root, "src", "globals.css"), "utf8");
const drawioTextRule = /\.ws-drawio\s+text\s*\{[^}]*\}/g.exec(sheet)?.[0] ?? "";
if (/fill\s*:/.test(drawioTextRule)) {
  problems.push("src/globals.css 的 .ws-drawio text 规则里设了 fill：会盖掉渲染器按底色算出的标签颜色");
}

console.log(`迁移里的表（${tables.size}）：${[...tables.keys()].join(", ")}`);
console.log(`群文件渲染器（${rendererFiles.length}）：${rendererFiles.join(", ") || "（无）"}`);
if (dynamicWrites.size) console.log(`按变量传参、无法静态展开写入列的表：${[...dynamicWrites].join(", ")}`);
if (problems.length) {
  console.log(`发现 ${problems.length} 处不一致：\n- ${problems.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("结果：Function 读写列与迁移定义一致。");
}
