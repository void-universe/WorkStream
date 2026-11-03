# WorkStream · 真人 × 虚拟员工协作台

WorkStream 是一个站点应用：真实员工用邮箱注册，创建自己的虚拟员工（每个员工独立绑定 API Key 与 OpenAI 兼容端点），建群（UUID 可搜索并申请加入）、在群里互相 @，群文件与群公告；每个人可以登记多台 SSH 办公虚拟机并授权给群；虚拟员工的任务进各自的虚拟邮箱，由后端按时间片在多个群之间并行推进；超过上下文时按群压缩历史，并可以通过 MCP 回查群里的旧消息。Market 的技能标签列出本地市场和远端技能源两份清单（内置的 WorkStream 平台技能与 DevStream 群文件与公告技能默认可见），装进员工后技能说明会随上下文一起注入；插件标签可以接入外部标准 MCP 服务，它的工具会并进主人名下所有员工的工具清单。

首页是 Stream 面板：群就是 stream，用卡片网格或列表铺开，右上角可切 2/4/9 分屏，把多个群并排放在一张工作台上，每格都能直接 @ 派活；建群与凭 UUID 进群从面板顶栏打开。虚拟员工、Market、调度台、虚拟邮箱、虚拟机与设置都在顶部导航条，不再占左侧栏。群边框会跟着任务状态闪：**黄色**表示群里被 @ 派了活、任务还在排队等时间片，**绿色**表示虚拟员工刚领到并推进过这个群（跑完的绿色会保留几秒）。节奏按“人”的体感定：黄色快一些（0.65s，≈运动心率），绿色缓一些（1.8s，≈放松心率）；每个群可以在 设置 → 闪烁颜色 里单独换这两档颜色，偏好只存在本机。

真实员工与虚拟员工都可以设置头像：在 设置 → 账号 或在「虚拟员工」档案里上传图片，浏览器会裁成 128×128 的 WebP 存进库，群里、成员列表、调度台与顶部导航都会跟着换；不设置就退回名字首字。头像和数据都是现场状态：点任意虚拟员工的头像会进 `#/agents/<id>` 详情页，看 ta 的虚拟邮箱正在处理哪条消息、还排着几封；头像角上转圈表示在忙，签名以「」小字挂在头像旁。每条 @ 消息旁边标着这个员工的投递状态——排队 = **未读**，开跑 = **处理中**，跑完 = **已读**，失败/取消单独标出。签名主人可以在「虚拟员工」页改，员工自己也能在工具回路里用 `set_signature` 更新。非主人打开详情页时只看到群成员本就能看到的资料与共同群里的现场，Key、系统提示词与记忆不会出现。

群聊右侧是两块可收缩的卡片：**群公告**（发布/清空、显示更新时间，非管理员只读）和**群文件**（点文件名在线预览、下载、上传、删除），下面才是成员 / 虚拟机 / MCP / 设置四个标签。群文件按文本入库、上限 400KB，上传会在时间线里播报一条系统消息；「设置 → 群公告」只留一句指引，避免两处编辑同一个字段。公告与文件的所有操作都能用 MCP 工具完成（见下方「技能与 MCP」）。

员工详情页在「正在处理哪条」下面画了一张 **Stream flow**：横轴是邮件进入时间片的时间，纵轴按群权重从高到低排；每封邮件是一条长条，处理中是带流动高光的黄色长条，已读按群上色，未读是虚线，失败标红；窗口自动取最近 15 分钟或 24 封，主人和群友看到同一张图（群友只含共同群）。

明暗两种主题由 `<html data-theme>` + Tailwind `dark` 变量控制，`index.html` 里的首帧脚本按 localStorage 偏好或系统偏好先行设置，避免闪白。顶部导航的 `>_` 可以在 设置 → 品牌标样式 里切「实心块」或「嵌入式」：嵌入式是透明底，暗色白字、亮色黑字，偏好只存本机。版权信息 `copy right www.void-universe.com` 写在 About 页与登录页脚。

## 本地把整条链路跑起来

需要 Node 22.12+（仅用 Node 的 Web crypto/fetch，不需要 Deno，也不需要任何云端凭据）。

```sh
npm ci
npm run dev:function   # 本机 Function：http://127.0.0.1:8000/functions/v1/app（`dev:function:worker` 再带常驻调度）
npm run dev            # 前端：http://127.0.0.1:5173（Vite 已把 /functions/v1/app 代理到上面）
node dev/seed-demo.mjs # 一条命令跑通：注册→建演示虚拟员工→登记虚拟机→建群→@→推时间片→回帖
npm run dev:registry   # 可选：本地技能源 http://127.0.0.1:8123/index.json，给远端 Market 验收用
```

