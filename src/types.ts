export type User = {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string;
  avatar?: string | null;
  at_channel: "virtual" | "real_email";
  prefs: { theme?: "light" | "dark" | "system"; notify_real_email?: boolean };
  created_at: string;
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
  source: "builtin" | "public" | "upload" | string;
  is_public: boolean;
  is_default: boolean;
  always_on: boolean;
  downloads: number;
  installs: number;
  created_at: string;
  updated_at: string;
  body?: string;
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
  kind: "chat" | "system";
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

export type Probe = { reachable: boolean; checked_at: string; note: string; http_status?: number };

export type Vm = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth_kind: "password" | "key";
  workdir: string;
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
  members: Member[];
  files: GroupFile[];
  vms: StreamVm[];
  requests: Request[];
};
