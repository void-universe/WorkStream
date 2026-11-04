-- 排程：虚拟员工按时刻表自己醒来干活，不等人 @。
-- 为什么时钟状态只有 next_run_at 一列：暂停就是把它写空，恢复就是按排程规格重算下一次——
-- 再加一个 enabled 位就会有两个真值源，出现"enabled 为真而 next_run_at 为空"这种没人能兑现的组合。
-- 为什么到点判定挂在主人身上（owner_id + next_run_at 索引）而不是逐个员工扫：
-- 扫到期的那一路每轮都要跑，范围必须有界；主人是 scheduler.tick 与 worker 本来就按人分组的键。
-- 为什么不记"上一次该跑的时刻"：追补时按 next_run_at 往后数对点数就够了，多存一个游标只会多一个能写错的地方。

CREATE TABLE app.schedules (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  name text NOT NULL,
  instruction text NOT NULL,
  kind text NOT NULL,
  interval_minutes integer,
  at_time text,
  weekdays jsonb,
  tz_offset_minutes integer,
  next_run_at timestamptz,
  last_run_at timestamptz,
  merged_runs integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX schedules_owner_due_idx ON app.schedules (owner_id, next_run_at);
CREATE INDEX schedules_agent_idx ON app.schedules (agent_id);
