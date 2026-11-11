// Moves one virtual employee's executor from this machine to a remote box (or back), without
// touching the employee's data: memory, streams, mail and skills all live in the WorkStream
// database, so a migration is "run the executor over there, point the employee at it".
//
// Why a CLI and not a backend action: an Edge Function has no raw TCP sockets, so the product can
// never open the SSH connection itself (docs/guide.en.md, "Deployment status"). The operator's
// machine already holds the key, which is exactly what passwordless ssh means.
//
// The employee switch is one `agents.update`: the server re-runs discovery inside that request and
// writes nothing when discovery fails, so the commit point is atomic and the old address keeps
// working until the new executor has answered.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { safeApiBaseUrl } from "../functions/util.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_API = "http://127.0.0.1:8000/functions/v1/app";
const DEFAULT_PORT = 8300;
const REMOTE_BASE = "workstream-executor";
const LOCAL_BASE = resolve(REPO, "dev/.executor");
const RECORD_BASE = resolve(REPO, "dev/.migrate");
const DISCOVERY_PATH = "/stream-server/v1";
const NODE_MIN_MINOR = 12;

/* ------------------------------------------------------------------ pure helpers (gated by smoke) */

/** `v22.14.0` / `22.14.0` → { major, minor, patch }. Anything unparsable is a failed preflight, not a guess. */
export function parseNodeVersion(raw) {
  const match = String(raw ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** The executor bundle is the same Node-only code the repo runs; 22.12 is the floor the gate enforces. */
export function assertNodeVersion(raw) {
  const version = parseNodeVersion(raw);
  if (!version) throw Object.assign(new Error(`cannot parse node version "${raw}"`), { code: "node_version_invalid" });
  if (version.major !== 22 || version.minor < NODE_MIN_MINOR) {
    throw Object.assign(
      new Error(`executor needs Node 22.${NODE_MIN_MINOR}+ (found ${version.major}.${version.minor}.${version.patch}); install Node 22 on the target and retry`),
      { code: "node_version" },
    );
  }
  return version;
}

/** The address the employee will dial. Reuses the server's own SSRF rules so the CLI cannot book an
 *  address the backend would refuse later (`insecure_api_base_url` / `private_api_base_url`). */
export function normalizeEndpoint(raw, { allowHttp = false } = {}) {
  if (raw === "demo://local") {
    throw Object.assign(new Error("the demo endpoint cannot be reached from another box"), { code: "demo_endpoint" });
  }
  try {
    return safeApiBaseUrl(raw, { allowPrivate: allowHttp });
  } catch (error) {
    throw Object.assign(new Error(error?.error ?? String(error?.message ?? error)), { code: error?.error ?? "invalid_url" });
  }
}

/** Everything the remote process needs, and nothing it can infer. Token is generated per migration. */
export function buildExecutorConfig({ port = DEFAULT_PORT, host = "127.0.0.1", token, upstreamUrl, upstreamKey = null, upstreamModel = null, label, models = null }) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw Object.assign(new Error(`port must be 1-65535, got ${port}`), { code: "bad_port" });
  }
  if (typeof token !== "string" || token.length < 32) {
    throw Object.assign(new Error("executor token must be at least 32 characters"), { code: "bad_token" });
  }
  if (!upstreamUrl) throw Object.assign(new Error("upstreamUrl is required: the box has to call a model"), { code: "upstream_missing" });
  return {
    host, port: Number(port), token, upstreamUrl,
    upstreamKey, upstreamModel,
    label: label ?? "workstream-executor",
    models,
    log: "executor.log",
  };
}

/** Remote layout is relative on purpose: ssh/scp start in the login directory, and a relative path
 *  has no spaces, so it survives every remote shell (sh, cmd, PowerShell) without quoting. */
export function remoteDirFor(agentId) {
  return `${REMOTE_BASE}/${agentId}`;
}

/** Where the last migration of this employee went. It carries no secret on purpose: the target,
 *  the directory and the upstream address are enough to stop the old executor and default the next
 *  run, while the bearer token and the upstream key live only in the bundle on its own machine. */
