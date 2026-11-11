// 浏览器到同源 app Function 的唯一入口：不拼物理函数名，不带任何平台凭据。
import type { I18n, MsgKey } from "./lib/i18n";

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

/** 服务端错误码到字典键：文案在 src/locales/*.json，切了语言就得跟着切。 */
const ERROR_KEYS: Record<string, MsgKey> = {
  login_required: "errors.login_required",
  bad_credentials: "errors.bad_credentials",
  email_taken: "errors.email_taken",
  email_not_verified: "errors.email_not_verified",
  not_stream_member: "errors.not_stream_member",
  permission_denied: "errors.permission_denied",
  owner_only: "errors.owner_only",
  leader_only: "errors.leader_only",
  agent_not_owned: "errors.agent_not_owned",
  agent_not_found: "errors.agent_not_found",
  agent_profile_forbidden: "errors.agent_profile_forbidden",
  stream_not_found: "errors.stream_not_found",
  invite_only: "errors.invite_only",
  invite_not_found: "errors.invite_not_found",
  owner_must_transfer: "errors.owner_must_transfer",
  owner_immovable: "errors.owner_immovable",
  admin_scope: "errors.admin_scope",
  member_missing: "errors.member_missing",
  member_removed: "errors.member_removed",
  invalid_api_base_url: "errors.invalid_api_base_url",
  insecure_api_base_url: "errors.insecure_api_base_url",
  private_api_base_url: "errors.private_api_base_url",
  demo_needs_demo_model: "errors.demo_needs_demo_model",
  data_key_misconfigured: "errors.data_key_misconfigured",
  secret_unreadable: "errors.secret_unreadable",
  standin_create_failed: "errors.standin_create_failed",
  invalid_start_at: "errors.invalid_start_at",
  invalid_end_at: "errors.invalid_end_at",
  body_too_large: "errors.body_too_large",
  file_too_large: "errors.file_too_large",
  invalid_file_name: "errors.invalid_file_name",
  invalid_file_path: "errors.invalid_file_path",
  invalid_file_url: "errors.invalid_file_url",
  invalid_size_bytes: "errors.invalid_size_bytes",
  invalid_url: "errors.invalid_url",
  seq_contention: "errors.seq_contention",
  upstream_unauthorized: "errors.upstream_unauthorized",
  upstream_not_found: "errors.upstream_not_found",
  upstream_rate_limited: "errors.upstream_rate_limited",
  upstream_server_error: "errors.upstream_server_error",
  upstream_bad_request: "errors.upstream_bad_request",
  upstream_timeout: "errors.upstream_timeout",
  upstream_unreachable: "errors.upstream_unreachable",
  upstream_stream_incomplete: "errors.upstream_stream_incomplete",
  hop_limit: "errors.hop_limit",
  slice_interrupted: "errors.slice_interrupted",
  skill_not_found: "errors.skill_not_found",
  skill_forbidden: "errors.skill_forbidden",
  skill_not_installed: "errors.skill_not_installed",
  builtin_skill_locked: "errors.builtin_skill_locked",
  invalid_skill_flags: "errors.invalid_skill_flags",
  invalid_skill_name: "errors.invalid_skill_name",
  invalid_skill_summary: "errors.invalid_skill_summary",
  invalid_skill_body: "errors.invalid_skill_body",
  invalid_skill_category: "errors.invalid_skill_category",
  invalid_skill_version: "errors.invalid_skill_version",
  skill_upload_failed: "errors.skill_upload_failed",
  skill_install_failed: "errors.skill_install_failed",
  skill_update_failed: "errors.skill_update_failed",
  skill_not_owned: "errors.skill_not_owned",
  skill_not_remote: "errors.skill_not_remote",
  no_agents_to_install: "errors.no_agents_to_install",
  registry_not_found: "errors.registry_not_found",
  registry_not_owned: "errors.registry_not_owned",
  registry_exists: "errors.registry_exists",
  too_many_registries: "errors.too_many_registries",
  invalid_registry_name: "errors.invalid_registry_name",
  invalid_registry_id: "errors.invalid_registry_id",
  invalid_index_url: "errors.invalid_index_url",
  invalid_body_url: "errors.invalid_body_url",
  registry_upload_failed: "errors.registry_upload_failed",
  registry_update_failed: "errors.registry_update_failed",
  registry_remove_failed: "errors.registry_remove_failed",
  registry_unreachable: "errors.registry_unreachable",
  registry_timeout: "errors.registry_timeout",
  registry_unauthorized: "errors.registry_unauthorized",
  registry_rejected: "errors.registry_rejected",
  registry_redirect_blocked: "errors.registry_redirect_blocked",
  registry_bad_response: "errors.registry_bad_response",
  registry_schema_unsupported: "errors.registry_schema_unsupported",
  registry_too_large: "errors.registry_too_large",
  registry_body_unreachable: "errors.registry_body_unreachable",
  registry_body_timeout: "errors.registry_body_timeout",
  registry_body_unauthorized: "errors.registry_body_unauthorized",
  registry_body_rejected: "errors.registry_body_rejected",
  registry_body_redirect_blocked: "errors.registry_body_redirect_blocked",
  registry_body_too_large: "errors.registry_body_too_large",
  registry_body_binary: "errors.registry_body_binary",
  registry_body_empty: "errors.registry_body_empty",
  skill_not_in_registry: "errors.skill_not_in_registry",
  skill_skipped_invalid_slug: "errors.skill_skipped_invalid_slug",
  skill_skipped_invalid_name: "errors.skill_skipped_invalid_name",
  skill_skipped_duplicate_slug: "errors.skill_skipped_duplicate_slug",
  skill_skipped_invalid_body_url: "errors.skill_skipped_invalid_body_url",
  skill_skipped_over_limit: "errors.skill_skipped_over_limit",
  invalid_slug: "errors.invalid_slug",
  plugin_not_found: "errors.plugin_not_found",
  plugin_not_owned: "errors.plugin_not_owned",
  plugin_unreachable: "errors.plugin_unreachable",
  plugin_timeout: "errors.plugin_timeout",
  plugin_unauthorized: "errors.plugin_unauthorized",
  plugin_rejected: "errors.plugin_rejected",
  plugin_bad_response: "errors.plugin_bad_response",
  plugin_too_large: "errors.plugin_too_large",
  plugin_tool_failed: "errors.plugin_tool_failed",
  plugin_upload_failed: "errors.plugin_upload_failed",
  plugin_update_failed: "errors.plugin_update_failed",
  plugin_remove_failed: "errors.plugin_remove_failed",
  too_many_plugins: "errors.too_many_plugins",
  invalid_plugin_name: "errors.invalid_plugin_name",
  invalid_plugin_token: "errors.invalid_plugin_token",
  too_many_images: "errors.too_many_images",
  unsupported_image_type: "errors.unsupported_image_type",
  invalid_image_data: "errors.invalid_image_data",
  image_write_failed: "errors.image_write_failed",
  attachment_not_image: "errors.attachment_not_image",
  nothing_running: "errors.nothing_running",
  interrupt_message_invalid: "errors.interrupt_message_invalid",
  agent_not_in_stream: "errors.agent_not_in_stream",
  schedule_not_found: "errors.schedule_not_found",
  schedule_not_owned: "errors.schedule_not_owned",
  schedule_target_locked: "errors.schedule_target_locked",
  too_many_schedules: "errors.too_many_schedules",
  schedule_changed: "errors.schedule_changed",
  schedule_write_failed: "errors.schedule_write_failed",
  schedule_delete_failed: "errors.schedule_delete_failed",
  schedules_request_failed: "errors.schedules_request_failed",
  daily_schedule_unreachable: "errors.daily_schedule_unreachable",
  invalid_kind: "errors.invalid_kind",
  invalid_interval_minutes: "errors.invalid_interval_minutes",
  invalid_at_time: "errors.invalid_at_time",
  invalid_tz_offset_minutes: "errors.invalid_tz_offset_minutes",
  invalid_weekdays: "errors.invalid_weekdays",
  invalid_purpose: "errors.invalid_purpose",
  dream_failed: "errors.dream_failed",
  dream_empty: "errors.dream_empty",
  dream_write_failed: "errors.dream_write_failed",
  server_error: "errors.server_error",
  account_missing: "errors.account_missing",
  agent_create_failed: "errors.agent_create_failed",
  agent_delete_failed: "errors.agent_delete_failed",
  agent_deleted: "errors.agent_deleted",
  agent_key_missing: "errors.agent_key_missing",
  agent_key_required_for_backend: "errors.agent_key_required_for_backend",
  agent_missing: "errors.agent_missing",
  agent_not_promotable: "errors.agent_not_promotable",
  agent_update_failed: "errors.agent_update_failed",
  already_verified: "errors.already_verified",
  binary_file_needs_download: "errors.binary_file_needs_download",
  connector_needs_agent_run: "errors.connector_needs_agent_run",
  connector_tool_unmatched: "errors.connector_tool_unmatched",
  database_runtime_unavailable: "errors.database_runtime_unavailable",
  delegate_write_failed: "errors.delegate_write_failed",
  empty_body: "errors.empty_body",
  empty_reply: "errors.empty_reply",
  file_delete_failed: "errors.file_delete_failed",
  file_not_found: "errors.file_not_found",
  file_path_exists: "errors.file_path_exists",
  file_selector_required: "errors.file_selector_required",
  file_write_failed: "errors.file_write_failed",
  grant_failed: "errors.grant_failed",
  grant_not_found: "errors.grant_not_found",
  gateway_url_no_credentials: "errors.gateway_url_no_credentials",
  history_request_failed: "errors.history_request_failed",
  history_unavailable: "errors.history_unavailable",
  internal_only: "errors.internal_only",
  interrupted: "errors.interrupted",
  invalid_before_seq: "errors.invalid_before_seq",
  invalid_body: "errors.invalid_body",
  invalid_content: "errors.invalid_content",
  invalid_content_type: "errors.invalid_content_type",
  invalid_host: "errors.invalid_host",
  invalid_json: "errors.invalid_json",
  invalid_port: "errors.invalid_port",
  invalid_table: "errors.invalid_table",
  invalid_weight: "errors.invalid_weight",
  invalid_window: "errors.invalid_window",
  invite_failed: "errors.invite_failed",
  link_expired: "errors.link_expired",
  link_invalid: "errors.link_invalid",
  link_used: "errors.link_used",
  mail_not_found: "errors.mail_not_found",
  mcp_key_invalid: "errors.mcp_key_invalid",
  mcp_key_required: "errors.mcp_key_required",
  member_write_failed: "errors.member_write_failed",
  memory_missing: "errors.memory_missing",
  memory_write_failed: "errors.memory_write_failed",
  mention_agent_missing: "errors.mention_agent_missing",
  mention_human_missing: "errors.mention_human_missing",
  mention_not_in_stream: "errors.mention_not_in_stream",
  message_missing: "errors.message_missing",
  message_write_failed: "errors.message_write_failed",
  messages_request_failed: "errors.messages_request_failed",
  method_not_allowed: "errors.method_not_allowed",
  missing_action: "errors.missing_action",
  outbox_write_failed: "errors.outbox_write_failed",
  owner_missing: "errors.owner_missing",
  profile_write_failed: "errors.profile_write_failed",
  qca_agent_id_invalid: "errors.qca_agent_id_invalid",
  qca_needs_real_origin: "errors.qca_needs_real_origin",
  registration_failed: "errors.registration_failed",
  remove_all_overflow: "errors.remove_all_overflow",
  request_failed: "errors.request_failed",
  request_handled: "errors.request_handled",
  request_not_found: "errors.request_not_found",
  runtime_state_corrupt: "errors.runtime_state_corrupt",
  runtime_state_unavailable: "errors.runtime_state_unavailable",
  schedule_deleted: "errors.schedule_deleted",
  server_needs_stream_backend: "errors.server_needs_stream_backend",
  server_not_found: "errors.server_not_found",
  server_unreachable: "errors.server_unreachable",
  server_write_failed: "errors.server_write_failed",
  servers_request_failed: "errors.servers_request_failed",
  session_failed: "errors.session_failed",
  signature_update_failed: "errors.signature_update_failed",
  skill_body_too_large: "errors.skill_body_too_large",
  step_write_failed: "errors.step_write_failed",
  // 规范对接那一族（functions/streamspec.mjs 的 ERROR_CODES）：客户端出网失败与执行 server 自己回的错
  // 都长成 stream_<环节>，加上建档时那句 stream_needs_real_origin。码在客户端是抛出来的、在服务端是
  // 写进错误正文的，两边都可能落到界面上，所以一族一起配齐。
  stream_bad_request: "errors.stream_bad_request",
  stream_bad_response: "errors.stream_bad_response",
  stream_closed: "errors.stream_closed",
  stream_create_failed: "errors.stream_create_failed",
  stream_delete_failed: "errors.stream_delete_failed",
  stream_endpoint_missing: "errors.stream_endpoint_missing",
  stream_method_not_allowed: "errors.stream_method_not_allowed",
  stream_missing: "errors.stream_missing",
  stream_needs_real_origin: "errors.stream_needs_real_origin",
  stream_no_reply: "errors.stream_no_reply",
  stream_origin_invalid: "errors.stream_origin_invalid",
  stream_payload_too_large: "errors.stream_payload_too_large",
  stream_profile_unknown: "errors.stream_profile_unknown",
  stream_redirect_blocked: "errors.stream_redirect_blocked",
  stream_response_too_large: "errors.stream_response_too_large",
  stream_session_error: "errors.stream_session_error",
  stream_session_unstored: "errors.stream_session_unstored",
  stream_timeout: "errors.stream_timeout",
  stream_turn_incomplete: "errors.stream_turn_incomplete",
  stream_turn_not_found: "errors.stream_turn_not_found",
  stream_unauthorized: "errors.stream_unauthorized",
  stream_unavailable: "errors.stream_unavailable",
  stream_unreachable: "errors.stream_unreachable",
  stream_upstream_failed: "errors.stream_upstream_failed",
  stream_upstream_unconfigured: "errors.stream_upstream_unconfigured",
  stream_write_failed: "errors.stream_write_failed",
  trajectory_forbidden: "errors.trajectory_forbidden",
  unfiltered_query: "errors.unfiltered_query",
  unfiltered_write: "errors.unfiltered_write",
  unknown_action: "errors.unknown_action",
  verify_token_failed: "errors.verify_token_failed",
  vm_create_failed: "errors.vm_create_failed",
  vm_delete_failed: "errors.vm_delete_failed",
  vm_not_found: "errors.vm_not_found",
  vm_not_owned: "errors.vm_not_owned",
  vm_update_failed: "errors.vm_update_failed",
  window_inverted: "errors.window_inverted",
  window_needs_bounds: "errors.window_needs_bounds",
  window_too_far_ahead: "errors.window_too_far_ahead",
  // 六个校验器（text/uuid/int/oneOf/avatarData/email）按字段名拼出来的 invalid_<字段>：
  // 码不在服务端任何一处字面写着，所以 dev/check-schema.mjs 那道对账要单独从调用点的 name: 反推。
  invalid_action: "errors.invalid_action",
  invalid_api_key: "errors.invalid_api_key",
  invalid_avatar: "errors.invalid_avatar",
  invalid_compact_at: "errors.invalid_compact_at",
  invalid_context_chars: "errors.invalid_context_chars",
  invalid_current_password: "errors.invalid_current_password",
  invalid_display_name: "errors.invalid_display_name",
  invalid_gateway_url: "errors.invalid_gateway_url",
  invalid_id: "errors.invalid_id",
  invalid_instruction: "errors.invalid_instruction",
  invalid_label: "errors.invalid_label",
  invalid_mcp_key: "errors.invalid_mcp_key",
  invalid_model: "errors.invalid_model",
  invalid_name: "errors.invalid_name",
  invalid_new_password: "errors.invalid_new_password",
  invalid_note: "errors.invalid_note",
  invalid_password: "errors.invalid_password",
  invalid_q: "errors.invalid_q",
  invalid_query: "errors.invalid_query",
  invalid_role: "errors.invalid_role",
  invalid_secret: "errors.invalid_secret",
  invalid_signature: "errors.invalid_signature",
  invalid_token: "errors.invalid_token",
  invalid_username: "errors.invalid_username",
  // functions/store.mjs 按表名拼出来的 <表>_request_failed：读写失败回同一个码，
  // 表名不在任何一处字面写着，所以 dev/check-schema.mjs 那道对账要按建表清单展开。
  agent_skills_request_failed: "errors.agent_skills_request_failed",
  agents_request_failed: "errors.agents_request_failed",
  files_request_failed: "errors.files_request_failed",
  mail_request_failed: "errors.mail_request_failed",
  members_request_failed: "errors.members_request_failed",
  memories_request_failed: "errors.memories_request_failed",
  outbox_request_failed: "errors.outbox_request_failed",
  plugins_request_failed: "errors.plugins_request_failed",
  qca_sessions_request_failed: "errors.qca_sessions_request_failed",
  requests_request_failed: "errors.requests_request_failed",
  run_steps_request_failed: "errors.run_steps_request_failed",
  runtime_state_request_failed: "errors.runtime_state_request_failed",
  sessions_request_failed: "errors.sessions_request_failed",
  skill_registries_request_failed: "errors.skill_registries_request_failed",
  skills_request_failed: "errors.skills_request_failed",
  slice_prefs_request_failed: "errors.slice_prefs_request_failed",
  stream_sessions_request_failed: "errors.stream_sessions_request_failed",
  stream_vms_request_failed: "errors.stream_vms_request_failed",
  streams_request_failed: "errors.streams_request_failed",
  tokens_request_failed: "errors.tokens_request_failed",
  users_request_failed: "errors.users_request_failed",
  vms_request_failed: "errors.vms_request_failed",
  workers_request_failed: "errors.workers_request_failed",
};

export function describeError(i18n: I18n, error: unknown): string {
  if (error instanceof ApiError) return describeCode(i18n, error.code);
  if (error instanceof TypeError) return i18n.t("errors.network");
  return String((error as Error)?.message ?? error);
}

/** 服务端落库的错误码（不是异常对象）也要能翻成人话，比如插件的 last_error。 */
export function describeCode(i18n: I18n, code: string): string {
  const key = ERROR_KEYS[code];
  return key ? i18n.t(key) : i18n.tf("errors.withCode", { code });
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
