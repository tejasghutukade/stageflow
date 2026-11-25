# Tools and approvals

What an agent may call, the names to put in `approvals.ask_first`, and the checks that run on every call. Field shapes are in [agent-definition.md](agent-definition.md).

## Contents

- [Start sealed](#start-sealed)
- [Names the model sees and names the file uses](#names-the-model-sees-and-names-the-file-uses)
- [Builtin tools](#builtin-tools)
- [MCP tools](#mcp-tools)
- [Skills](#skills)
- [Stageflow tools](#stageflow-tools)
- [Sub-agents](#sub-agents)
- [The gate](#the-gate)
- [Path guard](#path-guard)
- [Ask first](#ask-first)
- [Agents that manage agents](#agents-that-manage-agents)

## Start sealed

A new agent gets read-only tools, or no `tools` block at all, until the job needs `write` or `shell`. Grant only the tools the job uses.

Anything that sends, posts, writes, merges, deletes, pays, or changes the outside world goes in `approvals.ask_first`, under the grant id. `bash` asks every time whether or not it is listed.

`tools.browser` is stored and wired to nothing. Leave it out.

## Names the model sees and names the file uses

`instructions` and the model's tool call use the Pi name. `approvals.ask_first` uses the grant id. A mismatch is `agent.ask_first_not_granted`, or a tool that never pauses.

| Kind | Model-facing name | Grant id in `ask_first` |
|---|---|---|
| Builtin | `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash` | the same name |
| MCP | `<server>_<tool>` | `<server>.<tool>` |
| Stageflow | `stageflow_<tool>` | `stageflow.<tool>` |
| Sub-agent | `agent_<id>` | `agent:<id>` |

A wildcard grant `tools.mcp.<server>: ["*"]` lets `ask_first` name any `<server>.<tool>`. The pause itself is an exact match on the grant id of that call. `helpdesk.*` in `ask_first` does not pause `helpdesk.create_ticket`. List each side-effecting tool.

## Builtin tools

| Group | Tools |
|---|---|
| `read` | `read`, `grep`, `find`, `ls` |
| `write` | `write`, `edit` |
| `shell` | `bash` |

`tools.builtin` grants a whole group. `tools.builtin_tools` adds single tools on top. No duplicates.

`write` and `edit` go in `ask_first`. Grant `shell` only after the user accepts two facts: every command asks first, and `bash` is not path-confined (see [Path guard](#path-guard)). The validator warns `agent.shell_not_path_confined`.

## MCP tools

`tools.mcp` is a map of server name to a list of tool names. The server name matches `^[A-Za-z0-9_.-]{1,64}$`. Each list needs at least one entry. `["*"]` grants every tool that server exposes. `[]` is an error. The name `stageflow` is reserved (`agent.mcp_name_reserved`).

Use a server name that `list_catalog` with `kind: mcp_servers` or the project's `.mcp.json` already has. A name the Host does not know warns `agent.mcp_server_unknown` and still saves. Adding a server is [mcp-servers.md](mcp-servers.md).

Read-only MCP tools stay out of `ask_first`. Each tool that creates, updates, deletes, sends, or pays goes in, as `<server>.<tool>`.

`orders` with exactly `[status]` is the protected-chat order tool. It opens no MCP server. Expect warning `agent.mcp_server_unknown` for `orders`. It is allowed only with `web_chat.access: authenticated`. See [channels-and-identity.md](channels-and-identity.md).

## Skills

`tools.skills` is a list of skill names installed on the Host (`sf skills list`). A missing name warns `agent.skill_unknown`, and the session fails to start. Do not invent a name. Install is a person action (`sf skills install`, or the console Catalog → Skills).

A skill can carry its own tools. Treat a skill that writes, sends, or runs commands the way you treat `write` and `shell`: do not grant it until the user accepts that reach, and put its side-effecting calls in `ask_first` when they appear as grant ids.

## Stageflow tools

Host MCP `tools/list` annotations come from `TOOL_META.risk`. Agent grants still use `tools.stageflow.groups` / `tools.stageflow.tools` and `ask_first`; the annotations do not replace those grants.

`tools.stageflow.groups` grants a group. `tools.stageflow.tools` adds single tools. Unknown group: `agent.stageflow_group_unknown`. Unknown tool: `agent.stageflow_tool_unknown`.

These decide things a person must decide. Granting them is `agent.stageflow_operator_only`:

- Group `gates.decide`
- Tools `get_started`, `answer_gate`, `decide_feedback_loop`, `decide_agent_action`

A coding agent acting for the user approves with `sf agents approve` only after the user decides. It does not grant that power to the project agent.

Put every granted tool whose risk is write, destructive, or external into `ask_first` as `stageflow.<tool>`. Read tools stay out. Destructive tools live in the `*.cleanup` groups so they are not included by accident.

| Group | Read (no ask-first) | Ask first |
|---|---|---|
| `discover` | `list_catalog` with `kind: skills`, `list_catalog` with `kind: pipelines`, `list_catalog` with `kind: tasks`, `list_catalog` with `kind: models`, `list_catalog` with `kind: providers`, `list_catalog` with `kind: health`, `validate` (including `preflight: true`), `read_pipeline` with `view: dag`, `list_catalog` with `kind: mcp_servers` | `probe_project_mcp` (connects out) |
| `runs.read` | `get_run` (omit `runId`), `get_run`, `get_run` with `view: export`, `get_stage` with `view: events`, `log`, `envelope`, or `verification`, `run_files` with `view: artifact`, `changes`, `diff`, or `file`, `wait_run` | |
| `runs.control` | | `start_run`, `start_run` with `stage`, `start_run` with `from_run`, `stage_action` with `action: retry`, `resume`, `recover`, or `stop_recovery` |
| `runs.cleanup` | | `cancel_run`, `abandon_stage`, `delete_runs`, `delete_runs` with `gc: true` |
| `gates.read` | `list_waiting` with `detail: full` or `summary` | |
| `triggers` | `get_trigger` with `list: true`, `get_trigger` | `save_trigger` with `mode: create` or `update`, `save_trigger` with `enabled_only`, `fire_trigger` |
| `agents.read` | `get_agent` with `list: true` or `view: definition`, `revisions`, `revision`, or `diff`, `validate` with `kind: agent`, `get_agent_session` with `list: true` or by id | |
| `agents.manage` | | `save_agent` with `mode: create`, `mode: update`, or `from_revision: true`, `set_agent_enabled` with `enabled: true` or `false` |
| `agents.cleanup` | | `archive_agent` |
| `agents.converse` | | `agent_chat` (spends money), `stop_agent_session` |
| `pipelines.author` | `read_pipeline`, `validate` with `kind: draft` | `write_pipeline` with `mode: create` or `update`, `write_stage` with `mode: create`, `patch: true`, `no_pipeline: true`, or `form: content` update, `write_task` with `mode: create` or `update`, `import_task` |
| `connections` | `get_connection`, `validate` with `kind: connection_recipient` | `save_connection` with `mode: create`, `save_connection` with `mode: update`, `test_connection` |
| `connections.cleanup` | | `remove_connection` |
| `memories` | `get_memory` with `list: true`, `get_memory` | `save_memory` with `mode: create`, `mode: update`, or `card: true` |
| `memories.cleanup` | | `delete_memory_card` |
| `artifacts.read` | `stageflow_get_artifact` with `list: true`, or with `view: record`, `versions`, or `content` | `stageflow.get_artifact` |
| `artifacts.write` | | `publish_artifact` (session tool; owner is this agent). Not Host MCP `save_artifact`. |
| `artifacts.cleanup` | | `stageflow.delete_artifact` → `stageflow_delete_artifact` (this agent's rows in this project only) |
| `artifacts.refresh` | | `stageflow.refresh_artifact` → `stageflow_refresh_artifact` (this agent's live artifacts in this project only) |
| `evals.read` | `get_eval` with `list: true` or `view: definition` or `calibrations`, `validate` with `kind: eval`, `get_eval_run` (list or `view: export`), `get_eval_results` (table or `case_id`), `compare_eval_runs`, `get_eval_failures` with `view: suggestions` or `sort_status` | |
| `evals.run` | | `run_eval`, `sort_eval_failures`, `calibrate_eval_grader`, `cancel_eval_run`, `try_eval_case` |
| `evals.write` | | `save_eval` with `mode: create`, `update`, or `source: sample`, `save_dataset` with `action: create`, `ops`, or `convert`, `review_eval_results` with `action: label`, `accept`, or `dismiss` |
| `evals.cleanup` | | `delete_eval_run` |

Web chat plus `get_agent_session` (including `list: true`) warns `agent.web_chat_reads_conversations`: the public link's agent can read every agent's sessions. Do not combine them.

**Artifacts.** `publish_artifact` takes the same fields as a stage publish: `id`, `kind`, `title`, optional `description`, `tags`, `summary`, and one of `path`, `content`, or `content_base64`. Agent `path` is project-relative and passes the path guard (no `..`, symlinks, `agents/*.agent.yaml`, or `$STAGEFLOW_HOME` outside the project). Put secrets only in scrubbed content; never publish raw credentials. Listing and deleting: `stageflow-operate` `references/artifacts.md`.

The live list is `GET /api/agents/stageflow-tools`. There is no CLI for that registry.

## Sub-agents

`sub_agents` is a list of agent ids that already exist (`sf agents list`). No duplicates. An agent cannot list itself (`agent.sub_agent_self`). An unknown id warns `agent.sub_agent_unknown`.

Each id becomes a tool `agent_<id>` with grant id `agent:<id>`. Put `agent:<id>` in `ask_first` when that call spends money or can change something the caller must not do alone. `sub_agent_depth` is 1 to 5, default 1. Over it: `agent.delegate_depth_exceeded`. A call to an id that is not listed: `agent.delegate_not_allowed`.

Sub-agents do not inherit the caller's memories, channel, or web chat. A public web agent cannot have sub-agents. A protected-chat agent can, and each of them has to be consumer-safe too. See [channels-and-identity.md](channels-and-identity.md).

## The gate

Every tool call, in this order:

1. Path guard (below). A forbidden path is blocked before the grant check.
2. Granted? Otherwise the model is told the tool is not granted.
3. Ask-first? `approvals.ask_first`, plus `bash` whenever `bash` is granted.

One pending approval per session. A second, different call while one is pending is `agent.session_busy`. The same tool and the same arguments, already approved once in that session, are not asked again. A denial tells the model: the operator denied it, do not retry it, continue without it or explain. Stopping the turn expires the open approval. Disabling the agent lets you deny a pending action and refuses approve (`agent.disabled`). A Host restart fails running and waiting turns with `agent.host_restarted` and expires pending approvals.

`on_timeout: skip` (default) tells the model the action was skipped. `on_timeout: deny` ends the turn with `agent.approval_expired`.

Who can decide: the Inbox (`#/inbox`), the session page, `sf agents approve|deny <id> <sessionId>`, or MCP `decide_agent_action` with `action: approve` or `deny`. `approvals.approvers.operators` stays `true`. `approvers.channel_ids` is ignored (warning `agent.channel_approvers_unused`). A channel cannot approve.

Pass on a decision the user made. Do not approve because the action looks reasonable.

## Path guard

The guard looks at arguments named `path`, `file_path`, `filePath`, `file`, `target`, `destination`, `dest`, `output_path`, and entries of `paths`. A relative path resolves against the project root. It refuses a write of `agents/*.agent.yaml`, and anything under `$STAGEFLOW_HOME` that sits outside the project. Pi's read-only builtins (`read`, `grep`, `find`, `ls`) are exempt. The check is on the arguments it can see.

`bash` is not path-confined. The runtime sees a command string. A granted `bash` can change agent files and Stageflow state, which is why every bash call asks first. One exception: a `bash` command that names the memory store is blocked with "The memory store cannot be accessed with shell commands." That block does not make the rest of the shell safe.

## Ask first

`ask_first` may only name a granted tool (`agent.ask_first_not_granted`), except that a `["*"]` MCP grant accepts any `<server>.<tool>`.

`approvals.approvers.operators: false` with an empty `channel_ids` is an error. `false` with `channel_ids` validates and still leaves nobody who can approve, because channel approvers are unused. Keep `operators: true`.

A scheduled or channel agent with ask-first tools waits for a person on every such call. Say that before you write the file. If the job must finish unattended, drop the side-effecting tool rather than omitting `ask_first`.

## Agents that manage agents

Grant `agents.manage` or `agents.cleanup` only when the job is to administer other agents, and put every non-read tool in `ask_first`.

When the caller is itself an agent (not you, not the console), the Host enforces:

- It cannot grant builtin tools, MCP tools, MCP wildcards, skills, or the browser that it does not hold.
- It cannot drop an `ask_first` entry it is bound by on a tool the new definition still holds.
- It cannot edit, restore, or archive itself.
- It cannot approve or deny an action on its own sessions.

`set_agent_enabled` with `enabled: true` checks the definition being enabled against those same rules. A new agent created through the API still starts disabled.
