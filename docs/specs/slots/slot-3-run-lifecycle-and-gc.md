---
status: implementation-brief
slot: 3
---

# Slot 3 — Runs queue, cancel, delete, and clean up after themselves

## For the agent picking this up

Stageflow is a Node/TypeScript runtime for **configurable multi-stage agent workflows**. A user
authors pipeline-owned YAML (`*.pipeline.yaml`, `*.task.yaml`, an optional `stageflow.yaml`
manifest); the runtime executes each stage in a fresh agent session, hands off between stages via
typed envelopes and artifacts, and pauses at HITL gates for operator input. Stages are
domain-agnostic — release automation, research flows, ops runbooks, and SDLC are all valid patterns.

The shapes you need to hold in your head:

- **CLI `sf`** — `sf run`, `sf runs …`, `sf validate`, `sf ui`, `sf providers`. Entry point
  `src/cli.ts`.
- **The Host** — one process serving HTTP: a REST API under `/api/*` for the operator console
  (`src/server/http.ts`), an MCP endpoint at `/mcp` for coding-agent harnesses (`src/mcp/`), and an
  A2A surface (`src/a2a/`). Started by `sf ui` or `sf mcp`.
- **State** — SQLite via `better-sqlite3` under `.stageflow/` (`src/runstore/`), plus a
  filesystem workspace tree per run under `.stageflow/runs/<runId>/`.
- **Stages** — each stage attempt is a **forked Node child process** (`src/runtime/
  stageProcessLauncher.ts`) running the CLI in worker mode, which drives a
  [Pi](https://github.com/badlogic/pi-mono) coding agent. That agent has shell access.
- **`RunManager`** (`src/runtime/runManager.ts`) is the orchestration seam — start, resume, retry,
  abandon, capacity, leases.

Stageflow is being containerized. The container work is broken into nine shipping slots; the full
breakdown is [`../pre-container-work.md`](../pre-container-work.md). **This is slot 3.** You do not
need to read the other eight, but you do need the dependency section below.

---

## Mission

Make a run a thing that can be **queued, cancelled, deleted, and garbage-collected** — and make the
disk it consumes visible before the volume fills.

Concretely, ship in one release:

1. `cancel_run(runId, reason)` and a new terminal run status `cancelled` (3.1)
2. `delete_run(runId, { force })` that removes rows, workspace, worktree, run branch, and A2A
   artifacts, on MCP + REST + CLI (3.2)
3. Two-stage retention — **SLIM** then **PURGE** — with per-status overrides and bare-clone cache
   eviction (3.3)
4. `sf runs gc [--dry-run]`, a periodic in-Host sweep, per-run disk usage in `list_runs`, a total in
   health, and a startup warning at a threshold (3.4)
5. An **admission queue**: a `queued` run status, `start_run` returning a run id plus a queue
   position instead of a hard rejection, `STAGEFLOW_MAX_QUEUED`, round-robin dequeue across project
   roots (11.3)
6. **Disk admission**: refuse to start when free disk is below a floor, with its own error code
   (11.4)

## Why this matters

There is currently no way to stop a run, no way to delete a run, and nothing that ever reclaims a
byte. Every stage attempt writes a `log.jsonl`, a `stream.log`, a `.pi-agent/` directory, a
`pi-session.jsonl`, and an artifacts tree — and nothing deletes any of it, ever.

On a laptop that is fine, because the cleanup path is a human typing `rm -rf ~/.stageflow/runs`. In
a container **there is no hand**. A Host running nightly pipelines fills its volume, SQLite starts
failing writes mid-run, and the operator's only recovery is destroying the volume — which also
destroys the run history and the provider credentials that live beside it.

Slot 2 (shipping in the same release) gives every run its own **git worktree**, i.e. a full checkout
of the repository per run. That turns a slow leak into a fast one. Cleanup stops being hygiene and
becomes the thing that makes the feature safe to ship.

---

## Dependencies

**Assumes shipped: slot 1.** Slot 1 introduces `STAGEFLOW_HOME` (replacing the hardcoded
`path.join(os.homedir(), ".stageflow")` at `src/project/globalHome.ts:5-7`) and a documented durable
layout. Your GC sweeps that root, your health disk total reports it, and your startup warning
thresholds against it. Do not hardcode paths; resolve through whatever slot 1 landed.

**MUST ship in the same release as slot 2.** Slot 2 creates a `git worktree` per run under
`$STAGEFLOW_HOME/worktrees/<runId>/` and a run branch `stageflow/run-<runId>`. Shipping worktree
creation without worktree cleanup is shipping a disk leak with a faster clock. This is stated as
non-negotiable in the build order. If slot 2 slips, your `delete_run` and SLIM still ship — they
just have one fewer thing to reclaim; write the worktree-reclaim path behind the same git service
module (`src/git/`) slot 2 creates and no-op it when the run has no worktree binding.

**Depends on slot 4's process-group kill fix.** Your `cancel_run` signals live stage workers. The
existing kill path does not actually escalate (see *Verified current state* below), and the forked
child is not detached, so nothing signals the agent's `bash` grandchildren. Slot 4 fixes both.
**Coordinate with whoever owns slot 4, or land that fix first.** Without it, `cancel_run` will
SIGTERM a worker, the worker's agent subprocess will survive, and the run will report `cancelled`
while a `git` or `npm` process keeps writing into the worktree you are about to delete. That is
worse than no cancel at all.

**Nothing depends on you within this release** except slot 2's disk-leak argument. Slot 8 (backup and
restore) will later want your retention windows documented; slot 9's export wants `delete_run` to
not strand exported records.

---

## The state machine

### Run statuses today

`src/runstore/port.ts:14`:

```ts
export type RunStatus = "created" | "running" | "succeeded" | "failed";
```

Four values. `created` is the pre-first-stage state; `running` covers both actively executing and
parked-on-HITL (the console derives a display-only `waiting_for_input` from
`run.waiting_stage_id` — `ui/src/status/runStatus.ts:17` and `:24-27`). Terminal statuses are
`succeeded` and `failed`.

### Run statuses after this slot

| Status | Terminal? | Added by | Meaning |
|---|---|---|---|
| `queued` | no | **this slot (11.3)** | Admitted, run id issued, not yet scheduled — waiting for a concurrency slot |
| `created` | no | exists | Run record exists, no stage has started |
| `running` | no | exists | At least one stage running, succeeded, or parked on HITL |
| `succeeded` | yes | exists | All non-failed stages resolved successfully |
| `failed` | yes | exists | An unhandled stage failure |
| `cancelled` | **yes** | **this slot (3.1)** | An operator or harness stopped it deliberately |

