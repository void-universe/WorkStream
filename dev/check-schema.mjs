// 迁移自检：把 sql/*.sql 的列定义和 functions/*.mjs 里真实读写的列对账。
// 本机假数据库是 JSON 存储，不会拒绝多余列，所以列名写错在本地跑不出来——这里静态拦一道。
// 用法：node dev/check-schema.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKEND_IDS } from "../functions/backends.mjs";
import { DEFAULT_LOCALE as SERVER_DEFAULT_LOCALE, LOCALE_IDS } from "../functions/locales.mjs";

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

/* ---------- 5. 后端清单与界面「模型来源」对账 ---------- */
// 后端能填什么由 functions/backends.mjs 说了算（服务端 oneOf 用的就是那份 id 清单）。
// 界面上的下拉选项与 TS 联合类型是它的两个副本：冒烟只打接口看不见界面，这一处只能静态对账。
const agentsView = readFileSync(join(root, "src", "views", "Agents.tsx"), "utf8");
const backendSelect = /<NativeSelect[\s\S]*?id="agent-backend"[\s\S]*?<\/NativeSelect>/.exec(agentsView)?.[0] ?? "";
const optionIds = [...backendSelect.matchAll(/<NativeSelectOption value="([a-z_]+)">/g)].map((match) => match[1]);
const unionSource = /type Backend = ([^;]+);/.exec(agentsView)?.[1] ?? "";
const unionIds = [...unionSource.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
const sameSet = (left, right) => left.length === right.length && [...left].sort().join() === [...right].sort().join();
if (!optionIds.length) problems.push('src/views/Agents.tsx 的「模型来源」下拉没解析出选项（改了结构要同步改这道对账）');
else if (!sameSet(optionIds, BACKEND_IDS)) problems.push(`「模型来源」下拉 [${optionIds.join(",")}] 与后端清单 [${BACKEND_IDS.join(",")}] 对不上`);
if (!sameSet(unionIds, BACKEND_IDS)) problems.push(`type Backend [${unionIds.join(",")}] 与后端清单 [${BACKEND_IDS.join(",")}] 对不上`);

/* ---------- 6. 界面语言：清单、字典与取词点对账 ---------- */
// 服务端只要 id 白名单，前端还要自称、书写方向和「译完与否」，所以清单存了两份
// （functions/ 打包不了 src/ 的 TS）。字典缺一个键不会报错，只会把界面渲染成 ⟦键名⟧；
// 少一个占位符也不会报错，只会把变量名整个吞掉——这类缺口冒烟打接口永远看不见，只能静态对账。
const i18nSource = readFileSync(join(root, "src", "lib", "i18n.ts"), "utf8");
const clientLocales = [
  ...i18nSource.matchAll(/\{ id: "([\w-]+)", label: "(?:[^"]|\\")*", intl: "([\w-]+)", dir: "(ltr|rtl)", complete: (true|false) \}/g),
].map((match) => ({ id: match[1], intl: match[2], dir: match[3], complete: match[4] === "true" }));
if (!clientLocales.length) problems.push("src/lib/i18n.ts 的 LOCALES 没解析出条目（改了行结构要同步改这道对账）");
const clientIds = clientLocales.map((locale) => locale.id);
if (clientIds.length && !sameSet(clientIds, LOCALE_IDS)) {
  problems.push(`前端语言清单 [${clientIds.join(",")}] 与服务端白名单 [${LOCALE_IDS.join(",")}] 对不上`);
}
const clientDefault = /DEFAULT_LOCALE: LocaleId = "([\w-]+)"/.exec(i18nSource)?.[1] ?? "";
if (clientDefault !== SERVER_DEFAULT_LOCALE) {
  problems.push(`默认语言两边不一致：前端 ${clientDefault || "（没解析出来）"} / 服务端 ${SERVER_DEFAULT_LOCALE}`);
}

const localeDir = join(root, "src", "locales");
const dictNames = readdirSync(localeDir).filter((name) => name.endsWith(".json")).sort();
const completeIds = clientLocales.filter((locale) => locale.complete).map((locale) => locale.id);
for (const id of completeIds) {
  if (!dictNames.includes(`${id}.json`)) problems.push(`${id} 标了 complete: true，但没有 src/locales/${id}.json：选了它会拿到空字典`);
}
for (const name of dictNames) {
  const id = name.replace(/\.json$/, "");
  if (!completeIds.includes(id)) problems.push(`src/locales/${name} 存在，但清单里 ${id} 没标 complete: true：界面永远选不到它`);
  if (!clientIds.includes(id)) problems.push(`src/locales/${name} 对应的语言 id 不在前端清单里：多出来的一份没人读的字典`);
}

