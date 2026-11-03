-- 云端 Agent 后端：员工可以不走自建 OpenAI 兼容端点，改挂 Qoder Cloud Agents 上已有的 agent。
-- 沿用迁移 API 支持的子集：ADD COLUMN 一次一列、可空、无默认值；backend 为空一律按 openai 处理。
-- PAT 复用 api_key_cipher / api_key_tail（AES-GCM 密封，接口只回尾号），api_base_url 存 QCA 的 API origin。
-- 一个 (员工, 群) 一条云端 session：WorkStream 的群转录才是上下文权威，session 只当云端侧的缓存，
-- 全员工共用一条会让不同群在云端串台。唯一性由代码依赖（同群复用同一条），不建唯一索引。

ALTER TABLE app.agents ADD COLUMN backend text;
ALTER TABLE app.agents ADD COLUMN qca_agent_id text;
ALTER TABLE app.agents ADD COLUMN qca_environment_id text;

CREATE TABLE app.qca_sessions (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  session_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX qca_sessions_agent_stream_idx ON app.qca_sessions (agent_id, stream_id);