**`interrupted` is not yours.** Slot 4 adds a non-terminal `interrupted` state for stages orphaned
by a Host restart or a graceful shutdown, so a restart stops looking like a batch of failures.
Design your status handling so a fifth and sixth value slotting in later is a one-line change, but
do not add `interrupted` here.

### The sequencing note — read this before writing any code

> **Add `queued` and `cancelled` in ONE schema pass.**

Each new run status ripples through the same seven places. Doing them in two passes means paying
that cost twice, reviewing the same files twice, and shipping an intermediate release where the
console renders one unknown status but not the other.

The seven places:

1. **The store schema** — `runs.status` is a bare `TEXT NOT NULL` with no CHECK constraint
   (`src/runstore/sqlite/schema.ts:2-18`), so no DDL is strictly required; but
   `idx_runs_status_created` (`schema.ts:48-49`) governs how `listRuns` filters, and slot 1's
   schema-version ledger means a status-vocabulary change is a version bump whether or not the DDL
   moves.
2. **The TypeScript type** — `RunStatus` at `src/runstore/port.ts:14`, and every exhaustive `switch`
   over it.
3. **Status derivation** — `deriveStatusFromStages` (`src/runstore/port.ts:603-624`) and
   `syncRunStatusFromStages` (`src/runtime/stageRecovery.ts:48-59`). **This is the sharp edge:**
   `syncRunStatusFromStages` only protects `succeeded` from being recomputed
   (`stageRecovery.ts:55`). Without a matching guard, a cancelled run whose stages are then
   reconciled will silently flip from `cancelled` back to `failed`.
4. **MCP responses** — `src/mcp/controlTools.ts`, and the tool descriptions, which enumerate
   behaviour in prose that harnesses read.
5. **REST responses** — `src/server/http.ts` (`GET /api/runs` at `:290`, run detail at `:339`).
6. **The operator console** — `ui/src/status/runStatus.ts` has five exhaustive switches over
   `DisplayStatus` (`cssStatusToken` `:29-45`, `statusCopy` `:47-60`, `statusDotVariant`
   `:105-122`, plus `ringStatus`/`ringGlyph` for stages). TypeScript will fail the build on each,
   which is the good outcome — follow the compiler.
7. **The CLI and the CI contract** — `sf runs list --status` validates against a hardcoded four-value
   list (`src/cli/runsCommand.ts:57-61`, error text at `:404-406`, usage at `:34`), and
   `sf run --json` exit codes are public (`docs/ci.md`, "Exit codes"). See *3.1* for the exit-code
   decision.

---

## Verified current state

Every claim below was read in the tree at the time of writing. Where the plan document
([`../pre-container-work.md`](../pre-container-work.md)) is imprecise, it is called out.

**There is no delete, no run-level cancel, and no GC anywhere.** Confirmed by search across `src/`
and `ui/src/`. The only hits for cancel/retention machinery are:

- `src/runtime/stageProcessLauncher.ts:118` — `cancelRun(runId, killAfterMs = 5000)`, which despite
  the name is **stage-process teardown only**: it signals live child processes for a run and does
  not touch the store, the run status, or scheduling.
- `src/runtime/runManager.ts:545` — its only caller, inside `abandonStage`, which is per-stage.
- `src/a2a/store.ts:300` — `pruneExpired`, the only retention sweep in the codebase (see below).

The MCP `abandon_stage` tool description says it outright: *"There is no run-level cancel tool."*
(`src/mcp/controlTools.ts:382-386`). That string is part of your diff.

### `src/runtime/runManager.ts`

| Thing | Where | Detail |
|---|---|---|
| `DEFAULT_MAX_CONCURRENT` | `:160` | `= 3`. Overridable via constructor option, a global settings file (`readMaxConcurrentFromGlobal()`), or `STAGEFLOW_MAX_CONCURRENT_RUNS` — precedence at `:250-253`. |
| `parseMaxConcurrent` | `:166-171` | Falls back to the default on empty / non-finite / `< 1`. |
| `busy_capacity` rejection | `tryReserve` `:1710-1744`, `busyFailure` `:1686-1708` | `if (this.active.size >= this.maxConcurrent) return busyFailure("busy_capacity")`. Returns `status: 409` plus `activeCount` / `maxConcurrent` / `activeRunIds`. **This is the code path 11.3 replaces with a queue.** |
| `BusyCode` | `:82` | `"busy_capacity" \| "busy_checkout"`. |
| The checkout lease | `checkoutLeases: Map<string,string>` `:188`; key via `toCheckoutLeaseKey` `:173-183` (`realpath`, with a `path.resolve` fallback that logs an invariant violation); taken in `tryReserve` `:1718-1732`; re-keyed provisional→real in `track` `:1750-1768`; re-hydrated on resume at `:380-381` | One active run per `realpath(checkout)`. Slot 2 narrows this to path-checkouts only; repository-bound runs each get their own worktree and run in parallel. Your queue must not treat a `busy_checkout` conflict as a capacity condition — see 11.3. |
| `reconcileOrphanedStages` | `:405-480`, called from `src/server/bootstrap.ts:98` | On boot, walks every run, and for each stage still `running` with no live worker (`hasActiveWorker` `:396-403`) calls `failStageAsInterrupted` with `STARTUP_RECONCILE_REASON` (`:161-162`, the string `"process_interrupted: no active worker (server restart)"`), then `syncRunStatusFromStages`. **Relevant to you twice:** it must skip `cancelled` runs, and it must not resurrect or clobber `queued` runs. |
| `resumeStalledSchedules` | `:482-500` | Only considers `summary.status === "running"`. `queued` runs need their own boot-time handling — re-enqueue, do not resume. |

### `src/runstore/workspaceLayout.ts` — exactly what leaks

The run workspace root is `<storeRoot>/runs/<runId>/` (`src/runstore/paths.ts:57-65`,
`SqliteRunStore.getWorkspaceDir` at `:526-528`). Under it, **per stage per attempt**
(`attemptWorkspaceDir`, `workspaceLayout.ts:22-36`, i.e.
`stages/<stageId>/attempts/<n>/`):

