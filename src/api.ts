// 浏览器到同源 app Function 的唯一入口：不拼物理函数名，不带任何平台凭据。
export const TOKEN_KEY = "workstream.token";
export const THEME_KEY = "workstream.theme";

export type Action = string;

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const MESSAGES: Record<string, string> = {
  login_required: "会话已过期，请重新登录。",
  bad_credentials: "邮箱或口令不对。",
  email_taken: "这个邮箱已经注册过了。",
  email_not_verified: "邮箱还没验证，暂时不能切到真实邮箱通道。",
  not_stream_member: "你不在这个群里。",
  permission_denied: "群里没有给你这个权限。",
  owner_only: "只有群主可以做这件事。",
  leader_only: "时间片优先级由群主或管理员确认。",
  agent_not_owned: "只有虚拟员工的主人能改它。",
  agent_not_found: "找不到这个虚拟员工。",
  agent_profile_forbidden: "你和这位虚拟员工不在同一个群里。",
  stream_not_found: "没有这个 UUID 对应的群。",
  invite_only: "这个群只接受邀请。",
  invite_not_found: "邀请不存在或不属于这个邮箱。",
  owner_must_transfer: "群主要先把群移交给别人才能退群。",
  owner_immovable: "不能对群主做这个操作。",
  admin_scope: "管理员不能移走管理员或虚拟员工，需要群主来。",
  member_missing: "找不到这个成员。",
  member_removed: "该成员已被移出群。",
  invalid_api_base_url: "API 地址格式不对，填 OpenAI 兼容端点的 base URL。",
  insecure_api_base_url: "线上只接受 https 的 API 地址。",
  private_api_base_url: "出于安全，不能指向内网或元数据地址。",
  demo_needs_demo_model: "演示端点的模型名要填 demo。",
  data_key_misconfigured: "WORKSTREAM_DATA_KEY 需要 64 位十六进制。",
  secret_unreadable: "加密凭据读不出来：主密钥可能已经更换。",
  body_too_large: "内容太大了，换个方式提交。",
  file_too_large: "群文件超过 400KB 文本上限。",
  invalid_file_name: "文件名不能带路径。",
  seq_contention: "群里消息太密集，这条没排上，请重发。",
  upstream_unauthorized: "上游拒绝了这把 Key。",
  upstream_not_found: "上游找不到这个模型或端点。",
  upstream_rate_limited: "上游限流，这一轮没跑成，要重新 @ 才会再试。",
  upstream_server_error: "上游自己出了错（5xx），这一轮没跑成。",
  upstream_bad_request: "上游没接受这次请求，检查模型名与参数。",
  upstream_timeout: "上游响应超时。",
  upstream_unreachable: "连不上上游。",
  upstream_stream_incomplete: "上游说到一半断了，这半截正文没有当成回复发出去。",
  hop_limit: "虚拟员工之间互相 @ 的层数到了上限，需要人来接。",
  slice_interrupted: "上一次执行中断，任务已回收为失败。",
  skill_not_found: "找不到这个技能。",
  skill_forbidden: "这个技能没有公开，只有作者能打开。",
  skill_not_installed: "这个员工没有安装该技能。",
  builtin_skill_locked: "内置平台技能始终启用，不能卸载。",
  invalid_skill_flags: "只有公开技能才能设为新员工默认技能。",
  invalid_skill_name: "技能名不能为空，最多 60 字。",
  invalid_skill_summary: "技能摘要不能为空，最多 300 字。",
  invalid_skill_body: "技能正文不能为空，最多 20000 字。",
  invalid_skill_category: "技能分类最多 20 字。",
  invalid_skill_version: "版本号最多 24 字。",
  skill_upload_failed: "技能保存失败，请重试。",
  skill_install_failed: "技能安装失败，请重试。",
  skill_update_failed: "技能没更新，请重试。",
  skill_not_owned: "只有技能的作者能改这一条。",
  skill_not_remote: "这个技能不是从远端技能源装的，没有可更新的版本。",
  no_agents_to_install: "你还没有虚拟员工，先去「虚拟员工」页建一个。",
  registry_not_found: "找不到这个技能源，可能已经被删掉了。",
  registry_not_owned: "只有添加这个技能源的人能改它。",
  registry_exists: "这个技能源已经添加过了。",
  too_many_registries: "每人最多添加 8 个技能源，先删掉不用的。",
  invalid_registry_name: "技能源名称不能为空，最多 40 字。",
  invalid_registry_id: "技能源 id 不对。",
  invalid_index_url: "技能源地址不对：要填完整的 https index JSON 地址。",
  invalid_body_url: "源里这条技能的正文地址不合法，已跳过。",
  registry_upload_failed: "技能源没存下来，请重试。",
  registry_update_failed: "技能源改动没保存，请重试。",
  registry_remove_failed: "技能源没删掉，请重试。",
  registry_unreachable: "连不上这个技能源，检查地址是否还能公开访问。",
  registry_timeout: "技能源响应超时。",
  registry_unauthorized: "技能源要求鉴权，公开清单不能有访问限制。",
  registry_rejected: "技能源返回了错误。",
  registry_redirect_blocked: "技能源地址发生了重定向，出于安全不跟随。",
  registry_bad_response: "技能源的 index 不是合法 JSON。",
  registry_schema_unsupported: "技能源的 index 格式版本不认识，只支持 schema 1。",
  registry_too_large: "技能源的 index 超过 256KB。",
  registry_body_unreachable: "连不上技能正文地址。",
  registry_body_timeout: "技能正文响应超时。",
  registry_body_unauthorized: "技能正文地址要求鉴权，装不了。",
  registry_body_rejected: "技能正文地址返回了错误。",
  registry_body_redirect_blocked: "技能正文地址发生重定向，出于安全不跟随。",
  registry_body_too_large: "技能正文超过 200KB 上限。",
  registry_body_binary: "技能正文是二进制文件，只能收文本。",
  registry_body_empty: "技能正文是空的，没法装。",
  skill_not_in_registry: "源上已经没有这个技能了。",
  skill_skipped_invalid_slug: "源上这条技能的 slug 不合法，被跳过了。",
  skill_skipped_invalid_name: "源上这条技能的名字不合法，被跳过了。",
  skill_skipped_duplicate_slug: "源上这条技能的 slug 重复，被跳过了。",
  skill_skipped_invalid_body_url: "源上这条技能的正文地址不合法，被跳过了。",
  skill_skipped_over_limit: "源上技能数超过 200 上限，这条被跳过了。",
  invalid_slug: "技能 slug 不合法，最长 64 字符（小写字母、数字、点、下划线、连字符）。",
  plugin_not_found: "找不到这个插件。",
  plugin_not_owned: "只有添加这个连接器的人能改它。",
  plugin_unreachable: "连不上这个 MCP 服务，检查一下地址和服务是否在跑。",
  plugin_timeout: "MCP 服务响应超时。",
  plugin_unauthorized: "MCP 服务拒绝了这把令牌。",
  plugin_rejected: "MCP 服务返回了错误。",
  plugin_bad_response: "MCP 服务的回包不是合法的 JSON-RPC。",
  plugin_too_large: "MCP 服务的回包太大了。",
  plugin_tool_failed: "插件里的工具执行失败。",
  plugin_upload_failed: "插件保存失败，请重试。",
  plugin_update_failed: "插件改动没保存，请重试。",
  plugin_remove_failed: "插件没删掉，请重试。",
  too_many_plugins: "每人最多接 12 个插件，先删掉不用的。",
  invalid_plugin_name: "插件名不能为空，最多 40 字。",
  invalid_plugin_token: "令牌格式不对，最多 400 字。",
  too_many_images: "一条消息最多带 4 张图。",
  unsupported_image_type: "图片只支持 PNG / JPEG / WebP / GIF。",
  invalid_image_data: "这张图太大或格式不对，换一张试试。",
  image_write_failed: "图片没存下来，请重发。",
  attachment_not_image: "这个附件不是可显示的图片。",
  nothing_running: "这位虚拟员工此刻没在处理任务，不用叫停。",
  interrupt_message_invalid: "要插话的那条消息不属于你，或不在本群。",
  agent_not_in_stream: "这个虚拟员工不在那个群里，先把它拉进群。",
  schedule_not_found: "找不到这条排程，可能已经被删掉了。",
  schedule_not_owned: "只有这条排程的主人能改它。",
  schedule_target_locked: "排程不能换干活的员工和群，删掉这条重新排。",
  too_many_schedules: "每人最多 20 条排程，先删掉不用的。",
  schedule_changed: "这条排程刚被别处改过，刷新后再试。",
  schedule_write_failed: "排程没存下来，请重试。",
  schedule_delete_failed: "排程没删掉，请重试。",
  schedules_request_failed: "排程读不出来，服务端这会儿连不上数据库。",
  daily_schedule_unreachable: "这个「每天」排程算不出下一个对点，检查时刻和周几。",
  invalid_kind: "排程类型只支持 every（每隔多久）或 daily（每天几点）。",
  invalid_interval_minutes: "间隔分钟数要在 1 到 10080（7 天）之间。",
  invalid_at_time: "时刻格式不对，填 HH:MM，比如 09:30。",
  invalid_tz_offset_minutes: "时区偏移要在 UTC-12 到 UTC+14 之间。",
  invalid_weekdays: "周几只能是 1 到 7（周一到周日）。",
  server_error: "服务端出了点问题，请稍后重试。",
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return MESSAGES[error.code] ?? `出错了：${error.code}`;
  if (error instanceof TypeError) return "连不上站点服务，检查一下网络或稍后重试。";
  return String((error as Error)?.message ?? error);
}

