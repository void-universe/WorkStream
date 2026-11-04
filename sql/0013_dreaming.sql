-- dreaming：把一名主人名下各个群的压缩摘要归并成一份「主人级」的全局记忆。
--
-- 为什么给 app.memories 加列而不是另起一张表：全局记忆和群摘要本来就是同一种东西（一段会被装配进
-- 提示词的正文），另起一张就会有两套读法，上下文装配、界面、删除链路各查各的——一处事实只有一个家。
-- scope 因此多出第三个值 "owner"：那一行按 owner_id 查，agent_id 记的是跑这次归并的员工（出处），
-- stream_id 留空。owner_id 可空：旧行没有这一列，读出来按空处理，而空的永远查不进主人级那一路。
--
-- 为什么 covers_streams 是一份 {"员工 id:群 id": 已归并到的序号} 的 JSON 而不是逐行标记：归并的输入天然就是
-- 「每份群摘要覆盖到哪个序号」，一份水位就能精确说出哪一段还没归并过；再多存一个全局游标，
-- 只会多一个能和各群摘要水位线对不上的地方。键里带员工 id 是因为同一个群可以有两个员工各折一份摘要，
-- 只按群记就会让后写的盖掉前一条的序号——那条要么每轮重并、要么被当成已归并而永久漏掉。
-- 归并失败时这一列不写新值，和「压缩失败不许抬水位线」同一口径。
--
-- 为什么排程用一列 purpose 而不是新表：做梦的定时和普通排程共用同一个时钟（next_run_at 一列、
-- CAS 推进、欠点合并、暂停即写空），另起一张就是第二个真值源。旧行没有这一列，读出来按普通排程处理。
ALTER TABLE app.memories ADD COLUMN owner_id uuid;
ALTER TABLE app.memories ADD COLUMN covers_streams jsonb;
CREATE INDEX memories_owner_idx ON app.memories (owner_id, scope);
ALTER TABLE app.schedules ADD COLUMN purpose text;
