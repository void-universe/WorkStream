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
  upstream_rate_limited: "上游限流，稍后会自动重试。",
  upstream_timeout: "上游响应超时。",
  upstream_unreachable: "连不上上游。",
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
  skill_upload_failed: "技能保存失败，请重试。",
  skill_install_failed: "技能安装失败，请重试。",
  too_many_images: "一条消息最多带 4 张图。",
  unsupported_image_type: "图片只支持 PNG / JPEG / WebP / GIF。",
  invalid_image_data: "这张图太大或格式不对，换一张试试。",
  image_write_failed: "图片没存下来，请重发。",
  attachment_not_image: "这个附件不是可显示的图片。",
  nothing_running: "这位虚拟员工此刻没在处理任务，不用叫停。",
  interrupt_message_invalid: "要插话的那条消息不属于你，或不在本群。",
  server_error: "服务端出了点问题，请稍后重试。",
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return MESSAGES[error.code] ?? `出错了：${error.code}`;
  if (error instanceof TypeError) return "连不上站点服务，检查一下网络或稍后重试。";
  return String((error as Error)?.message ?? error);
}

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
  MailItem,
  Member,
  Memory,
  Message,
  PresenceCurrent,
  Request,
  Skill,
  Stream,
  StreamDetail,
  StreamVm,
  User,
  Vm,
} from "./types";