/** 服务端落库的错误码（不是异常对象）也要能翻成人话，比如插件的 last_error。 */
export const describeCode = (code: string): string => MESSAGES[code] ?? `出错了：${code}`;

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 浏览器禁用存储时保持内存会话 */
  }
}

type Options = { body?: unknown; method?: "GET" | "POST"; query?: Record<string, string | number | undefined> };

export async function api<T>(action: Action, options: Options = {}): Promise<T> {
  const params = new URLSearchParams({ action });
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const token = getToken();
  const response = await fetch(`/functions/v1/app?${params.toString()}`, {
    method,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      // 站点 Function 的适配层会剥掉前端的 authorization / cookie，
      // 会话令牌走自定义头才能到达业务 handler。
      ...(token ? { "x-workstream-token": token } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    const code = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    if (code === "login_required") {
      setToken("");
      window.dispatchEvent(new CustomEvent("workstream:signed-out"));
    }
    throw new ApiError(code, response.status, code);
  }
  return payload as T;
}

export const get = <T>(action: Action, query: Record<string, string | number | undefined> = {}) =>
  api<T>(action, { method: "GET", query });

export const post = <T>(action: Action, body: unknown) => api<T>(action, { method: "POST", body });

// 视图层只要记住一个入口，类型也顺手从这儿导出。
export type {
  Agent,
  AgentPresence,
  AgentPresenceDetail,
  AgentProfileMail,
  Board,
  Delivery,
  GroupFile,
  InboxItem,
  InstallOutcome,
  MailItem,
  Member,
  Memory,
  Message,
  PresenceCurrent,
  RegistryProbe,
  RegistrySkipped,
  RegistrySummary,
  RemoteSkill,
  Request,
  RunStep,
  Schedule,
  Skill,
  SkillRegistry,
  SkillUpdateIssue,
  SkillUpdateRow,
  Stream,
  StreamDetail,
  StreamVm,
  TrajectoryResponse,
  User,
  Vm,
} from "./types";