| Path | Written by | Size profile |
|---|---|---|
| `log.jsonl` | `attemptLogPath` `:38-44` | small–medium; structured stage events |
| `stream.log` | `attemptStreamLogPath` `:46-52` | **large** — raw agent stream transcript |
| `envelope.json` | `attemptEnvelopePath` `:54-63` | small; the typed handoff. **Keep.** |
| `artifacts/` | `attemptArtifactsDir` `:65-74` | unbounded — whatever the stage wrote |
| `.pi-agent/` | `attemptAgentDir` `:76-85` | **large** — the agent's own working directory |
| `pi-session.jsonl` | `attemptSessionPath` `:87-96` | **large** — full session replay log |

Note the multiplier: this is **per attempt**, and retries, feedback loops, and fork generations all
create attempts. A run that retried a stage four times has four `.pi-agent/` trees and four session
logs. There is also a legacy non-attempt-scoped `stages/<stageId>/artifacts/` still read by
`listArtifactNames` (`:254-293`) — your SLIM walker must handle both shapes or it will miss
pre-migration runs.

### `src/runstore/sqlite/SqliteRunStore.ts` and `schema.ts`

- The `runs` table (`schema.ts:2-18`): `run_id` PK, `pipeline_id`, `task_id`, `task_yaml`, `status`,
  `created_at`, `updated_at`, `checkout_root`, `pipeline_dag_json`, `git_sha`, `ci_pr_url`,
  `ci_job_url`, `pipeline_path`, `task_path`, `project_root`. **No disk-usage column, no
  `finished_at`, no `slimmed_at`.** You will need at least `slimmed_at` and a cached
  `disk_bytes` + `disk_measured_at`.
- Tables that reference `runs(run_id)` and therefore must be deleted in dependency order:
  `run_submissions` (`schema.ts:20-24`, `run_id ... UNIQUE REFERENCES runs(run_id)`), `stages`
  (`:26-36`), `stage_events` (`:38-46`), `stage_executions` (`:57-73`),
  `verification_check_results` (`:75-91`), `feedback_loops` (`:93-110`), `feedback_replays`
  (`:112-134`), `feedback_replay_stage_passes` (`:136-152`), `fork_generations` (`:154+`). **The
  declared foreign keys are decoration today** — `PRAGMA foreign_keys` is not enabled (slot 1 /
  12.1 turns it on), so nothing cascades and nothing stops you orphaning rows. Write the deletes
  explicitly and wrap them in one `db.transaction`.
- `updateRunStatus` (`:599-613`) is a plain `UPDATE runs SET status …` that throws
  `Run not found: <id>` on zero changes. No status-transition validation exists anywhere.
- `listRuns` (`:1050-1092`) builds `WHERE` clauses for `status` / `since` / `pipeline`, then for
  **every** row loads stage snapshots and feedback-loop history before projecting a `RunSummary`.
  It is already N+1 per run; do **not** add a synchronous `du`-style directory walk into that loop.
  See 3.4 for the caching decision.
- Schema evolution today is `PRAGMA table_info` probes plus `ALTER TABLE` on every connection open
  (e.g. `ensureCiIdentityColumns` `:193-202`, `ensureRunLocatorColumns` `:210-218`). Slot 1 replaces
  this with a versioned migration ledger. **Add your columns through slot 1's mechanism, not by
  adding a tenth probe.**

### `src/runtime/stageProcessLauncher.ts` — the kill path your cancel depends on

```118:149:src/runtime/stageProcessLauncher.ts
  async cancelRun(runId: string, killAfterMs = 5000): Promise<void> {
    const children = [...this.active.values()].filter(
      (entry) => entry.runId === runId,
    );
    if (children.length === 0) {
      return;
    }

    await Promise.all(
      children.map(
        (entry) =>
          new Promise<void>((resolve) => {
            const child = entry.child;
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            child.once("exit", finish);
            child.kill("SIGTERM");
            if (killAfterMs > 0) {
              setTimeout(() => {
                if (!child.killed) {
                  child.kill("SIGKILL");
                }
              }, killAfterMs);
            }
          }),
      ),
    );
  }
```

**Two defects, both slot 4's to fix, both load-bearing for you:**

1. **The SIGKILL escalation is dead code.** `child.killed` is `true` as soon as a signal has been
   *sent*, not when the process has died. `child.kill("SIGTERM")` at `:138` sets it, so the
   `if (!child.killed)` guard at `:141` is always false by the time the timer fires. A worker that
   ignores or is wedged against SIGTERM is never killed, and the `await Promise.all` never settles —
   so `cancelRun` hangs forever. The fix is to escalate on a lost exit race (a flag set in the
   `exit` handler), not on `child.killed`.
2. **No process group.** `fork(this.cliEntry, args, { cwd, env, stdio })` at `:208-212` passes no
   `detached: true`, so the worker is not a process-group leader and
   `child.kill(sig)` reaches only the worker — not the Pi agent's `bash` grandchildren. Those keep
   running, and keep writing into the worktree.

Until slot 4 lands `detached: true` + `process.kill(-child.pid, sig)` + exit-race escalation,
**`cancel_run` cannot honestly claim the run has stopped.** Do not ship a `cancelled` status that
lies.

### `src/a2a/store.ts` — prior art for a sweep

`pruneExpired(now, terminalRetentionMs, messageRetentionMs)` at `:299-331` is the pattern to copy:

- selects expired rows by `state IN ('completed','failed') AND updated_at < ?`
- `unlink`s the frozen artifact files first, ignoring failures (`.catch(() => undefined)`)
- then deletes artifacts → messages → task inside one `db.transaction`
- takes an **explicit clock** as a parameter so the logic is deterministic to test
- defaults from `src/a2a/limits.ts:4-5` — `TERMINAL_RETENTION_MS` 30 days,
  `MESSAGE_TOMBSTONE_RETENTION_MS` 90 days

The scheduling half is `src/a2a/server.ts`: `RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000` (`:231`)
driving a `setInterval(...).unref()` (`:262-263`) that swallows errors. **Copy the shape, including
the `.unref()`** — a sweep timer that keeps the event loop alive prevents a clean exit.

A2A task rows carry a nullable `run_id` (`src/a2a/store.ts:22`, `:64`) and each task owns frozen
artifact files under `<storeRoot>/a2a-artifacts` (`:120`). `delete_run` must delete the A2A tasks
bound to that run and unlink their artifacts — otherwise `src/a2a/service.ts:205-208` and `:289-292`
will `readRun` a run id that no longer exists and throw.

### Where the new verbs get exposed

