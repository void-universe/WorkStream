-- Stream Server 后端：员工可以挂在一台按 Stream Server API Specification v1.0.0 提供接口的执行 server 上
-- （规范的机器可读表在 functions/streamspec.mjs）。令牌复用 api_key_cipher / api_key_tail（AES-GCM 密封，
-- 接口只回尾号），api_base_url 存那台 server 的地址：发现与规范路由都挂在它的 origin 上，前缀不可覆盖。
--
-- 为什么 stream_profile 是一列、而不是每轮现问一次：这一格决定提示词措辞与工具注入，两样都发生在调用之前。
-- 写它的只有建档/改档/自检三个主人动作，一轮任务只读；空值或表外的值由 backendFor 就地抛，不静默按某一档跑
-- ——猜错的那一档会让专属员工得到一句"你有这些工具"的措辞，而工具一个也发不出去，群里看到的是一次假执行。
-- 取值域 shared / dedicated / openai（openai = 发现失败后退回的 OpenAI 兼容那一档）由代码依赖
-- （STREAM_PROFILE_VALUES 与 oneOf），不建 CHECK 约束。旧行这一列为空：那批员工没有一条挂的是 stream 后端。
--
-- 一个 (员工, 群) 一条对方那侧的 session，与 qca_sessions 同口径：WorkStream 的群转录才是上下文权威，
-- session 只当执行 server 侧的对话缓存，全员工共用一条会让不同群在对方那侧串台。
-- 唯一性由代码依赖（同群复用同一条），不建唯一索引。
-- 沿用迁移 API 支持的子集：ADD COLUMN 一次一列、可空、无默认值。

ALTER TABLE app.agents ADD COLUMN stream_profile text;

CREATE TABLE app.stream_sessions (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  session_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX stream_sessions_agent_stream_idx ON app.stream_sessions (agent_id, stream_id);
