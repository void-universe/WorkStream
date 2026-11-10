# WorkStream Distributed Architecture and Turn Contract

**English** · [简体中文](distributed.md)

control plane · execution plane · unified turn interface | source: `functions/agents.mjs`, `functions/backends.mjs`, `functions/qca.mjs`, `functions/worker.mjs`, `dev/worker-main.mjs` | the dispatch-loop details are in [scheduler.en.md](scheduler.en.md)

**One-page conclusion.** The control plane (the WorkStream server) only reads and writes the database; the execution plane is worker processes spread across several servers, claiming and committing against that same database. Every backend channel -- the self-hosted OpenAI-compatible endpoint, the built-in demo model, the Qoder Cloud Agent, and an executor server attached through the specification -- converges on one turn interface: `completeForAgent` dispatches by `transport`, passes the arguments through to that channel verbatim, and the return value has one shape. Context authority always stays in WorkStream, and the cloud/CLI session is only a rebuildable cache; the chain of thought never enters the stream; interrupts are unified on the QCA pattern (ask even while idle, hand up the half-finished text). The round lives in the worker process, so a control-plane upgrade/restart cannot cut off work in flight.

---

## 1. Topology: control plane separated from execution plane

- **One shared database (option A)**: workers do not go through an HTTP task API, they connect directly to the same database as the control plane. The claim is a single-row CAS `queued→running` on `mail`; any worker can claim any mail (no owner pinning), and when several race at once only one wins.
- **One trust domain**: each worker holds the database service key and the `WORKSTREAM_DATA_KEY` master key, at the same level as the control plane. Credential values are never echoed (only a masked tail), and egress addresses go through `safeApiBaseUrl`.
- **A control-plane upgrade does not interrupt execution**: under `WORKSTREAM_EXECUTION=worker`, the control plane's `scheduler.tick` (with no worker context) returns early before reclaim, yielding `execution:"worker"` and `ran:[]`; claiming and execution all happen in the standalone worker process. When the control plane restarts, the round is still alive on the worker side and runs to the commit point and lands in the stream as usual. The tick/claim/heartbeat/reclaim mechanics are in [scheduler.en.md](scheduler.en.md) section 3.7.
- **The worker entry**: `startWorker` in `functions/worker.mjs` is the resident loop; `dev/worker-main.mjs` is the standalone process entry, where `--client <module>` injects the production database client (default export `async (env) => supabaseClient`), and local/test runs default to the fixture.

---

## 2. The unified turn interface

### 2.1 The dispatch port: completeForAgent

`completeForAgent` ([functions/agents.mjs](../../functions/agents.mjs)) is the single dispatch port for one model round: it resolves the backend entry via `backendFor(agent)`, then fetches the route from `TRANSPORT_ROUTES` by its `transport`. The arguments are passed through to that channel verbatim, and each takes only what it needs (`messages`, `tools`, `summary`, `window`, `onInterrupt`, `persistSession`, etc.) -- a hand-written branch once dropped `persistSession`, so as long as a new field is written into the table and the signature it can no longer go missing. The return value has one shape, so the engine and the trajectory need not care which backend ran.

### 2.2 The channel manifest

What a backend can do is written in the `BACKENDS` table in [functions/backends.mjs](../../functions/backends.mjs), not scattered across ifs. `transport` is the route name on the implementation side and must have a matching implementation in `TRANSPORT_ROUTES`:

| Backend id | transport | caps.tools | Implementation |
| --- | --- | --- | --- |
| `openai` | `chat` | Yes | `chatCompletion` |
| `demo` | `demo` | Yes | `demoRound` |
| `qca` | `cloud` | No | `askCloudAgent` |
| `stream` / `stream-dedicated` | `stream` | By profile (`shared` yes, `dedicated` no) | `askStreamServer` |

A `transport` declared in the manifest but not implemented (or implemented but not in the manifest) throws at module load, rather than surviving to runtime as an upstream error. `validateBackends` also self-checks at load (duplicate id, missing `caps.tools`, or not taking tools yet giving no `noToolsNotice` all throw on the spot). `dev/check-schema.mjs` has a separate static gate that reconciles this document's `transport` column three ways against `BACKENDS` and `TRANSPORT_ROUTES`.

The `stream` channel speaks the Stream Server specification we publish: the normative text (endpoint table, frame vocabulary, error-code family) is [functions/streamspec.mjs](../../functions/streamspec.mjs), a runnable reference implementation is [functions/streamserver.mjs](../../functions/streamserver.mjs), and the client side is [functions/stream.mjs](../../functions/stream.mjs). Which profile applies is decided by the one discovery request made when the record is created, updated or self-tested; the conclusion lands in `agents.stream_profile`, and a task round never writes it. A vendor examines itself before connecting: the conformance test suite is [functions/streamcts.mjs](../../functions/streamcts.mjs), with the command-line entry `node dev/cts.mjs --url <origin>`; it does not take our client as the examiner (marking your own paper has blind spots), recognises only the shapes the spec table computes, and answers in three verdicts -- pass/fail/skip, where behavior the spec leaves open is recorded as an observation and never failed.

### 2.3 The uniform return shape

Every route returns `{ content, reasoning, usage, finish_reason, mode }` (the cloud additionally carries `session_id`, `reply_event_id`, and the self-hosted channel `first_token_ms`). When `usage` is not reported it is left `null`, never passed off as 0; `mode` tags the channel/round reading (`qca`, `compress`, `cron`, `delivery`, etc.). The engine books to the store and draws the trajectory under the same shape.

---

## 3. Context authority and session granularity