- **MCP** — `src/mcp/controlTools.ts` registers 14 tools via `server.registerTool(name, { description, inputSchema }, handler)`.
  The closest prior art is `abandon_stage` at `:381-405`: zod input schema, call into `manager`,
  `textResult({ error, status }, true)` on failure, `textResult({ ok: true, … })` on success.
  `rerun` at `:408-429` shows the start-failure mapping (`mapStartFailure`) you will reuse for
  admission errors.
- **REST** — `src/server/http.ts`. Route matching is a linear `if (method === … && pathname.match(…))`
  chain; `abandon` is at `:608-628` and replies `202` with `{ ok, runId, stageId }`. Mutating routes
  are loopback-gated by `isMutatingApi` (`:141-165`) — which **short-circuits on
  `if (method !== "POST") return false`**, so a `DELETE` route would bypass the gate entirely and be
  reachable from anywhere the port is. `GET`s are likewise ungated (slot 5 fixes that — do not try
  to). `GET /api/health` at `:745-748` just returns `manager.getHealth()`, whose shape is
  `CapacityHealth` at `src/runtime/runManager.ts:98-106`.
- **CLI** — `src/cli/runsCommand.ts` (usage block at `:34-56`). Mutating verbs go through the Host
  over HTTP via `src/cli/hostClient.ts` (`httpAbandonStage` at `:284`), not by opening the store
  directly. Follow that: `sf runs cancel` and `sf runs delete` must call the Host so a single
  writer owns the store.

### `docs/ci.md` — the contract you are extending

- Exit codes (`docs/ci.md`, "Exit codes"): `0` = `succeeded`, `1` = `failed` or `busy`, `2` =
  `waiting`. Implemented in `exitCodeForRunOutcome` (`src/cli/runOutput.ts:188-197`) over
  `PipelineRunOutcome` — note `sf run` exit codes key off the **pipeline outcome**, not `RunStatus`.
- The busy JSON document (`outcome: "busy"`, `code: "busy_capacity" | "busy_checkout"`, no `runId`)
  is produced by `formatRunBusyJson` (`src/cli/runOutput.ts:41-64`), gated by `isBusyCode`
  (`:37-39`).
- `docs/ci.md`, "Concurrency env vars" lists `STAGEFLOW_MAX_CONCURRENT_RUNS`,
  `STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN`, `STAGEFLOW_MAX_ACTIVE_STAGE_PROCESSES`. Your new env vars
  go in that table.

---

## The work

### 3.1 — Run-level cancel

**Today.** Only per-stage `abandon_stage` exists (`RunManager.abandonStage`, MCP tool at
`src/mcp/controlTools.ts:381`, REST at `src/server/http.ts:608`, CLI `sf runs abandon`). It refuses
unless the stage is `running` (`runManager.ts:532-539`), tears down that run's live child processes
via `stageProcessLauncher.cancelRun` (`:540-547`), marks the stage failed with
`OPERATOR_ABANDON_REASON` (`:163-164`), and re-derives run status. On a fan-out pipeline you would
have to abandon each stage individually, racing the scheduler, which starts the next one.

**Target.** `RunManager.cancelRun(runId, reason)`:

1. Mark the run `cancelled` **first**, so the scheduler observes it before anything else happens.
2. Stop scheduling — no new stage attempts for this run, and drop it from the admission queue if it
   is `queued`.
3. Signal active workers via `stageProcessLauncher.cancelRun(runId)` (which slot 4 will have made
   actually work).
4. Mark still-`running` stages terminal with a cancel-specific reason string, distinct from
   `OPERATOR_ABANDON_REASON` and from slot 4's `process_interrupted` family.
5. Release the checkout lease and the active-map entry (`removeActiveEntry`).
6. Record the caller-supplied `reason` on the run so `get_run` can show *why*.

**Design decisions already made — do not relitigate:**

- **`cancelled` is a new terminal status, not an overloaded `failed`.** A cancel is an operator
  decision, not a defect; conflating them makes "how many pipelines are broken" unanswerable.
- **`reason` is required and free-text.** The one question an operator asks about a cancelled run is
  why, and a required field is the cheapest way to get an answer.
- **Cancel is idempotent.** Cancelling an already-`cancelled` run returns `ok: true` with no
  side effects; cancelling a `succeeded` or `failed` run is a `409`, because it would rewrite
  history.
- **Cancel does not delete anything.** Reclaiming disk is 3.2 (explicit) and 3.3 (time-based).
- **`syncRunStatusFromStages` gets a `cancelled` guard.** Mirror the existing `succeeded` guard at
  `src/runtime/stageRecovery.ts:55`. Without it, boot-time reconciliation silently rewrites
  `cancelled` to `failed`.
- **CI exit code: `cancelled` maps to exit `1`.** A cancelled run did not produce its deliverable, so
  a CI job must not pass. Add `outcome: "cancelled"` to the `sf run --json` document (so a harness
  can distinguish it from a genuine failure) while keeping the exit code at `1` — this extends the
  JSON contract additively without breaking any existing `if exit != 0` script. Document both in
  `docs/ci.md`.

