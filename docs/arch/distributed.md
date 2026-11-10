# WorkStream 分布式架构与回合契约

**简体中文 · [English](distributed.en.md)**

控制面 · 执行面 · 统一回合接口 ｜ 源码：`functions/agents.mjs`、`functions/backends.mjs`、`functions/qca.mjs`、`functions/worker.mjs`、`dev/worker-main.mjs` ｜ 调度循环的细节见 [scheduler.md](scheduler.md)

**一页结论。** 控制面（WorkStream 那台 server）只读写数据库，执行面是分布在多台 server 上的 worker 进程，对着同一个库认领与提交。所有后端通道——自建 OpenAI 兼容端点、内置演示模型、Qoder 云端 Agent、按规范对接的执行 server——都收敛到同一个回合接口：`completeForAgent` 按 `transport` 分流，入参原样递给那条通道，返回值形状一致。上下文权威永远在 WorkStream，云端/CLI 会话只当可重建的缓存；思考链永不进群；中断按 QCA 那套（静默也问、半截上交）统一。回合活在 worker 进程里，所以控制面升级/重启掐不断在跑的活。

---

## 1. 拓扑：控制面与执行面分离

- **共享一个库（方案 A）**：worker 不走 HTTP 任务 API，而是直接连控制面同一个数据库。认领是 `mail` 上 `queued→running` 的单行 CAS，任何一台 worker 都能认任何一封（不钉主人），多台同时抢只有一台赢。
- **同一信任域**：每台 worker 持有库的服务密钥与 `WORKSTREAM_DATA_KEY` 主密钥，与控制面同级。凭据的值永不回显（只回尾号），出网地址过 `safeApiBaseUrl`。
- **控制面升级不中断执行**：`WORKSTREAM_EXECUTION=worker` 时，控制面这次 `scheduler.tick`（无 worker 上下文）在回收之前就空转返回 `execution:"worker"`、`ran:[]`，认领与执行全在独立 worker 进程里。控制面重启时回合仍活在 worker 那边，照常跑到提交点落群。tick/认领/心跳/回收的机制见 [scheduler.md](scheduler.md) 第 3.7 节。
- **worker 入口**：`functions/worker.mjs` 的 `startWorker` 是常驻循环；`dev/worker-main.mjs` 是独立进程入口，`--client <module>` 注入生产库客户端（默认导出 `async (env) => supabaseClient`），本机/测试默认用夹具。

---

## 2. 统一回合接口

### 2.1 分流口：completeForAgent

`completeForAgent`（[functions/agents.mjs](../../functions/agents.mjs)）是一轮模型调用的唯一分流口：按 `backendFor(agent)` 解析出后端条目，再按它的 `transport` 从 `TRANSPORT_ROUTES` 取路由。入参一律原样递给那条通道，各自只取自己要的（`messages`、`tools`、`summary`、`window`、`onInterrupt`、`persistSession` 等）——过去手写分支时漏传过 `persistSession`，加字段只要写进表和签名就不会再丢。返回值形状一致，引擎与轨迹不用关心后端。

### 2.2 通道清单

后端能做什么写在 [functions/backends.mjs](../../functions/backends.mjs) 的 `BACKENDS` 表里，不散在各处的 if。`transport` 是实现侧的路由名，必须在 `TRANSPORT_ROUTES` 里有对应实现：

| 后端 id | transport | caps.tools | 实现入口 |
| --- | --- | --- | --- |
| `openai` | `chat` | 是 | `chatCompletion` |
| `demo` | `demo` | 是 | `demoRound` |
| `qca` | `cloud` | 否 | `askCloudAgent` |
| `stream` / `stream-dedicated` | `stream` | 按档（`shared` 是，`dedicated` 否） | `askStreamServer` |

清单里声明了却没有实现的 `transport`（或实现了清单里没有的）在模块加载时就抛，不留到运行时变成一句上游错误。`validateBackends` 也在加载时自查（id 重复、缺 `caps.tools`、不吃工具却没给 `noToolsNotice` 都就地抛）。`dev/check-schema.mjs` 另有一道静态闸，把这份文档的 `transport` 列与 `BACKENDS`、`TRANSPORT_ROUTES` 三方对账。

`stream` 那一条说的是我们发布的 Stream Server 规范：规范正文（端点表、帧词表、错误码族）在 [functions/streamspec.mjs](../../functions/streamspec.mjs)，能跑的参考实现在 [functions/streamserver.mjs](../../functions/streamserver.mjs)，客户端那一侧在 [functions/stream.mjs](../../functions/stream.mjs)。走哪一档由建档、改档、连接自检那一次发现请求决定，结论落在 `agents.stream_profile`，一轮任务从不写它。供应商接入前自己考自己：符合性测试套件在 [functions/streamcts.mjs](../../functions/streamcts.mjs)，命令行入口 `node dev/cts.mjs --url <origin>`；它不拿我们的客户端当考官（自己给自己判卷有盲点），只认规范表算出来的形状，判 pass/fail/skip 三档——规范没定的行为只记观察，不判 fail。

### 2.3 统一返回形状

每条路由都回 `{ content, reasoning, usage, finish_reason, mode }`（云端另带 `session_id`、`reply_event_id`，自建另带 `first_token_ms`）。`usage` 不回报时留 `null`，不拿 0 冒充；`mode` 标这条通道/这一轮的口径（`qca`、`compress`、`cron`、`delivery` 等）。引擎按同一形状落库与画轨迹。

---

## 3. 上下文权威与会话粒度

