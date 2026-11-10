// Stream Server API Specification v1.0.0：WorkStream 与「跑虚拟员工的那台 server」之间的接口口径。
//
// 为什么是一张表：这份规范有三处消费者——客户端按 profile 选路（functions/stream.mjs）、
// 参考实现按它挂路由（functions/streamserver.mjs）、官网那两页规范文档照它写。路径散在字符串里，
// 「声明了却没人实现」的那条只会在运行时变成一句 404，正是 mcp.mjs 冷启动扫的那类事故。
// 表本身不自洽（profile 重复、路径参数没闭合、错误码不成族）在加载时就抛。
//
// 两档后端可以混合对接：
//   shared    —— 无状态的分时执行器：一轮的全部输入都在请求里，服务器不挂 WorkStream 的库、
//                也不认识「哪个员工」，所以它不需要数据库钥匙，可以同时替任意多个员工干活。
//   dedicated —— 专属云端员工：会话在对方那侧，帧词表沿用 Qoder 云端 Agent 那一套
//                （functions/qca.mjs 的读循环），我们每轮把上下文压成一条正文发过去。
// 发现（GET 前缀本身）失败就退回 OpenAI 兼容那一档。退回不是猜：它记在 agents.stream_profile 里，
// 提示词措辞、工具注入与自检读的都是这同一个值。
export const SPEC_VERSION = "1.0.0";
export const SPEC_MAJOR = Number(SPEC_VERSION.split(".")[0]);
export const SPEC_ID = `stream-server/${SPEC_VERSION}`;

/** 所有 endpoint 的公共前缀。前缀不可覆盖：另一套前缀的服务（云端 Agent 那一套）走它自己的后端条目。 */
export const SPEC_PREFIX = "/stream-server/v1";

/** caps 的键集合：多一个键等于声明了一件规范没定义的事，客户端无从判断，就地拒。 */
export const CAP_KEYS = ["tools", "interrupt", "usage", "reasoning"];

/**
 * 两档的 id。客户端选路（functions/stream.mjs 的 PROFILE_ROUTES）、后端清单
 * （functions/backends.mjs 的 backendFor）与自检都按这两个值分支，字面量只在下面这张表里出现一次。
 */
export const SHARED_PROFILE = "shared";
export const DEDICATED_PROFILE = "dedicated";

/** 「两档都要有」的那条 endpoint 挂在这个 profile 上：发现响应本身不属于任何一档。 */
export const ANY_PROFILE = "any";

/**
 * profile 是「服务器怎么被使用」，不是「服务器怎么实现」。caps 里 tools 那一格由 profile 决定，
 * 服务器只能在发现响应里照抄：shared 档必须吃工具（不吃工具的服务器对我们的引擎没有用处——
 * 工具回路是它干活的手），dedicated 档必须不吃（专属员工用它自己的工具集，我们的群工具不在这条通道里，
 * 措辞不说清模型就会把工具名写进正文，群里看到的是一次假执行）。
 * 其余三格由服务器如实声明，缺就按这里的默认；客户端落库时按这一轮实际收到了什么标注，
 * 不拿声明值冒充口径。
 */
export const PROFILES = [
  {
    id: SHARED_PROFILE,
    stateless: true,
    caps: { tools: true, interrupt: true, usage: true, reasoning: true },
  },
  {
    id: DEDICATED_PROFILE,
    stateless: false,
    caps: { tools: false, interrupt: false, usage: false, reasoning: false },
  },
];

export const PROFILE_IDS = PROFILES.map((profile) => profile.id);

/** 发现失败时客户端记下的那一档：不是规范的一档，是「这台服务器只认 OpenAI 兼容」这个事实。 */
export const FALLBACK_PROFILE = "openai";

/** agents.stream_profile 列的取值域（oneOf 用的就是这份）。 */
export const STREAM_PROFILE_VALUES = [...PROFILE_IDS, FALLBACK_PROFILE];

