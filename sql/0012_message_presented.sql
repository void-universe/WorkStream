-- 虚拟员工这一轮交出的群文件（交付卡片）。原件只在 app.files 里存一份，这里放
-- [{file_id,name,content_type,size_bytes,note}]，让 messages.list 不必回表查文件就能把卡片渲染出来。
-- 这一列只给客户端看：装配上下文取消息时不选它，所以交付说明不会进任何一轮模型请求。
-- 可空、无默认值，符合迁移 API 的子集；旧行没有卡片，读出来按空列表处理。
ALTER TABLE app.messages ADD COLUMN presented jsonb;
