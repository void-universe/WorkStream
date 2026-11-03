-- 远端技能市场：主人自己添加的 registry 源，以及从源里快照下来的技能。
-- 沿用 0001 的约束子集：只写 PRIMARY KEY / UNIQUE / NOT NULL，不写 DEFAULT、CHECK、外键；
-- id、时间戳、状态全部由 Function 侧显式提供。
-- index_url 过 safeApiBaseUrl（线上只收 https，WORKSTREAM_DEV=1 才放行内网），
-- 正文快照进 app.skills.body，之后上游改了什么不影响已装员工；
-- skills 上的三个 source_* 列用来把快照回指到某个源的某个 slug，好做版本比对与更新。
-- 唯一性由代码依赖：skill_registries(owner_id, index_url)、skills(source_registry_id, source_slug) 每人一条。

CREATE TABLE app.skill_registries (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  name text NOT NULL,
  index_url text NOT NULL,
  skill_count integer NOT NULL,
  last_error text,
  skills_at timestamptz,
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX skill_registries_owner_enabled_idx ON app.skill_registries (owner_id, enabled);

-- 迁移 API 的 ALTER TABLE ADD COLUMN 只支持可空、无默认值的新列，一次一列；历史行为空。
ALTER TABLE app.skills ADD COLUMN version text;
ALTER TABLE app.skills ADD COLUMN source_registry_id uuid;
ALTER TABLE app.skills ADD COLUMN source_slug text;
