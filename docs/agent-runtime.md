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
| `ui.present` | `present_ui`. Read-only. Places an artifact reference in the reply. Eval sessions stub it. |

### MCP servers

An agent can use any server defined in the project `.mcp.json` **or saved from the console** (Settings → Project MCP); a console entry wins when both use a name. Servers start lazily, in their own processes, the first time the agent uses them. They are released with the session (see [Memory and lifetime](#memory-and-lifetime)).

`${NAME}` placeholders in a server's config are filled from the secrets saved in the console, and from Host environment variables only if their names are listed in `STAGEFLOW_MCP_ENV_ALLOW`. A console secret wins over a Host variable of the same name. The full rules are in [MCP](mcp.md); the host-side files are in [Data directory](data-directory.md).

### Stageflow tools

An agent can be given Stageflow's own tools (the ones in [MCP tools](mcp.md#tools)), whole groups or one at a time. Each tool has a group and a risk (`read`, `write`, `destructive`, `external`). Host MCP `tools/list` maps that same risk to wire annotations; see [Tool list shape](mcp.md#tool-list-shape).

| Group | Tools | Notes |
|-------|-------|-------|
| `discover` | `list_catalog` with `kind: skills`, `list_catalog` with `kind: pipelines`, `list_catalog` with `kind: tasks`, `list_catalog` with `kind: models`, `list_catalog` with `kind: providers`, `list_catalog` with `kind: health`, `validate` (catalog paths, `draft`, `preflight: true`, and the rest), `read_pipeline` with `view: dag`, `list_catalog` with `kind: mcp_servers` (read), `probe_project_mcp` (external) | `get_started` is operator-only. |
| `runs.read` | `get_run` (omit `runId`), `get_run`, `get_run` with `view: export`, `get_stage` with `view: events`, `log`, `envelope`, or `verification`, `run_files` with `view: artifact`, `changes`, `diff`, or `file`, `wait_run` | All read. |
| `runs.control` | `start_run`, `start_run` with `stage`, `start_run` with `from_run`, `stage_action` with `action: retry`, `resume`, `recover`, or `stop_recovery` | Write. |
| `runs.cleanup` | `cancel_run`, `abandon_stage`, `delete_runs`, `delete_runs` with `gc: true` | Destructive. |
| `gates.read` | `list_waiting` with `detail: full` or `summary` | Read. |
| `gates.decide` | `answer_gate`, `decide_feedback_loop`, `decide_agent_action` | **Operator-only: cannot be granted.** |
| `triggers` | `get_trigger` with `list: true`, `get_trigger` (read), `save_trigger` with `mode: create` or `update` (write), `save_trigger` with `enabled_only` (write), `fire_trigger` (external) | |
| `agents.read` | `get_agent` with `list: true` or `view: definition`, `revisions`, `revision`, or `diff`, `validate` with `kind: agent`, `get_agent_session` with `list: true` or by id | Read. |
| `agents.manage` | `save_agent` with `mode: create`, `mode: update`, or `from_revision: true`, `set_agent_enabled` with `enabled: true`, `set_agent_enabled` with `enabled: false` | Write. |
| `agents.cleanup` | `archive_agent` | Destructive. |
| `agents.converse` | `agent_chat` (external), `stop_agent_session` (write) | |
| `evals.read` | `get_eval` with `list: true` or `view: definition` or `calibrations`, `validate` with `kind: eval`, `get_eval_run` (list or `view: export`), `get_eval_results` (table or `case_id`), `compare_eval_runs`, `get_eval_failures` with `view: suggestions` or `sort_status` | Read, free. See [Evals](evals.md). |
| `evals.run` | `run_eval` (external), `try_eval_case` (external), `sort_eval_failures` (external), `cancel_eval_run` (write) | `run_eval` and `try_eval_case` call models and cost money, bounded by the eval's cost limit. `sort_eval_failures` sends failed results to an external classifier and costs a little. |
| `evals.write` | `save_eval` with `mode: create`, `update`, or `source: sample`, `save_dataset` with `action: create`, `ops`, or `convert`, `review_eval_results` with `action: label`, `accept`, or `dismiss` | Write. |
| `evals.cleanup` | `delete_eval_run` | Destructive. |
| `pipelines.author` | `read_pipeline` (read), `write_pipeline` with `mode: create`, `write_pipeline` with `mode: update`, `write_stage` with `mode: create`, `patch: true`, `no_pipeline: true`, or `form: content` update (write), `write_task` with `mode: create` or `update` (`no_pipeline: true` for standalone tasks), `validate` with `kind: draft` (read), `import_task` (external) | Package edits and standalone task, stage, and catalog-file saves. |
| `connections` | `get_connection`, `validate` with `kind: connection_recipient` (read), `save_connection` with `mode: create`, `save_connection` with `mode: update` (write), `test_connection` (external) | Secret values are stored and never returned. |
| `connections.cleanup` | `remove_connection` | Destructive. |
| `memories` | `get_memory` with `list: true` (read), `get_memory`, `save_memory` with `mode: create`, `mode: update`, or `card: true` (write) | |
| `memories.cleanup` | `delete_memory_card` | Destructive. |
| `artifacts.read` | `stageflow_get_artifact` with `list: true`, `stageflow_get_artifact` with `view: record`, `versions`, `content`, or `data` | Read. Ask-first id `stageflow.get_artifact`. The model calls `stageflow_get_artifact`. Reading is project-wide. `view: data` returns current snapshots for `live.declarative` and `artifact.not_live` for a static artifact. |
| `artifacts.write` | `publish_artifact` | Write. Ask-first id `publish_artifact`. The model calls `publish_artifact`. The session tool is bound to this agent and to this session's project. The Host MCP tool `save_artifact` is not given to the agent, because that tool lets the caller choose an owner. |
| `artifacts.cleanup` | `stageflow_delete_artifact` | Destructive. Ask-first id `stageflow.delete_artifact`. The model calls `stageflow_delete_artifact`. An agent can delete only an artifact it owns in the session's project. Another owner's key, or a `project_root` other than that project, is `artifact.not_found` and nothing is deleted. Omitting `project_root` still deletes only in the session's project. |
| `artifacts.refresh` | `stageflow_refresh_artifact` | External. Ask-first id `stageflow.refresh_artifact`. The model calls `stageflow_refresh_artifact`. An agent can refresh only a live artifact it owns in the session's project. Another owner's key, or a `project_root` other than that project, is `artifact.not_found` and nothing runs. |

Rules:

- **Only a person decides.** Gates and approvals (`gates.decide`) cannot be granted, so one agent can never approve or deny another's action (`agent.stageflow_operator_only`).
- **Destructive tools have their own groups**, so ticking "Run and recover pipelines" never selects `delete_runs`.
- **An agent cannot hand out more than it holds.** `save_agent` with `mode: create`, `mode: update`, or `from_revision: true` and `set_agent_enabled` with `enabled: true` called by an agent refuse any grant it does not itself hold (tools, MCP tools, skills, the browser), and refuse a copy that would drop an ask-first the caller is bound by.
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

**`publish_artifact` reads a `path` only from a file the agent could already read.** The path is relative to the project root. An absolute path, a `..` segment, a symlink, an `*.agent.yaml` file under `agents/`, and anything under `$STAGEFLOW_HOME` outside the project are refused before the bytes are read. The file size is checked with `lstat` first. Over 5 MiB is `artifact.too_large` and the file is not read. `content` and `content_base64` are the other ways to pass bytes. For every kind except `static.image`, the bytes are checked as UTF-8 and scrubbed with the same secret scrubber as a stage publish, whether they came from `content`, `content_base64`, or `path`. Bytes that are not valid UTF-8 are `artifact.invalid_shape`. Image bytes are stored unchanged. An error from the tool does not include the secret.

An agent that holds `artifacts.write` gets a short section in its system prompt (kinds, the id rule, the size cap, that publishing the same id again creates a new version, that the artifact is owned by this agent, and that the prompt does not list other agents' artifacts). An agent that holds `artifacts.read` gets one sentence naming `stageflow_get_artifact`. An agent that holds `artifacts.cleanup` gets one sentence naming `stageflow_delete_artifact`. An agent that holds `artifacts.refresh` gets one sentence naming `stageflow_refresh_artifact`. An agent with none of those grants keeps the same system prompt and the same tool list. Compaction does not rewrite that section; it lives only in the system prompt.

### Artifacts in an eval session

An eval session (`source: eval`) that publishes stores the row with `hidden = 1` under `eval:agent:<id>/<artifact id>`. It does not replace a visible artifact with the same id. List, search, MCP, and the console omit it. `publish_artifact` is class `write`, `stageflow.delete_artifact` is class `destructive`, and `stageflow.refresh_artifact` is class `external`, so the default `read_only` policy stubs them and writes nothing. `stageflow.get_artifact` is read and runs. Under `real`, those tools follow the same rules as other tools of those classes. `stageflow.refresh_artifact` runs under `real` unless ask-first records `would_ask_first`. An eval session under `real` can delete a visible artifact owned by that agent, because `real` runs the real tools. No approval row is created for an eval session. A sub-agent does not inherit the caller's artifact grants; it uses its own definition.

## Asking first

A call to a tool in `approvals.ask_first` (always including `bash`) pauses the turn. The session shows **waiting** until someone decides.

- **One at a time.** A session has at most one pending approval, and it stands for the exact call it was raised for (same tool, same arguments). A different call while one is pending is refused with `agent.session_busy`.
- **Approved once means approved for the session.** An identical call (same tool, same arguments) that a person approved is not asked about again in that session. A different call, or a new session, asks again.
- **Denied** tells the model the operator refused and not to retry. The turn carries on.
- **Who decides.** A person, in the Inbox or the agent session page, with `sf agents`, or with the MCP tool `decide_agent_action` (`action: approve` or `deny`). Channels cannot decide (`approvals.approvers.channel_ids` is reserved and ignored). When desktop notifications are on (Settings → Notifications), the console also raises one when an agent asks; it checks every 15 seconds while the console is open.
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
| `cost_usd` | The thread has cost that much, including sessions it rolled from. |

All refuse with `agent.limit_reached` (409). With `always_on: true`, `max_turns` and `session_minutes` do not apply, and `cost_usd` counts the cost of the last 24 hours instead. On a web chat a limit shows as `web_chat.limit_reached`. A channel thread rolls onto a new session when it reaches its turn or time limit. Its cost limit counts the thread's spend over the last 24 hours, across rollovers, so a rollover does not reset it. Once that 24-hour spend is under the limit again, the thread continues on a new session. While a thread is past `cost_usd` it stays on the same session, and the sender is told the cost limit was reached. A session that is not always-on is also refused once it alone has spent `cost_usd`.

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
