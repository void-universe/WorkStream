-- 群消息的图片附件引用。
-- 原件按群文件那套存在 app.files（content 列放纯 base64），这里只存 [{file_id,name,content_type,size_bytes}]，
-- 让 messages.list 翻页不必拖着几 MB 的 base64；可空、无默认值，符合迁移 API 的子集。
ALTER TABLE app.messages ADD COLUMN attachments jsonb;