- **WorkStream is the sole authority for the transcript**: each round `buildContext` re-renders memory + summary + window on the spot into messages and sends them out. The provider-side session is only a cache, not a source of truth.
- **The cloud session is stored one per (employee, stream)**: `askCloudAgent` ([functions/qca.mjs](../../functions/qca.mjs)) uses `flattenPrompt` each round to compress the assembled messages into one `user.message` body and send it over; the cloud session is only the cloud-side conversation cache, landed in `qca_sessions` one per (employee, stream) -- sharing one would cross streams on the cloud side.
- **A one-shot question is not cached**: `persistSession=false` is for one-round questions like compaction, not written back to that stream's session, so summary instructions do not pollute the conversation history.
- **The CLI session follows the same reading (R3, planned)**: once the CLI executor is wired in, `cli_sessions` stores the per (employee, stream) `session_id` and uses `--resume` to get an append-only prefix; WorkStream remains the sole authority for the transcript and the summaries, the CLI session is only a cache and is rebuilt if lost.

---

## 4. Tool capability: caps.tools

The single `caps.tools` field decides two things at once, no longer each saying its own: tool injection (the engine's `withTools`: for a channel that does not take tools, `tools` is `null` in the request body and the connector-tool step is skipped) and the prompt wording (the `backend.tools` slot: whether to drop "call tools on demand" or "write the conclusion straight into the body"). A channel that does not take tools must carry its own `noToolsNotice`, otherwise the model does not know it cannot reach anything in this channel and writes tool names into the body following the skill instructions -- what the stream sees is a fake execution. The QCA agent uses its own toolset, and our group tools are not injected into this channel.

---

## 5. The body red line: the chain of thought never enters the stream

Only `content` enters the stream; `reasoning` only lands in the step detail, and the single place to read it is the "Reasoning" tab of the trajectory inspector on the employee detail page (`StepInspector`). The cloud's `textOf` takes only `type=text` blocks and drops thinking / tool blocks outright; the demo model's excerpt takes only human messages from the window. This is a product red line, not a style preference: a colleague's internal reasoning appearing in the stream is a leak.

---

## 6. Interrupt semantics

- **Ask onInterrupt within the round**: in-process it is fired immediately by `fireInterrupt` from `bus`; across processes the 400ms inbox polling is the backstop. On a hit it calls `reader.cancel()` and throws `Interrupted` (carrying the half already emitted, `partial`).
- **Ask even while idle (the QCA pattern)**: a cloud agent running its own tools may go a long time without emitting a delta, so `askCloudAgent` asks `onInterrupt` once even after `IDLE_MS` (800ms) of silence; otherwise this channel's preemption could only wait for the whole-round timeout, a notch behind the self-hosted endpoint.
- **The half-finished text is not lost**: on the rerun it is fed back as a hint that "the previous message was cut off mid-sentence"; a stop request sets the task to `cancelled` and the half never lands in the stream. Interrupt reruns are capped at 2.
- **Background mail does not take interrupts**: mail whose `meta.kind` is `compress` / `dreaming` is a one-shot question, not a character goes into the stream, and the determination has exactly one home (`interruptibleMail`).
- **The CLI executor (R3)**: the cut-off semantics change from "cancel the read loop" to "kill the process group + salvage the half-finished text incrementally from stdout".

---

## 7. Failure and reclaim

- **Failure codes get their name at the source**: a self-hosted non-2xx is immediately turned into `upstream_*` by `upstreamCode`, and the cloud carries `qca_*` via `QcaError`; the inbox, the trajectory and the UI read the same code.
- **A stream that breaks half-way is not "finished"**: if the SSE reaches its end with neither `[DONE]` nor `finish_reason`, the round records `upstream_stream_incomplete` (the cloud `qca_stream_ended_unfinished`) and closes as failed, and not a character of the half lands in the stream.
- **There is no automatic re-delivery**: the claim only goes from `queued` via CAS, `reapStale` collects runaway `running` into `failed`, and no path ever re-queues a `failed`. The failure message says "to try again, @ them again".
- **Reclaim is by heartbeat**: the worker's heartbeat timer refreshes `mail.heartbeat_at` for the mails it is running, and `reapStale` skips rows with a fresh heartbeat (`>= cutoff`); the threshold goes through `WORKSTREAM_REAP_MS` (`reapThreshold`, default 5 minutes, clamped to [10s, 1h]). A live long task is not killed by mistake, and a zombie left by a crash is still collected. The mechanics are in [scheduler.en.md](scheduler.en.md) sections 3.1/3.7.

---

## 8. Acceptance readings

- **One dispatch port**: every backend route returns the uniform shape, and the engine and trajectory are backend-agnostic (smoke).
- **Three-way transport reconciliation**: this document's `transport` column ↔ `BACKENDS` ↔ `TRANSPORT_ROUTES` (the `dev/check-schema.mjs` static gate + the cold-start throw).
- **caps.tools takes effect**: `false` ⇒ `tools` is `null` in the request body and `noToolsNotice` must be present (`validateBackends` + smoke).
- **The chain of thought never enters the stream**: `reasoning` only lands in the step detail (smoke §25 + `StepInspector`).
- **Interrupts follow the QCA reading**: the cloud can be cut within `IDLE_MS` of silence, the half is handed up, and a stop sets `cancelled` (smoke 8b).
- **Control-plane upgrade survival**: `WORKSTREAM_EXECUTION=worker` ⇒ the control-plane tick idles and the in-flight round finishes in the worker and lands in the stream (smoke §31).
- **Shared-database CAS**: any worker claims any mail, only one wins, and only one reply lands in the stream (smoke §31).
- **Heartbeat reclaim**: a fresh heartbeat is spared, a stalled one is reclaimed as `failed`, and interrupts received in the meantime become tasks and are not lost (smoke §31).