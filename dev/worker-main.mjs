// 独立 worker 进程入口：脱离站点 Function 单独跑，对着同一个库认领与提交回合。
// 分布式部署时每台 server 起一个（label 区分），控制面升级/重启不影响这里在跑的活。
// 用法：node dev/worker-main.mjs [数据文件] [--label 名称] [--tick 毫秒] [--heartbeat 毫秒] [--client 模块]
//   默认用本机假库（dev/.wsdb.json），与 local-function 同一份数据；清空它即可重来。
//   --client 指向一个默认导出 async (env) => supabaseClient 的模块，接真实库（部署侧的租户路由/凭据由它决定）。
// 这里不猜生产库的接法：平台租户路由还是裸 Supabase 是部署事实，交给 --client 模块，配错就冷启动崩。
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { startWorker } from "../functions/worker.mjs";
import { createFixtureClient } from "./fixture-supabase.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const positional = argv.filter((item, index) => !item.startsWith("--") && argv[index - 1]?.startsWith("--") !== true);
const file = resolve(positional[0] ?? join(here, ".wsdb.json"));
const env = (name) => process.env[name];
process.env.WORKSTREAM_DEV = "1";

const clientModule = flag("--client");
let supabase;
if (clientModule) {
  const factory = (await import(resolve(clientModule))).default;
  if (typeof factory !== "function") throw new Error("--client 模块必须默认导出 async (env) => supabaseClient");
  supabase = await factory(env);
} else {
  supabase = createFixtureClient(file);
  console.log(`本地数据库文件：${file}`);
}

const worker = startWorker({
  supabase, env,
  label: flag("--label") ?? "worker",
  tickMs: Number(flag("--tick") ?? 1_000),
  heartbeatMs: Number(flag("--heartbeat") ?? 5_000),
});

// 收到终止信号就优雅排空：停认领、等在跑回合收尾、落 stopped，不硬掐正在生成的回复。
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[worker] 收到 ${signal}，排空在跑回合后退出`);
    void worker.stop().then(() => process.exit(0));
  });
}
