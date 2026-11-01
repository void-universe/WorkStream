-- 头像：真实员工与虚拟员工都可以设置；浏览器裁成 128×128 后以 data URL 存这一列。
-- 迁移 API 的 ALTER TABLE ADD COLUMN 只支持可空、无默认值的新列，所以历史行为空。
ALTER TABLE app.users ADD COLUMN avatar text;
ALTER TABLE app.agents ADD COLUMN avatar text;
