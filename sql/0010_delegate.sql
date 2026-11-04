-- 替身：真人不在时，由自己名下的一个虚拟员工接住冲 ta 来的 @ 并代 ta 回应。
-- 班表挂在账号上（一次设定对所有群生效），群里的开关只是覆盖：members.delegate_mode 为空按「跟随全局」处理。
-- 生效与否在派发那一刻按服务器时钟判定，不建「到点翻牌」的状态位——没有任何常驻进程保证那次翻牌一定发生，
-- 翻了牌的写法会让时段结束后的替身永远停在开启态。
-- 回复仍由替身自己署名，messages.on_behalf_of 记下 ta 替谁说话：群里必须看得见是替身，不是本人。

ALTER TABLE app.users ADD COLUMN delegate_agent_id uuid;
ALTER TABLE app.users ADD COLUMN delegate_start_at timestamptz;
ALTER TABLE app.users ADD COLUMN delegate_end_at timestamptz;

ALTER TABLE app.members ADD COLUMN delegate_mode text;
ALTER TABLE app.members ADD COLUMN delegate_agent_id uuid;

ALTER TABLE app.messages ADD COLUMN on_behalf_of uuid;
