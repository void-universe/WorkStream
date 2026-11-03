-- 轨迹步骤：一次运行（app.mail 那一行）拆成若干密序号的步骤，供员工详情页的时间线与检视器读。
--  kinds：model = 一轮模型调用（含思考链、用量、首字延迟）；tool = 一次工具调用（含参数、结果）。
--  detail 放原文，超单步上限的字段截断后把原始长度记在 chars，前端显示"已截断"而不是悄悄变短。
--  只存得到一次运行被回收或删群时连带清掉；历史邮箱记录按 app.mail 的保留策略走。

CREATE TABLE app.run_steps (
  id uuid PRIMARY KEY,
  mail_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  seq integer NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  name text,
  call_id text,
  detail jsonb,
  chars integer,
  input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  cached_tokens integer,
  first_token_ms integer,
  duration_ms integer,
  error text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (mail_id, seq)
);
CREATE INDEX run_steps_mail_seq_idx ON app.run_steps (mail_id, seq);
CREATE INDEX run_steps_stream_started_idx ON app.run_steps (stream_id, started_at);
CREATE INDEX run_steps_agent_started_idx ON app.run_steps (agent_id, started_at);
