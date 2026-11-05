# Runs

How to watch a run and what the control verbs actually do. Starting a run is [start-a-run.md](start-a-run.md). Answering a gate is [hitl-gates.md](hitl-gates.md).

## Watch between waits

`wait_run` and `sf runs wait` block. Between wakes, read state. Do not infer progress from the wait `reason` alone.

| Want | MCP | CLI |
|---|---|---|
| Status, stage statuses, cost, waiting fields | `get_run` `{ runId }` | `sf runs show --run <id> --json` |
| Persisted stage events | `list_stage_events` `{ runId, stageId, attempt? }` | no equivalent; use MCP |
| Live assistant text as it streams | `tail_stage_log` `{ runId, stageId, attempt?, since_offset? }` | no equivalent; use MCP |
| Why verification failed | `get_stage_verification` `{ runId, stageId }` | `sf runs verify --run <id> --stage <s> --json` |

`get_run` does not include the event log. `tail_stage_log` returns `text`, `next_offset`, and `attempt_complete`. Pass the previous `next_offset` as `since_offset`. Omit `since_offset` to read what is still retained. It is redacted stream text, not prompts or artifacts.

`wait_run` and `sf runs wait` do not wake when a run becomes `cancelled`. Their document nests the projection under `run`, so the status there is `run.status`. After `reason: "timeout"`, call `get_run` or `sf runs show --json` and read the top-level `status`. If it is `cancelled`, stop waiting and report.

## Verbs that differ

Confirm before `retry_stage`, `resume_stage`, and `rerun`. Each starts model work again.

| Verb | What it does | What it refuses |
|---|---|---|
| `retry_stage` / `sf runs retry` | A new attempt of a failed stage | A stage that is waiting. Answer it instead. |
| `resume_stage` / `sf runs resume` | Continues the same attempt after an interrupt or a timeout | A fresh start. Use retry for that. |
| `abandon_stage` / `sf runs abandon` | Marks a running stage failed | A waiting stage (409). Answer it. Prefer `cancel_run` to stop the whole run. |
| `cancel_run` / `sf runs cancel` | Stops the run. `reason` is required | Nothing else stops the run. Killing the CLI process does not. |
| `rerun` / `sf runs rerun` | A new run from the same inputs. `pinned` keeps the recorded settings | Do not rerun a run that is still active. The tool text says "completed or failed"; the Host does not check. |
| `recover_manual_stage` / `sf runs recover` | Supplies guidance to a manual-recovery stage, or `--stop` / `stop_manual_recovery` | Not a substitute for `answer_gate`. |
| `delete_run` / `sf runs delete` | Removes the run. `--force` deletes one that is not terminal | Irreversible. Confirm. |
| `gc_runs` / `sf runs gc` | Reclaims disk | CLI executes unless `--dry-run`. MCP stays a dry run unless `execute: true`. |

## Store reads without a Host

`sf runs list`, `show`, `verify`, `waiting`, and `wait` read the store on disk. They start a Host only when that store needs a migration. Answering, cancelling, retrying, resuming, and rerunning need a Host. The CLI starts one unless `STAGEFLOW_NO_AUTOSTART` is set.

Run files live under `$STAGEFLOW_HOME/runs/<runId>/` (default `~/.stageflow/`). The CLI JSON field is `runDir`.