/**
 * endpoint 清单。path 里的 `{name}` 是路径参数，取值由 endpointPath 校验后编码，
 * 不让调用方把 `/` 或 `?` 拼进路径里。optional 的那条允许服务器不实现：
 * 中断在 dedicated 档可以退化成「掐自己的读循环」（caps.interrupt 如实声明为 false）。
 */
export const ENDPOINTS = [
  { name: "discovery", profile: ANY_PROFILE, method: "GET", path: "/" },
  { name: "createTurn", profile: SHARED_PROFILE, method: "POST", path: "/turns" },
  { name: "interruptTurn", profile: SHARED_PROFILE, method: "POST", path: "/turns/{turn_id}/interrupt" },
  { name: "getTurn", profile: SHARED_PROFILE, method: "GET", path: "/turns/{turn_id}" },
  { name: "createSession", profile: DEDICATED_PROFILE, method: "POST", path: "/sessions" },
  { name: "postEvents", profile: DEDICATED_PROFILE, method: "POST", path: "/sessions/{session_id}/events" },
  { name: "streamEvents", profile: DEDICATED_PROFILE, method: "GET", path: "/sessions/{session_id}/events/stream" },
  { name: "interruptSession", profile: DEDICATED_PROFILE, method: "POST", path: "/sessions/{session_id}/interrupt", optional: true },
];

/**
 * SSE 帧词表。两档不同，读循环各一份：shared 是我们自己定义的 turn.*，
 * dedicated 沿用云端那一套（event_delta 是增量、agent.message 是权威正文、session.error 是对方报错）。
 * 两档都只用 `data:` 行 + JSON，`type` 字段区分帧——所以 parseFrame 是共用的（functions/qca.mjs 导出）。
 */
export const EVENTS = {
  shared: ["turn.delta", "turn.done", "turn.error"],
  dedicated: ["event_delta", "agent.message", "session.error"],
};

/** shared 档流结束的哨兵，与 OpenAI 兼容那一路同写法。 */
export const STREAM_DONE = "[DONE]";

/** 中断后 shared 档 turn.done 里的 finish_reason：这一轮是被叫停的，不是「说完了」。 */
export const INTERRUPTED_REASON = "interrupted";

/**
 * 错误码一族。客户端与参考实现各回各的，但都长成 stream_<环节>，界面据此分清
 * 「模型端点坏了」（upstream_*）、「云端 Agent 坏了」（qca_*）和「这台执行 server 坏了」（stream_*）。
 * 每个码都必须在 src/api.ts 的 ERROR_KEYS 里有文案，否则用户看到的是内部标识（dev/check-schema.mjs 第 8 节）。
 */
export const ERROR_CODES = {
  client: [
    "stream_origin_invalid",
    "stream_redirect_blocked",
    "stream_unauthorized",
    "stream_unreachable",
    "stream_timeout",
    "stream_bad_response",
    "stream_response_too_large",
    "stream_bad_request",
    "stream_payload_too_large",
    "stream_unavailable",
    "stream_turn_not_found",
    "stream_no_reply",
    "stream_turn_incomplete",
    "stream_session_error",
    "stream_endpoint_missing",
    "stream_profile_unknown",
    "stream_session_unstored",
  ],
  server: [
    "stream_upstream_unconfigured",
    // 这台 server 背后那条模型腿坏了。与「调它的人令牌不对」（stream_unauthorized）必须分开：
    // 混成一个码，用户看到的是「凭据被拒」，于是去重贴一遍本来没错的 Key。
    // 上游那一步的精确码（upstream_*）由 detail 带，那是数据不是文案。
    "stream_upstream_failed",
    "stream_method_not_allowed",
    "stream_bad_request",
    "stream_payload_too_large",
    "stream_unauthorized",
    "stream_turn_not_found",
    // 与客户端那一格同码：服务器说「这条路我没实现」，正是客户端据此退回 OpenAI 兼容那一档的事实。
    // 两边各造一个词会让同一个 404 在界面上有两种说法。
    "stream_endpoint_missing",
    // 也与客户端那一格同码，但意思反过来：这台 server 现在接不下了（轮次表满、限流、5xx），
    // 过一会儿再试就有。跟「背后那条模型腿坏了」（stream_upstream_failed）分开，是因为界面上
    // 这两句对应两种动作——一个让用户等，一个让用户去查上游配置。
    "stream_unavailable",
  ],
};