**Files likely to touch.** `src/runtime/runManager.ts`, `src/runtime/stageRecovery.ts`,
`src/runtime/pipelineScheduler.ts`, `src/runstore/port.ts`, `src/runstore/sqlite/SqliteRunStore.ts`,
`src/mcp/controlTools.ts` (new tool + fix the "There is no run-level cancel tool." sentence in
`abandon_stage`'s description at `:386`), `src/server/http.ts`, `src/cli/runsCommand.ts`,
`src/cli/hostClient.ts`, `src/cli/runOutput.ts`, `ui/src/status/runStatus.ts`, `docs/ci.md`,
`docs/mcp.md`, `docs/cli-reference.md`.

---

### 3.2 — Run deletion

**Today.** Nothing deletes a run. Not the rows, not the workspace, not the A2A tasks. Verified by
search; also recorded as gap **S5** in
[`../container-ready-assessment.md`](../container-ready-assessment.md) (`:190`, `:299`).

**Target.** `delete_run(runId, { force?: boolean })` removing, in this order:

1. **A2A tasks** bound to the run (`a2a_tasks.run_id`), with their frozen artifact files under
   `<storeRoot>/a2a-artifacts` unlinked first — same order `pruneExpired` uses
   (`src/a2a/store.ts:307-318`).
2. **Store rows**, child-first, in one transaction: `stage_events`, `verification_check_results`,
   `stage_executions`, `feedback_replay_stage_passes`, `feedback_replays`, `feedback_loops`,
   `fork_generations`, `stages`, `run_submissions`, then `runs`.
3. **The run workspace** — `rm -rf` of `getWorkspaceDir(runId)`
   (`SqliteRunStore.ts:526-528`).
4. **The worktree** — `git worktree remove --force` then `git worktree prune`, through slot 2's
   `src/git/` module (it handles the case where the directory vanished underneath git).
5. **The run branch** — `stageflow/run-<runId>` in the bare cache.

Refuses with `409` on an active run (`queued`, `created`, or `running`) unless `force: true`, which
runs `cancelRun` first and waits for it to settle before proceeding.

**Design decisions already made — do not relitigate:**

- **Delete is hard, not a tombstone.** The entire point is reclaiming bytes; a soft-delete flag
  reclaims none and adds a filter to every query.
- **`force` cancels rather than refusing harder.** "Delete this, I mean it" is the operator's most
  common intent, and making them issue two calls just invites a race.
- **The run branch is deleted with the run.** Slot 2 deliberately lets the branch outlive the
  worktree so committed work survives worktree removal — but `delete_run` is an explicit "I want
  this gone" instruction, so it takes the branch too. Time-based PURGE (3.3) also takes it; SLIM
  does not.
- **Filesystem failures do not abort the row deletion.** If the worktree is gone or the workspace is
  unreadable, log it and continue. A run whose rows survive because a directory was already missing
  is a leak that never resolves.
- **Deletion is not recursive across reruns.** A `rerun` creates an independent run; deleting the
  parent does not touch children.

**Files likely to touch.** New `src/runstore/deleteRun.ts` (or a `RunStore.deleteRun` port method —
prefer the port, since `src/runstore/port.ts:407` already establishes mutation methods there),
`src/runstore/sqlite/SqliteRunStore.ts`, `src/a2a/store.ts` (a `deleteByRunId` alongside
`pruneExpired`), `src/runtime/runManager.ts`, `src/mcp/controlTools.ts`, `src/server/http.ts`
(`DELETE /api/runs/:runId` — the first `DELETE` verb in the file; **you must widen `isMutatingApi`
at `:141-165` beyond its `method !== "POST"` early return**, or the only destructive route in the
API ships ungated), `src/cli/runsCommand.ts`, `src/cli/hostClient.ts`.

---

### 3.3 — Two-stage retention

**Today.** No retention of any kind for runs. The only sweep in the codebase is A2A's
(`src/a2a/store.ts:299-331`), and it does not know runs exist.

**Target.** Two stages, because **a single TTL forces a bad trade**: you usually want to keep the
*record* of a failed run for weeks while reclaiming its *disk* in days.

#### The SLIM / PURGE split

| Artifact | SLIM reclaims | PURGE reclaims | Why |
|---|---|---|---|
| `worktrees/<runId>/` (slot 2) | **yes** | yes | Biggest single consumer; reconstructable from `resolved_sha` |
| `stages/*/attempts/*/.pi-agent/` | **yes** | yes | Agent scratch; no diagnostic value after terminal |
| `stages/*/attempts/*/pi-session.jsonl` | **yes** | yes | Large session replay log |
| `stages/*/attempts/*/stream.log` | **yes** | yes | Large raw transcript |
| `stages/*/attempts/*/artifacts/` over a size threshold | **yes** | yes | Unbounded; small artifacts are usually the deliverable |
| `stages/*/attempts/*/artifacts/` under the threshold | no | yes | Cheap to keep, most likely to be wanted |
| `stages/*/attempts/*/log.jsonl` | no | yes | Structured events, small, the triage surface |
| `stages/*/attempts/*/envelope.json` | no | yes | The typed handoff — the record of what the stage produced |
| `runs` / `stages` / `stage_executions` rows | no | yes | The run record itself |
| `stage_events` rows | no | yes | Timeline |
| `verification_check_results` rows | no | yes | Verification history |
| `feedback_*` / `fork_generations` rows | no | yes | Run structure |
| A2A tasks + frozen artifacts for the run | no | yes | Already governed by A2A's own 30-day window; PURGE catches the rest |
| The run branch `stageflow/run-<runId>` | no | yes | SLIM must not destroy committed work |
| Bare clone cache `repos/<host>/<owner>/<repo>.git` | n/a | evicted separately | Shared across runs — see below |

#### Default windows

| Terminal status | SLIM after | PURGE after |
|---|---|---|
| `succeeded` | 3 days | 30 days |
| `cancelled` | 1 day | 14 days |
| `failed` | **14 days** | 90 days |

Configurable per status. The `failed` SLIM window is deliberately long: the worktree of a failed run
is exactly the thing someone wants to `docker exec` into, and a 3-day window makes "it broke over the
weekend" unrecoverable.

**Bare-cache eviction** is a separate rule with a separate clock: evict
`$STAGEFLOW_HOME/repos/<host>/<owner>/<repo>.git` when it has **no live worktrees** and **no run
activity** inside a TTL (default 30 days). Never evict a cache with a live worktree, regardless of
age.

**Design decisions already made — do not relitigate:**

- **Two stages, not one TTL.** Stated above; it is the core design point of 3.3.
- **Non-terminal runs are never touched.** Retention keys off a terminal timestamp. A `running` run
  older than any window stays untouched — that is a hang for slot 4's budgets to handle, not a GC
  target.
- **SLIM is idempotent and recorded.** A `slimmed_at` column means the sweep skips already-slimmed
  runs instead of re-walking their trees every hour.
- **SLIM keeps `envelope.json` unconditionally**, regardless of size. It is the typed contract
  between stages and the smallest thing that answers "what did this run produce".
- **PURGE reuses `delete_run`'s implementation.** One deletion path, one set of ordering bugs to
  fix.
- **Windows are host config, not per-task.** Retention is an operator concern; per-task overrides
  mean one pipeline author can fill the operator's volume.

**Files likely to touch.** New `src/runstore/retention.ts` (policy + the pure "what is eligible"
function, taking an explicit clock like `pruneExpired` does), new `src/runstore/diskUsage.ts`,
`src/runstore/port.ts`, `src/runstore/sqlite/SqliteRunStore.ts` (`slimmed_at` column via slot 1's
migration ledger), `src/a2a/store.ts`, and slot 2's `src/git/`.

---

### 3.4 — Make it visible and runnable

**Today.** `GET /api/health` returns `manager.getHealth()` — a `CapacityHealth`
(`src/runtime/runManager.ts:98-106`) of `activeRunIds`, `activeCount`, `maxConcurrent`,
`slotsAvailable`, `activeStageProcesses`, `maxActiveStageProcesses`. **No disk figure anywhere.**
There is no `sf runs gc`, no periodic sweep for runs, and no startup check on the durable root.

**Target.**

1. **`sf runs gc [--dry-run]`** — runs one sweep and prints what it reclaimed (or would). `--dry-run`
   is the default-adjacent safety valve for the first time an operator runs it. Goes through the
   Host like the other mutating `sf runs` verbs (`src/cli/hostClient.ts`), plus an MCP tool and a
   REST route so a remote harness can trigger it.
2. **A periodic in-Host sweep** so an unattended container self-maintains. Copy A2A's shape exactly:
   a module-level interval constant, `setInterval(...).unref()`, errors swallowed and logged
   (`src/a2a/server.ts:231`, `:262-263`). Default hourly; `STAGEFLOW_GC_INTERVAL_MS` to override,
   `0` to disable.
3. **Per-run disk usage in `list_runs`** — a `disk_bytes` field on `RunSummary`.
4. **A total in health** — `GET /api/health` gains disk usage broken out by category (`runs/`,
   `worktrees/`, `repos/`, `state.db` + WAL, `a2a-artifacts/`), plus free space on the durable
   root's filesystem.
5. **A startup warning** when the durable root crosses a configurable threshold
   (`STAGEFLOW_DISK_WARN_BYTES`, or a percentage of the filesystem). One log line at boot, named and
   actionable, telling the operator to run `sf runs gc`.

**Design decisions already made — do not relitigate:**

- **Disk usage is measured by the sweep and cached on the row, never computed inside `listRuns`.**
  `listRuns` (`SqliteRunStore.ts:1050-1092`) already does per-row stage and feedback-loop loads;
  adding a recursive directory walk per run would make the console's run list quadratic in disk I/O.
  Store `disk_bytes` + `disk_measured_at`, refresh on the sweep and at run terminal, and report it
  as a possibly-stale cached figure.
- **`du` is not shelled out to.** Walk with `fs.promises`, summing `stat().blocks * 512` for apparent
  vs. allocated honesty, on the same `execFile`-not-`shell` principle slot 2 applies to git.
- **The startup warning warns; it never refuses.** Refusing to start because the disk is full turns
  a degraded Host into one an operator cannot log into to fix it. Admission control (11.4) is where
  refusal belongs, and it refuses *runs*, not the Host.
- **The sweep does not run on boot.** A Host restarting in a crash loop must not do heavy I/O on
  every start. First sweep fires one interval after boot.

**Files likely to touch.** `src/cli/runsCommand.ts`, `src/cli/hostClient.ts`,
`src/server/http.ts`, `src/server/bootstrap.ts` (the sweep timer, next to the existing
`reconcileOrphanedStages()` call at `:98`), `src/mcp/controlTools.ts`,
`src/runtime/runManager.ts` (health payload), `src/runstore/port.ts` (`RunSummary.disk_bytes`),
`ui/src/` (run list column, health panel), `docs/cli-reference.md`, `docs/ci.md`.

---

### 11.3 — Admission queue instead of rejection

**Today.** Over capacity, `tryReserve` returns a hard failure
(`src/runtime/runManager.ts:1715-1717`) and `busyFailure` (`:1686-1708`) builds a `409` with
`code: "busy_capacity"`. Nothing queues. `sf run --json` prints an `outcome: "busy"` document with
no `runId` (`src/cli/runOutput.ts:41-64`) and exits `1`; MCP returns `isError` with the same code
(described at `src/mcp/catalogTools.ts:186`).

This matters more after slot 2, which removes the checkout lease for repository-bound runs
*specifically so parallelism becomes the point*. Once runs can run in parallel, the only backpressure
left is "no" — and a CI system firing five PR pipelines gets five failed MCP calls and a retry race.

**Target.** A `queued` run status.

- `start_run` admits the run, writes the row with status `queued`, and returns
  `{ runId, queued: true, queuePosition }` **immediately**.
- `get_run` / `list_runs` report `queued` and the current position.
- `cancel_run` works on a `queued` run: remove from the queue, mark `cancelled`, no workers to
  signal.
- `STAGEFLOW_MAX_QUEUED` bounds the queue depth. **`busy_capacity` moves here** — it is returned
  when the *queue* is full, not when the concurrency slots are full.
- Dequeue **round-robin across `project_root`** (the column already exists,
  `schema.ts:17`; `listProjectRoots()` at `SqliteRunStore.ts:1095`), so one busy repo cannot
  starve every other repo in the container.

**Design decisions already made — do not relitigate:**

- **`queued` is a real persisted run status, not an in-memory waiting list.** The run id is handed to
  the caller before the run starts, so the run must survive a Host restart — an in-memory queue
  would hand out ids that evaporate.
- **`busy_capacity` moves rather than disappears.** Keeping the code means every existing harness
  branch on it still works; it just fires far less often and now means "queue full".
- **`busy_checkout` does not queue.** A checkout conflict (`tryReserve` `:1718-1732`) is a
  contention on a resource the *caller* named, not a capacity condition; queuing on it would block
  behind a run that might never end. It stays an immediate `409`. After slot 2 it applies only to
  path-checkouts anyway.
- **Round-robin over project root, not a second static per-project cap.** A static cap wastes slots
  when only one project is active; round-robin gives fairness *and* full utilisation.
- **Queue order within a project root is FIFO by `created_at`.** No priorities in v1 — priorities
  need a policy nobody has asked for yet.
- **`sf run` (the blocking CLI path) waits through `queued` transparently.** It already polls to
  terminal (`pollRunUntilTerminal`, `src/cli/hostClient.ts:88`); a queued prefix changes nothing
  visible except a "queued at position N" line on stderr. Its exit-code contract is untouched.
- **Boot re-enqueues.** `resumeStalledSchedules` (`runManager.ts:482-500`) only looks at `running`;
  add a `queued` pass that rebuilds the queue in `created_at` order.

**Files likely to touch.** `src/runtime/runManager.ts` (the bulk — a queue alongside `active` /
`checkoutLeases`, and `tryReserve` becoming an admit-or-enqueue decision),
`src/runtime/pipelineScheduler.ts`, `src/runstore/port.ts`,
`src/runstore/sqlite/SqliteRunStore.ts`, `src/mcp/catalogTools.ts` (the `start_run` tool description
at `:186` documents the busy codes verbatim), `src/mcp/controlTools.ts`, `src/server/http.ts`,
`src/cli/runOutput.ts`, `src/cli/runsCommand.ts`, `src/a2a/service.ts:311` (branches on
`busy_capacity` / `busy_checkout`), `ui/src/`, `docs/ci.md`, `docs/mcp.md`.

---

### 11.4 — Disk admission

**Today.** Nothing checks free disk anywhere. A run starts, slot 2 clones a repository into a fresh
worktree, the volume fills mid-clone, and SQLite starts failing writes for *every* run on the Host —
not just the one that ran out.

**Target.** Before admitting a run (queued or not), stat the durable root's filesystem and refuse
when free space is below a floor:

- `STAGEFLOW_MIN_FREE_DISK_BYTES`, with a sensible default (a couple of GB) and support for a
  percentage form.
- A dedicated error code **`insufficient_disk`**, distinct from `busy_capacity`, returned with the
  free-bytes figure and the configured floor so a harness can back off intelligently rather than
  retry-storming.
- Surfaced the same three ways `busy_capacity` is: MCP `isError` payload, REST `409`, and a
  `sf run --json` document.

**Design decisions already made — do not relitigate:**

- **Its own error code.** `busy_capacity` means "come back in a minute"; `insufficient_disk` means
  "come back after someone frees space". A harness must be able to tell them apart — retrying the
  second one is exactly wrong.
- **It refuses admission, it does not queue.** Queuing a run that cannot start until a human
  intervenes just moves the failure later and holds a queue slot.
- **The check is per-admission, not continuous.** A run that fills the disk mid-flight is 11.2's
  per-run disk quota (not this slot). Do not build a watchdog.
- **The floor is on the durable root's filesystem**, not a Stageflow-computed budget — `statfs` on
  the real mount is what SQLite cares about.

**Files likely to touch.** `src/runtime/runManager.ts` (admission path), the shared disk helper from
3.4, `src/cli/runOutput.ts` (a new non-busy start-failure code —
`formatRunStartFailedJson` at `:66-76` already carries an optional `code`),
`src/mcp/catalogTools.ts`, `src/server/http.ts`, `docs/ci.md`.

---

## Out of scope

- **The `interrupted` status and graceful shutdown** — slot 4. That slot adds a non-terminal
  `interrupted` stage state produced by SIGTERM handling and by `reconcileOrphanedStages`
  (`src/runtime/runManager.ts:405-480`), and makes it resumable. Leave `STARTUP_RECONCILE_REASON`
  alone; just make sure your `cancelled` runs are skipped by reconciliation.
- **The process-group kill fix** — also slot 4, and a hard dependency of yours (see *Dependencies*).
  Do not fix `stageProcessLauncher.ts:137-145` in this slot's diff; coordinate so it lands first.
- **Backup and restore** — slot 8. `sf backup` / `sf restore` and the "what in `$STAGEFLOW_HOME` is
  irreplaceable" table are theirs. Your retention windows are an input to their docs, not their
  implementation.
- **Per-stage CPU and memory limits — explicitly rejected.** The operator owns CPU and memory via
  `docker run --cpus --memory`. Enforcing them inside Stageflow means cgroups or nested containers,
  which needs privileges the docs tell users never to grant. Stageflow owns **time, disk, and
  tokens**, because those map to run semantics it already tracks.
- **Run-level wall-clock deadlines, token budgets, and per-run disk quotas** — 11.2, a later slot.
  You provide the terminal status vocabulary those will extend.
- **Authentication on the new verbs.** Slot 5 adds `STAGEFLOW_CONTROL_TOKEN`, the allow-list, and
  gating for reads. Register your new mutating routes in the existing `isMutatingApi` loopback gate
  (`src/server/http.ts:141-165`) so slot 5 picks them up automatically; do not invent a second gate.
  Widening that function to cover `DELETE` *is* in scope — leaving it POST-only is not "slot 5's
  problem", it is shipping an ungated destructive route.

---

## Acceptance criteria

**Cancel**

1. `cancel_run(runId, reason)` on a `running` run: the run reaches `cancelled`, every live stage
   worker is gone (verified by pid, not by the absence of a log line), no further stage starts, and
   the checkout lease is released.
2. `cancel_run` on a `queued` run removes it from the queue and marks it `cancelled` without
   spawning anything.
3. `cancel_run` is idempotent on an already-`cancelled` run and `409`s on `succeeded` / `failed`.
4. A cancelled run survives a Host restart as `cancelled` — `reconcileOrphanedStages` and
   `syncRunStatusFromStages` do not rewrite it.
5. `sf run --json` on a cancelled run emits `outcome: "cancelled"` and exits `1`.

**Delete**

6. `delete_run` on a terminal run leaves zero rows in all ten run-scoped tables, zero bytes under
   `runs/<runId>/`, no worktree, no `stageflow/run-<runId>` branch, and no A2A tasks or frozen
   artifacts for that run.
7. `delete_run` on an active run `409`s; with `force: true` it cancels first, then deletes.
8. `delete_run` on a run whose workspace directory was already removed by hand still deletes the
   rows and reports success.
9. `delete_run` is available on MCP, REST (`DELETE /api/runs/:runId`), and CLI
   (`sf runs delete --run <id> [--force]`).

**Retention**

10. A `succeeded` run past its SLIM window loses its worktree, `.pi-agent/` trees, `stream.log`s,
    `pi-session.jsonl`s, and oversized artifacts, and keeps its run record, envelopes, stage events,
    and verification history — verified by reading them back through `get_run` and `get_envelope`
    after the sweep.
11. A run past its PURGE window is gone as if `delete_run` had run.
12. A `failed` run and a `succeeded` run with the same terminal timestamp are SLIMmed on different
    days, per the per-status override.
13. A non-terminal run older than every window is untouched.
14. A bare clone cache with a live worktree is never evicted, regardless of age.
15. The sweep is idempotent: running it twice back to back reclaims nothing the second time and does
    not re-walk already-slimmed runs.

**Visibility**

16. `sf runs gc --dry-run` reports exactly what a real sweep would reclaim and changes nothing.
17. `list_runs` reports `disk_bytes` per run; `GET /api/health` reports a category breakdown plus
    free space.
18. Crossing `STAGEFLOW_DISK_WARN_BYTES` produces exactly one named warning at boot and does not
    prevent startup.
19. The periodic sweep does not keep the process alive (`.unref()`), does not run at boot, and its
    failures are logged rather than fatal.

**Admission**

20. With `maxConcurrent` slots full, `start_run` returns a `runId` and a queue position instead of
    `busy_capacity`; the run later starts on its own.
21. With `STAGEFLOW_MAX_QUEUED` also full, `start_run` returns `busy_capacity`.
22. Queued runs across two project roots dequeue round-robin, not FIFO across the whole queue.
23. `queued` runs survive a Host restart and are re-enqueued in `created_at` order.
24. Below `STAGEFLOW_MIN_FREE_DISK_BYTES`, `start_run` returns `insufficient_disk` — not
    `busy_capacity` — with the free-bytes figure and the floor.

**Contract**

25. `docs/ci.md` documents `cancelled`, `insufficient_disk`, the queued start document, and the new
    env vars in the concurrency table.
26. `npm test`, `npm run ui:test`, and `npm run typecheck` pass.

---

## Testing

Tests live in `tests/*.test.ts` (Vitest), with YAML fixtures under `tests/fixtures/pipelines/`,
`stages/`, and `tasks/`. UI tests live in the `ui/` workspace. Prefer extending fixtures over inline
YAML when behaviour is catalog-driven. Existing neighbours to read and imitate:
`tests/cli.runs.mutate.test.ts`, `tests/cli.run.json.test.ts`, `tests/a2a.limits.test.ts` (the
retention-window pattern).

Suggested new files:

- `tests/runtime.cancelRun.test.ts` — status transition, idempotency, `409` on terminal, lease
  release, queued-run cancel.
- `tests/runstore.deleteRun.test.ts` — row-by-row emptiness across all ten tables, filesystem
  removal, missing-directory tolerance, `force` behaviour.
- `tests/runstore.retention.test.ts` — the SLIM/PURGE eligibility function against an **injected
  clock**, exactly as `pruneExpired` takes `now: Date` (`src/a2a/store.ts:300-304`). Table-drive it
  off the windows table above; per-status overrides; non-terminal runs untouched; idempotency.
- `tests/runstore.diskUsage.test.ts` — the walker against a synthetic tree, including the legacy
  non-attempt-scoped artifacts dir.
- `tests/runtime.admissionQueue.test.ts` — queue position, `STAGEFLOW_MAX_QUEUED` boundary,
  round-robin across two `project_root`s, restart re-enqueue.
- `tests/cli.runs.gc.test.ts` — `--dry-run` reclaims nothing, JSON shape.
- `tests/mcp.runLifecycle.test.ts` and a REST equivalent — the new verbs, including the `409` paths.

Make the clock, the filesystem root, and the free-disk reading injectable. Three of these test files
are otherwise either flaky or dependent on the machine they run on.

**Manual verification is the real acceptance test for cancel.** Start a pipeline whose stage shells
out to a long `sleep` through the agent, `cancel_run` it, and confirm with `ps` that no descendant
survives. This is the assertion that catches the slot 4 dependency not having landed, and no unit
test will catch it for you.

---

## Repo conventions

Read [`AGENTS.md`](../../../AGENTS.md) at the repo root first. The load-bearing parts for this slot:

- **Commands.** `npm run build`, `npm test`, `npm run typecheck`, `npm run ui:test`. Run the last
  three before finishing. Dev entrypoint without a global install: `npm run dev -- runs list`.
- **Minimal, focused diffs.** Match the existing patterns in each file you touch. No drive-by
  refactors — do not restructure `runManager.ts` while you are in there, even though it is 1972
  lines.
- **No comments unless the logic is non-obvious.**
- **JSON output and exit codes are a public contract.** Anything you change in `sf run --json` or an
  exit code must land in `docs/ci.md` in the same commit, and `tests/cli.*.test.ts` asserts the
  shapes.
- **Never shell out with `shell: true`.** Use `execFile` with argument arrays (the rule slot 2's
  `src/git/` module is built on).
- **Positioning in user-facing copy.** Lead with configurable stages and pipelines; SDLC is one
  example among others. Do not write docs that imply Stageflow is an SDLC tool.
- **Do not author `clonable` / `clone_forks` in YAML** (rejected keys), and author new catalog
  contracts as `io` / `verify` / `on_verify_fail`. Not expected to come up in this slot.
- Public docs index: [`docs/README.md`](../../README.md). The pages you will touch are
  [`docs/ci.md`](../../ci.md), [`docs/cli-reference.md`](../../cli-reference.md), and
  [`docs/mcp.md`](../../mcp.md).

---

## Open questions for the human

1. **Is `cancelled` exit `1`, or does it get its own exit code?** The brief above decides exit `1`
   with a distinct `outcome: "cancelled"` in the JSON, on the grounds that adding a fourth exit code
   to a published three-code table (`docs/ci.md`) breaks scripts that switch exhaustively. If you
   would rather have exit `3`, say so before the CI docs get written.
2. **Should SLIM be the default at all, or opt-in for the first release?** Reclaiming a failed run's
   worktree is exactly what bites the one user who needed it. The defaults above (14-day SLIM for
   `failed`) are a compromise; shipping with retention disabled and a loud health warning until an
   operator opts in is the more conservative option.
3. **What is the right `STAGEFLOW_MIN_FREE_DISK_BYTES` default?** "A couple of GB" is a placeholder.
   It should plausibly cover one worktree of the largest repo the Host serves, which nobody can know
   ahead of time. A percentage of the filesystem may be the better default shape.
4. **Does `delete_run` need an audit trail?** After slot 13.5 (per-caller attribution) a harness can
   delete another caller's run and leave no evidence. Deciding now whether deletion writes an
   append-only audit line is cheaper than retrofitting it.
5. **Should the queue be per-Host or per-project-root persisted?** Round-robin dequeue is specified,
   but if a project root is removed from the manifest while runs are queued against it, those runs
   are orphaned. Drain them, cancel them, or leave them queued forever?
6. **Slot 4 coordination: who lands the process-group fix?** It is listed as slot 4's work
   (`10.7`, a rider on 3.1/4.1), but `cancel_run` is functionally broken without it. Either slot 4
   lands first, or this slot takes that one hunk of `stageProcessLauncher.ts` and slot 4 inherits it.
   Pick one before either slot starts.
