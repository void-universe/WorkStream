// Remote-side process control for a migrated executor. It is invoked over ssh as a single command
// (`node <dir>/scripts/executor/launcher.mjs start`) and always prints one JSON line, so the
// migration tool never has to parse shell output or rely on a particular remote shell.
//
// Detached spawn is why this exists instead of `nohup ... &`: `&`, `nohup` and quoting differ
// between sh, cmd and PowerShell, while `node launcher.mjs start` is the same string everywhere.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUN = resolve(ROOT, "scripts/executor/run.mjs");
const CONFIG = resolve(ROOT, "executor.json");
const STATE = resolve(ROOT, "executor.state.json");
const DISCOVERY_TIMEOUT_MS = 5000;

const say = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const fail = (error, extra = {}) => {
  say({ ok: false, error, ...extra });
  process.exit(1);
};

function readConfig() {
  if (!existsSync(CONFIG)) fail("executor_config_missing", { path: CONFIG });
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch (error) {
    fail("executor_config_invalid", { detail: String(error?.message ?? error) });
  }
}

/** The pid alone cannot tell two runs apart: a re-migration writes a new token into executor.json,
 *  and reusing the old process would leave the employee holding a key the process never saw. */
function fingerprint(config) {
  const material = [config.host, config.port, config.token, config.upstreamUrl, config.upstreamKey, config.upstreamModel];
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}

function readState() {
  try {
    const state = JSON.parse(readFileSync(STATE, "utf8"));
    return Number.isInteger(state?.pid) && state.pid > 0 ? state : null;
  } catch {
    return null;
  }
}

/** Older bundles recorded only the pid. Keep honouring it so upgrading the launcher cannot leave a
 *  forgotten executor holding the port (the migration would otherwise fail with a bare 401). */
function readLegacyPid() {
  try {
    const pid = Number(readFileSync(resolve(ROOT, "executor.pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Signal 0 asks the OS whether the pid exists without touching it; EPERM still means "alive". */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function discovery(config, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  const url = `http://127.0.0.1:${Number(config.port ?? 8300)}/stream-server/v1`;
  const response = await fetch(url, {
    headers: config.token ? { authorization: `Bearer ${config.token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw Object.assign(new Error(`discovery_${response.status}`), { status: response.status });
  return body;
}

/** Does anything answer on the configured port? A 401 or a stall both mean the port is taken. */
async function portAnswers(config) {
  const url = `http://127.0.0.1:${Number(config.port ?? 8300)}/stream-server/v1`;
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    if (code === "ECONNREFUSED") return false;
    return error?.name === "TimeoutError";
  }
}

function logTail(config, bytes = 2000) {  const path = resolve(ROOT, config?.log ?? "executor.log");
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").slice(-bytes);
  } catch {
    return null;
  }
}

async function terminate(pid) {
  if (!pid || !alive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Fall through to the liveness check; an EPERM would surface there.
  }
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && alive(pid)) await new Promise((done) => setTimeout(done, 200));
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Windows terminates on SIGTERM only; the caller reports what is left.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  const stopped = !alive(pid);
  if (stopped) rmSync(STATE, { force: true });
  return stopped;
}

async function start(config) {
  const state = readState() ?? { pid: readLegacyPid(), fingerprint: null };
  if (state.pid && alive(state.pid) && state.fingerprint === fingerprint(config)) {
    const body = await discovery(config, 3000).catch(() => null);
    if (body) {
      say({ ok: true, started: false, pid: state.pid, descriptor: body });
      return;
    }
  }
  if (state.pid && alive(state.pid)) await terminate(state.pid);
  // Anything still answering on the port after our own process is gone belongs to someone else
  // (another executor, another config). Spawning would only crash with EADDRINUSE; name it instead.
  if (await portAnswers(config)) {
    fail("port_in_use", { port: Number(config.port ?? 8300), hint: "stop whatever listens there, or migrate with --port <free port>" });
  }
  const child = spawn(process.execPath, [RUN, CONFIG], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  writeFileSync(STATE, JSON.stringify({ pid: child.pid, fingerprint: fingerprint(config) }), "utf8");

  const deadline = Date.now() + Number(config.startTimeoutMs ?? 20000);
  let lastError = "executor_not_ready";
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 300));
    try {
      const body = await discovery(config, 2000);
      say({ ok: true, started: true, pid: child.pid, descriptor: body });
      return;
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
  }
  await terminate(child.pid);
  fail("executor_not_ready", { pid: child.pid, detail: lastError, log: logTail(config) });
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv.find((item) => !item.startsWith("--")) ?? "status";
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : null;
  };

  if (command === "install") {
    // Bootstrapping: the only file that exists before the bundle does is this launcher, copied into
    // the login directory. `install` creates the real root so scp has somewhere to put the rest.
    const root = resolve(process.cwd(), flag("root") ?? ROOT);
    mkdirSync(root, { recursive: true });
    say({ ok: true, root });
    return;
  }
  if (command === "cleanup") {
    // The bootstrap copy lives in the login directory; remove it once the real bundle is in place.
    try {
      unlinkSync(fileURLToPath(import.meta.url));
      say({ ok: true, removed: true });
    } catch (error) {
      say({ ok: true, removed: false, detail: String(error?.message ?? error) });
    }
    return;
  }

  const config = readConfig();
  if (command === "start") return start(config);
  if (command === "stop") {
    const pid = readState()?.pid ?? null;
    const stopped = await terminate(pid);
    say({ ok: stopped, stopped, pid });
    if (!stopped) process.exit(1);
    return;
  }
  if (command === "health") {
    try {
      say({ ok: true, descriptor: await discovery(config) });
    } catch (error) {
      fail("executor_unreachable", { detail: String(error?.message ?? error), log: logTail(config) });
    }
    return;
  }
  if (command === "chmod") {
    // The config holds the bearer token and the upstream key; 0600 where the OS supports it.
    try {
      chmodSync(CONFIG, 0o600);
      say({ ok: true, mode: "0600" });
    } catch (error) {
      say({ ok: true, mode: "unsupported", detail: String(error?.message ?? error) });
    }
    return;
  }
  if (command === "config") {
    // Read back by the migration tool when moving this executor to another box: the next box must
    // call the same upstream. Only the upstream triple crosses the wire — the bearer token stays
    // on the box it belongs to.
    say({ ok: true, config: { upstreamUrl: config.upstreamUrl, upstreamKey: config.upstreamKey, upstreamModel: config.upstreamModel } });
    return;
  }
  if (command === "status") {
    const pid = readState()?.pid ?? null;
    const running = alive(pid);
    const body = running ? await discovery(config, 3000).catch(() => null) : null;
    say({ ok: true, running, pid: running ? pid : null, descriptor: body });
    return;
  }
  fail("unknown_command", { command, known: ["install", "start", "stop", "status", "health", "chmod", "config", "cleanup"] });
}

await main();
