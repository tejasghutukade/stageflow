# CLI JSON and exit codes

Branch on these documents and exit codes. Human lines on stderr are not the contract. Add `--json` on every command that accepts it. Autostart failures are in [control-surface.md](control-surface.md#autostart).

`sf trigger fire` uses the same completion document and exit codes as `sf run`.

## Contents

- [sf run](#sf-run)
- [sf runs](#sf-runs)
- [sf browser](#sf-browser)
- [Exit code index](#exit-code-index)

## sf run

`sf run` prints one JSON document when the run finishes or parks. It can block for the whole run. A queued start also prints `queued at position <n>` on stderr. That line is not the result.

Validation, before a run exists, prints the validate document and no `outcome`: `{ "ok", "scope", "checks", "summary", "findings" }`. Each finding has `severity`, `category`, `code`, `file`, `message`. Exit `1` when `ok` is false.

Preflight failure, also before a run exists: `{ "code", "error", "checks" }`. Exit `1`.

Start refused:

| `code` | Document | Exit |
|---|---|---|
| `busy_capacity` | `{ "ok": false, "outcome": "busy", "code", "reason", "activeCount", "maxConcurrent", "activeRunIds" }` | 1 |
| `busy_checkout` | `{ "ok": false, "outcome": "busy", "code", "reason", "conflictingRunId", "conflictingCheckout" }` | 1 |
| `busy_caller_quota` | `{ "ok": false, "outcome": "failed", "code": "busy_caller_quota", "reason" }` | 1 |
| `insufficient_disk` | `{ "ok": false, "outcome": "failed", "code", "reason", "freeBytes", "minFreeBytes" }` | 1 |
| anything else at start | `{ "ok": false, "outcome": "failed", "reason", "code"? }` | 1 |

`busy_caller_quota` is a busy condition in the Host, and the CLI document labels it `outcome: "failed"`. Branch on `code`, not on `outcome` alone, when you report it. It is not queued.

Completion (`--include stages` adds `stages` from the run projection):

| `outcome` | Document | Exit |
|---|---|---|
| `succeeded` | `{ "ok": true, "outcome", "runId", "runDir", "total_cost_usd"? }` | 0 |
| `waiting` | `{ "ok": false, "outcome", "runId", "runDir", "total_cost_usd"? }` | 2 |
| `cancelled` | `{ "ok": false, "outcome", "runId", "runDir", "reason"?, "total_cost_usd"? }` | 1 |
| `failed` | `{ "ok": false, "outcome", "runId", "runDir", "reason"?, "findings"?, "total_cost_usd"? }` | 1 |

`total_cost_usd` is omitted when no stage reported usage. `--include stages` requires `--json`. Findings on a failed completion use `severity`, `code`, `file`, `message`, `category`.

`sf runs rerun` and `sf runs retry` and `sf runs recover` (without `--stop`) print this same completion document. `sf trigger fire` does too.

## sf runs

Read verbs start a Host only when the store needs a migration. Mutating verbs always do. On that failure the document is `{ "error", "reason" }` and the exit is `1`.

| Command | Success document | Exit |
|---|---|---|
| `list` | `{ "runs": [ RunSummary, ... ] }` | 0 |
| `show` | One run projection: `run_id`, `status`, `stages` (each with `stage_id`, `status`, `envelope`, `cost_usd`?), `waiting_*`, `failed_stage_id`, `failed_reason`, `total_cost_usd`?, `feedback_loops` | 0 |
| `verify` | The stage's verification history (`attempts[]` with `attempt`, `status`, `checks`) | 0 |
| `waiting` | `{ "waiting": [ ... ] }` | 0 |
| `wait` | `{ "ok": true, "reason", "elapsed_ms", "until", "run" }` | 0, including `reason: "timeout"` |
| `answer` | `{ "ok": true }` or `{ "ok": true, "verification" }` | 0 |
| `feedback-decide` | `{ "ok": true, "effect", "loopId" }`. `effect` is `extended`, `continued`, or `abandoned` | 0 |
| `retry` | `sf run` completion document | 0, 1, or 2 |
| `resume` | `{ "ok": true, "runId", "stageId", "attemptIndex" }` | 0 |
| `recover` | `sf run` completion document | 0, 1, or 2 |
| `recover --stop` | `{ "ok": true, "runId", "stageId" }` | 0 |
| `abandon` | `{ "ok": true, "runId", "stageId" }` | 0 |
| `cancel` | `{ "ok": true, "runId" }` | 0 |
| `delete` | `{ "ok": true, "runId" }` | 0 |
| `gc` | `{ "slimmed", "purged", "bareCachesEvicted" }` arrays of run ids. Executes unless `--dry-run` | 0 |
| `rerun` | `sf run` completion document | 0, 1, or 2 |

`list --status` accepts `created`, `queued`, `running`, `succeeded`, `failed`, `cancelled`. `waiting` is not a run status. Parked HITL runs stay `running`. Use `sf runs waiting`.

`wait` reasons are `waiting`, `terminal`, `timeout`, and `already`. The wait document is `{ reason, run, ... }`, so its status is `run.status`. A cancelled run does not wake this wait. After `timeout`, `sf runs show --json` and MCP `get_run` put the status in top-level `status`. Abort (Ctrl-C) is `{ "error", "code": "aborted" }` and exit `130`. The run continues.

A mutating failure is `{ "error", "status"? }` and exit `1`. `--answer` that is not JSON is `{ "error", "status": 400 }`. `--decision` must be `extend`, `continue`, or `abandon`.

`show` and `wait` accept `--from <sf-run.json>` in place of `--run`.

## sf browser

`sf browser` never starts a Host. `--json` prints the success document, or `{ "error", "code" }` on failure. The exit code is the contract. Full documents are in [browser-logins.md](browser-logins.md).

| Exit | Meaning |
|---|---|
| 0 | Ok, or logged in. |
| 1 | Error (`not_found`, `confirmation_required`, `blocked_site`, `not_pinned`, `pinned_by_config`, usage). |
| 2 | `profile_busy`: a live run holds the profile. |
| 3 | Check saw logged out. |
| 4 | Check could not tell. |
| 5 | Login timed out or the window closed. |
| 130 | Login interrupted. |

`check` with exit `0` has `state: "logged_in"`. Exit `3` is `logged_out`. Exit `4` is `unknown`. Do not treat a JSON body alone as success when the exit is `3` or `4`: the body is still a result document, and the exit says which.

## Exit code index

| Exit | Where it is used |
|---|---|
| 0 | Success. For `sf run`, the run succeeded. For `sf browser check`, the profile is logged in. For `sf runs wait`, the wait returned, including a timeout. |
| 1 | Failure, refusal, validation, cancel, busy, disk, or a browser error. |
| 2 | `sf run` (and rerun, retry, recover, trigger fire) parked on a human gate. `sf browser` profile is held by a live run. |
| 3, 4, 5 | `sf browser` only: logged out, unknown, login not completed. |
| 130 | The wait or the browser login was interrupted. The pipeline run keeps going. |
