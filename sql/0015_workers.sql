-- 分布式执行：回合循环可以跑在独立的 worker 进程里（分布在多台 server），控制面只读写库。
-- 控制面升级/重启时在跑的回合不受影响——它活在 worker 进程里，认领与提交都对着同一个库。
--
-- 为什么 workers 是一张心跳表而不是注册中心：worker 没有运行时贡献者，上线就是 upsert 一行、
-- 下线就是心跳停摆；调度台读这张表看"谁在干活"，reapStale 读它判断"那台是不是死了"。
-- status 只有 active/draining/stopped 三档，优雅退出先写 draining 再排空，最后一行 stopped 留着好对账。
--
-- 为什么 mail 补 worker_id 与 heartbeat_at 两列而不是只靠 workers 心跳：回收要落到"这一封"上——
-- 同一台 worker 上别的信在跑不代表这一封没 hang 死。heartbeat_at 由 worker 的心跳定时器替在跑的信刷新，
-- 阈值走配置；旧行这两列为空，回收退回 started_at 的老口径，不 redefine 已有行的语义。
-- 沿用迁移 API 支持的子集：ADD COLUMN 一次一列、可空、无默认值。

ALTER TABLE app.mail ADD COLUMN worker_id uuid;
ALTER TABLE app.mail ADD COLUMN heartbeat_at timestamptz;

CREATE TABLE app.workers (
  id uuid PRIMARY KEY,
  label text NOT NULL,
  version text,
  status text NOT NULL,
  inflight integer NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX workers_heartbeat_idx ON app.workers (last_heartbeat_at);