const PARAM_RE = /\{([a-z_]+)\}/g;
const SEGMENT_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ABSOLUTE_PATH_RE = /^\/[A-Za-z0-9_./{}-]*$/;

const byName = new Map(ENDPOINTS.map((entry) => [entry.name, entry]));

/** 能不能当路径参数用。导出是因为客户端要先判对方发来的 id 合不合规，
 *  不合规要报成本通道的失败码，而不是等 endpointPath 抛一句只有开发者看得懂的话。 */
export const isSegment = (value) => typeof value === "string" && SEGMENT_RE.test(value);

/** 表里的一条 endpoint。名字打错是写代码的人的错，不是用户的错：抛普通 Error，不进错误码文案那一套。 */
export function endpoint(name) {
  const entry = byName.get(name);
  if (!entry) throw new Error(`规范里没有这条 endpoint：${name}`);
  return entry;
}

/**
 * endpoint → 完整路径。参数只认 [A-Za-z0-9_.:-]：turn_id / session_id 都是对方发的不透明 id，
 * 直接拼进路径就等于让对方决定我们请求的是哪一条路由。
 */
export function endpointPath(name, params = {}) {
  const entry = endpoint(name);
  const path = `${SPEC_PREFIX}${entry.path === "/" ? "" : entry.path}`;
  return path.replace(PARAM_RE, (_match, key) => {
    const value = params[key];
    if (typeof value !== "string" || !SEGMENT_RE.test(value)) {
      throw new Error(`${name} 的路径参数 ${key} 不合规：只接受 1-128 个字母数字与 _ . : -`);
    }
    return encodeURIComponent(value);
  });
}

/** 这一档要用的 endpoint（profile 传 ANY_PROFILE 只拿发现那条）。 */
export function endpointsFor(profile) {
  return ENDPOINTS.filter((entry) => entry.profile === profile || entry.profile === ANY_PROFILE);
}

const escapeLiteral = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** endpoint → 匹配它的正则。路径里除 `{name}` 之外的部分逐字转义：表允许 `.`，
 *  不转义就成了「任意字符」，一条声明会被另一条路径撞上。 */
const MATCHERS = ENDPOINTS.map((entry) => {
  const full = `${SPEC_PREFIX}${entry.path === "/" ? "" : entry.path}`;
  let pattern = "";
  let last = 0;
  for (const match of full.matchAll(PARAM_RE)) {
    pattern += escapeLiteral(full.slice(last, match.index)) + `(?<${match[1]}>[^/]+)`;
    last = match.index + match[0].length;
  }
  return { name: entry.name, entry, re: new RegExp(`^${pattern + escapeLiteral(full.slice(last))}$`) };
});

/**
 * endpointPath 的逆运算：一条请求路径落在表里的哪条 endpoint 上，带路径参数的取值。
 * 住在规范模块里是因为「客户端拼路径」与「服务端认路径」必须是同一张表的两种读法——
 * 各写一份正则，表改了只改一边，另一边在运行时变成一句 404。
 * 参数值先解码再按 isSegment 判：正则只保证不含 `/`，而 endpointPath 发出去的是编码过的，
 * 带 `:` 的 session id 不解回来就永远不合规。
 */
export function matchEndpoint(pathname) {
  const found = MATCHERS.find(({ re }) => re.test(pathname));
  if (!found) return null;
  const groups = found.re.exec(pathname)?.groups ?? {};
  const params = {};
  for (const [key, value] of Object.entries(groups)) {
    let decoded;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return null;
    }
    if (!isSegment(decoded)) return null;
    params[key] = decoded;
  }
  return { name: found.name, entry: found.entry, params };
}

