-- 技能市场与员工技能安装记录。
-- 沿用 0001 的约束子集：只写 PRIMARY KEY / UNIQUE / NOT NULL，不写 DEFAULT、CHECK、外键。
-- id、时间戳、计数全部由 Function 侧显式提供；唯一性由代码依赖：
--   agent_skills(agent_id, skill_id)。
-- 内置技能（WorkStream 平台技能）写在 functions/skills.mjs 常量里，不入库；
-- 默认公共技能由 skills.market 首用时按固定 id 幂等补齐。

CREATE TABLE app.skills (
  id uuid PRIMARY KEY,
  owner_id uuid,
  name text NOT NULL,
  summary text NOT NULL,
  category text NOT NULL,
  body text NOT NULL,
  source text NOT NULL,
  is_public boolean NOT NULL,
  is_default boolean NOT NULL,
  always_on boolean NOT NULL,
  downloads integer NOT NULL,
  installs integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX skills_owner_idx ON app.skills (owner_id);
CREATE INDEX skills_public_idx ON app.skills (is_public);

CREATE TABLE app.agent_skills (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  skill_id uuid NOT NULL,
  installed_by uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz,
  UNIQUE (agent_id, skill_id)
);
CREATE INDEX agent_skills_agent_idx ON app.agent_skills (agent_id);