/** 取词点只认字面量键：写变量取词这道闸看不见，所以别那么写。 */
const usedKeys = new Set();
const tpKeys = new Set();
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { walk(join(dir, entry.name)); continue; }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    const text = readFileSync(join(dir, entry.name), "utf8");
    for (const match of text.matchAll(/\.(?:t|tf|tp)\(\s*"([\w.-]+)"/g)) usedKeys.add(match[1]);
    for (const match of text.matchAll(/\.tp\(\s*"([\w.-]+)"/g)) tpKeys.add(match[1]);
  }
})(join(root, "src"));

const holders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join("+");
const readDict = (name) => JSON.parse(readFileSync(join(localeDir, name), "utf8"));
const source = readDict("zh-Hans.json");
for (const key of usedKeys) {
  if (!(key in source)) problems.push(`界面取了字典里没有的键：${key}（渲染成 ⟦${key}⟧）`);
}
for (const key of tpKeys) {
  const hits = String(source[key] ?? "").match(/\{0\}/g)?.length ?? 0;
  if (hits !== 1) problems.push(`tp("${key}") 要按 {0} 切开插元素，中文源里 {0} 出现 ${hits} 次`);
}
for (const name of dictNames) {
  const dict = readDict(name);
  const missing = Object.keys(source).filter((key) => !(key in dict));
  const extra = Object.keys(dict).filter((key) => !(key in source));
  if (missing.length) problems.push(`src/locales/${name} 缺 ${missing.length} 个键：${missing.join(", ")}`);
  if (extra.length) problems.push(`src/locales/${name} 有中文源里没有的键：${extra.join(", ")}`);
  for (const key of Object.keys(dict)) {
    if (!(key in source)) continue;
    if (holders(dict[key]) !== holders(source[key])) {
      problems.push(`src/locales/${name} 的 ${key} 占位符和中文源对不上：[${holders(source[key])}] vs [${holders(dict[key])}]`);
    }
  }
}

/* ---------- 7. 界面文案裸奔：只许跌不许涨的棘轮 ---------- */
// 字典对账只能证明「取词点取到的键都在字典里」，证明不了「界面里没有没进字典的中文」——
// 漏迁的那句在中文界面上一切正常，切到英文才露出来，冒烟打接口永远看不见。
// 这里按文件数非注释中文行：数字变大就是又有一句硬编码上了屏，当场拒绝；
// 数字变小却没改表同样拒绝，否则这张表会变成一份越来越假的欠债清单。
// 表里留着的每一处都应该是「数据/枚举/兜底」而不是界面文案，改的人得逐行确认才能把数字往下调。
// - src/lib/i18n.ts：语言的自称（简体中文、日本語），换了界面语言也不该被翻译，否则用户认不出自己要选的那个。
// - src/views/Agents.tsx：写进 model 列的哨兵值「云端 Agent」与它的回读比对，是数据不是文案（屏上那一行已走 agent.qcaModel）。
// - src/views/Skills.tsx：技能分类默认值「协作」入库、会被服务端原样存下，另有一行是「技能源示例 index」的 JSON 样例正文。
const BARE_COPY_CEILING = {
  "src/lib/i18n.ts": 2,
  "src/views/Agents.tsx": 2,
  "src/views/Skills.tsx": 3,
};
const bareFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) bareFiles.push(path);
  }
})(join(root, "src"));
const stripComments = (text) =>
  text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[\t ]*\/\/.*$/gm, "");
const bareCounts = new Map();
for (const path of bareFiles) {
  const relative = path.slice(root.length + 1).replace(/\\/g, "/");
  if (relative.startsWith("locales/") || relative === "lib/route.ts") continue;
  const lines = stripComments(readFileSync(path, "utf8")).split(/\r?\n/);
  const hit = lines.filter((line) => /[\u4e00-\u9fff]/.test(line)).length;
  if (hit) bareCounts.set(relative, hit);
}
for (const [file, count] of bareCounts) {
  const allowed = BARE_COPY_CEILING[file];
  if (allowed === undefined) problems.push(`${file} 有 ${count} 行界面文案没进字典：迁进 src/locales/*.json，别把数字加进 dev/check-schema.mjs 的表里`);
  else if (count > allowed) problems.push(`${file} 的裸奔中文从 ${allowed} 行涨到 ${count} 行：新加的中文没进字典`);
  else if (count < allowed) problems.push(`${file} 的裸奔中文从 ${allowed} 行降到 ${count} 行：把 dev/check-schema.mjs 里的数字改成 ${count}，欠债清单要如实`);
}
for (const file of Object.keys(BARE_COPY_CEILING)) {
  if (!bareCounts.has(file)) problems.push(`${file} 在裸奔清单里记了 ${BARE_COPY_CEILING[file]} 行，实际已经一行不剩：把这一项整条删掉`);
}

