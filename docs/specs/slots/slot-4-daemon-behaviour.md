---
status: implementation-brief
slot: 4
---

# Slot 4 — Restarting the Host becomes routine

## For the agent picking this up

**Stageflow** is a Node/TypeScript runtime for configurable multi-stage agent workflows. Users author
pipelines and tasks in YAML (`*.pipeline.yaml`, `*.task.yaml`); each stage runs in a fresh agent
session; stages hand off through typed envelopes and artifacts; human-in-the-loop gates park a stage
until an operator answers.

Three things you need to hold in your head about the process model, because this slot is entirely
about process lifecycle:

- **The CLI is `sf`** (`src/cli.ts`). `sf run` runs a pipeline to completion and is treated as a
  public CI contract (`docs/ci.md`) — its JSON on stdout and its exit codes are things people script
  against.
- **The Host is a long-lived HTTP server** started by `sf ui` (console + REST + MCP) or `sf mcp`
  (headless, same server without the browser bits). Both go through `createHttpHost`
  (`src/server/createHttpHost.ts`). It serves REST for the operator console, MCP for coding-agent
  harnesses, and A2A. Run state lives in SQLite at `~/.stageflow/.stageflow/state.db` via
  `SqliteRunStore` (`src/runstore/sqlite/SqliteRunStore.ts`), in WAL mode.
- **Stages run as forked Node children.** `StageProcessLauncher.spawnAndWait`
  (`src/runtime/stageProcessLauncher.ts:208`) forks the same CLI entry with
  `internal run-stage`, and that child runs a "Pi" coding agent. Pi has a `bash` tool, so the child
  spawns **grandchildren** the Host has never heard of. A signal delivered to the child alone does
  not reach them.

Stageflow is being containerized. The work is split into nine shipping slots; this is **slot 4**.
The full plan is [`../pre-container-work.md`](../pre-container-work.md) — this brief is
self-contained, so you do not need to read it, but Workstream 4 and items 10.7–10.9, 12.5 and the
`service.log` bullet in 10.11 are the source material.

## Mission

Turn the Host from "a CLI that happens to serve HTTP" into a service that can be stopped and started
without losing work.

Six pieces, in dependency order:

1. **Graceful shutdown** on SIGTERM/SIGINT — today there is no handler at all.
2. **An `interrupted` stage status**, non-terminal and resumable, replacing "restart looks like a
   batch of failures."
3. **`STAGEFLOW_NO_AUTOSTART`** so `docker exec … sf run` cannot fork a rival Host onto the same
   SQLite file.
4. **Structured JSON-lines logging to stdout**, because `docker logs` is the only observability a
   container operator gets by default.
5. **Process groups and a kill escalation that actually escalates** — the current one is
   unreachable code, and both shutdown and cancel depend on it.
6. **Stop truncating stdout** — `process.exit` discards queued writes when stdout is a pipe, and an
   undrained worker stdout pipe can hang a stage forever.

## Why this matters

**Item 4.2 — the `interrupted` stage status — is the single highest-value item in the entire
pre-container plan.** Not the highest-value item in this slot; in the whole plan. Everything else
across the nine slots makes containerizing *possible*; this one makes it *survivable*.

The reason is that a container's defining property is that it gets restarted. Image upgrades,
`docker compose up -d` after a config edit, host reboots, OOM kills, `restart: unless-stopped` after
a crash — a container is a thing that stops and starts, routinely, without a human watching. Today
every one of those events is destructive: in-flight stages are killed mid-work and, on the next
boot, `reconcileOrphanedStages` marks them **failed**. An operator who upgrades the image at 2am
wakes up to a wall of failures that are indistinguishable from real ones, with no way to tell which
runs were fine and which were genuinely broken, and no way to pick up where any of them left off.

`interrupted` converts that from "restarting the container destroys work" into "restarting the
container is routine." It is also load-bearing for the rest of this slot: graceful shutdown needs a
status to *write* when it stops a worker mid-stage. Without `interrupted`, a clean shutdown has
nothing honest to record and degrades into the same wall of failures.

The rest of the slot is unglamorous but each item is a real, verified failure:

- The kill escalation in `cancelRun` is dead code (see the quoted block below) and nothing signals
  the agent's `bash` grandchildren. `docker stop` today leaves them running until the container
  runtime SIGKILLs the whole cgroup — possibly mid-`git commit`.
- The worker's stdout is piped and never read. 64 KB of output from any dependency and the stage
  hangs forever holding its concurrency slot.
- `process.exit(code)` at `src/cli.ts:475` can truncate `sf run --json` output when stdout is a
  pipe, which is every CI invocation and every `docker exec … | jq`.

## Dependencies

**Assumes shipped: slot 1** (`STAGEFLOW_HOME` as the explicit durable root, plus `PRAGMA
user_version` schema versioning and a downgrade guard). This slot's clean-close path adds a WAL
checkpoint to whatever teardown slot 1 leaves behind, and the exit-code table below reserves a code
for slot 1's "store is newer than this binary" refusal.

**Coordinate with slot 3.** Slot 3 adds run-level `cancel_run`, which is specified as "SIGTERM active
workers with a SIGKILL escalation." That escalation is exactly the broken code this slot fixes
(item 10.7 below, in `StageProcessLauncher.cancelRun`). Whoever lands first owns the process-group
change; the other builds on it. Do not implement it twice. If slot 3 is already in flight, ship the
10.7 fix first and in isolation so slot 3 can rebase onto it.

