# AGENTS.md

WorkStream 是"真人 × 虚拟员工"协作台：Vite 静态前端 + 单个 Edge Function 后端。改代码前先读 [README.md](README.md) 的「代码结构」和 [docs/arch/scheduler.md](docs/arch/scheduler.md)；这份文件里的每条规则都必须能指到本仓的一处实现或一道门禁，指不出来的规则不该写进来。

## 环境与门禁

- **Node 必须 22.12+，`engines` 是 `>=22.12.0 <23`。** 本机系统 Node 是 v24，会被 [scripts/check-node.mjs](scripts/check-node.mjs) 的 `preinstall`/`predev`/`prebuild` 拦下。所有 `npm`/`npx` 前面加 `export PATH="/d/tools/node22:$PATH"`（便携版 Node 22）。
- **`npm run qa` 是唯一的全量门禁**（= check-node + check-schema + smoke）。改动合入前跑它，报数以千计：`dev/smoke.mjs` 用真实 handler + 本机假数据库跑端到端，**851 项检查、0 失败**是当前的地板，只许涨不许跌。
- **`npm run build` = `tsc --noEmit && node scripts/build.mjs`**，类型检查在构建里，不在 qa 里。
- **本仓没有 ESLint 配置**：别跑 `npx eslint`，别建议加 linter 来代替静态检查。需要机器可验的不变量时，照 `dev/check-schema.mjs` 的样子写成 `scripts/` 下的静态对账 + 在 `dev/smoke.mjs` 里落一条 `check()`。
- 起服务端要带 `--worker`（或 `WORKSTREAM_WORKER=1`）：[functions/worker.mjs](functions/worker.mjs) 是常驻调度循环，不带它就只能靠前端每 5 秒轮询推进一格，页面一隐藏邮箱就停（见 [dev/local-function.mjs:17](dev/local-function.mjs#L17)）。
- 前端调后端只走同源的 `/functions/v1/app?action=<名称>`，会话令牌在自定义头 `x-workstream-token` 里；本机打 dev 函数服也要按这个形式打，`POST` 到 `/app` 不带 `action` 只会拿到 `missing_action`。

## 约定

- **注册即效果，`register()` 必须返回精确的 disposer。** 新加任何注册表（工具、提示词块、文件渲染器、动作路由），撤销就是调用它返回的那个函数，并且要在 `dev/smoke.mjs` 里证明撤销干净：注册 → 断言在 → 撤销 → 断言不在。参照 [functions/mcp.mjs:734](functions/mcp.mjs#L734)：声明里有、注册表里没有的工具当场抛，不留到运行时变一句 `tool_not_allowed`。
- **顺序是被分配的资源，不是代码行的先后。** 提示词块的位置写在 [functions/prompt.mjs:23](functions/prompt.mjs#L23) 的槽位表里：每块领一个 `order` 并声明 `volatile`（这一轮会不会变），装配按「稳定块在前、每轮必变的块在后」排序，因为提供商侧前缀缓存按从头开始最长匹配，一个易变块排在中间就把它之后所有内容每轮重付一次。加新块是从表里领号，不是在数组尾部顺手 push——记忆那条已经吃过教训，[functions/engine.mjs:598](functions/engine.mjs#L598) 的升序拼接就是为了不打断旧前缀。这条不变量由 `dev/smoke.mjs` 的 8d 兜着（[dev/smoke.mjs:1035](dev/smoke.mjs#L1035)：两轮请求的公共前缀必须覆盖整段上一轮窗口，且可复用比例 ≥95%），断点本身由 8d2 钉在表上（[dev/smoke.mjs:1060](dev/smoke.mjs#L1060)）。
- **模型可见的必须可复原。** 任何东西进了请求体，就得能从 `run_steps` 或转录里重建：用量列由 [functions/steps.mjs:53](functions/steps.mjs#L53) 的 `usageColumns` 统一落，这一步落下的提示词槽位由 `prompt_slots` 单列落（[functions/engine.mjs:765](functions/engine.mjs#L765)），轨迹的「上下文」页就是拿它列出断点前后的块。加一类模型可见输入，同一轮就要有一步轨迹，否则后台信为什么这么答永远说不清。
- **思考链不进群。** `reasoning` 只进步骤 detail（[functions/engine.mjs:762](functions/engine.mjs#L762)），群正文只有 `content`；看思考链的唯一入口是轨迹检视器的「思考链」页（[src/views/agents/StepInspector.tsx:208](src/views/agents/StepInspector.tsx#L208)）。这是产品红线，不是风格偏好：群里出现同事的内部推理，等同于泄露。
- **配置错了就地炸，别加一句 WARN。** 自检覆盖不到的静默失败不算修好。[functions/mcp.mjs:747](functions/mcp.mjs#L747) 在冷启动就把"声明了但没实现"抛出来，`dev/check-schema.mjs` 静态对账迁移列与代码实读写列——因为本机假数据库是 JSON 存储，列名写错在本地根本跑不出来。缺引用、不认识的枚举值、格式版本对不上：整条拒绝并把原因如实报出去（`functions/plugins.mjs` 的 `normalizeTools` 与 `functions/registries.mjs` 的 `normalizeIndex` 都返回 `skipped` 原因列表），不许静默跳过或悄悄改名兼容。
- **限额按完整结果算，不按片段算。** 字节、字符、条数、时限要在能看见最终发出的那个值时才收口：[functions/plugins.mjs:18](functions/plugins.mjs#L18) 的 512KB 是逐块累计字节、含包装与元数据，[:19](functions/plugins.mjs#L19) 的 6000 字符是拼完 `text` 部件之后再截。要测就测三种：刚好、超一点点、单块就超。
- **只在提交点发布状态。** 领取任务用比较并写（`db.mail.claim`），收尾统一结掉未合上的步骤（`closeOrphanSteps`）；未成功之前不要把中间态写成终态。
- **不透明的 id 必须带来源。** 外部传入的 id 一律走 [functions/util.mjs:66](functions/util.mjs#L66) 的 `uuid(value, name)`，错误信息里要说清是哪个字段；内部新 id 用 `newId()`。别加模块级的 `current` / `active` / `selection` 单例——共享状态要挂在一个有主人的服务对象上。
- **类型能证明的边界不要再校验。** 校验放在真边界：请求体入口（`text` / `int` / `oneOf` / `avatarData`）、用户自填的外部地址（[functions/util.mjs:163](functions/util.mjs#L163) `safeApiBaseUrl`：线上只收 https，`WORKSTREAM_DEV=1` 才放行内网与元数据地址）、入库、出网、跨进程。进程内函数之间不补防御性 fallback，也不为静态类型已排除的输入写测试。
- **随部署变化的旋钮不许硬编码。** 上下文预算、超时、上限这类做成 `Config`/入参/env（`CONTEXT_CHARS_DEFAULT` 在 [functions/util.mjs:85](functions/util.mjs#L85)，密钥主密钥走 `WORKSTREAM_DATA_KEY`）。一个 `DEFAULT_*` 常量或测试钩子不算可配置。协议常量、外部规范、安全不变量保持固定。
- **新行为挂扩展点，不改主循环。** 工具进 `TOOL_HANDLERS`，动作进各模块的 `actions` 表（[functions/handler.mjs:75](functions/handler.mjs#L75) 对未知动作回 `unknown_action`），提示词块进 [functions/prompt.mjs:23](functions/prompt.mjs#L23) 的槽位表，后端通道进 [functions/backends.mjs:20](functions/backends.mjs#L20) 的清单（"这条通道吃不吃工具"是 `caps.tools` 一个字段，提示词措辞与工具注入读同一份；表里声明的 transport 缺实现由 [functions/agents.mjs:380](functions/agents.mjs#L380) 冷启动抛出），群文件预览进 [src/lib/fileRenderers.mjs:25](src/lib/fileRenderers.mjs#L25) 的渲染器注册表并在 [src/lib/renderers/index.mjs](src/lib/renderers/index.mjs) 登记一行（漏登记由 `npm run check:schema` 静态拦，界面「模型来源」下拉与后端清单也在 `dev/check-schema.mjs` 里对账——冒烟看不见界面），界面语言进 [src/lib/i18n.ts:15](src/lib/i18n.ts#L15) 的 `LOCALES` 表并在 `src/locales/<id>.json` 补一份同键字典（字典键集与占位符、取词点用到的键、和服务端白名单 [functions/locales.mjs:4](functions/locales.mjs#L4) 的 id 集合同样由 `dev/check-schema.mjs` 对账——服务端打包不了前端 TS，清单只能存两份，那就必须有一道闸保证它们不各说各话）。要改 `functions/engine.mjs` 的派发主循环，同一份改动里更新 [docs/arch/scheduler.md](docs/arch/scheduler.md)。
- **界面给出去的选择必须真的生效。** `LOCALES` 里 `complete: false` 的语言只在「即将上线」列名、不可点：选了却仍显示中文，用户不会收到任何报错，这比不提供更糟（`dev/check-schema.mjs` 钉住「标了 complete 就必须有字典」）。同一口径下，顶栏主题、设置页的语言下拉都当场写账户偏好（`auth.patch`），不留「还得点保存才生效」的第二条路。
- **上屏的中文句子必须进字典，字典对账看不见的那半边由棘轮兜。** 界面里每一句给用户看的文案（含 [src/api.ts](src/api.ts) 里服务端错误码的文案，错误码到字典键的映射是 `ERROR_KEYS`）都要有 `src/locales/*.json` 的一份；数据、枚举、兜底哨兵可以留中文，但必须逐条写进 `dev/check-schema.mjs` 的 `BARE_COPY_CEILING`，并且说得出它为什么不是文案。这道闸是**只许跌不许涨的棘轮**：按文件数非注释中文行，涨了就是新加了一句硬编码文案，跌了却没改表同样拒绝——因为字典键集对账只能证明「取词点取到的键都在字典里」，证明不了「界面里没有没进字典的中文」，而漏迁的那句在中文界面上一切正常、切到英文才露出来，冒烟打接口永远看不见。服务端错误码另有一道对账：`functions/*.mjs` 里字面写得出的码必须在 `ERROR_KEYS` 里有一个键，而用户更容易撞上的另一类码在任何一处都不写字面、是模板按变量拼出来的（校验器拼的 `invalid_<字段>`、远端抓取拼的 `registry_<原因>`、技能源逐条跳过拼的 `skill_skipped_<原因>`、数据库读写失败按表名拼的 `<表>_request_failed`）。这道对账先按形状认出「像码」的模板（恰好一个 `${…}`、两侧静态段只剩 `[a-z_]`），再按一张取值来源表把那个变量在代码里能取到的字面全展开，拿真码去查文案，并钉住三件事：会拼码的函数必须登记在签名表上、登记了取值来源却一个值都收不到要报、长得像码但不是码的形状必须写进 `NOT_CODES` 并说清它是什么（`call_<id>` 是工具调用号、`<字段>_clipped` 是轨迹里的长度字段）——表外的新拼法、表里已没人调的旧签名都会当场报。
- **换语言才露脸的问题在源码形状层钉住，别等截图。** 中文句子结尾的「。」自己断句，拉丁文种要一个空格：JSX 里把两个取词表达式紧挨着排，中文界面一切正常、切到英文就渲染成 `…follows it.No delegate…`（群设置抽屉的替身那行真就这么错过一句）。`dev/check-schema.mjs` 的 7b 认这个形状——相邻两行各是一个 `{…}` 取词子节点、中间没有 `{" "}` 就当场报（同一行并排的两个取词也报）。同类的是宽度：德语复合词把固定宽度的控件撑截，`npm run check:schema` 管不了，只能按「最窄容器 + 明暗两主题」的截图口径查。
- **注册是副作用，注销要精确。** 注册函数返回只摘自己那一条的 disposer：同 id 重复注册就地抛错而不是静默覆盖，缺字段的注册在登记时就抛（`npm run qa` §24 锁住这三条）。没有运行时的贡献者就不要搭注册表——声明式的槽位表够用。
- **迁移只追加。** `sql/` 下按 0001→0012 递增编号建新的 `.sql`，已发布的迁移不改编；新列不回填旧行的既有语义。改完跑 `npm run check:schema`。
- **断言成对写。** 一条"越权被拒"的检查必须配一条"主人做同一件事能成"的检查，否则只读 id 列做 owner 比较会永远成立，假通过。
- **测试描述行为，不描述正确性。** 行为改了就把测试一起改掉，并在交付说明里写清为什么改。
- **重复的同类值优先对称。** 说不出理由的不对称通常是漏了一次抽取。

## 密钥与提交

- API Key、PAT、会话令牌、`auth_cipher`/`vm` 口令的**值**任何时候都不回显：不打日志、不贴进会话、不进截图、不写进文档与测试夹具。接口只回掩码尾号（[functions/util.mjs:197](functions/util.mjs#L197) `maskKey`），密文列永不出现在任何读接口的列清单里。
- **明文列里不许出现凭据。** 有些字段按设计就是明文（`vms.gateway_url` 存的是浏览器直连的 ttyd 网关地址，服务端不代理会话，所以它不需要密封）。这种字段要在写入点把形状收死：[functions/vms.mjs:197](functions/vms.mjs#L197) `gatewayOf` 只认 ws/wss/http/https，URL 里带 `user:pass@`、查询串或片段一律 `gateway_url_no_credentials` 拒掉——允许用户把 token 拼进地址，等于亲手把口令抄进一份永远明文的数据库。
- **只在用户明确要求时提交或推送。** 提交前先扫暂存内容里有没有密钥；只 `git add` 自己改过的文件，不用 `git add -A`；`git commit` 后核对 `git status`，推送前用 `git ls-remote` 确认远端状态。
- 密钥来源是环境变量与站点 Secret（`WORKSTREAM_DATA_KEY`、`WORKSTREAM_SMTP_URL`），值通过站点设置录入；需要上游真实 Key 的验证由用户提供，不代造。

## 前端与视觉验收

- **前端改动要真在浏览器里看过才算完。** 截图验收至少覆盖**最窄容器**和**明暗两种主题**（主题由 `<html data-theme>` 控制，可用 `localStorage` 的 `workstream.theme` 预置）。截图脚本放 `dev/_shots/`（已 gitignore）。
- 组件优先用 `src/lib/ui.tsx` 与 `vendor/` 里那份 shadcn/Tailwind CSS，不新引 UI 库；`recharts`、`cmdk` 这类已有依赖先查能不能复用。
- **一处颜色只有一个地方决定。** 代码按数据算出来的 SVG 颜色写在元素属性上，CSS 选择器不要再设同名属性——作者样式压过 presentation attribute，暗色主题下浅粉彩节点配近白标签就等于看不见（`npm run check:schema` 已锁住 `.ws-drawio text` 这一处）。
- 整块可点的区域不要再叠一个跳转按钮；列表按类型用小标签区分，不按类型分区。
- 数字与单位在界面上要能自证口径：拿不到就说"不回报"，不拿 0% 冒充（参照 Stream flow 缓存命中条的写法）。

## 注释与文档

- 注释用中文，**只写为什么**：隐藏的约束、微妙的不变量、某个 bug 的绕法。不复述代码在做什么，不解释远处的行为，不留下评审历史。
- 改行为的那次提交里同步改 README 对应段落与 JSDoc；一处事实只有一个家。
- 不用隐喻。要写"契约"之前先问有没有更准确的词（响应字段、JSON 校验、ESM 导出）。
- 文件末尾恰好一个换行。

## 改这份指令

保持每条规则自足，同时链到它指向的实现或门禁。能在 `dev/smoke.mjs` 或 `scripts/` 里机器可验的不变量，就优先变成一道闸而不是一条口头规矩——口头规矩会随人员流动失效，闸门不会。加规则要能指出它防的是本仓哪一种真实故障；指不出来就删掉。

## 第三方与出处

`vendor/` 只有模板带来的 shadcn/Tailwind CSS 及其许可证，来源与改动记录见 [PROVENANCE.md](PROVENANCE.md)。上游依赖自带的许可证保留在各包内。