/* ---------- 7b. 两句文案并排时必须要有分隔 ---------- */
// 中文句子之间靠「。」自己断开，拉丁文种靠空格：JSX 里把两个取词表达式紧挨着排，
// 中文界面看不出问题，切到英文就渲染成 "…follows it.No delegate…"。这类只有换语言才露脸，
// 冒烟和中文截图都看不见，所以在源码形状这一层钉住：相邻的两个子节点都取词，就必须有一个 {" "} 分隔。
const copyChild = /^\{[^{}]*\}(?:\{" "\})?$/;
const takesCopy = (text) => /i18n\.(t|tf|tp)\(|\(i18n[,)]/.test(text);
for (const path of bareFiles) {
  const lines = stripComments(readFileSync(path, "utf8")).split(/\r?\n/);
  const relative = path.slice(root.length + 1).replace(/\\/g, "/");
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i].trim();
    const b = lines[i + 1].trim();
    if (!copyChild.test(a) || !copyChild.test(b) || !takesCopy(a) || !takesCopy(b)) continue;
    if (/^\{" "\}/.test(b) || a.endsWith(`{" "}`)) continue;
    problems.push(`${relative}:${i + 1} 两句文案中间没有分隔：中文能自己断句，拉丁文种会连成 "…it.No…"，在两句之间加 {" "}`);
  }
  for (let i = 0; i < lines.length; i++) {
    if (/\{[^{}]*i18n[^{}]*\}\{[^{}]*i18n[^{}]*\}/.test(lines[i])) {
      problems.push(`${relative}:${i + 1} 两句文案中间没有分隔：中文能自己断句，拉丁文种会连成 "…it.No…"，在两句之间加 {" "}`);
    }
  }
}