/** 一档的 caps 默认值（tools 那格是规范钉死的，其余按 profile 的默认）。 */
export function defaultCaps(id) {
  const profile = PROFILES.find((entry) => entry.id === id);
  if (!profile) throw new Error(`规范里没有这一档 profile：${id}`);
  return { ...profile.caps };
}

/**
 * 发现响应的正文由表算出来，不是手写一份 JSON：多声明一档没人实现的 profile，
 * 客户端就会照它选路，然后每一轮都失败在调不到路由上。
 * 形状是 { spec, profiles: [{ id, caps }], models?, label? }：caps 按档各一份，
 * 一台服务器同时声明两档时才不会互相打架。
 */
export function specDescriptor({ profiles, models = null, label = null }) {
  if (!profiles.length) throw new Error("发现响应至少要声明一档 profile");
  const seen = new Set();
  const entries = profiles.map((id) => {
    if (!PROFILES.some((profile) => profile.id === id)) throw new Error(`发现响应声明了规范里没有的 profile：${id}`);
    if (seen.has(id)) throw new Error(`发现响应把同一档 profile 声明了两次：${id}`);
    seen.add(id);
    return { id, caps: defaultCaps(id) };
  });
  return {
    spec: SPEC_ID,
    profiles: entries,
    ...(models ? { models } : {}),
    ...(label ? { label } : {}),
  };
}

/**
 * 发现响应不合规的理由码。回码不回句子：这句理由要显示在界面上，而界面有四种语言，
 * 服务端拼好的中文句子贴到英文界面上就是一道没译的文案（AGENTS.md 那条「上屏的句子都归字典」）。
 * detail 是当时读到的值——数据不是文案，原样带上去，界面上按等宽字体摆出来。
 */
export const DISCOVERY_REASONS = [
  "not_json",
  "spec_missing",
  "spec_major_mismatch",
  "no_profiles",
  "unknown_profile",
  "duplicate_profile",
  "unknown_caps",
  "caps_not_boolean",
  "caps_tools_mismatch",
];

/**
 * 客户端侧的发现解析：不合规就整条退回（回 code + detail），不猜、不悄悄改口径。
 * 主版本不同等于对方说的是另一套规范，同样退回——静默按 1.0 解释会在每一轮上以别的形式失败。
 */
export function parseDescriptor(body) {
  const reject = (code, detail = null) => ({ descriptor: null, code, detail });
  if (!body || typeof body !== "object") return reject("not_json");
  const spec = String(body.spec ?? "");
  if (!/^stream-server\/\d+\.\d+\.\d+$/.test(spec)) return reject("spec_missing", spec || null);
  if (Number(spec.split("/")[1].split(".")[0]) !== SPEC_MAJOR) {
    return reject("spec_major_mismatch", spec);
  }
  if (!Array.isArray(body.profiles) || !body.profiles.length) return reject("no_profiles");
  const seen = new Set();
  const profiles = [];
  for (const raw of body.profiles) {
    const id = String(raw?.id ?? "");
    const known = PROFILES.find((profile) => profile.id === id);
    if (!known) return reject("unknown_profile", id || null);
    if (seen.has(id)) return reject("duplicate_profile", id);
    seen.add(id);
    const caps = raw?.caps && typeof raw.caps === "object" ? raw.caps : {};
    const extra = Object.keys(caps).filter((key) => !CAP_KEYS.includes(key));
    if (extra.length) return reject("unknown_caps", `${id}: ${extra.join(",")}`);
    for (const key of CAP_KEYS) {
      if (caps[key] !== undefined && typeof caps[key] !== "boolean") return reject("caps_not_boolean", `${id}.${key}`);
    }
    if (caps.tools !== undefined && caps.tools !== known.caps.tools) {
      return reject("caps_tools_mismatch", `${id}: ${String(caps.tools)}`);
    }
    profiles.push({ id, caps: { ...defaultCaps(id), ...caps, tools: known.caps.tools } });
  }
  return {
    descriptor: {
      spec,
      profiles,
      ...(Array.isArray(body.models) ? { models: body.models.map(String) } : {}),
      ...(typeof body.label === "string" && body.label ? { label: body.label } : {}),
    },
    code: null,
    detail: null,
  };
}

