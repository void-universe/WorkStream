// 符合性测试套件（functions/streamcts.mjs）的命令行入口：供应商接入前在自己机器上跑，或我们替某台 server 跑。
//
// 令牌只从环境（WORKSTREAM_CTS_TOKEN）或 --token 显式给：两种都不回显，也不进 --json 的输出。
// 有任一 fail 以 1 退出，可以直接当 CI 的门；origin 不合规（带凭据、带路径）以 2 退出。
//
//   WORKSTREAM_CTS_TOKEN=… node dev/cts.mjs --url https://example.com
//   node dev/cts.mjs --url http://127.0.0.1:8123 --anonymous     # 本地参考实现的 dev 模式不收令牌
//   node dev/cts.mjs --url https://example.com --profile dedicated --only dedicated.session.turn
//   node dev/cts.mjs --list
import { CTS_CHECKS, CtsInputError, runConformance } from "../functions/streamcts.mjs";

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(name);

if (flag("--list")) {
  for (const check of CTS_CHECKS) console.log(`${check.profile.padEnd(9)} ${check.id.padEnd(36)} ${check.title}`);
  process.exit(0);
}

const url = arg("--url");
if (!url) {
  console.error("usage: node dev/cts.mjs --url <origin> [--token …|--anonymous] [--profile shared|dedicated] [--model …] [--only id,id] [--timeout ms] [--json]");
  process.exit(2);
}
const token = arg("--token") ?? process.env.WORKSTREAM_CTS_TOKEN ?? null;
if (!token && !flag("--anonymous")) {
  console.error("a token is required: set WORKSTREAM_CTS_TOKEN or pass --token; if the server under test admits anonymous callers, say so with --anonymous.");
  process.exit(2);
}
const only = arg("--only") ? arg("--only").split(",").map((id) => id.trim()).filter(Boolean) : null;

const MARK = { pass: "✓", fail: "✗", skip: "−" };

try {
  const report = await runConformance({
    origin: url,
    token: flag("--anonymous") ? null : token,
    profile: arg("--profile"),
    model: arg("--model"),
    timeoutMs: Number(arg("--timeout")) || undefined,
    only,
  });
  if (flag("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const item of report.results) {
      console.log(`${MARK[item.verdict]} ${item.id.padEnd(36)} ${String(item.ms).padStart(6)}ms  ${item.detail}`);
    }
    const { pass = 0, fail = 0, skip = 0 } = report.counts;
    console.log(`\n${report.results.length} checks: ${pass} pass, ${fail} fail, ${skip} skip (${report.profile ?? "no profile"} profile, ${report.origin})`);
  }
  process.exit(report.counts.fail ? 1 : 0);
} catch (error) {
  if (error instanceof CtsInputError) {
    console.error(`the run never started: ${error.code}${error.detail ? ` (${error.detail})` : ""}`);
    process.exit(2);
  }
  throw error;
}
