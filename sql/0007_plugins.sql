-- 插件市场：外部 MCP 连接器。一条记录 = 主人接的一个 MCP 服务，它的工具会并进主人名下所有员工的工具清单。
-- 沿用 0001 的约束子集：只写 PRIMARY KEY / UNIQUE / NOT NULL，不写 DEFAULT、CHECK、外键；
-- id、时间戳、状态全部由 Function 侧显式提供。
-- auth_cipher 是 seal() 后的令牌密文，任何读接口都不返回它，只返回 auth_tail；
-- 没有令牌的公开服务留 NULL。
-- tools 缓存 tools/list 的结果 [{name,description,parameters}]，探针（plugins.probe）成功时刷新；
-- 引擎组每轮工具清单读的是这份缓存，不在模型回路上现连外部服务。

CREATE TABLE app.plugins (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  name text NOT NULL,
  endpoint text NOT NULL,
  auth_cipher text,
  auth_tail text,
  tools jsonb,
  tools_at timestamptz,
  status text NOT NULL,
  last_error text,
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX plugins_owner_enabled_idx ON app.plugins (owner_id, enabled);
