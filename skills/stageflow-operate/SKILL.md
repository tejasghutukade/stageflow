---
name: stageflow-operate
description: >-
  Runs and operates Stageflow day to day: starts pipeline runs (CLI, MCP, CI),
  watches progress, answers human-in-the-loop gates on the native question UI,
  makes feedback-loop decisions, and lists, inspects, retries, resumes, cancels,
  reruns and exports runs. Also handles the Inbox and agent approvals,
  pipeline-stage connections, saved browser logins, trigger firing, A2A
  callers, backup and restore, and cost. Use for "run this pipeline", "check my
  run", "answer the pending question", "cancel the run", "connect Slack, email
  or another provider for a pipeline stage send", "fire the trigger", "log in
  again". Not for editing pipeline or agent YAML, or evals.
compatibility: Needs the sf CLI on PATH, or a running Stageflow Host reachable over MCP or HTTP. Node 18+ for scripts/mcp-call.mjs.
---

# Stageflow operate

Operate a Stageflow installation: start runs, watch them, answer the humans-in-the-loop gates, and manage what runs depend on (connections, saved logins, triggers, A2A callers). Authoring is elsewhere: use `stageflow-pipelines` to change pipeline, stage or task YAML, `stageflow-agents` to change an agent, `stageflow-evals` for evals, and `stageflow` for install and setup.

Runs execute inside a **Host**, a global service on `127.0.0.1:${STAGEFLOW_SERVICE_PORT:-3847}`. The `sf` CLI is a client of it, and so are MCP and REST. Run state lives under `$STAGEFLOW_HOME` (default `~/.stageflow/`), never in the project tree. Stopping a CLI process does not stop a run; cancelling does.

## Ground rules