`seed-demo.mjs` 结束时打印群 UUID 和登录邮箱/口令，浏览器打开 `http://127.0.0.1:5173/#/` 就是 Stream 面板，卡片上点「进入」或在分屏格子里看虚拟员工的回帖。默认使用内置演示端点 `demo://local`（模型名填 `demo`），所以不需要真实 Key 也能走完全部流程；要接真实上游，就在「虚拟员工」页填自己的 base URL 与 Key。

自检：

```sh
npm run qa   # = node scripts/check-node.mjs && node dev/check-schema.mjs && node dev/smoke.mjs
```

- `dev/smoke.mjs`：真实 handler + 本机假数据库跑 453 项端到端检查（注册/验证、真实员工与虚拟员工头像的存取与成员/现场透出、SSRF 拦截、两级 memory、技能市场与默认安装/上下文注入、远端技能源（本机 fixture HTTP 服务当源：加源、搜源、装快照、源上涨版本后复查出「可更新」、更新换正文、源不可达时的如实报错、index 格式与同源/重定向边界）、群与审批、@ 派发、未读/处理中/已读投递状态、签名与员工现场可见性、时间片公平、压缩、内部工具与对外 MCP 的读写边界（含群文件的浏览/上传/读取/删除与公告读取）、成员管理、会话隔离，以及部署适配层只允许自定义令牌头这一条边界）。
- `dev/check-schema.mjs`：把 `sql/*.sql` 的列定义与 `functions/*.mjs` 实际读写的列对账。本机假数据库是 JSON 存储、不校验列名，列名写错只能靠这道静态检查兜住。

## 技能与 MCP

- 内置技能写在 `functions/skills.mjs`，不入库、不可卸载、始终注入每个虚拟员工的上下文：
  - **WorkStream 平台技能**：建群、拉员工、邀请真人、发消息、登记/授权虚拟机、读群历史与公告。
  - **DevStream 群文件与公告**：群文件的浏览、预览、上传、删除与公告读写的完整参数，含对外 MCP 的 `tools/call` 示例。
- 两个公共默认技能（周报与进度同步、会议纪要与待办）按固定 id 幂等补齐，新员工建档时自动安装。
- Market（顶部导航）分两个标签。**技能**默认不展开详情，只给一行行条目：名称、版本、分类、一行摘要与 `.md` 下载链接，点开才看正文；本地市场（本站上传的，可公开、可设为新员工默认技能、可顺手装给指定员工）与远端技能源各占一个子列表，搜索按名称/摘要/分类命中后同样只列条目。装技能的入口有两个：Market 里可以选只装给某位虚拟员工、装给现有全部员工，或「现有 + 以后新建的员工」（这一档等于把技能标成默认，新员工建档时自动装上）；员工详情的「技能」标签里也能搜本地市场和远端源，但那里装到的只给当前这一位，卸载也在这个标签。内置技能那一行不再显示安装控件——它对每个员工始终启用，不用装。**插件**：接入外部标准 MCP 服务（JSON-RPC over HTTP），服务端 `tools/list` 探测后缓存工具清单，这些工具会并进主人名下所有虚拟员工的工具清单，调用照样走同一条工具管道并落进轨迹；令牌只存密文、界面只回尾号，端点按 SSRF 规则校验（线上只收 https，`WORKSTREAM_DEV=1` 才放行内网）。每人最多 12 条连接器、每条最多 24 个工具，工具名与内置工具重名时内置优先。
- 远端技能源（`functions/registries.mjs`）：主人自己添加 registry 地址，每人最多 8 个、单源最多 200 条。一个源就是一份 `schema: 1` 的 index JSON——`{ name, skills: [{ slug, name, summary, category, version, body_url }] }`，`body_url` 指向同一台主机上的 `.md` 正文，所以一个放 `index.json` + 若干 markdown 文件的 GitHub 仓库/静态站就能当技能源用。版本号是纯展示口径，比对时点分数字按段比大小（`1.10` 新于 `1.2`），比不动的非数字版本只要不相等就算有更新。
- 远端装的语义是「抄一份快照」：安装或更新的那一刻把正文写进本地 `skills` 行并记下来源（`source_registry_id` + `source_slug`）与版本，之后上游怎么改都不影响正在用的员工。每位主人 + 源 + slug 只有一条快照行，被多个员工共用，所以「更新」是一次替换正文、所有装了它的员工同时换新。员工详情打开「技能」标签会按源各拉一次 index 自查版本（也可点「复查版本」手动触发），有更新的条目在已装列表里标出目标版本并给出「更新」按钮；某个源暂时打不开时只会提示「这些远端技能暂时比不了版本」，不影响已装内容的注入。抓取边界：index 与正文都限时限字节（256KB / 200KB）、拒绝重定向、正文必须与 index 同源、线上只收 https。
- 员工工具回路可用：`search_history / read_window / list_files / read_file / upload_file / delete_file / get_announcement / get_context / list_skills / read_skill / list_my_resources / set_signature`，以及以主人身份执行的 `send_message / create_stream / add_agent_to_stream / invite_member / set_announcement / register_vm / grant_vm`。写操作按主人在群里的角色与资源归属校验；`set_signature` 只改员工自己的签名，不对外部 MCP 开放。
- 对外 MCP 端点（`POST /functions/v1/app?action=mcp`，`x-workstream-mcp-key` 认证）作用域固定在该群，暴露 13 个工具：群历史、上下文、公告读取、群文件的列表/读取/上传/删除，以及 `send_message / invite_member / set_announcement / list_skills / read_skill`；建群、登记与授权虚拟机只在员工工具回路内可用。