- **WorkStream 是转录的唯一权威**：每轮 `buildContext` 把记忆 + 摘要 + 窗口现场重渲染成 messages 发出去。提供商侧的会话只是缓存，不是事实来源。
- **云端会话按 (员工, 群) 各存一条**：`askCloudAgent`（[functions/qca.mjs](../../functions/qca.mjs)）每轮用 `flattenPrompt` 把组好的 messages 压成一条 `user.message` 正文发过去；云端 session 只当云端侧的对话缓存，落 `qca_sessions` 按 (员工, 群) 各一条——共用一条会让不同群在云端串台。
- **一次性提问不缓存**：`persistSession=false` 用于压缩这类一轮性提问，不写回群里那条 session，免得摘要指令混进对话史。
- **CLI 会话同一口径（R3，规划）**：接 CLI 执行器后 `cli_sessions` 存 per (员工, 群) 的 `session_id`，用 `--resume` 拿 append-only 前缀；WorkStream 仍是转录与摘要的唯一权威，CLI 会话只当缓存，丢了就重建。

---

## 4. 工具能力：caps.tools

`caps.tools` 一个字段同时决定两件事，不再各说一套：工具注入（引擎 `withTools`：不吃工具的通道请求体里 `tools` 为 `null`，连接器工具那一步也跳过）与提示词措辞（`backend.tools` 槽位：落「按需调用工具」还是「把结论直接写进正文」）。不吃工具的通道必须自带 `noToolsNotice`，否则模型不知道自己在这一条通道里调不到东西，会照着技能说明把工具名写进正文——群里看到的是一次假执行。QCA agent 用它自己的工具集，我们的群工具不在这条通道里注入。

---

## 5. 正文红线：思考链不进群

只有 `content` 进群，`reasoning` 只落步骤 detail，唯一读处是员工详情轨迹检视器的「思考」标签（`StepInspector`）。云端 `textOf` 只取 `type=text` 的块，thinking / 工具块一律丢掉；演示模型的摘录只取窗口里的真人发言。这是产品红线，不是风格偏好：同事的内部推理出现在群里就是泄漏。

---

## 6. 中断语义

- **轮内问 onInterrupt**：同进程由 `bus` 的 `fireInterrupt` 即时点火，跨进程由 400ms 的邮箱轮询兜底。命中就 `reader.cancel()` 并抛 `Interrupted`（带已输出的半截 `partial`）。
- **静默也要问（按 QCA 那套）**：云端 agent 跑自己的工具时可能很久不吐增量，所以 `askCloudAgent` 在静默 `IDLE_MS`（800ms）也问一次 `onInterrupt`，否则这条通道的抢占只能等到整轮超时，跟自建端点差一截。
- **半截不丢**：重跑时作为「上一条说到一半被打断」的提示喂回去；叫停则任务置 `cancelled`，半截不落群。插话重跑上限 2 次。
- **后台信不吃插话**：`meta.kind` 是 `compress` / `dreaming` 的信是一次性提问，一个字不进群，判定只有一个家（`interruptibleMail`）。
- **CLI 执行器（R3）**：掐断语义从「cancel 读循环」变成「kill 进程组 + 从 stdout 增量捞半截」。

---

## 7. 失败与回收

- **失败码在源头就有名字**：自建非 2xx 当场用 `upstreamCode` 翻成 `upstream_*`，云端用 `QcaError` 带 `qca_*`；邮箱、轨迹、界面读同一个码。
- **流断在半路不算说完**：SSE 走到尽头既没 `[DONE]` 也没 `finish_reason`，记 `upstream_stream_incomplete`（云端 `qca_stream_ended_unfinished`）并结为失败，半截一个字不落群。
- **没有自动重投**：认领只从 `queued` 走 CAS，`reapStale` 把跑飞的 `running` 收成 `failed`，没有任何一条路会把 `failed` 重新排队。失败提示写「要再试请重新 @ 他」。
- **回收按心跳**：worker 的心跳定时器替在跑的信刷新 `mail.heartbeat_at`，`reapStale` 跳过心跳新鲜的行（`>= cutoff`），阈值走 `WORKSTREAM_REAP_MS`（`reapThreshold`，默认 5 分钟，夹在 [10s, 1h]）。活着的长任务不被误杀，崩溃留下的僵尸照收。机制见 [scheduler.md](scheduler.md) 第 3.1/3.7 节。

---

## 8. 验收口径

- **一个分流口**：每条后端路由都回统一形状，引擎与轨迹与后端无关（smoke）。
- **transport 三方对账**：本文档 `transport` 列 ↔ `BACKENDS` ↔ `TRANSPORT_ROUTES`（`dev/check-schema.mjs` 静态闸 + 冷启动抛）。
- **caps.tools 生效**：`false` ⇒ 请求体 `tools` 为 `null` 且必有 `noToolsNotice`（`validateBackends` + smoke）。
- **思考链不进群**：`reasoning` 只落步骤 detail（smoke §25 + `StepInspector`）。
- **中断按 QCA 口径**：云端静默 `IDLE_MS` 内可掐断、半截上交、叫停置 `cancelled`（smoke 8b）。
- **控制面升级存活**：`WORKSTREAM_EXECUTION=worker` ⇒ 控制面 tick 空转、在跑回合在 worker 里跑完落群（smoke §31）。
- **共享库 CAS**：任何 worker 认任何信、只有一台赢、群里只落一条回复（smoke §31）。
- **心跳回收**：心跳新鲜放过、停摆回收成 `failed`、期间插话转待办不丢（smoke §31）。