/**
 * 两档都声明时挑哪一档：优先 shared。它能带上我们的群工具，工具回路才是员工干活的手；
 * dedicated 那一档只有对方自己的工具，我们的一个都发不过去。
 */
export function pickProfile(descriptor) {
  const ids = (descriptor?.profiles ?? []).map((entry) => entry.id);
  return ids.includes(SHARED_PROFILE) ? SHARED_PROFILE : ids[0] ?? null;
}

/**
 * 表本身的错冷启动就炸：名字重复会让后一条悄悄盖掉前一条；路径参数没闭合等于把用户输入拼进路由；
 * 错误码不长成 stream_<环节> 的一族，界面上就分不清是哪条通道坏了。
 * 导出是为了让自检能用一份坏表打这一枪——真表崩了会连累整个套件。
 */
export function validateSpec({ profiles = PROFILES, endpoints = ENDPOINTS, events = EVENTS, codes = ERROR_CODES } = {}) {
  const profileIds = new Set(profiles.map((profile) => profile.id));
  if (profileIds.size !== profiles.length) throw new Error("profile id 重复");
  for (const profile of profiles) {
    if (typeof profile.stateless !== "boolean") throw new Error(`profile ${profile.id} 没声明 stateless`);
    if (typeof profile.caps?.tools !== "boolean") throw new Error(`profile ${profile.id} 没声明 caps.tools`);
    const extra = Object.keys(profile.caps).filter((key) => !CAP_KEYS.includes(key));
    if (extra.length) throw new Error(`profile ${profile.id} 声明了规范没定义的 caps：${extra.join("、")}`);
  }
  const names = new Set();
  for (const entry of endpoints) {
    if (names.has(entry.name)) throw new Error(`endpoint 名重复：${entry.name}`);
    names.add(entry.name);
    if (!entry.profile || (entry.profile !== ANY_PROFILE && !profileIds.has(entry.profile))) {
      throw new Error(`endpoint ${entry.name} 挂在规范里没有的 profile：${entry.profile}`);
    }
    if (!["GET", "POST"].includes(entry.method)) throw new Error(`endpoint ${entry.name} 的方法不在白名单：${entry.method}`);
    if (!entry.path.startsWith("/") || !ABSOLUTE_PATH_RE.test(`/${entry.path.slice(1)}`)) {
      throw new Error(`endpoint ${entry.name} 的路径不合规：${entry.path}`);
    }
    const open = (entry.path.match(/\{/g) ?? []).length;
    const close = (entry.path.match(/\}/g) ?? []).length;
    const params = [...entry.path.matchAll(PARAM_RE)].length;
    if (open !== close || open !== params) throw new Error(`endpoint ${entry.name} 的路径参数没闭合：${entry.path}`);
  }
  for (const profile of profiles) {
    if (!endpoints.some((entry) => entry.profile === profile.id && !entry.optional)) {
      throw new Error(`profile ${profile.id} 一条必需 endpoint 都没有`);
    }
  }
  // 没有发现那条，客户端就无从知道对方认哪一档，只能整条退回 OpenAI 兼容——规范也就没有存在的意义。
  if (!endpoints.some((entry) => entry.profile === ANY_PROFILE)) throw new Error("规范里没有发现 endpoint");
  for (const [profile, list] of Object.entries(events)) {
    if (!profileIds.has(profile)) throw new Error(`帧词表挂在规范里没有的 profile：${profile}`);
    if (!list.length) throw new Error(`profile ${profile} 没声明任何帧`);
  }
  for (const [side, list] of Object.entries(codes)) {
    const unique = new Set(list);
    if (unique.size !== list.length) throw new Error(`${side} 侧的错误码有重复`);
    for (const code of list) {
      if (!/^stream_[a-z_]+$/.test(code)) throw new Error(`${side} 侧的错误码不成族：${code}`);
    }
  }
  return true;
}

validateSpec();