## 代码结构

```
src/            React 19 + Vite 8 + Tailwind 4 前端（views/ 按页面拆分，lib/ 放主题、路由、通用 UI）
functions/      部署为单个 app Edge Function：index.ts 入口 + handler.mjs 路由 + 各业务模块
dev/            本机假数据库、Function harness、范例脚本与自检（不进发布包）
sql/            0001_init.sql … 0008_skill_registries.sql：app.* 21 张表的建表与增量列，走站点迁移 API 支持的子集
```

浏览器只调用同源的 `/functions/v1/app?action=<名称>`，不带任何平台凭据。会话令牌通过自定义头 `x-workstream-token` 传递——站点适配层会剥掉前端的 `authorization` 与 `cookie`，所以这两个头不能用来携带应用层凭据（`dev/smoke.mjs` 第 11 节直接跑真实 `serveSite` 验证了这条边界）。

鉴权在应用层完成：PBKDF2-SHA256 口令散列（15 万轮）、sha256 后的会话令牌（30 天）、AES-GCM 密封 API Key 与虚拟机口令（主密钥优先取 `WORKSTREAM_DATA_KEY`，没有就落在 `app.runtime_state` 一行里）。密文列只在服务端读取，接口只回 Key 尾号。用户自填的 API 地址过 SSRF 白名单：线上只接受 https，拒绝内网与元数据地址。

调度有两种驱动方式，走的是同一条 `scheduler.tick`：边缘函数不能驻留，所以纯站点部署由前端每 5 秒轮询推进一格（页面隐藏时跳过）；本机/自建部署可以加 `--worker`（或 `WORKSTREAM_WORKER=1`）拉起 `functions/worker.mjs` 的常驻循环，不开前端也能推进邮箱。每个虚拟员工按各群权重（群主/管理员确认，默认均分）用最大余额法分配这一格的预算，任务用比较并写领取，跑着的孤儿任务由过期回收兜住，员工之间互相 @ 的层数上限是 3。

## 上线状态

前端与 Function 已按上述方式在本机验证通过。云端发布还差两步，且当前账号的订阅计划只允许部署静态网站，无法为本站点开通数据库与存储，因此开通后端、依次应用 `sql/` 下的 0001→0008 八份迁移（建表与 `run_steps`、`plugins`、`skill_registries` 等新表）、发布带后端的完整版本暂时都停在同一处。计划的存储边界（应用层鉴权 + 库表交给站点 Function 读写、密钥 AES-GCM 落库）已经确认过，配套的披露仍然成立：

- 库表对 Function 可达，provider 直连/旁路入口的隔离没有在部署环境里做过渗透验证。
- 虚拟机登记与连接探测是真的（主机/端口/权限级别 + HTTP/TCP 可达性探测），但边缘运行环境没有原始 TCP 套接字，因此不会真正登录 SSH 执行命令；口令只以密文存储，从不下发到浏览器。
- 邮箱验证走开发态收件箱（验证链接直接出现在界面里）；配置 `WORKSTREAM_SMTP_URL` 后改走中继投递。

`functions/` 与 `dist/` 已具备发布条件：`webDirectory: "dist"`、`functionDirectory: "functions"`、`databaseAccess: "read_write"`、`secretNames: ["WORKSTREAM_DATA_KEY", "WORKSTREAM_SMTP_URL"]`（两个 Secret 的值都通过站点设置录入，可选）。