1. **Confirm before anything costly, destructive or externally visible.** See [Confirm first](#confirm-first). A yes in an earlier turn covers only what was described then.
2. **Never put a secret in chat, a command line, YAML or a file.** Send the user to the console, to a harness secret prompt, or to an `env:` reference. Details in [references/connections-and-channels.md](references/connections-and-channels.md#secrets).
3. **Never invent a tool, flag or code.** Use only the names in this skill and its references. `node scripts/mcp-call.mjs --list-tools` prints what the Host really has.
4. **Machine-read everything**: `--json` on every `sf` command, and branch on JSON fields and exit codes, not on prose.
5. **Print gate prompts verbatim.** Never paraphrase a question a stage asked a human, and never answer a gate yourself unless the user told you the answer.
6. **A message that may have been sent is never resent.** `CHANNEL_SEND_OUTCOME_UNKNOWN` means ask the user to check the destination.

## Confirm first

State what will happen in one or two lines and wait for a yes.

| Action | Why it needs a yes |
|---|---|
| Start a run (`sf run`, `start_run`, `rerun`, `retry_stage`, `resume_stage`, `fire_trigger`, `sf trigger fire`, `run_stage`) | Calls models and tools, costs money, and can write to a checkout or send messages. Stageflow cannot predict the cost; say so. |
| Any run whose pipeline has `channels:`, `browser:` or tools that act externally | Externally visible. Name the channel and recipient. |
| `--skip-gates` / `skip_gates` | Turns every human gate into a stage failure. Only when the user asked for unattended behavior. |
| `cancel_run`, `abandon_stage`, `stop_manual_recovery`, `stop_agent_session` | Ends work in progress. |
| `delete_run`, `sf runs delete --force`, `gc_runs` with `execute: true`, `sf runs gc` (executes by default on the CLI) | Irreversible. |
| `create_connection`, `update_connection`, `remove_connection`, `test_connection` | Touches secrets; `test_connection` also makes a live provider call. |
| `sf browser clear`, `sf browser login` | Deletes a saved login, or opens a window on the user's screen. |
| `create_trigger`, `update_trigger`, `set_trigger_enabled` | An enabled schedule or event trigger starts runs by itself. |
| `sf a2a ...` caller, publication or enable changes | Exposes pipelines to outside callers. |
| `approve_agent_action` | Lets an agent perform the action it asked about. Show the pending action first. |
| `sf backup`, `sf restore` | Backups can hold provider credentials; restore replaces state. |

## 1. Reach Stageflow

Do these in order and stop at the first that works.

1. `sf --version` prints a version, or you have a native Stageflow MCP tool list, or the user gave you a Host URL. If none, stop and use the `stageflow` skill to set up.
2. Probe the Host (no auth needed): `node scripts/mcp-call.mjs --probe` prints `up <baseUrl>` or `down <baseUrl>`. Add `--base-url <url>` for a Host on another port or machine. `up <baseUrl> bearer`: the suffix means a drive token is set. The probe does not send it. Later `/mcp` calls do.
3. Choose the surface:

| Situation | Use |
|---|---|
| This harness already lists Stageflow MCP tools (`start_run`, `wait_run`, ...) | Those tools. |
| Host `up`, no native tools | `node scripts/mcp-call.mjs --tool <name> --args '<json>'`. See [references/mcp-call.md](references/mcp-call.md). |
| You have a shell and `sf` | The CLI with `--json`. Most `sf` verbs start the Host themselves when it is down, headless, detached, and leave it running. |
| Host is remote, in Docker, or the harness has no shell | MCP or REST with a bearer token. The CLI cannot target a non-local Host. |

`STAGEFLOW_NO_AUTOSTART=1` stops the CLI from spawning a Host (a Host that is already up still works). A Host on a non-default port is invisible to the CLI unless `STAGEFLOW_SERVICE_PORT` is exported to the same port. Full model, autostart table, tokens and failure modes: [references/control-surface.md](references/control-surface.md).

**Done when** you know the surface and, for MCP, the base URL.

## 2. Start a run

Read [references/start-a-run.md](references/start-a-run.md) for selection, task shapes, binding and flags.

1. **Select** one pipeline and one task. Named by the user: match against id and path; several matches, ask. Unnamed: list and ask. MCP has `list_pipelines` and `list_tasks`. The CLI has no list command: read `stageflow.yaml` and walk its catalog roots. With no catalog task, build an inline task from the user's goal (`id`, `goal`, optional `context`, `constraints`, `input`).
2. **Validate, free.** The CLI accepts only one of `--pipeline`, `--task`, or `--trigger`. Run them separately: `sf validate --pipeline <path> --strict --json`, then `sf validate --task <path> --json` when there is a task file. Exit 0 is clean, exit 1 is findings. On MCP call `preflight` with `pipeline` and optional `project_root`; it checks `requires:`, declared secrets, stage MCP variables and live channel checks, never sends a message and never creates a run. Fix or report `missing_tool`, `tool_version_mismatch`, `secret_unavailable`, `unresolved_var`, `channel_check_failed` before starting.
3. **Self-check what the validator skips.** `sf validate` does not compare the task `input` with the entry stage's `io.input` schema. Read both and say if they disagree.
4. **Confirm** (see [Confirm first](#confirm-first)): pipeline, task, binding (checkout path or repository and ref), whether it sends or browses, and whether gates are skipped.
5. **Start.**

| Surface | Command | Returns |
|---|---|---|
| MCP | `start_run` with `pipeline` plus exactly one of `task_path` or inline `task` | `{ "runId" }` at once, or `{ "runId", "queued": true, "queuePosition" }` |
| CLI | `sf run --task <path> --pipeline <path> --json` | One JSON document **when the run ends or parks**. It can block for the whole run. |

Prefer MCP `start_run` for anything long: it returns immediately. For a long `sf run`, launch it in the harness's background shell and poll with `sf runs wait`.

Start results (MCP `isError` payload or CLI JSON):

| Result | Meaning and next step |
|---|---|
| `runId` (queued or not) | Success. Go to [Watch](#3-watch). A queued run is only slower. |
| `busy_capacity` | The admission queue is full. Report `activeCount` / `maxConcurrent`. Do not loop. |
| `busy_checkout` | Another run holds that checkout path. It never queues. Report `conflictingRunId`. |
| `busy_caller_quota` | A named caller hit its concurrent-run limit. Report it. |
| `insufficient_disk` | Report `freeBytes` / `minFreeBytes`. Not queued. |
| validation or `preflight` code, `absolute_path_not_allowed`, `unknown_project_root`, `task.binding_conflict` | Fix the input and try again. See [references/start-a-run.md](references/start-a-run.md). |

**Done when** you have a `runId`, or a busy, disk or error report is printed.

## 3. Watch

MCP: `wait_run` with `{ "runId", "until": "any" }` (`timeout_ms` default 60000, max 240000). CLI: `sf runs wait --run <id> --json --until any [--timeout-ms n]`.

Do not branch on `reason` alone. After every wake read the run:

| What you see | Next |
|---|---|
| `run.status` is `succeeded` or `failed` | [Report](#5-report) |
| `run.waiting_stage_id` / `waiting_stage_ids` set, or a stage `waiting_for_input` | [Answer a gate](#4-answer-a-gate) |
| `reason: "timeout"` | Read the run again with `get_run` or `sf runs show --json`. Those documents put the status in top-level `status`, not `run.status`. If it is `cancelled`, [Report](#5-report). Otherwise wait again. |
| error `code: "aborted"` (CLI exit 130) | The run continues. Say so and stop. |

Cancelled-run caveat: `wait_run` and `sf runs wait` never wake on a `cancelled` run. `run.status` is only on that wait document. After a timeout, read top-level `status` from `get_run` or `sf runs show --json`.

To show live progress between waits, use `get_run` (stage statuses and costs), `list_stage_events`, or `tail_stage_log` with the returned offset. See [references/runs.md](references/runs.md).

Without a Host (only the CLI, Host gone): `sf runs list|show|waiting|wait|verify` read the store directly. Answering and every other change need a Host; the CLI starts one.

## 4. Answer a gate

A gate is a stage waiting for a human. `list_waiting` (or `sf runs waiting --run <id> --json`) returns each gate with `waiting_kind`, `pending_prompt` and artifacts. `get_waiting_summary` gives only counts and identities.

- `waiting_kind: feedback_loop_decision`: not a normal gate. Print the prompt verbatim, ask extend, continue or abandon, then `decide_feedback_loop` with `{ runId, stageId, decision, loopId?, reason? }` or `sf runs feedback-decide --run <id> --stage <sourceStageId> [--loop <id>] --decision extend|continue|abandon --json`. Never send this through `answer_gate`.
- Everything else: read [references/hitl-gates.md](references/hitl-gates.md) for the exact `answer` for each kind, and [references/native-question-ui.md](references/native-question-ui.md) before presenting it. In short: use this harness's own question tool (`AskQuestion`, `AskUserQuestion`, `ask_user`) when it is in your tool list and the gate fits it; otherwise ask in chat. `multi_question` is one picker with one question per item, or the whole gate in chat. `free_text` with no closed set is always chat.

Submit with `answer_gate` `{ runId, stageId, answer }` or `sf runs answer --run <id> --stage <id> --answer '<json>' --json`. Success is `{ "ok": true }` even if the run parks again, so go back to [Watch](#3-watch). On 400, 404 or 409 print the payload and collect a corrected reply. A 409 from answer includes the stage not waiting, or a resume already in progress.

Gates on browser stages carry a `handoff` (a window on the user's screen, their own Chrome, or a live view in the console). Tell the user where to log in before asking them to accept. See [references/browser-logins.md](references/browser-logins.md).

**Done when** `answer_gate` or `decide_feedback_loop` returned `{ "ok": true }` and you are watching again.

## 5. Report

Print one shape on every path:

1. Current or last-known stage (or "start and finish only" when the CLI ran without a later `runs show`).
2. The waiting prompt verbatim when parked.
3. Outcome: store status `succeeded`, `failed`, `cancelled`, or `running` when parked on a gate (`sf run` exit 2 is that signal). Also `busy` and `insufficient_disk` at start. Do not call the store status `waiting`.
4. Run id.
5. Where it lives: `$STAGEFLOW_HOME/runs/<runId>/` (the CLI JSON `runDir`).
6. Cost: `total_cost_usd` from `get_run`, `sf runs show --json` or the `sf run --json` document, and per-stage `cost_usd`. Say "not reported" when absent.

For a failure add `failed_stage_id` and `failed_reason` verbatim, and offer the next step: `get_stage_verification` for verification failures, `retry_stage` for a failed stage, `resume_stage` for an interrupted or timed-out one, `rerun` for a fresh run. Repository-bound succeeded runs may have a reclaimed worktree (`checkout_reclaimed`); `run_branch` is kept.

## 6. Operate on existing runs

Read [references/runs.md](references/runs.md) first; it has the full table and the semantics that differ.

| Want | MCP | CLI |
|---|---|---|
| List, filter | `list_runs` (`status`, `since`, `pipeline`, `caller_id`) | `sf runs list [--status ...] [--since iso] [--pipeline x] --json` |
| One run | `get_run` | `sf runs show --run <id> --json` |
| Why a stage failed verification | `get_stage_verification` | `sf runs verify --run <id> --stage <s> --json` |
| Retry a failed stage (new attempt) | `retry_stage` | `sf runs retry --run <id> --stage <s> --json` |
| Resume an interrupted or timed-out stage (same session) | `resume_stage` | `sf runs resume ...` |
| Manual-recovery stage | `recover_manual_stage` / `stop_manual_recovery` | `sf runs recover --run <id> --stage <s> [--guidance t] [--stop] --json` |
| Mark a running stage failed | `abandon_stage` | `sf runs abandon ...` |
| Stop a whole run | `cancel_run` (`reason` required) | `sf runs cancel --run <id> --reason <text> --json` |
| Start over from the same inputs | `rerun` (`pinned`) | `sf runs rerun --run <id> [--pinned] --json` |
| Envelope, artifacts, diff | `get_envelope`, `read_artifact`, `get_run_diff`, `list_checkout_changes`, `read_checkout_file` | `sf envelope get`, `sf artifact read`, `sf export-run` |
| Delete, reclaim disk | `delete_run`, `gc_runs` | `sf runs delete --run <id> [--force]`, `sf runs gc [--dry-run]` |

`retry_stage`, `resume_stage` and `rerun` start model work again: confirm first. Waiting stages cannot be retried or abandoned; answer them.

## 7. Other operating jobs

Each has a reference with the exact calls. Read it before acting.

| Job | Reference |
|---|---|
| Connections (Slack, Telegram, AgentMail, iMessage, WhatsApp): create, check, replace key, enable, remove; stage channel sends; unknown outcomes | [references/connections-and-channels.md](references/connections-and-channels.md) |
| Saved browser logins: list, check, log in again, delete, unpin; own-Chrome handoff | [references/browser-logins.md](references/browser-logins.md) |
| Triggers (list, show, fire, enable, create) and A2A (callers, publications, status) | [references/triggers-and-a2a.md](references/triggers-and-a2a.md) |
| Inbox, agent approvals, agent sessions and schedules at the operate level | [references/agents-and-inbox.md](references/agents-and-inbox.md) |
| Backup, restore, export, retention, cost and usage | [references/backup-export-cost.md](references/backup-export-cost.md) |
| JSON shapes and exit codes of `sf run`, `sf runs`, `sf browser` and friends | [references/cli-json-and-exit-codes.md](references/cli-json-and-exit-codes.md) |

## Troubleshooting

| You see | Do |
|---|---|
| `down <baseUrl>` from the probe and you only have MCP | A Host must be running: ask the user to start `sf ui` (console) or `sf mcp` (headless), or use the CLI, which starts one. |
| CLI exit 1 with `autostart_disabled`, `port_occupied`, `bind_refused`, `spawn_failed`, `timed_out` | See the failure table in [references/control-surface.md](references/control-surface.md#autostart). |
| `sf ui` fails to bind after a CLI command | A CLI verb already started a headless Host on that port. Use that Host, or stop it and start `sf ui`. |
| 401 or 403 over MCP/REST | A token is required or has the wrong scope. Ask the user for `STAGEFLOW_CONTROL_TOKEN`; never print it. |
| `Stage provider auth is not configured` | Provider credentials missing: run `sf providers status`, then use the `stageflow` skill. |
| A run is `queued` for long | Host is at its concurrency limit. `get_health` shows `slotsAvailable`; wait or cancel something. |
| Anything else unclear | `sf doctor --json`, then the `stageflow` skill. |

## Known quirks

- `wait_run` / `sf runs wait` do not wake on `cancelled` runs. After a timeout, read top-level `status` from `get_run` or `sf runs show --json`. `run.status` exists only on the wait document.
- `sf runs gc` executes by default; the MCP `gc_runs` is a dry run unless `execute: true`. Use `--dry-run` first on the CLI.
- The MCP `rerun` description says "completed or failed", but the Host does not check the status. Do not rerun a run that is still active.
- `test_connection` is marked read-only but sends the secrets you pass to the provider and makes a live call.
- The short `sf --help` header is a partial index. Trust `sf <command> --help`.