**Blocks nothing**, but every later slot benefits: slot 5's bind work and slot 7's health surfaces
both assume a Host that shuts down cleanly, and 4.4's logger is the sink that slot 6's redaction
(6.3) and slot 9's audit lines (13.5) plug into.

## Verified current state

Everything below was read in the tree, not taken from the plan.

| Claim | Evidence |
|---|---|
| No SIGTERM or SIGINT handler exists anywhere in the Host path | `rg "SIGTERM\|SIGINT" src/cli.ts` → no matches. The only signal handling in `src/` is `process.once("SIGINT", …)` inside two interactive CLI prompts (`src/cli/runsCommand.ts:520`, `src/cli/providersCommand.ts:279`) |
| `sf ui` and `sf mcp` block on a never-resolving promise | `await new Promise(() => undefined);` at `src/cli.ts:413` (ui) and `src/cli.ts:430` (mcp) |
| Both discard the server handle | `const { url, mcpUrl } = await startUiServer({…})` (`src/cli.ts:402`) and `const { mcpUrl } = await startMcpServer({…})` (`src/cli.ts:421`) — but `createHttpHost` returns `{ server, port, host, url, mcpUrl, manager, store, runChangeBus }` (`src/server/createHttpHost.ts:121-129`). The handles you need are already there and simply thrown away |
| The only teardown that exists | `server.on("close", () => { void boot.mcpHandler.close(); });` (`src/server/createHttpHost.ts:108-110`). Nothing ever calls `server.close()` |
| `process.exit` call sites in the CLI | `src/cli.ts:475` (`.then((code) => process.exit(code))`) and `src/cli.ts:478` (the `.catch` path). Plus `src/runtime/stageWorker.ts:229`, `:232`, `:234` |
| The fork has no `detached` and pipes stdout | `fork(this.cliEntry, args, { cwd, env: {…}, stdio: ["pipe", "pipe", "pipe", "ipc"] })` — `src/runtime/stageProcessLauncher.ts:208-212` |
| A stderr reader exists; there is **no** stdout reader | `if (child.stderr) { … }` at `src/runtime/stageProcessLauncher.ts:223-239`. `child.stdout` appears nowhere in the file |
| `exitForOutcome` and the worker exit codes | `src/runtime/stageWorker.ts:225-235`; `STAGE_WORKER_EXIT = { SUCCEEDED: 0, FAILED: 1, WAITING: 2 }` at `src/runtime/stageWorkerProtocol.ts:7-11` |
| Orphans are marked **failed** on boot | `reconcileOrphanedStages` (`src/runtime/runManager.ts:405`) skips stages whose status is not `"running"` (`:432`), skips ones with a live worker (`:433`), then calls `failStageAsInterrupted` with `STARTUP_RECONCILE_REASON` (`:436-441`) |
| Despite the name, `failStageAsInterrupted` writes a plain failure | `const event: StageLogEvent = { event: "failed", reason };` — `src/runtime/stageRecovery.ts:35`. The word "interrupted" exists only inside the reason *string*: `"process_interrupted: no active worker (server restart)"` (`src/runtime/runManager.ts:161-162`) and `"process_interrupted: operator abandoned stage"` (`:163-164`) |
| There is no `interrupted` status in the type system | `StageSnapshot["status"]` is `"pending" \| "running" \| "waiting_for_input" \| "succeeded" \| "failed" \| "skipped"` (`src/runstore/port.ts:84-93`). `RunStatus` is `"created" \| "running" \| "succeeded" \| "failed"` (`src/runstore/port.ts:14`). `StageReadiness` (`:23-30`) mirrors the stage union |
| `resume_stage` exists but only accepts timed-out stages | MCP tool at `src/mcp/controlTools.ts:356`, → `RunManager.resumeTimedOutStage` (`src/runtime/runManager.ts:724`), gated by `assertTimedOutStageEligible` (`src/runtime/resumeTimedOut.ts:40-59`), which requires `status === "failed"` **and** a timeout-shaped last failure reason |
| The verify executor signals a shell, not a pipeline, with no escalation | `spawn(input.command, { cwd, shell: true, stdio: ["ignore","pipe","pipe"] })` at `src/runtime/completionCheckRunner.ts:195-199`; on timeout, `child.kill("SIGTERM")` at `:237` and nothing more |
| The autostart path detach-spawns a second Host and logs to a file in the data root | `src/server/ensureGlobalService.ts:134` (`const logPath = path.join(globalHome, "service.log")`), `:138` (`openSync(logPath, "a")`), `:149-152` (`spawnFn(process.execPath, spawnArgs, { detached: true, stdio: ["ignore", logFd, logFd] })`), `:153` (`child.unref()`). No env guard of any kind |
| SQLite is opened with WAL and never closed | `new Database(dbPath)`, `pragma("journal_mode = WAL")`, `pragma("busy_timeout = …")` at `src/runstore/sqlite/SqliteRunStore.ts:492-495`. There is **no** `close()` method on `SqliteRunStore` and none on the `RunStore` port — `rg "close" src/runstore/` returns nothing relevant |
| `server.requestTimeout = 0` | `src/server/createHttpHost.ts:106` — relevant here only because an in-flight request with no timeout can outlive your grace period |

