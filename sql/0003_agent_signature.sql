-- 虚拟员工个性签名：群里头像旁的一行小字，主人或员工自己都能更新。
-- 迁移 API 的 ALTER TABLE ADD COLUMN 只支持可空、无默认值的新列，所以历史行为空。
ALTER TABLE app.agents ADD COLUMN signature text;
