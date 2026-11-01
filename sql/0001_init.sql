-- Workstream 初始 schema：16 张 app.* 表。
-- 只使用站点迁移 API 支持的 PostgreSQL 子集：
--   类型 boolean/integer/bigint/text/uuid/timestamptz/jsonb；
--   约束 PRIMARY KEY / UNIQUE / NOT NULL；不写 DEFAULT、CHECK、外键、触发器、自定义函数。
-- 所有 id、时间戳、序号由 Function 侧显式提供（functions/util.mjs 的 newId()/now()），
-- 因此这里不需要 DEFAULT；seed/DML 也不属于迁移。
-- 唯一性由代码依赖：users.email、sessions.token_hash、tokens.token_hash、
--   streams.mcp_key_hash、members(stream_id,principal_type,principal_id)、
--   messages(stream_id,seq)、stream_vms(stream_id,vm_id)、slice_prefs(agent_id,stream_id)。

CREATE TABLE app.users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  password_iterations integer NOT NULL,
  at_channel text NOT NULL,
  prefs jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE app.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  user_agent text,
  updated_at timestamptz
);
CREATE INDEX sessions_user_idx ON app.sessions (user_id);

CREATE TABLE app.tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  kind text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX tokens_user_idx ON app.tokens (user_id);

CREATE TABLE app.outbox (
  id uuid PRIMARY KEY,
  recipient_email text NOT NULL,
  user_id uuid,
  kind text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  link text,
  stream_id uuid,
  channel text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  read_at timestamptz,
  updated_at timestamptz
);
CREATE INDEX outbox_user_idx ON app.outbox (user_id);

CREATE TABLE app.agents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  name text NOT NULL,
  role text NOT NULL,
  api_base_url text NOT NULL,
  api_key_cipher text,
  api_key_tail text NOT NULL,
  model text NOT NULL,
  system_prompt text NOT NULL,
  context_chars integer NOT NULL,
  key_source text NOT NULL,
  color text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX agents_owner_idx ON app.agents (owner_id);

CREATE TABLE app.memories (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  scope text NOT NULL,
  stream_id uuid,
  kind text NOT NULL,
  content text NOT NULL,
  covers_through_seq integer,
  source text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX memories_agent_idx ON app.memories (agent_id, scope);
CREATE INDEX memories_stream_idx ON app.memories (agent_id, stream_id);

CREATE TABLE app.streams (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  owner_id uuid NOT NULL,
  join_policy text NOT NULL,
  announcement text NOT NULL,
  announcement_at timestamptz,
  context_chars integer NOT NULL,
  next_seq bigint NOT NULL,
  mcp_key_hash text UNIQUE,
  mcp_key_set boolean,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX streams_owner_idx ON app.streams (owner_id);

CREATE TABLE app.members (
  id uuid PRIMARY KEY,
  stream_id uuid NOT NULL,
  principal_type text NOT NULL,
  principal_id uuid NOT NULL,
  role text NOT NULL,
  added_by uuid,
  joined_at timestamptz NOT NULL,
  updated_at timestamptz,
  UNIQUE (stream_id, principal_type, principal_id)
);
CREATE INDEX members_stream_idx ON app.members (stream_id);
CREATE INDEX members_principal_idx ON app.members (principal_type, principal_id);

CREATE TABLE app.requests (
  id uuid PRIMARY KEY,
  stream_id uuid NOT NULL,
  kind text NOT NULL,
  applicant_user_id uuid,
  applicant_email text,
  applicant_name text,
  agent_id uuid,
  status text NOT NULL,
  handled_by uuid,
  handled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX requests_stream_idx ON app.requests (stream_id, status);

CREATE TABLE app.messages (
  id uuid PRIMARY KEY,
  stream_id uuid NOT NULL,
  seq bigint NOT NULL,
  sender_type text NOT NULL,
  sender_id uuid NOT NULL,
  sender_name text NOT NULL,
  content text NOT NULL,
  mentions jsonb NOT NULL,
  reply_to uuid,
  kind text NOT NULL,
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz,
  UNIQUE (stream_id, seq)
);
CREATE INDEX messages_stream_seq_idx ON app.messages (stream_id, seq);

CREATE TABLE app.mail (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  message_id uuid,
  trigger_seq bigint NOT NULL,
  priority integer NOT NULL,
  status text NOT NULL,
  slice_count integer NOT NULL,
  error text,
  meta jsonb,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL
);
CREATE INDEX mail_agent_status_idx ON app.mail (agent_id, status);
CREATE INDEX mail_agent_created_idx ON app.mail (agent_id, created_at);
CREATE INDEX mail_stream_idx ON app.mail (stream_id);

CREATE TABLE app.vms (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  label text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL,
  username text NOT NULL,
  auth_kind text NOT NULL,
  secret_cipher text,
  key_source text NOT NULL,
  workdir text NOT NULL,
  last_probe jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX vms_owner_idx ON app.vms (owner_id);

CREATE TABLE app.stream_vms (
  id uuid PRIMARY KEY,
  stream_id uuid NOT NULL,
  vm_id uuid NOT NULL,
  level text NOT NULL,
  granted_by uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz,
  UNIQUE (stream_id, vm_id)
);
CREATE INDEX stream_vms_vm_idx ON app.stream_vms (vm_id);

CREATE TABLE app.files (
  id uuid PRIMARY KEY,
  stream_id uuid NOT NULL,
  name text NOT NULL,
  object_path text,
  size_bytes bigint NOT NULL,
  content_type text NOT NULL,
  store text NOT NULL,
  content text,
  uploaded_by uuid,
  created_at timestamptz NOT NULL
);
CREATE INDEX files_stream_idx ON app.files (stream_id);

CREATE TABLE app.slice_prefs (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  weight integer NOT NULL,
  set_by uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (agent_id, stream_id)
);

CREATE TABLE app.runtime_state (
  id uuid PRIMARY KEY,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
