// The executor process that migration copies to the target box: one Node process, no npm install,
// no database. Everything it needs is executor.json next to the bundle, so moving an employee is
// "copy files, start a process, point the employee at it" and nothing else.
//
// Why a separate entry instead of dev/stream-server.mjs: that CLI reads env and binds loopback for
// tests. A migrated executor has to read one file (written by the migration tool, chmod 600) and
// log where the launcher can read the tail when the start fails.
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createStreamServer } from "../../functions/streamserver.mjs";
import { listenStreamServer } from "../../dev/stream-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** A missing config or a missing upstream is a deployment mistake, not a per-turn error: stop here,
 *  where the operator is still watching, instead of failing every round with stream_upstream_unconfigured. */
function readConfig() {
  const path = resolve(process.argv[2] ?? resolve(ROOT, "executor.json"));
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    process.stderr.write(`executor: cannot read ${path}: ${error?.message ?? error}\n`);
    process.exit(1);
  }
  if (!config?.upstreamUrl) {
    process.stderr.write(`executor: ${path} needs upstreamUrl (the OpenAI-compatible base URL this box calls)\n`);
    process.exit(1);
  }
  return { ...config, path };
}

const config = readConfig();
const logPath = resolve(ROOT, config.log ?? "executor.log");
if (existsSync(logPath) && statSync(logPath).size > LOG_MAX_BYTES) renameSync(logPath, `${logPath}.1`);

const log = (level, message) => {
  const line = `${new Date().toISOString()} ${level} ${message}\n`;
  appendFileSync(logPath, line);
  process.stdout.write(line);
};
for (const level of ["log", "info", "warn", "error"]) {
  console[level] = (...args) => log(level === "log" ? "info" : level, args.map(String).join(" "));
}

// Registered before the server starts: a bind failure or a bad upstream would otherwise print to a
// detached process's stderr, which nobody is reading, and the log would end at "starting".
process.on("uncaughtException", (error) => {
  log("error", `uncaught: ${error?.stack ?? error}`);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  log("error", `unhandled rejection: ${error?.stack ?? error}`);
  process.exit(1);
});

const server = createStreamServer({
  upstreamUrl: config.upstreamUrl,
  upstreamKey: config.upstreamKey ?? null,
  upstreamModel: config.upstreamModel ?? null,
  token: config.token ?? null,
  dev: config.dev === true,
  label: config.label ?? null,
  models: Array.isArray(config.models) ? config.models : null,
});
const started = await listenStreamServer({
  server,
  host: config.host ?? "127.0.0.1",
  port: Number(config.port ?? 8300),
  log: (line) => log("info", line),
});

log("info", `executor ready pid=${process.pid} origin=${started.origin} profiles=${server.descriptor.profiles.map((entry) => entry.id).join(",")}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log("info", `executor received ${signal}, closing`);
    void started.close().then(() => process.exit(0));
  });
}
