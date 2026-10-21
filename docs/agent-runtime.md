# Agent runtime

What the Host does when someone messages an agent, and what each setting in the [agent definition](agent-definition.md) enforces. For the overview see [Agents](agents.md).

## A turn

One message from a person (or a schedule, a channel or another agent) is one **turn**:

1. **Open a session** if the message does not name one. The session records where it came from (`console`, `cli`, `mcp`, `web`, `schedule`, `agent`, or a channel provider) and is **pinned to the agent's current revision**. Later edits reach new sessions only.
2. **Begin the turn.** Refused if the agent is disabled or archived (`agent.disabled`, `agent.archived`), if the session already has a turn running or waiting (`agent.session_busy`, 409), or if a [limit](#limits) has been reached (`agent.limit_reached`, 409).
3. **Run the model** in a Pi model session on the pinned revision, with the granted tools. Every tool call passes the [gate](#the-gate) first.
4. **Check the reply** against the guardrails, then store it, with the turn's tokens and cost.
5. **Score** the reply if `evals.groundedness` is on, and push the turn to the OTLP collector if `observability.otlp` is on.

A turn ends `succeeded`, `failed` or `cancelled`. Turns on one session run one at a time. On a channel a turn only counts as succeeded once the reply has reached the person (see [Replies that do not arrive](agents.md#replies-that-do-not-arrive)).

`model.backend: claude` and `execution: sandbox` are not available: the agent saves with a warning and its sessions fail with `agent.backend_unavailable` or `agent.sandbox_unavailable`. A model from Cursor is refused unless the Host opts in; see [Environment variables](#environment-variables).

## The gate

Every tool call goes through one gate before it runs, in this order:

1. **Path guard.** See [below](#the-path-guard-and-bash).
2. **Granted?** The tool must be one the pinned revision grants: a builtin, `<server>.<tool>` (or any tool of a server listed with `"*"`), `stageflow.<tool>`, or `agent:<id>`. Otherwise the call is refused and the model is told so.
3. **Ask first?** If the tool is in `approvals.ask_first` (or is `bash`), the turn pauses for a person. See [Asking first](#asking-first).

The gate runs one call at a time per turn.

## Tools

| Source | How it reaches the model |
|--------|--------------------------|
| Builtin groups `read` (read, grep, find, ls), `write` (write, edit), `shell` (bash), or single tools in `builtin_tools` | Pi's own tools. |
| MCP servers in `tools.mcp` | The server's tools, named `<server>_<tool>`, grant id `<server>.<tool>`. Only the tools listed (or all, with `"*"`) are exposed. |
| Skills in `tools.skills` | Loaded into the session. A skill that is not installed fails the session with `agent.backend_unavailable`. |
| Sub-agents in `sub_agents` | One tool per agent, `agent_<id>`, grant id `agent:<id>`. |
| Stageflow tools in `tools.stageflow` | Named `stageflow_<tool>`, grant id `stageflow.<tool>`. |

### MCP servers

An agent can use any server defined in the project `.mcp.json` **or saved from the console** (Settings → Project MCP); a console entry wins when both use a name. Servers start lazily, in their own processes, the first time the agent uses them. They are released with the session (see [Memory and lifetime](#memory-and-lifetime)).

`${NAME}` placeholders in a server's config are filled from the secrets saved in the console, and from Host environment variables only if their names are listed in `STAGEFLOW_MCP_ENV_ALLOW`. A console secret wins over a Host variable of the same name. The full rules are in [MCP](mcp.md); the host-side files are in [Data directory](data-directory.md).

### Stageflow tools

An agent can be given Stageflow's own tools (the ones in [MCP tools](mcp.md#tools)), whole groups or one at a time. Each tool has a group and a risk (`read`, `write`, `destructive`, `external`).

| Group | Tools | Notes |
|-------|-------|-------|
| `discover` | `list_skills`, `list_pipelines`, `list_tasks`, `list_models`, `list_providers`, `get_health`, `preflight`, `validate`, `describe_pipeline`, `list_project_mcp` (read), `probe_project_mcp` (external) | `get_started` is operator-only. |
| `runs.read` | `list_runs`, `get_run`, `export_run`, `read_artifact`, `wait_run`, `list_stage_events`, `tail_stage_log`, `get_stage_verification`, `get_envelope`, `list_checkout_changes`, `get_run_diff`, `read_checkout_file` | All read. |
| `runs.control` | `start_run`, `run_stage`, `rerun`, `retry_stage`, `resume_stage`, `recover_manual_stage`, `stop_manual_recovery` | Write. |
| `runs.cleanup` | `cancel_run`, `abandon_stage`, `delete_run`, `gc_runs` | Destructive. |
| `gates.read` | `list_waiting`, `get_waiting_summary` | Read. |
| `gates.decide` | `answer_gate`, `decide_feedback_loop`, `approve_agent_action`, `deny_agent_action` | **Operator-only: cannot be granted.** |
| `triggers` | `list_triggers`, `get_trigger` (read), `create_trigger`, `update_trigger`, `set_trigger_enabled` (write), `fire_trigger` (external) | |
| `agents.read` | `list_agents`, `get_agent`, `validate_agent`, `list_agent_revisions`, `get_agent_session`, `list_agent_sessions` | Read. |
| `agents.manage` | `create_agent`, `save_agent`, `enable_agent`, `disable_agent`, `restore_agent_revision` | Write. |
| `agents.cleanup` | `archive_agent` | Destructive. |
| `agents.converse` | `agent_chat` (external), `stop_agent_session` (write) | |
| `evals.read` | `list_evals`, `get_eval`, `validate_eval`, `get_eval_run`, `list_eval_runs`, `get_eval_results`, `get_eval_result`, `compare_eval_runs` | Read, free. See [Evals](evals.md). |
| `evals.run` | `run_eval` (external), `cancel_eval_run` (write) | `run_eval` calls models and costs money, bounded by the eval's cost limit. |
| `pipelines.author` | `read_pipeline` (read), `create_pipeline`, `edit_pipeline`, `create_stage`, `edit_stage`, `create_task`, `edit_task` (write) | |

Rules:

- **Only a person decides.** Gates and approvals (`gates.decide`) cannot be granted, so one agent can never approve or deny another's action (`agent.stageflow_operator_only`).
- **Destructive tools have their own groups**, so ticking "Run and recover pipelines" never selects `delete_run`.
- **An agent cannot hand out more than it holds.** `create_agent`, `save_agent`, `restore_agent_revision` and `enable_agent` called by an agent refuse any grant it does not itself hold (tools, MCP tools, skills, the browser), and refuse a copy that would drop an ask-first the caller is bound by.
- **No self-service.** An agent cannot edit or archive itself.
- **Web chat warning.** A web-chat agent that can read agent sessions gets `agent.web_chat_reads_conversations`, because those hold visitors' messages.
- The serving list for the console is `GET /api/agents/stageflow-tools`. The console turns on ask-first for every non-read tool when you tick a group.

The Workshop and the agent author chat are agents with a fixed grant list, checked through the same grant ids.

### The path guard and `bash`

Agent definitions and Stageflow state are never writable through a tool that names the path. The guard looks at the arguments of every tool except Pi's read-only builtins (`read`, `grep`, `find`, `ls`): any of `path`, `file_path`, `filePath`, `file`, `target`, `destination`, `dest`, `output_path`, or a `paths` list. It refuses a call whose target is:

- an `*.agent.yaml` file under the project's `agents/` directory, or
- anything under the Stageflow home (`$STAGEFLOW_HOME`), unless the project itself lives inside it (as the Docker workspace does).

Relative paths resolve against the project root. This is a check on arguments, not a sandbox.

**`bash` is not path-confined.** The runtime sees a command string, not what it does, so an agent granted `bash` can still change agent files and Stageflow state. The editor warns (`agent.shell_not_path_confined`). So that a person reads each command first, **every `bash` call is ask-first**, whether or not `bash` is in `approvals.ask_first`. Do not grant `bash` to an agent that must stay confined.

## Asking first

A call to a tool in `approvals.ask_first` (always including `bash`) pauses the turn. The session shows **waiting** until someone decides.

- **One at a time.** A session has at most one pending approval, and it stands for the exact call it was raised for (same tool, same arguments). A different call while one is pending is refused with `agent.session_busy`.
- **Approved once means approved for the session.** An identical call (same tool, same arguments) that a person approved is not asked about again in that session. A different call, or a new session, asks again.
- **Denied** tells the model the operator refused and not to retry. The turn carries on.
- **Who decides.** A person, in the Inbox or the agent session page, with `sf agents`, or with the MCP tools `approve_agent_action` and `deny_agent_action`. Channels cannot decide (`approvals.approvers.channel_ids` is reserved and ignored). When desktop notifications are on (Settings → Notifications), the console also raises one when an agent asks; it checks every 15 seconds while the console is open.
- **Timeout.** After `timeout_minutes`, `on_timeout: skip` tells the model the action was skipped and the turn goes on; `deny` ends the turn with `agent.approval_expired`.
- **Stopping the turn** closes a waiting approval (stored as `expired`): it leaves the pending list, cannot be approved later, and does not pre-approve a later identical call.
- **Disabling the agent** while an approval waits: the approval can still be **denied**, but approving it is refused (`agent.disabled`).
- **Restart.** Pending approvals do not survive a Host restart; see [Restarts](#restarts).

Each decision also appears in the trace as an `approval <tool>` span with its outcome.

## Guardrails and streaming

`guardrails.block_patterns` are checked on the finished reply. A match fails the turn with `agent.guardrail_blocked` and **the reply is not stored or sent**. For an agent with patterns, streamed text is held back and released only after the check passes, so blocked text is never shown; the reply then appears at the end instead of word by word. Agents without patterns stream as it arrives.

## Limits

Limits are read from the session's pinned revision and checked **when a turn starts**; a turn already running is not cut short.

| Limit | Refuses a new turn when |
|-------|--------------------------|
| `max_turns` | The session already has that many turns. |
| `session_minutes` | The session is that old. |
| `cost_usd` | The turns so far have cost that much. |

All refuse with `agent.limit_reached` (409). With `always_on: true`, `max_turns` and `session_minutes` do not apply, and `cost_usd` counts the cost of the last 24 hours instead. On a web chat a limit shows as `web_chat.limit_reached`.

### Long conversations

When a session is rebuilt (after a restart, an idle release, or a new Host), its stored transcript is replayed into a new model session. If the earlier messages exceed 60,000 characters, `limits.long_context` decides: `truncate` drops the oldest messages; `summarize` (default) keeps each dropped message as one line of at most 160 characters in a short digest. The newest message is always kept.

### Project context

With `project_context: true` the project's `AGENTS.md` (or, if there is none, `CLAUDE.md`) is added to the system prompt, cut at 20,000 characters.

## Sub-agents

`sub_agents` become tools (`agent_<id>`, taking a `message`). The callee runs in **its own session** (source `agent`, author the caller's id) on **its own current revision and its own approvals**, and its last reply is returned to the caller as the tool result. A callee that fails (disabled, over a limit, an error) returns "Sub-agent … failed: <code>" as the tool result instead of failing the caller.

- **Depth.** The caller's `sub_agent_depth` caps nesting: a top-level session is depth 0, and a call is refused (`agent.delegate_depth_exceeded`) once the nesting depth reaches the calling agent's `sub_agent_depth`. A call to an agent that is not in `sub_agents` is refused (`agent.delegate_not_allowed`).
- **Stopping.** Stopping the caller's turn stops the callee's.
- **Cost.** Each session carries its own tokens and cost; a callee's cost is on the callee's session, not added to the caller's turn.
- **Approvals.** If the callee asks first, the caller waits, since the callee's approval is pending on the callee's session.

## Memory and lifetime

- **Idle release.** The Host drops a session's Pi session and its isolated MCP processes after **30 idle minutes** (`STAGEFLOW_AGENT_SESSION_IDLE_MINUTES`; `0` keeps them). Sessions are also released when a turn is stopped, when the agent is archived, and on shutdown. The next message reopens the session from the stored transcript.
- **Stall watchdog.** If the model sends nothing for **180 seconds** (`STAGEFLOW_AGENT_STALL_SECONDS`; `0` turns it off) the turn fails with `agent.model_timeout` (504). Time spent waiting for an approval, a running tool or a sub-agent is not counted.
- **Pi session files** are kept under `$STAGEFLOW_HOME/agents/pi-sessions`; the stored transcript is the source of truth.

## Restarts

When the Host starts, any turn that was `running` or `waiting` is marked failed with `agent.host_restarted`, its session goes back to open, and pending approvals are marked expired. Channel replies that were mid-send become "unknown" and wait for a person ([Replies that do not arrive](agents.md#replies-that-do-not-arrive)). On an always-on iMessage agent, an interrupted turn is retried once without asking the person again. Definitions, revisions, messages and the rest of the history stay.

## Where state lives

Definitions: `agents/<id>.agent.yaml` in the project. Everything else is in the run store SQLite database under `$STAGEFLOW_HOME`, in the `agent_*` tables: `agent_definitions`, `agent_revisions`, `agent_sessions`, `agent_messages`, `agent_turns`, `agent_spans`, `agent_eval_scores`, `agent_approvals`, `agent_executed_payloads` (the remembered approved calls), `agent_outbound_sends`, `agent_inbound_events` (dedupe of provider events), `agent_schedules` (next run per agent) and `agent_deliveries` (channel replies). See [Data directory](data-directory.md).

## Environment variables

Set on the Host (for Docker see [Docker](docker.md)). The Host refuses to start on a `STAGEFLOW_*` name it does not know, so all of these are accepted.

| Variable | Default | Effect |
|----------|---------|--------|
| `STAGEFLOW_AGENT_SESSION_IDLE_MINUTES` | `30` | Idle time before a session's runtime is released. `0` keeps it. An empty value counts as `0`. |
| `STAGEFLOW_AGENT_STALL_SECONDS` | `180` | Silence from the model before a turn fails. `0` turns the watchdog off. |
| `STAGEFLOW_AGENT_CHANNEL_LISTENERS` | on | `0` stops the Host opening AgentMail and iMessage streams. |
| `STAGEFLOW_AGENT_SCHEDULE_TICK_INTERVAL_MS` | `30000` | How often schedules are checked. `0` turns schedules off. |
| `STAGEFLOW_AGENTS_ALLOW_CURSOR_NATIVE_TOOLS` | unset | `1` lets agents use `cursor/*` models, which run Cursor's own file and shell tools beside the agent's, so grants and ask-first cannot hold. |
| `STAGEFLOW_PUBLIC_CHAT_ORIGINS` | none | Comma-separated origins allowed to call the public web chat API from another site. |
| `STAGEFLOW_MCP_ENV_ALLOW` | none | Comma-separated Host variable names that agents and Check may use to fill `${NAME}` in MCP servers. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | none | The collector for [live OTLP export](agent-observability.md#export). |
