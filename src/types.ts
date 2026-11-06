export type User = {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string;
  avatar?: string | null;
  at_channel: "virtual" | "real_email";
  prefs: { theme?: "light" | "dark" | "system"; notify_real_email?: boolean; dreaming_auto?: boolean; lang?: string };
  delegate: {
    agent_id: string | null;
    start_at: string | null;
    end_at: string | null;
  };
  created_at: string;
};

/** 某个群里替身当下的状态：本群覆盖 + 账号班表 + 服务端按此刻时钟算出的结论。 */
export type DelegateStatus = {
  mode: "inherit" | "on" | "off";
  agent_id: string | null;
  agent_name: string | null;
  active: boolean;
  reason: string | null;
  schedule: { agent_id: string | null; start_at: string | null; end_at: string | null };
};

export type Agent = {
  id: string;
  owner_id: string;
  name: string;
  role: string;
  signature: string | null;
  avatar?: string | null;
  api_base_url: string;
  api_key_tail: string;
  model: string;
  system_prompt: string;
  context_chars: number;
  key_source: "secret" | "database" | string;
  color: string;
  status: "active" | "paused";
  backend?: "openai" | "qca";
  qca_agent_id?: string | null;
  qca_environment_id?: string | null;
  created_at: string;
};

export type Memory = {
  id: string;
  scope?: "common" | "stream";
  stream_id?: string | null;
  kind: "note" | "fact" | "summary";
  content: string;
  covers_through_seq?: number | null;
  source?: string;
  created_at: string;
};

export type Skill = {
  id: string;
  owner_id: string | null;
  name: string;
  summary: string;
  category: string;
  source: "builtin" | "public" | "upload" | "remote" | string;
  version: string | null;
  is_public: boolean;
  is_default: boolean;
  always_on: boolean;
  downloads: number;
  installs: number;
  created_at: string;
  updated_at: string;
  body?: string;
  /** 远端快照的回指：源被删掉后仍能看出这条是从哪个 registry 的哪个 slug 抄来的。 */
  source_registry_id?: string | null;
  source_slug?: string | null;
};

/** 一次安装的结果：加了几个链接、几个员工本来就有。 */
export type InstallOutcome = {
  installed: boolean;
  scope: "agent" | "all_agents" | string;
  agents: { agent_id: string; agent_name?: string; duplicate?: boolean }[];
  added: number;
  already: number;
  always_on?: boolean;
};