**One correction to the plan doc.** `pre-container-work.md` §4.2 says orphans are marked failed "with
`process_interrupted`", which reads as if a distinct reason code exists in the data model. It does
not — `process_interrupted:` is a prefix inside a free-text `reason` string on a `failed` event. The
status column, the type union, and every consumer see an ordinary failure. Everything else the plan
asserts about this slot checked out at the cited lines.

## The work

### 4.1 Graceful shutdown

**Today.** Nothing. `docker stop` sends SIGTERM, Node has no listener, and the default action
terminates the process instantly. Workers are orphaned, the WAL is left as-is, and in-flight state is
whatever happened to be committed.

**Target.** A `ShutdownController` owned by the Host, installed by `sf ui` and `sf mcp`, that on the
first SIGTERM or SIGINT runs an ordered drain:

1. **Stop accepting new starts.** `startRun` and `rerun` return a structured
   `{ code: "shutting_down" }` error with HTTP 503. Queued runs (slot 3's `queued` status) stay
   queued.
2. **Stop scheduling.** No new stage is dispatched. In-flight stages keep running for now.
3. **Stop the listener.** `server.close()` so no new connections are accepted; existing responses
   finish. `server.closeIdleConnections()` immediately; `closeAllConnections()` at the hard deadline.
4. **Signal active workers.** SIGTERM to each active stage's **process group** (see 10.7). Workers
   get the remaining budget to finish or checkpoint.
5. **Checkpoint.** Every stage still active at the deadline is written as `interrupted` (4.2) with
   `reason: "host_shutdown"`, its attempt number preserved so `resume_stage` can continue the same
   session. SIGKILL the groups that did not exit.
6. **Close SQLite cleanly.** `PRAGMA wal_checkpoint(TRUNCATE)` then `db.close()`, so the next boot
   does not inherit a large WAL.
7. **Exit with a defined code** (table below), via `process.exitCode` plus a drain — not
   `process.exit` (10.9).

**A second signal escalates immediately:** SIGKILL the worker groups, attempt the `interrupted`
writes and the WAL checkpoint on a short fixed budget, exit with the escalated code. A third signal
is not handled — at that point the operator should use SIGKILL on the Host.

**Design decisions already made:**

- **`STAGEFLOW_SHUTDOWN_GRACE_MS`, default `8000`.** Below `docker stop`'s 10-second default so the
  Host finishes its own drain rather than being SIGKILLed mid-checkpoint. Document that raising it
  requires raising compose's `stop_grace_period` in step (12.5).
- **Workers get `grace - 2000ms`; the final 2s is reserved for the checkpoint-and-close.** The
  database work must never be the thing that gets cut off.
- **A clean drain exits `0`, not `143`.** The Host did what it was asked; it did not crash. Callers
  that care about *how* it stopped read the log line, not the exit code.
- **The drain is idempotent and racy-signal-safe.** Wrap it in a single promise; repeat first-signal
  deliveries join it rather than restarting it.
- **Keep the `sf run` foreground path out of this.** `sf run` is a short-lived CLI, not a service.
  It inherits the fixes from 10.7/10.9 and nothing else.

**Files likely to touch:** new `src/server/shutdown.ts`; `src/cli.ts:398-431` (replace both
`new Promise(() => undefined)` blocks with an await on the controller and keep the `server`/`manager`
handles); `src/server/createHttpHost.ts`; `src/runtime/runManager.ts` (a `stopAcceptingWork()` and a
`drainActiveStages(deadline)`); `src/runtime/stageProcessLauncher.ts`;
`src/runstore/sqlite/SqliteRunStore.ts` (add `close()`); `src/runstore/port.ts` (add `close()` to the
`RunStore` port).

### 4.2 The `interrupted` stage status

**This is the highest-value item in the whole nine-slot plan.** See [Why this matters](#why-this-matters).

**Today.** There is no `interrupted` status. Three different situations all land on `failed`:

- boot-time orphan reconciliation (`src/runtime/runManager.ts:436-441`),
- operator `abandon_stage` (`src/runtime/runManager.ts:549-554`),
- a real stage failure.

`failStageAsInterrupted` (`src/runtime/stageRecovery.ts:9`) is misleadingly named: it writes
`{ event: "failed", reason }` (`:35`) and the only trace of interruption is the `process_interrupted:`
prefix in the reason text.

**Target.** A first-class `interrupted` stage status that is **not terminal**:

- Added to `StageSnapshot["status"]` (`src/runstore/port.ts:84-93`) and to `StageReadiness`
  (`:23-30`), with a matching `{ event: "interrupted", reason }` stage event handled in
  `deriveExecutionPatchFromEvent` (`src/runstore/stageExecution.ts`) and in the event→status fold at
  `src/runstore/port.ts:538-552`.
- **Produced by both paths:** graceful shutdown (4.1 step 5, `reason: "host_shutdown"`) and boot-time
  orphan reconciliation (`reason: "orphaned_no_worker"`).
- **Resumable via `resume_stage`,** continuing the same attempt and session rather than starting a
  new one — the whole point is that the work already done is not thrown away.
- **Not a run failure.** `deriveStatusFromStages` (`src/runstore/port.ts:603-624`) must not fold an
  `interrupted` stage into a `failed` run. A run with interrupted stages and nothing else wrong is
  `running` — it is waiting for something, exactly like `waiting_for_input`.

**Design decisions already made:**

- **`interrupted` is a stage status only; no new run status in this slot.** Run-level `cancelled`
  and `queued` are slot 3 and 11.3, and the plan is explicit that those two land in one schema pass.
  Adding a third run status here would collide with that pass.
- **`abandon_stage` keeps writing `failed`.** It is an operator's deliberate "stop this," which is
  terminal by intent. Only the two involuntary paths produce `interrupted`. Rename
  `failStageAsInterrupted` → `markStageInterrupted` and give it a `status: "failed" | "interrupted"`
  parameter rather than forking it into two near-identical functions.
- **Widen `assertTimedOutStageEligible`, do not add a second tool.** `resume_stage` already means
  "continue the same attempt/session" (`src/mcp/controlTools.ts:356-378`). Accepting `interrupted`
  alongside timed-out-`failed` is a two-line change in `src/runtime/resumeTimedOut.ts:40-59` and
  keeps the harness surface the same. Rename the function to `assertResumableStage` while you are
  there.
- **Resume still requires the session file.** `reconstructTimedOutAndContinue` already refuses when
  the attempt's session file is missing (`src/runtime/resumeTimedOut.ts:98-103`) and says "use retry
  to start a new attempt." That guard is correct for `interrupted` too — surface the reason rather
  than silently retrying.
- **Auto-resume on boot is opt-in, and capped.** See 12.5.

**Files likely to touch:** `src/runstore/port.ts`, `src/runstore/stageExecution.ts`,
`src/runstore/trackProjection.ts`, `src/runstore/sqlite/SqliteRunStore.ts`,
`src/runtime/stageRecovery.ts`, `src/runtime/runManager.ts`, `src/runtime/resumeTimedOut.ts`,
`src/mcp/controlTools.ts`, `src/server/http.ts`, `ui/` status rendering, `docs/ci.md`,
`docs/hitl.md`.

### 4.3 Do not fork a rival Host

**Today.** `sf run` and the mutating `sf runs` verbs call `ensureGlobalService`, which probes
`http://127.0.0.1:<port>/api/health` and, if nothing answers, detach-spawns `sf mcp`:

```149:153:src/server/ensureGlobalService.ts
    const child = spawnFn(process.execPath, spawnArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
```

In a container that is actively harmful. `docker exec <container> sf run …` runs in the same PID
namespace and the same filesystem but its health probe can fail for reasons that have nothing to do
with the Host being down — a bind other than loopback (slot 5), a control token it does not send
(slot 5), a slow boot. The response is to spawn a **second Host** writing to the **same
`state.db`**. Two writers, two schedulers, two sets of leases.

**Target.** `STAGEFLOW_NO_AUTOSTART` (any value other than empty / `0` / `false` enables it; set in
the image). When enabled, `ensureGlobalService` skips the spawn entirely and returns a new
`{ ok: false, reason: "autostart_disabled", message }` whose message names the situation and the
fix — something like: *"No Stageflow Host is answering at http://127.0.0.1:3847. Autostart is
disabled (STAGEFLOW_NO_AUTOSTART). Start the Host with `sf mcp`, or in Docker check that the
container's entrypoint is running."*

**Design decisions already made:**

- **Default off outside the image.** Laptop autostart is a genuinely good affordance; this is a
  container-profile switch, not a behaviour change for existing users.
- **Exit `1`, not a new exit code.** `docs/ci.md` fixes `sf run` at `0` / `1` / `2` and that table is
  a public contract. "No host running" is a start failure, which is already `1`. Distinguish it in
  the `--json` document via a structured `{ code: "autostart_disabled" }`, which is where slot 7's
  error taxonomy (8.5) wants it anyway.
- **The message must not tell the user to unset the variable.** Two Hosts on one database is the
  failure we are preventing.

**Rider — 10.11 `service.log`.** The same function writes `$STAGEFLOW_HOME/service.log`
(`src/server/ensureGlobalService.ts:134-145`): unbounded, no rotation, inside the data volume where
it competes for space with `state.db`, and invisible to `docker logs`. When 4.3 lands, **the file
must become unreachable in the container profile, not merely unused** — move the `openSync` inside
the autostart branch so that with `STAGEFLOW_NO_AUTOSTART` set nothing ever opens or creates it.
Leave the laptop path as-is; it is the right place for a detached process's output there.

**Files likely to touch:** `src/server/ensureGlobalService.ts`, `src/cli/runCommand.ts`,
`src/cli/runsCommand.ts`, `docs/cli-reference.md`, `docs/ci.md`.

### 4.4 Structured logging to stdout

**Today.** Ad-hoc `console.log` / `console.error` scattered through the code — 11 call sites in
`src/runtime/runManager.ts`, 10 in `src/cli.ts`, plus every CLI command module. Worker stderr is
re-emitted by the Host with a `[stage:<id>]` text prefix
(`src/runtime/stageProcessLauncher.ts:230`). The autostart path sends everything to a file.

**Target.** One logger module, `src/logging/logger.ts`, emitting **JSON lines to stdout**:

```json
{"ts":"2026-09-21T12:00:00.000Z","level":"info","event":"stage.interrupted","msg":"stage interrupted by host shutdown","run_id":"r_01H…","stage_id":"implement","attempt":2,"component":"shutdown"}
```

Required fields: `ts`, `level`, `event`, `msg`. Correlation fields when in scope: `run_id`,
`stage_id`, `attempt`. Plus `component`.

**Design decisions already made:**

- **`STAGEFLOW_LOG_FORMAT=json|pretty`, defaulting to `pretty` when stdout is a TTY and `json`
  otherwise.** A container gets structured output with no configuration; a laptop gets readable
  output with no configuration. `STAGEFLOW_LOG_LEVEL` (`debug|info|warn|error`) defaults to `info`.
- **stdout, not stderr, for lifecycle events.** `docker logs` captures both, but stdout is the
  conventional stream for a service's own event log, and it keeps stderr meaningful for crashes.
- **Redaction lives in the sink, not at call sites.** A single `redact(record)` step inside the
  logger before serialization, driven by a pattern list plus the set of known secret values. Per-call
  redaction fails by omission: the next log line someone adds is the leak. Slot 6 (6.3) extends the
  pattern list; this slot builds the seam.
- **Per-line size cap with explicit truncation** (`"truncated": true`). An agent in a retry loop can
  otherwise fill a VPS through `docker logs` alone (11.5).
- **Correlation ids propagate via an explicit child logger**, `logger.child({ run_id, stage_id,
  attempt })`, threaded through the call chain. No `AsyncLocalStorage` — the win does not justify the
  debugging cost in a codebase that forks per stage.
- **No new logging dependency.** This is roughly one file. Adding pino or winston means a transport
  ecosystem and a config surface for something that writes JSON to fd 1.
- **Do not convert every `console.*` call in this slot.** Convert the Host and runtime paths
  (`runManager`, `stageProcessLauncher`, shutdown, `createHttpHost`) and leave CLI command output
  alone — `sf validate` printing a human report to stdout is not a log line, and `sf run --json`'s
  stdout document must stay the only thing on stdout for that command.

**Files likely to touch:** new `src/logging/logger.ts` and `src/logging/redact.ts`;
`src/runtime/runManager.ts`, `src/runtime/stageProcessLauncher.ts`, `src/server/createHttpHost.ts`,
new `src/server/shutdown.ts`; `docs/ci.md` (env var table).

### 10.7 Process groups, and the kill escalation that does not work

**This is the load-bearing bug in the slot.** Verbatim, from
`src/runtime/stageProcessLauncher.ts`:

```137:145:src/runtime/stageProcessLauncher.ts
            child.once("exit", finish);
            child.kill("SIGTERM");
            if (killAfterMs > 0) {
              setTimeout(() => {
                if (!child.killed) {
                  child.kill("SIGKILL");
                }
              }, killAfterMs);
            }
```

Two independent defects in nine lines:

1. **`child.killed` does not mean "the child is dead."** Node sets it to `true` as soon as a signal
   has been *successfully sent*. Line 138 sends SIGTERM, so `child.killed` is already `true` when the
   timer fires 5 seconds later — the `SIGKILL` branch on line 142 is **unreachable in exactly the
   case it exists for**: a worker that ignored or is too wedged to handle SIGTERM. The escalation
   looks present in code review and has never once fired.
2. **The fork is not detached, so the signal reaches one process.** `fork(…, { cwd, env, stdio:
   ["pipe","pipe","pipe","ipc"] })` (`:208-212`) has no `detached: true`, so the worker shares the
   Host's process group. `child.kill("SIGTERM")` signals the worker and nothing below it. The agent's
   `bash` tool grandchildren — `npm test`, `git`, a dev server — keep running, holding file locks and
   writing to the worktree after Stageflow believes the stage is stopped.

**Target.**

- `detached: true` on the `fork`, giving the worker its own process group.
- Signal the group: `process.kill(-child.pid, "SIGTERM")`, then `process.kill(-child.pid, "SIGKILL")`
  on escalation. Guard `child.pid` being `undefined` (spawn failure) and catch `ESRCH`, which just
  means the group is already gone.
- **Escalate on a lost exit race, not on `child.killed`.** Keep a local `exited` flag set by the
  `exit` handler and check *that* in the timer. This is the actual fix; `detached` without it leaves
  the escalation just as dead.
- **Same treatment for the verify executor.** `src/runtime/completionCheckRunner.ts:195-199` spawns
  with `shell: true` and on timeout signals only the shell (`:237`). A `sh -c "npm run build && npm
  test"` shell dies and the build keeps going. Add `detached: true`, signal the group, and add the
  SIGKILL escalation the verify path does not have at all today.
- `detached: true` also means the child is not killed when the parent dies — deliberate here, since
  we want *our* orderly signalling, but it makes the escalation timer mandatory rather than
  best-effort.

**Coordinate with slot 3:** `cancelRun` is also slot 3's `cancel_run` primitive. One implementation.

**Files likely to touch:** `src/runtime/stageProcessLauncher.ts` (fork options + `cancelRun`),
`src/runtime/completionCheckRunner.ts`.

### 10.8 Drain the worker's stdout

**Today.** `stdio: ["pipe", "pipe", "pipe", "ipc"]` (`src/runtime/stageProcessLauncher.ts:211`)
creates a pipe for the child's stdout, and nothing in the file ever touches `child.stdout`. A pipe
with no reader fills its ~64 KB kernel buffer and then **blocks the writer forever**. The worker
stops making progress, so it emits no IPC result and never exits; the Host's `Promise` at
`src/runtime/stageProcessLauncher.ts:241` never settles; the stage hangs holding its concurrency
slot until someone notices.

This has not bitten yet only because Stageflow's own worker logging goes to stderr, which *is*
drained (`:223-239`). It is one chatty dependency away from biting.

**Target.** Drain it. Attach a reader to `child.stdout` mirroring the existing stderr reader, and
route the lines into the 4.4 logger as `event: "stage.stdout"` with the run/stage correlation fields.

**Design decision already made:** drain rather than `"ignore"`. `"ignore"` also fixes the hang, but a
stage whose tool prints a useful diagnostic to stdout would lose it silently, and in a container the
log is all the operator has. Apply the 4.4 per-line size cap so a runaway writer costs log volume
rather than memory.

**Files likely to touch:** `src/runtime/stageProcessLauncher.ts`.

### 10.9 Stop truncating stdout with `process.exit`

**Today.** Two families of call sites:

```473:479:src/cli.ts
if (isDirectCliInvocation()) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
```

and `exitForOutcome` in the worker:

```225:235:src/runtime/stageWorker.ts
export function exitForOutcome(outcome: RunStageOutcome): never {
  const message = outcomeToWorkerResult(outcome);
  sendWorkerResult(message);
  if (isRunStageWaiting(outcome)) {
    process.exit(STAGE_WORKER_EXIT.WAITING);
  }
  if (outcome.ok) {
    process.exit(STAGE_WORKER_EXIT.SUCCEEDED);
  }
  process.exit(STAGE_WORKER_EXIT.FAILED);
}
```

When stdout is a TTY, Node's writes are synchronous and this is fine — which is why it looks fine on
a laptop. When stdout is a **pipe** they are asynchronous, and `process.exit` discards whatever is
still queued. Every container invocation is the pipe case: `docker logs`, `docker exec … sf run
--json | jq`, CI output capture. So `sf run --json` can emit **truncated JSON** against an output
contract `docs/ci.md` treats as public, and only in the environment we are about to ship.

`exitForOutcome` has a second, subtler exposure: `process.send` (`src/runtime/stageWorker.ts:221`) is
asynchronous over the IPC channel, and exiting immediately afterwards can drop the result message.
The Host does fall back to `resultFromExitCode` (`src/runtime/stageProcessLauncher.ts:56-70`), so
today this degrades a `failed` with a specific `reason` into a generic "stage failed" rather than
losing the outcome — still a real loss of diagnostics.

**Target.**

- In `src/cli.ts`, set `process.exitCode = code` and let the event loop drain naturally. Keep a
  safety net: if the loop has not exited after a short delay, force it — an undrained handle
  somewhere else should not hang CI.
- In `exitForOutcome`, pass the `process.send` callback and exit from it, or `await` a flush of
  stdout/stderr before setting `process.exitCode`. The function's `never` return type has to change.
- Audit for any other `process.exit` that runs after writing to stdout.

**Design decision already made:** `process.exitCode` + natural drain is preferred over an explicit
`writeSync` flush. It is the smaller change and it composes with 4.1, whose whole design is "stop
work, then let the process end on its own."

**Files likely to touch:** `src/cli.ts`, `src/runtime/stageWorker.ts`,
`src/runtime/stageWorkerProtocol.ts`.

### 12.5 Exit codes, stop timeouts, and restart-loop protection

**Today.** `docs/ci.md:45-51` publishes exit codes for `sf run` only:

| Code | `outcome` | When |
|---|---|---|
| `0` | `succeeded` | Pipeline completed |
| `1` | `failed` or `busy` | Stage error, validation at start, concurrency conflict |
| `2` | `waiting` | Stage blocked on HITL |

Nothing is published for the **Host** process (`sf ui`, `sf mcp`), because until this slot it only
ever exited by being killed.

**Target — the proposed Host exit-code table**, published in `docs/ci.md` alongside the existing one
and treated with the same "public contract" discipline:

| Code | Meaning |
|---|---|
| `0` | Clean shutdown. Signal received, drain completed within the grace period, all stages either finished or recorded `interrupted`, SQLite checkpointed and closed |
| `1` | Unhandled error. The Host crashed; state may not be checkpointed |
| `2` | *Reserved — never used by the Host.* `sf run` uses `2` for `waiting` and the two tables should not disagree on a number |
| `3` | Refused to start: invalid configuration (bad bind, malformed env, unwritable `$STAGEFLOW_HOME`) |
| `4` | Refused to start: on-disk store schema is newer than this binary (slot 1 / 12.1's downgrade guard) |
| `5` | Forced shutdown. The grace period expired; workers were SIGKILLed. `interrupted` records were attempted and may be incomplete |
| `6` | Escalated shutdown. A second signal arrived during the drain |

`sf run`'s `0` / `1` / `2` are **unchanged**. New failure modes (`autostart_disabled`) are
distinguished by structured `code` fields in the `--json` document, not by new exit numbers.

**Stop-timeout interaction.** `docker stop` defaults to a 10-second SIGTERM→SIGKILL window.
`STAGEFLOW_SHUTDOWN_GRACE_MS` defaults to `8000` so the forced-exit timer fires *inside* that window
and the Host controls its own ending. Document the pairing explicitly: raising the grace period
without raising compose's `stop_grace_period` produces exactly the truncated shutdown the setting was
meant to prevent.

**Restart-loop protection.** `interrupted` being resumable is right, and it is also a footgun: a
stage that wedges or crashes the Host on resume will do it again on every boot, and
`restart: unless-stopped` turns that into an infinite loop that never makes progress and never stops
making noise.

- Record `auto_resume_count` per stage attempt, incremented only by automatic (boot-time) resumption.
- `STAGEFLOW_MAX_AUTO_RESUMES`, default `3`. Past the cap, the stage stays `interrupted` with
  `reason: "auto_resume_capped"` and only an explicit operator/harness `resume_stage` will move it.
- An explicit `resume_stage` resets the counter — a human or harness deciding to try again is a
  different thing from a loop.

**Design decision already made:** **boot-time auto-resume is opt-in**
(`STAGEFLOW_AUTO_RESUME_INTERRUPTED`, default off) in this slot. Reconciliation writes `interrupted`
unconditionally, which is the valuable half and is safe; automatically restarting agent work on boot
is a behaviour change that deserves its own opt-in until the cap has been exercised in the field.

**Files likely to touch:** `docs/ci.md`, `docs/cli-reference.md`, `src/runtime/runManager.ts`,
`src/runstore/port.ts` (the `auto_resume_count` column), new `src/server/shutdown.ts`.

## Out of scope

- **Run-level `cancel_run`, `delete_run`, and GC/retention** — slot 3. This slot fixes the *kill
  primitive* that `cancel_run` will call (10.7); it does not add the run-level verb or the
  `cancelled` run status.
- **The `queued` run status and admission control** — 11.3, batched with slot 3's `cancelled` in one
  schema pass.
- **`STAGEFLOW_CONTROL_TOKEN`, bind resolution, allowed-hosts** — slot 5. Do not touch the loopback
  gate in `src/server/createHttpHost.ts:64-81`.
- **A finite `server.requestTimeout`** (`src/server/createHttpHost.ts:106`) — slot 5's 10.11 bullet.
  Noted here only because it interacts with the drain.
- **Curated child environment / secret scoping** (6.1, 6.2) — slot 6. You are adding `detached` to the
  `fork` options; leave `env: { ...process.env, ... }` exactly as it is.
- **Log volume budgets and the compose `logging:` driver** (11.5) — this slot sets the format and the
  per-line cap; the retention/driver story is later.
- **`tini` in the image, the Dockerfile, and compose** — after all nine slots. Worth stating the
  connection though: **`tini` is only sufficient because of this slot's process-group work.** An init
  process reaps zombies and forwards signals to PID 1; it does not know about the agent's `bash`
  grandchildren, and it cannot turn a dead escalation branch into a live one. Without 10.7, adding
  `tini` produces a container that looks correct and still leaves grandchildren running through a
  `docker stop`.

## Acceptance criteria

**4.1 Graceful shutdown**

1. `sf mcp`, sent SIGTERM with no active runs, exits `0` within 1 second.
2. `sf mcp`, sent SIGTERM with one active stage, stops accepting `start_run` (503,
   `code: "shutting_down"`), signals the worker, and exits `0` within
   `STAGEFLOW_SHUTDOWN_GRACE_MS`.
3. A worker that ignores SIGTERM is SIGKILLed and the Host still exits within the grace period, with
   code `5`.
4. A second SIGTERM during the drain exits promptly with code `6`.
5. After any of the above, `state.db-wal` is small (checkpointed) and the store reopens without
   recovery.

**4.2 `interrupted`**

6. A stage active at shutdown is `interrupted`, not `failed`, with its attempt number preserved.
7. A stage found `running` with no live worker at boot is `interrupted`, not `failed`.
8. A run whose only non-succeeded stage is `interrupted` is **not** `failed`.
9. `resume_stage` on an `interrupted` stage continues the same attempt and session and the run
   proceeds through its remaining stages.
10. `abandon_stage` still produces `failed`.
11. `interrupted` appears in MCP `get_run`, REST run detail, `sf runs show --json`, and the operator
    console without any consumer crashing on the unknown value.

**4.3 No rival Host**

12. With `STAGEFLOW_NO_AUTOSTART=1` and no Host running, `sf run` exits `1`, prints a message naming
    the probed URL and how to start a Host, emits `code: "autostart_disabled"` under `--json`, and
    **spawns no process**.
13. With `STAGEFLOW_NO_AUTOSTART=1`, `$STAGEFLOW_HOME/service.log` is never created.
14. Without the variable, autostart behaves exactly as it does today.

**4.4 Logging**

15. With stdout piped, every Host line is valid JSON with `ts`, `level`, `event`, `msg`.
16. Lifecycle events inside a run carry `run_id`, and stage events carry `stage_id` and `attempt`.
17. With `STAGEFLOW_LOG_FORMAT=pretty`, output is human-readable.
18. A known secret value passed through a log message is redacted, including via a call site that
    made no attempt to redact.

**10.7 / 10.8 / 10.9**

19. A stage whose agent spawned a long-running grandchild: cancelling the stage leaves **no**
    surviving descendants.
20. A worker that ignores SIGTERM is SIGKILLed after `killAfterMs` — verify the escalation actually
    fires, since today it never does.
21. A verify command that spawns a child and exceeds `timeout_ms` leaves no surviving descendants.
22. A worker that writes >1 MB to stdout completes normally instead of hanging.
23. `sf run --json` piped to a consumer emits complete, parseable JSON — no truncation.

**12.5**

24. The Host exit-code table is in `docs/ci.md` and matches the implementation.
25. After `STAGEFLOW_MAX_AUTO_RESUMES` automatic cycles the stage stays `interrupted` with
    `auto_resume_capped`, and an explicit `resume_stage` still works and resets the counter.

## Testing

Run before finishing, per `AGENTS.md`:

```bash
npm test
npm run typecheck
npm run ui:test     # the interrupted status touches console rendering
```

Where the automated coverage goes:

- **Extend `tests/runtime.stageRecovery.test.ts`** — it already covers `failStageAsInterrupted`
  (`:189`, `:210`, `:246`) and is the natural home for the `interrupted` status and the widened
  resume eligibility.
- **Signal handling and process groups need real processes, not mocks.** A fixture child that traps
  SIGTERM and refuses to die is the only honest test for the escalation, and a fixture that spawns a
  sleeping grandchild is the only honest test for the group signal. Both are POSIX-only — gate on
  `process.platform !== "win32"`.
- **Store-close behaviour:** assert the WAL is truncated after a clean close and that a second open
  succeeds.
- **Exit codes:** `tests/cli.*.test.ts` is the existing pattern for exit-code assertions.
- **The stdout-hang test must have a timeout**, or a regression hangs CI instead of failing it.

Manual verification is worth doing for the signal paths, in a real consumer project with a pipeline
whose stage shells out to something long-running:

1. Start `sf mcp` in one terminal, start a run, `kill -TERM <host-pid>` mid-stage. Confirm the Host
   exits `0` within the grace period, `ps` shows no surviving agent descendants, and on restart the
   stage reads `interrupted`.
2. `resume_stage` that stage and confirm the run finishes.
3. Repeat with a stage whose agent launched a `sleep 600` via its `bash` tool, and confirm the sleep
   is gone.
4. `sf run --json | jq .` in a loop and confirm no truncated document.

## Repo conventions

- `AGENTS.md` is the contributor guide; read it first. Minimal focused diffs, match the patterns in
  the area you touch, **no comments unless the logic is non-obvious**, no drive-by refactors.
- Tests live in `tests/*.test.ts`; fixtures under `tests/fixtures/` are canonical YAML. Prefer
  extending a fixture over inlining YAML.
- `docs/ci.md` JSON output and exit codes are a public contract — changing them is a documentation
  change *and* a test change, together.
- The stage worker protocol is `src/runtime/stageWorkerProtocol.ts`; keep exit codes and IPC message
  shapes in that one place.
- Operator console code is in `ui/` and has its own rules in `ui/AGENTS.md`. Read it before touching
  status rendering for `interrupted`.
- Public docs are indexed from `docs/README.md`. Planning artifacts under `docs/plans/`,
  `docs/ideation/`, and `docs/adr/` are local-only and gitignored.

## Open questions for the human

1. **Should `sf ui` and `sf mcp` exit `0` or `143` on a clean SIGTERM drain?** This brief decides
   `0` (the Host did what it was asked). `143` is the conventional "terminated by SIGTERM" value and
   some supervisors read it as a normal stop. Confirm before the table is published, because it
   becomes a contract.
2. **Is `STAGEFLOW_SHUTDOWN_GRACE_MS = 8000` the right default?** It fits inside `docker stop`'s
   10-second window, but 8 seconds is short for an agent mid-`npm test`. The alternative is a longer
   default (say 30 s) plus documentation insisting on `stop_grace_period: 35s`, which is more correct
   and more likely to be got wrong.
3. **Should boot-time auto-resume of `interrupted` stages be opt-in (this brief's choice,
   `STAGEFLOW_AUTO_RESUME_INTERRUPTED` default off) or on by default with the `MAX_AUTO_RESUMES`
   cap?** On-by-default is the better container experience and the whole point of 4.2; opt-in is the
   safer first release. This is the one decision here that changes what users feel.
4. **Does `interrupted` need a run-level counterpart?** This brief says no, to avoid colliding with
   slot 3 / 11.3's single schema pass for `cancelled` + `queued`. If a harness needs to distinguish
   "this run is paused because the Host restarted" from "this run is progressing," it currently has
   to look at stage statuses. Acceptable, or does it want a run status in the slot 3 pass?
5. **Should `abandon_stage` gain an `interrupted` option?** It writes `failed` today and this brief
   keeps that. An operator who abandons a stage intending to resume it later has no way to say so.
6. **Convert worker stderr to structured logs, or keep the `[stage:<id>]` prefix?** The current
   prefix format (`src/runtime/stageProcessLauncher.ts:230`) may be something people's tooling greps
   for. Wrapping each line in JSON is more correct and is a visible change to local output.