export function recordPath(agentId) {
  return join(RECORD_BASE, `${agentId}.json`);
}

export function readRecord(agentId) {
  try {
    return JSON.parse(readFileSync(recordPath(agentId), "utf8"));
  } catch {
    return null;
  }
}

export function writeRecord(agentId, record) {
  mkdirSync(RECORD_BASE, { recursive: true });
  writeFileSync(recordPath(agentId), `${JSON.stringify({ ...record, agentId, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** A -> B leaves the executor on A running unless someone stops it. Same target and same directory
 *  means "the same bundle, restarted by the launcher", so stopping it there would kill the new run. */
export function shouldStopSource({ previous, target, dir, keepSource = false }) {
  if (keepSource || !previous?.target) return false;
  if (previous.target === target && previous.dir === dir) return false;
  return true;
}

/** `user@host:port` — the port is optional and Termux's sshd lives on 8022, so parsing it is what
 *  keeps a phone from being dialled on 22. Returns the ssh target and the port separately. */
export function parseTarget(raw) {
  const match = String(raw ?? "").match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
  if (!match) throw Object.assign(new Error(`--to must be user@host[:port], got "${raw}"`), { code: "target_invalid" });
  return {
    target: match[1] ? `${match[1]}@${match[2]}` : match[2],
    sshPort: match[3] ? Number(match[3]) : null,
  };
}

export function parseArgs(argv) {
  const options = { allowHttp: false, trustNewHost: false, dryRun: false, json: false, revert: false, keepSource: false, help: false };
  const valued = new Set([
    "employee", "to", "dir", "port", "host", "public-url", "upstream-url", "upstream-key",
    "upstream-model", "model", "api", "token-file", "email", "password-file",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw Object.assign(new Error(`unexpected argument "${item}"`), { code: "bad_args" });
    const [rawName, inline] = item.slice(2).split("=");
    if (valued.has(rawName)) {
      const value = inline ?? argv[index + 1];
      if (value === undefined) throw Object.assign(new Error(`--${rawName} needs a value`), { code: "bad_args" });
      if (inline === undefined) index += 1;
      options[rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      continue;
    }
    if (rawName === "allow-http") options.allowHttp = true;
    else if (rawName === "trust-new-host") options.trustNewHost = true;
    else if (rawName === "dry-run") options.dryRun = true;
    else if (rawName === "keep-source") options.keepSource = true;
    else if (rawName === "json") options.json = true;
    else if (rawName === "revert") options.revert = true;
    else if (rawName === "help") options.help = true;
    else throw Object.assign(new Error(`unknown flag --${rawName}`), { code: "bad_args" });
  }
  if (options.revert && !options.to) options.to = "local";
  return options;
}

/* ------------------------------------------------------------------------------ the HTTP side */

class ApiError extends Error {
  constructor(code, status, detail) {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function createApi(base, token) {
  const call = async (action, { body = null, query = null } = {}) => {
    const url = new URL(base);
    url.searchParams.set("action", action);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-workstream-token": token } : {}) },
      body: body ? JSON.stringify(body) : "{}",
      signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new ApiError(payload?.error ?? `http_${response.status}`, response.status, payload);
    }
    return payload;
  };
  return { call };
}

/** Hidden prompt: a session token and the account password are never echoed, never put on argv. */
async function promptHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw Object.assign(new Error("no TTY to prompt on; pass --token-file or WORKSTREAM_TOKEN"), { code: "no_tty" });
  process.stdout.write(question);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise((done, reject) => {
    let value = "";
    const finish = (error, result) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      if (error) reject(error);
      else done(result);
    };
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish(null, value);
        if (char === "\u0003") return finish(Object.assign(new Error("cancelled"), { code: "cancelled" }));
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
      process.stdout.write("*".repeat(value.length) + "\r" + question + "*".repeat(value.length));
    };
    stdin.on("data", onData);
  });
}

async function resolveSession(options) {
  const base = options.api ?? process.env.WORKSTREAM_API ?? DEFAULT_API;
  const fileToken = options.tokenFile ? readFileSync(options.tokenFile, "utf8").trim() : null;
  const token = process.env.WORKSTREAM_TOKEN ?? fileToken;
  if (token) return { api: createApi(base, token), base, token };
  if (!options.email) {
    throw Object.assign(new Error("no session: set WORKSTREAM_TOKEN, pass --token-file, or pass --email to log in"), { code: "no_session" });
  }
  const password = options.passwordFile
    ? readFileSync(options.passwordFile, "utf8").trim()
    : process.env.WORKSTREAM_PASSWORD ?? await promptHidden(`password for ${options.email}: `);
  const response = await createApi(base, null).call("auth.login", { body: { email: options.email, password } });
  return { api: createApi(base, response.token), base, token: response.token };
}

/* --------------------------------------------------------------------------- ssh / scp plumbing */

export function sshCommon(options) {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", options.trustNewHost ? "StrictHostKeyChecking=accept-new" : "StrictHostKeyChecking=yes",
  ];
  if (options.sshPort) args.push("-p", String(options.sshPort));
  return args;
}

function runBinary(command, args, { input = undefined, timeout = 120000 } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", input, timeout, windowsHide: true });
  if (result.error) {
    throw Object.assign(new Error(`${command} could not start: ${result.error.message}`), { code: `${command}_failed` });
  }
  return result;
}

function sshRun(options, remoteArgs, { timeout = 120000 } = {}) {
  const result = runBinary("ssh", [...sshCommon(options), options.target, ...remoteArgs], { timeout });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join("\n");
    const hint = /refused|timed out|Permission denied|Could not resolve|host key|not found|not recognized/i.test(detail)
      ? " — passwordless ssh to this target must already work (BatchMode=yes never prompts), and `node` must be on PATH for a non-interactive shell"
      : "";
    throw Object.assign(new Error(`ssh ${options.target} failed: ${detail || `status ${result.status}`}${hint}`), { code: "ssh_failed" });
  }
  return result.stdout;
}

export function scpCommon(options) {
  // scp spells the port -P while ssh spells it -p; sharing the option list would silently dial 22.
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", options.trustNewHost ? "StrictHostKeyChecking=accept-new" : "StrictHostKeyChecking=yes",
  ];
  if (options.sshPort) args.push("-P", String(options.sshPort));
  return args;
}

function scpTo(options, sources, destination) {
  const result = runBinary("scp", [...scpCommon(options), "-r", ...sources, `${options.target}:${destination}`]);
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim().split("\n").slice(-3).join("\n");
    throw Object.assign(new Error(`scp failed: ${detail || `status ${result.status}`}`), { code: "scp_failed" });
  }
}

/** ssh prints one JSON line per launcher command; anything else is a shell banner, not our answer. */
function lastJson(text) {
  const lines = String(text ?? "").trim().split("\n").reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // Keep looking: a banner or a stack line can sit above the payload.
    }
  }
  return null;
}

/* ------------------------------------------------------------------------------- local plumbing */

/** Launcher payloads carry a machine code plus a human hint/detail; keep both, without the
 *  "port_in_use: port_in_use" doubling that comes from printing the code twice. */
function errorFromPayload(payload) {
  const message = payload?.hint ?? payload?.detail ?? payload?.error ?? "launcher_failed";
  return Object.assign(new Error(message), { code: payload?.error ?? "launcher_failed", detail: payload });
}

function nodeLauncher(launcherPath, command) {
  const result = spawnSync(process.execPath, [launcherPath, command], { encoding: "utf8", timeout: 120000, windowsHide: true });
  const payload = lastJson(result.stdout);
  if (result.status !== 0 || !payload?.ok) throw errorFromPayload(payload);
  return payload;
}

/** What the source executor calls upstream. Reading it from the box keeps A -> B to one command and
 *  keeps the upstream key off the operator's disk: it travels over the ssh session that moves the
 *  bundle. A source that cannot be reached simply yields nothing; the flags still win. */
async function readSourceConfig(previous, options) {
  if (!previous?.target || !previous.dir) return null;
  const upstreamOf = (config) => config
    ? { upstreamUrl: config.upstreamUrl ?? null, upstreamKey: config.upstreamKey ?? null, upstreamModel: config.upstreamModel ?? null }
    : null;
  try {
    if (previous.target === "local") {
      const path = join(previous.dir, "executor.json");
      return existsSync(path) ? upstreamOf(JSON.parse(readFileSync(path, "utf8"))) : null;
    }
    const payload = lastJson(sshRun(
      { ...options, target: previous.target, sshPort: previous.sshPort ?? null },
      ["node", `${previous.dir}/scripts/executor/launcher.mjs`, "config"],
      { timeout: 20000 },
    ));
    return payload?.ok ? upstreamOf(payload.config) : null;
  } catch {
    return null;
  }
}

/** Stop the executor the employee came from, now that the switch has landed. A source we cannot
 *  reach is a cleanup chore the operator can finish later, not a reason to fail the migration. */
async function stopSourceExecutor(previous, options, log) {
  try {
    if (previous.target === "local") {
      const payload = nodeLauncher(join(previous.dir, "scripts/executor/launcher.mjs"), "stop");
      log(`source executor stopped (local, pid ${payload.pid ?? "—"})`);
      return;
    }
    const payload = lastJson(sshRun(
      { ...options, target: previous.target, sshPort: previous.sshPort ?? null },
      ["node", `${previous.dir}/scripts/executor/launcher.mjs`, "stop"],
      { timeout: 30000 },
    ));
    log(`source executor stopped on ${previous.target} (pid ${payload?.pid ?? "—"})`);
  } catch (error) {
    log(`source not stopped (${previous.target}: ${error?.message ?? error}) — stop it by hand if it still listens on port ${previous.port}`);
  }
}

/** A turn that is still running on the old executor dies with it. Wait for the mailbox to go quiet;
 *  when it does not, the caller leaves the old process alone instead of cutting a live answer.
 *  `current` is the running letter (functions/presence.mjs); queued letters will simply run later
 *  on the new executor, so they do not hold the stop. */
async function waitForIdle(api, agentId, log, { timeoutMs = 20000, everyMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    const presence = await api.call("agents.presence", { query: { agent_id: agentId } }).catch(() => null);
    if (presence && !presence.current) return true;
    if (Date.now() >= deadline) return false;
    if (!announced) {
      log(`waiting up to ${Math.round(timeoutMs / 1000)}s for the running turn to finish before stopping the source`);
      announced = true;
    }
    await new Promise((done) => setTimeout(done, everyMs));
  }
}

/* ------------------------------------------------------------------------------- the migration */

function stageBundle(config) {
  const staging = mkdtempSync(join(tmpdir(), "workstream-bundle-"));
  // Only .mjs files: the executor graph imports nothing outside Node built-ins, so the box needs
  // no npm install. functions/index.ts is the Deno adapter and would be dead weight here.
  mkdirSync(join(staging, "functions"), { recursive: true });
  for (const entry of readdirSync(join(REPO, "functions"))) {
    if (entry.endsWith(".mjs")) cpSync(join(REPO, "functions", entry), join(staging, "functions", entry));
  }
  mkdirSync(join(staging, "dev"), { recursive: true });
  cpSync(join(REPO, "dev/stream-server.mjs"), join(staging, "dev/stream-server.mjs"));
  cpSync(join(REPO, "scripts/executor"), join(staging, "scripts/executor"), { recursive: true });
  writeFileSync(join(staging, "executor.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return staging;
}

/** Copy the staged tree into a directory that may already exist (a second migration to the same
 *  employee): copying the staging root itself would nest it one level deeper every time. */
function copyInto(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) cpSync(join(from, entry), join(to, entry), { recursive: true });
}

async function resolveEmployee(api, wanted) {
  const list = await api.call("agents.list");
  const needle = String(wanted ?? "").trim();
  if (!needle) throw Object.assign(new Error("--employee needs an id or a name"), { code: "employee_missing" });
  const exact = list.items.filter((item) => item.id === needle);
  if (exact.length === 1) return exact[0];
  const byName = list.items.filter((item) => item.name === needle);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw Object.assign(new Error(`${byName.length} employees are named "${needle}"; pass the id instead`), { code: "employee_ambiguous" });
  throw Object.assign(new Error(`no employee matches "${needle}"`), { code: "employee_not_found" });
}

async function switchEmployee(api, agent, { publicUrl, token, model }) {
  const body = { id: agent.id, backend: "stream", api_base_url: publicUrl, api_key: token };
  if (model) body.model = model;
  const response = await api.call("agents.update", { body });
  return response.agent;
}

async function probePublic(publicUrl, token) {
  const response = await fetch(`${publicUrl}${DISCOVERY_PATH}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw Object.assign(new Error(`discovery ${response.status} at ${publicUrl}`), { code: "public_unreachable" });
  return payload;
}

export async function migrate(options, log = () => {}) {
  const toLocal = options.to === "local";
  if (!toLocal && !options.to) {
    throw Object.assign(new Error("--to is required: user@host[:port] for a remote box, or local"), { code: "target_missing" });
  }
  if (!toLocal) {
    const parsed = parseTarget(options.to);
    options.target = parsed.target;
    options.sshPort = parsed.sshPort;
  }

  const session = await resolveSession(options);
  log(`session ready against ${session.base}`);
  const agent = await resolveEmployee(session.api, options.employee);
  if ((agent.backend ?? "openai") !== "stream") {
    throw Object.assign(
      new Error(`"${agent.name}" runs on the ${agent.backend ?? "openai"} backend; this tool only moves Stream Server executors (switch the backend in the UI first)`),
      { code: "employee_not_stream" },
    );
  }
  log(`employee ${agent.name} (${agent.id}) backend=stream url=${agent.api_base_url ?? "—"} profile=${agent.stream_profile ?? "—"}`);

  // The record of the previous migration is what makes A -> B work without ever touching A: it
  // supplies the upstream defaults (so B runs the same model) and the address to stop afterwards.
  const previous = readRecord(agent.id);
  const localConfigPath = join(LOCAL_BASE, agent.id, "executor.json");
  const localConfig = existsSync(localConfigPath) ? JSON.parse(readFileSync(localConfigPath, "utf8")) : null;
  // Only pay for the extra ssh round trip when the flags and the environment do not already say
  // which upstream the new box should call.
  const needsUpstream = !(options.upstreamUrl ?? process.env.WORKSTREAM_STREAM_UPSTREAM_URL)
    || !(options.upstreamModel ?? process.env.WORKSTREAM_STREAM_UPSTREAM_MODEL);
  const sourceConfig = needsUpstream ? await readSourceConfig(previous, options) : null;
  const upstreamUrl = options.upstreamUrl ?? process.env.WORKSTREAM_STREAM_UPSTREAM_URL ?? sourceConfig?.upstreamUrl ?? localConfig?.upstreamUrl ?? null;
  const upstreamKey = options.upstreamKey ?? process.env.WORKSTREAM_STREAM_UPSTREAM_KEY ?? sourceConfig?.upstreamKey ?? localConfig?.upstreamKey ?? null;
  const upstreamModel = options.upstreamModel ?? process.env.WORKSTREAM_STREAM_UPSTREAM_MODEL ?? sourceConfig?.upstreamModel ?? localConfig?.upstreamModel ?? null;
  const port = Number(options.port ?? previous?.port ?? localConfig?.port ?? DEFAULT_PORT);

  const publicUrl = toLocal ? `http://127.0.0.1:${port}` : options.publicUrl ? normalizeEndpoint(options.publicUrl, { allowHttp: options.allowHttp }).url : null;
  if (!toLocal && !publicUrl) throw Object.assign(new Error("--public-url is required for a remote target (the address WorkStream will dial)"), { code: "public_url_missing" });

  const token = randomBytes(32).toString("base64url");
  const target = toLocal ? "local" : options.target;
  const dir = toLocal
    ? (options.dir ? resolve(REPO, options.dir) : join(LOCAL_BASE, agent.id))
    : (options.dir ?? remoteDirFor(agent.id));
  if (String(dir).includes(" ")) throw Object.assign(new Error(`--dir must not contain spaces (ssh/scp run it through the remote shell): "${dir}"`), { code: "bad_dir" });
  const config = buildExecutorConfig({
    port,
    host: options.host ?? (toLocal ? "127.0.0.1" : publicUrl.startsWith("https:") ? "127.0.0.1" : "0.0.0.0"),
    token,
    upstreamUrl,
    upstreamKey,
    upstreamModel,
    models: upstreamModel ? [upstreamModel] : null,
  });
  const stopSource = shouldStopSource({ previous, target, dir, keepSource: options.keepSource });

  const plan = {
    employee: { id: agent.id, name: agent.name },
    target,
    dir,
    publicUrl,
    bind: config.host,
    port,
    upstreamUrl,
    source: previous ? { target: previous.target, dir: previous.dir, port: previous.port } : null,
    stopSource,
    tokenTail: token.slice(-4),
    switchBody: { backend: "stream", api_base_url: publicUrl, model: options.model ?? agent.model },
  };
  if (options.dryRun) {
    log("dry run: nothing was copied, started or switched");
    return { ok: true, dryRun: true, plan };
  }

  let started = null;
  let staging = null;
  try {
    if (toLocal) {
      const root = dir;
      staging = stageBundle(config);
      copyInto(staging, root);
      started = nodeLauncher(join(root, "scripts/executor/launcher.mjs"), "start");
      log(`executor started locally pid=${started.pid}`);
    } else {
      log(`ssh preflight ${options.target}`);
      const version = sshRun(options, ["node", "-p", "process.versions.node"], { timeout: 30000 }).trim();
      assertNodeVersion(version);
      log(`target node ${version}`);

      staging = stageBundle(config);
      // The bootstrap is the one file that has to land before the bundle root exists; `install`
      // creates that root, then scp can copy into it and the copy in the login dir is removed.
      scpTo(options, [join(REPO, "scripts/executor/launcher.mjs")], "ws-bootstrap.mjs");
      try {
        sshRun(options, ["node", "ws-bootstrap.mjs", "install", "--root", dir], { timeout: 30000 });
        scpTo(options, [join(staging, "functions"), join(staging, "dev"), join(staging, "scripts"), join(staging, "executor.json")], `${dir}/`);
        sshRun(options, ["node", `${dir}/scripts/executor/launcher.mjs`, "chmod"], { timeout: 30000 });
        started = lastJson(sshRun(options, ["node", `${dir}/scripts/executor/launcher.mjs`, "start"], { timeout: 60000 }));
      } finally {
        sshRun(options, ["node", "ws-bootstrap.mjs", "cleanup"], { timeout: 15000 });
      }
      if (!started?.ok) throw errorFromPayload(started);
      log(`executor started on ${options.target} pid=${started.pid}`);
    }

    const discovery = await probePublic(publicUrl, token);
    log(`discovery answered at ${publicUrl}: profiles=${(discovery.profiles ?? []).map((item) => item.id).join(",") || "—"}`);

    let switched;
    try {
      switched = await switchEmployee(session.api, agent, { publicUrl, token, model: options.model });
    } catch (error) {
      // The server re-checks the address with its own SSRF rules; naming the fix saves a round trip.
      const hint = error.code === "private_api_base_url"
        ? " — the WorkStream server refuses private-network addresses: give it an https address it can reach, or run it with WORKSTREAM_DEV=1"
        : error.code === "insecure_api_base_url"
          ? " — production accepts https only: put TLS in front of the executor"
          : "";
      throw Object.assign(new Error(`employee switch rejected (${error.code})${hint}; it still points at ${agent.api_base_url ?? "its old address"}`), { code: "switch_rejected", detail: error.detail });
    }
    log(`employee switched: stream_profile=${switched.stream_profile ?? "—"}`);

    const test = await session.api.call("agents.test", { body: { id: agent.id } });
    const result = test.result ?? {};
    if (result.reachable === false) {
      throw Object.assign(
        new Error(`employee was switched but the live check failed (${result.error ?? "unreachable"}); revert with --to local`),
        { code: "live_check_failed", detail: result },
      );
    }
    log(`live check ok: mode=${result.mode ?? "—"} profile=${result.profile ?? "—"} reply=${result.reply ?? ""}`);

    // The employee's data never moved: memory, skills, streams and the transcript live in the
    // WorkStream database, and a shared executor is stateless (each turn carries the blocks and
    // tools). What does not survive a move is a turn that is still in flight on the old process,
    // so stop it only after the switch, and only once the mailbox has gone quiet.
    if (stopSource) {
      if (await waitForIdle(session.api, agent.id, log)) await stopSourceExecutor(previous, options, log);
      else log(`source left running: a turn is still in flight on ${previous.target}; stop it by hand when it finishes`);
    }
    writeRecord(agent.id, {
      target, dir, port, publicUrl, upstreamUrl, upstreamModel, sshPort: options.sshPort ?? null,
    });
    return {
      ok: true,
      employee: { id: agent.id, name: agent.name },
      target,
      publicUrl,
      pid: started?.pid ?? null,
      profile: switched.stream_profile ?? null,
      sourceStopped: stopSource,
      reply: result.reply ?? null,
    };
  } catch (error) {
    if (started?.pid && !toLocal) {
      // Leaving a half-configured executor running would hold a port and burn the upstream key for
      // nobody; the employee was never switched (or the error says it was), so stop the process.
      try {
        sshRun(options, ["node", `${dir}/scripts/executor/launcher.mjs`, "stop"], { timeout: 30000 });
      } catch {
        // Best effort: the original error is what the operator needs to see.
      }
    }
    throw error;
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------------------- CLI glue */

function usage() {
  return [
    "Move an employee's Stream Server executor between this machine and a remote box.",
    "",
    "  node scripts/migrate.mjs --employee <id|name> --to <user@host[:port]|local> \\",
    "    [--public-url https://box.example.com] [--port 8300] [--dir workstream-executor/<id>] \\",
    "    [--upstream-url https://api.example.com/v1] [--upstream-key ...] [--upstream-model ...] \\",
    "    [--api http://127.0.0.1:8000/functions/v1/app] [--token-file <path>] [--email you@example.com]",
    "",
    "  --host <bind>      interface the executor listens on (default 127.0.0.1, or 0.0.0.0 with --allow-http)",
    "  --model <name>     model stored on the employee after the switch (default: keep the current one)",
    "  --allow-http       accept a plain-http or private-network address (self-hosted dev only)",
    "  --trust-new-host   accept an unknown ssh host key (default: known_hosts must already have it)",
    "  --dry-run          print the plan without copying, starting or switching anything",
    "  --revert           same as --to local: start the local executor again and point the employee at it",
  ].join("\n");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error?.code ?? "bad_args"}: ${error?.message ?? error}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const log = (line) => {
    if (!options.json) process.stdout.write(`${line}\n`);
  };
  try {
    const result = await migrate(options, log);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`done: ${result.employee.name} → ${result.target} (${result.publicUrl})\n`);
  } catch (error) {
    const code = error?.code ?? "migrate_failed";
    process.stderr.write(`error: ${code}: ${error?.message ?? error}\n`);
    if (error?.detail) process.stderr.write(`${JSON.stringify(error.detail)}\n`);
    process.exitCode = 1;
  }
}

const isEntry = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntry) await main();