/** 主人添加的一个远端技能源：一个可公开访问的 index JSON。 */
export type SkillRegistry = {
  id: string;
  owner_id: string;
  name: string;
  index_url: string;
  skill_count: number;
  last_error: string | null;
  skills_at: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type RegistrySkipped = { slug: string; reason: string };

export type RegistryProbe = {
  items: number;
  skipped: RegistrySkipped[];
  skills_at: string | null;
  error: string | null;
};

/** skills.remoteList 回带的按源汇总：连不上时只有这个源为空，别的源照常出条目。 */
export type RegistrySummary = {
  id: string;
  name: string;
  index_url: string;
  enabled: boolean;
  error: string | null;
  skill_count: number;
  skills_at: string | null;
  skipped: RegistrySkipped[];
};

export type RemoteSkill = {
  slug: string;
  name: string;
  summary: string;
  category: string;
  version: string;
  updated_at: string;
  size: number | null;
  body_url: string;
  registry_id: string;
  registry_name: string;
  installed_skill_id: string | null;
  installed_version: string;
  update_available: boolean;
};

/** skills.checkUpdates 的单行：某个已装远端快照的版本差。 */
export type SkillUpdateRow = {
  skill_id: string;
  name: string;
  registry_name: string;
  current_version: string;
  latest_version: string;
  update_available: boolean;
};

export type SkillUpdateIssue = { skill_id: string; name: string; reason: string };

export type PluginTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** 一个外部 MCP 连接器：tools 是最近一次 tools/list 的缓存，服务端在模型回路里读的就是它。 */
export type Plugin = {
  id: string;
  owner_id: string;
  name: string;
  endpoint: string;
  auth_tail: string;
  tools: PluginTool[];
  tool_count: number;
  tools_at: string | null;
  status: "untested" | "ready" | "error" | string;
  last_error: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type Stream = {
  id: string;
  name: string;
  owner_id: string;
  join_policy: "request" | "invite_only";
  announcement: string;
  announcement_at: string | null;
  context_chars: number;
  next_seq: number;
  mcp_key_set?: boolean;
  my_role?: "owner" | "admin" | "member" | null;
  agent_count?: number;
  created_at: string;
  updated_at?: string;
};

/** 排程行：next_run_at 为空就是暂停，界面上的"下一次"只认服务端算出来的 upcoming。 */
export type Schedule = {
  id: string;
  owner_id: string;
  agent_id: string;
  stream_id: string;
  name: string;
  instruction: string;
  kind: "every" | "daily";
  /** 这条排程到点干什么：留空是普通干活，"dreaming" 是归并全局记忆。建好后不能改。 */
  purpose?: "dreaming" | null;
  interval_minutes: number | null;
  at_time: string | null;
  weekdays: number[] | null;
  tz_offset_minutes: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
  merged_runs: number;
  created_at: string;
  updated_at: string;
  upcoming: string[];
};

/** dreaming.get 的返回：全局记忆那一行 + 开关 + 定时 + 上一次归并那封信。 */
export type DreamState = {
  auto: boolean;
  memory: {
    id: string;
    content: string;
    agent_id: string;
    /** 已归并到的水位线：{"员工 id:群 id": 覆盖到的序号}。同一个群里两个员工各有一份摘要，键要两个 id 才认得出是哪一份。 */
    covers_streams: Record<string, number>;
    updated_at: string;
  } | null;
  /** 归并排程不在这里：那是 cron.list 的账，界面从已经拿到的排程列表里数。 */
  last_run: {
    mail_id: string;
    agent_id: string;
    stream_id: string;
    status: "queued" | "running" | "done" | "failed" | "cancelled";
    error: string | null;
    reason: string | null;
    finished_at: string | null;
  } | null;
};

export type Member = {
  membership_id: string;
  type: "human" | "agent";
  role: "owner" | "admin" | "member";
  id?: string;
  display_name?: string;
  email?: string;
  avatar?: string | null;
  joined_at: string;
  agent?: Agent;
};

export type Delivery = {
  agent_id: string;
  agent_name: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

export type Attachment = {
  file_id: string;
  name: string;
  content_type: string;
  size_bytes: number;
};

/** 虚拟员工这一轮交出的群文件（交付卡片）：原件仍在群文件里，这里只是挂在回复下面的引用。 */
export type Presented = {
  file_id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  note?: string;
};

export type Message = {
  id: string;
  stream_id: string;
  seq: number;
  sender_type: "human" | "agent" | "system";
  sender_id: string;
  sender_name: string;
  content: string;
  mentions: { type: "human" | "agent"; id: string }[];
  attachments?: Attachment[];
  deliveries?: Delivery[];
  /** 这一轮交出的群文件；卡片只给客户端看，不进模型上下文。 */
  presented?: Presented[];
  kind: "chat" | "system";
  /** 替身代答时是被谁的名下任务触发的：署名仍是员工，界面要标出这是替谁说话。 */
  on_behalf_of?: string | null;
  error: string | null;
  created_at: string;
};

export type PresenceCurrent = {
  mail_id: string;
  message_id: string | null;
  seq: number;
  preview: string;
  started_at: string | null;
};

export type AgentPresence = {
  agent_id: string;
  name: string;
  signature: string;
  avatar?: string | null;
  color: string;
  status: "active" | "paused";
  owned_by_caller?: boolean;
  working: boolean;
  running: number;
  queued: number;
  current: PresenceCurrent | null;
};

/** 轨迹一步的原文。轻列没有这个字段，点开某一步时由 agents.trajectory 带回。 */
export type RunStepDetail = {
  model?: string;
  reasoning?: string;
  content?: string;
  context?: string;
  tool_names?: string;
  note?: string;
  args?: string;
  result?: string;
  reasoning_clipped?: number;
  content_clipped?: number;
  args_clipped?: number;
  result_clipped?: number;
  [key: string]: string | number | undefined;
};

export type RunStep = {
  id: string;
  mail_id: string;
  seq: number;
  kind: "model" | "tool";
  status: "running" | "done" | "failed" | "cancelled";
  name: string | null;
  call_id: string | null;
  chars: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  first_token_ms: number | null;
  duration_ms: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  detail?: RunStepDetail;
};

export type AgentProfileMail = {
  id: string;
  stream_id: string;
  stream_name: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  priority: number;
  trigger_seq: number;
  seq: number;
  preview: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  slice_count: number;
  /** 时间线用的轻列（不含 detail），按 seq 升序。 */
  steps: RunStep[];
};

export type AgentPresenceDetail = {
  ok: true;
  is_owner: boolean;
  profile: {
    id: string;
    owner_id: string;
    name: string;
    role: string;
    signature: string | null;
    avatar?: string | null;
    color: string;
    status: "active" | "paused";
    created_at: string;
  };
  owner: { id: string; display_name: string };
  streams: { stream_id: string; name: string; role: string; weight: number; queued: number; running: number }[];
  current: PresenceCurrent | null;
  queue: AgentProfileMail[];
};

export type TrajectoryResponse = {
  ok: true;
  mail: {
    id: string;
    agent: { id: string; name: string; role: string } | null;
    stream: { id: string; name: string };
    status: "queued" | "running" | "done" | "failed" | "cancelled";
    error: string | null;
    trigger_seq: number;
    slice_count: number;
    started_at: string | null;
    finished_at: string | null;
    trigger_preview: string;
  };
  steps: RunStep[];
  schemas: { name: string; parameters: Record<string, unknown> }[];
};

export type GroupFile = {
  id: string;
  stream_id: string;
  name: string;
  size_bytes: number;
  content_type: string;
  store: "db" | "storage";
  created_at: string;
  uploaded_name?: string;
};

export type Probe = {
  reachable: boolean;
  checked_at: string;
  note: string;
  http_status?: number;
  // 网关探活三态：布尔是真/假，null 是「服务端不出网探它」——内网网关要在浏览器里连。
  gateway?: { reachable: boolean | null; note: string; http_status?: number };
};

export type Vm = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth_kind: "password" | "key";
  workdir: string;
  gateway_url?: string;
  key_source?: string;
  last_probe: Probe | null;
  granted_to?: { stream_id: string; level: string }[];
};

export type StreamVm = {
  grant_id: string;
  level: "member" | "sudo";
  id: string;
  label: string;
  host?: string;
  port?: number;
  username?: string;
  workdir?: string;
  gateway_url?: string;
  last_probe?: Probe | null;
};

export type MailItem = {
  id: string;
  agent_id?: string;
  stream_id: string;
  stream_name?: string;
  message_id?: string | null;
  trigger_seq?: number;
  seq?: number;
  preview?: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  priority: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  slice_count: number;
};

export type InboxItem = {
  id: string;
  kind: "verify" | "mention" | "invite";
  subject: string;
  body: string;
  link: string | null;
  channel: "virtual" | "real_email";
  status: string;
  created_at: string;
  read_at: string | null;
};

export type Board = {
  agent: Agent;
  streams: {
    stream_id: string;
    name: string;
    weight: number;
    share: number;
    queued: number;
    running: number;
    done: number;
    failed: number;
    slices: number;
    last_error: string | null;
  }[];
};

export type Request = {
  id: string;
  kind: "human" | "invite" | "agent";
  stream_id?: string;
  applicant_email: string | null;
  applicant_name?: string | null;
  applicant_user_id: string | null;
  agent_id?: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  handled_at?: string | null;
};

export type StreamDetail = {
  ok: true;
  stream: Stream;
  my_role: "owner" | "admin" | "member";
  my_delegate: DelegateStatus;
  members: Member[];
  files: GroupFile[];
  vms: StreamVm[];
  requests: Request[];
};