/* ---------- 8. 服务端错误码与前端错误码文案 ---------- */
// 前端按码查字典：漏一个码不会报错，只会把 account_missing 这种内部标识直接贴到用户眼前，
// 四种语言一样难看、一样没用。冒烟断的是状态码，从没断过「这句文案在不在」。
// 服务端不少码是拼出来的，静态扫字面永远看不见；偏偏 invalid_<字段> 正是用户把表单填错时
// 最容易撞上的那一族——没文案就等于把内部字段名贴到屏幕上。所以这一族按校验器签名反推，
// 下面 8b 用一张签名表算出真实码集，不许只对着字面码收口。
// 反方向（字典里有、表里没引）单独查一道，防止文案和 ERROR_KEYS 各说各话。
const apiSource = readFileSync(join(root, "src", "api.ts"), "utf8");
const codeToKey = new Map();
for (const match of apiSource.matchAll(/^ {2}([a-z_]+): "errors\.([a-z_]+)",$/gm)) {
  if (match[1] !== match[2]) problems.push(`src/api.ts 的 ${match[1]} 指向 errors.${match[2]}：错误码和字典键要对得上`);
  codeToKey.set(match[1], `errors.${match[2]}`);
}
if (!codeToKey.size) problems.push("src/api.ts 的 ERROR_KEYS 没解析出条目（改了表结构要同步改这道对账）");
const serverCodes = new Map();
for (const file of readdirSync(functionDir).filter((name) => name.endsWith(".mjs"))) {
  const text = readFileSync(join(functionDir, file), "utf8");
  for (const match of text.matchAll(/\b(?:fail|new Halt)\(\s*"([a-z_]+)"/g)) serverCodes.set(match[1], file);
  for (const match of text.matchAll(/error:\s*"([a-z_]+)"/g)) if (!serverCodes.has(match[1])) serverCodes.set(match[1], file);
}
for (const [code, file] of serverCodes) {
  if (!codeToKey.has(code)) {
    problems.push(`服务端会回 ${code}（functions/${file}），前端没配这句文案：界面只会显示「出错了：${code}」`);
  }
}
for (const [code, key] of codeToKey) {
  if (!(key in source)) problems.push(`${key}：src/api.ts 引用了它，但中文字典里没有这句（渲染成 ⟦${key}⟧）`);
}
for (const key of Object.keys(source)) {
  if (!key.startsWith("errors.") || key === "errors.network" || key === "errors.withCode") continue;
  if (!codeToKey.has(key.slice("errors.".length))) {
    problems.push(`${key} 在字典里，但 src/api.ts 的 ERROR_KEYS 没引用：要么补进表，要么把这句删掉`);
  }
}

/* ---------- 8b. 拼出来的错误码 ---------- */
// 有一类码在 functions/ 里任何一处都不写字面，是模板字符串按变量拼出来的（invalid_<字段>、
// <表>_request_failed、skill_skipped_<原因>、registry_<失败>）。上面那道字面扫对它们是瞎的，
// 而这些偏偏是用户最容易撞上的几族——没配文案就等于把内部字段名或表名直接贴到屏幕上。
// 做法是：先认出所有「码形状」的模板，再按登记的取值来源把那个变量展开成真实码集，逐个查文案。
// 认不出的形状、登记了却收不到取值的来源都当场报：新增一处拼法要么登记它，要么写明白它不是错误码。
const CODE_SHAPERS = {
  text: { options: true },
  int: { options: true },
  uuid: { positional: 1, dflt: "id" },
  oneOf: { positional: 2, dflt: "field" },
  avatarData: { positional: 1, dflt: "avatar" },
  email: { positional: 1, dflt: "email" },
  remoteUrl: { options: true },
  stamp: { positional: 1 },
};
// 认「哪段代码在拼 invalid_<字段>」用的声明正则：export function / function / const 箭头三种写法都得认。
const OWNER_RE = /\n(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|\()/g;
// 长得像码、但不是码的形状，逐个写明白它是什么。漏登记会当场报，所以这张表不会悄悄变长。
const NOT_CODES = {
  "call_◆": "工具调用的 id，只进步骤 detail，不进响应体的错误码",
  "◆_clipped": "run_steps 里记原文长度的字段名，前端据此写「原文 N 字，这里显示前 M 字」",
};
// 变量名 → 它的取值从哪几个字面收集。只在本模块内收，免得把无关的 code: "…" 当成拼码取值。
const VALUES = new Map([
  ["name", () => [...shaperFields]],
  ["code", (file) => [...(codeLiterals.get(file) ?? [])]],
  ["reason", (file) => [...(noteLiterals.get(file) ?? [])]],
  ["table", () => [...tables.keys()]],
]);
const shaperFields = new Set();
const shapersSeen = new Set();
const codeLiterals = new Map();
const noteLiterals = new Map();
const composed = new Map();
const templates = new Map();
const unregisteredShapers = new Set();
for (const file of readdirSync(functionDir).filter((name) => name.endsWith(".mjs"))) {
  const text = readFileSync(join(functionDir, file), "utf8");
  // 校验器调用点：name 写在选项里，uuid/oneOf 那些是位置参数，没传就用签名里的默认名。
  for (const [shaper, spec] of Object.entries(CODE_SHAPERS)) {
    for (const match of text.matchAll(new RegExp(`(?:^|[^.\\w])${shaper}\\(`, "g"))) {
      shapersSeen.add(shaper);
      const args = argsOf(text, match.index + match[0].length - 1);
      let field = null;
      if (spec.options) field = args.map((arg) => /name:\s*"([a-z_]+)"/.exec(arg)?.[1]).find(Boolean);
      else field = /^"([a-z_]+)"$/.exec((args[spec.position] ?? "").trim())?.[1] ?? (args.length <= spec.position ? spec.dflt : null);
      if (field) shaperFields.add(field);
    }
  }
  for (const match of text.matchAll(/code:\s*"([a-z_]+)"/g)) {
    if (!codeLiterals.has(file)) codeLiterals.set(file, new Set());
    codeLiterals.get(file).add(match[1]);
  }
  for (const match of text.matchAll(/\bnote\([^,]+,\s*"([a-z_]+)"\s*\)/g)) {
    if (!noteLiterals.has(file)) noteLiterals.set(file, new Set());
    noteLiterals.get(file).add(match[1]);
  }
  // 签名表外的拼码函数要当场点名，否则新增一处拼接只是安静地漏掉。
  for (const match of text.matchAll(/`invalid_\$\{/g)) {
    const owners = [...text.slice(0, match.index).matchAll(OWNER_RE)];
    const last = owners[owners.length - 1];
    const owner = last ? (last[1] ?? last[2]) : "(模块顶层)";
    if (CODE_SHAPERS[owner]) continue;
    const where = `${file} · ${owner}()`;
    if (unregisteredShapers.has(where)) continue;
    unregisteredShapers.add(where);
    problems.push(`${where} 会拼 invalid_<字段>，但没登记在 dev/check-schema.mjs 的 CODE_SHAPERS：这道对账就看不见它产出的码`);
  }
  // 码形状 = 恰好一个 ${…}，两侧静态段都只含 [a-z_] 且至少一段非空（正文插值两侧是句子，不会算进来）。
  for (const match of text.matchAll(/`([^`\n]*)`/g)) {
    const pieces = match[1].split(/(\$\{[^{}]+\})/);
    const exprs = pieces.filter((piece) => piece.startsWith("${"));
    const [prefix = "", , suffix = ""] = pieces;
    if (!exprs.length || !/^[a-z_]*$/.test(prefix) || !/^[a-z_]*$/.test(suffix) || !(prefix || suffix)) continue;
    const shape = `${prefix}◆${suffix}`;
    if (exprs.length !== 1) {
      problems.push(`functions/${file} 里的 \`${match[1]}\` 长得像错误码却拼了 ${exprs.length} 个变量：这道对账只会展开单变量拼码，要么改成单变量，要么把它登记进 NOT_CODES`);
      continue;
    }
    // 同一个形状在不同模块按不同变量拼是两回事，所以按「形状 + 变量」留档，不让后一处盖掉前一处。
    const expr = exprs[0].slice(2, -1);
    templates.set(`${shape}::${expr}`, { file, expr, prefix, suffix, shape, raw: match[1] });
  }
}
const compositionOrder = [...templates.entries()].sort((left, right) => left[1].shape.localeCompare(right[1].shape));
for (const [, site] of compositionOrder) {
  const shape = site.shape;
  if (NOT_CODES[shape]) continue;
  const values = (VALUES.get(site.expr) ?? (() => null))(site.file);
  if (!values) {
    problems.push(`functions/${site.file} 里的 \`\${${site.expr}}\` 拼出 ${shape}：这个变量的取值来源没登记在 VALUES，这道对账看不见它产出的码`);
    continue;
  }
  if (!values.length) {
    problems.push(`${shape} 的取值来源（${site.expr}）一个都没收到：这道对账形同没跑，去 functions/${site.file} 看字面收集规则改了没有`);
    continue;
  }
  for (const value of values) composed.set(`${site.prefix}${value}${site.suffix}`, `${site.file} · \`${site.raw}\``);
}
// 表里的签名也要真的还有人调：留着早删掉的校验器，这张表就开始讲假话。
for (const shaper of Object.keys(CODE_SHAPERS)) {
  if (!shapersSeen.has(shaper)) problems.push(`dev/check-schema.mjs 的 CODE_SHAPERS 登记了 ${shaper}()，但 functions/ 里没有任何调用点：删掉它，这道对账只描述现在的代码`);
}
for (const [code, where] of composed) {
  if (!codeToKey.has(code)) problems.push(`服务端会回 ${code}（${where}），前端没配这句文案：界面只会显示「出错了：${code}」`);
}

console.log(`迁移里的表（${tables.size}）：${[...tables.keys()].join(", ")}`);
console.log(`群文件渲染器（${rendererFiles.length}）：${rendererFiles.join(", ") || "（无）"}`);
console.log(`后端清单（${BACKEND_IDS.length}）：${BACKEND_IDS.join(", ")}`);
console.log(`界面语言（${clientIds.length}，已译完 ${completeIds.length}）：字典 ${dictNames.join(", ")}`);
console.log(`取词点（${usedKeys.size} 个键，扫 src/ 全量 .ts/.tsx）`);
console.log(`界面文案裸奔（${[...bareCounts.values()].reduce((n, c) => n + c, 0)} 行，分布在 ${bareCounts.size} 个文件；表里记了 ${Object.keys(BARE_COPY_CEILING).length} 处欠债）`);
console.log(`服务端错误码（字面可扫 ${serverCodes.size} 个 + 拼出来 ${composed.size} 个）与前端文案（ERROR_KEYS ${codeToKey.size} 条）`);
if (dynamicWrites.size) console.log(`按变量传参、无法静态展开写入列的表：${[...dynamicWrites].join(", ")}`);
if (problems.length) {
  console.log(`发现 ${problems.length} 处不一致：\n- ${problems.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("结果：读写列、渲染器登记、后端清单、语言字典、错误码文案与界面文案裸奔棘轮全部对账通过。");
}
