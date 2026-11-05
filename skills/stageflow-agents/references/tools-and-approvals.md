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

Use a server name that `list_project_mcp` or the project's `.mcp.json` already has. A name the Host does not know warns `agent.mcp_server_unknown` and still saves. Adding a server is [mcp-servers.md](mcp-servers.md).

Read-only MCP tools stay out of `ask_first`. Each tool that creates, updates, deletes, sends, or pays goes in, as `<server>.<tool>`.

`orders` with exactly `[status]` is the protected-chat order tool. It opens no MCP server. Expect warning `agent.mcp_server_unknown` for `orders`. It is allowed only with `web_chat.access: authenticated`. See [channels-and-identity.md](channels-and-identity.md).

## Skills

`tools.skills` is a list of skill names installed on the Host (`sf skills list`). A missing name warns `agent.skill_unknown`, and the session fails to start. Do not invent a name. Install is a person action (`sf skills install`, or the console Catalog → Skills).

A skill can carry its own tools. Treat a skill that writes, sends, or runs commands the way you treat `write` and `shell`: do not grant it until the user accepts that reach, and put its side-effecting calls in `ask_first` when they appear as grant ids.

## Stageflow tools

`tools.stageflow.groups` grants a group. `tools.stageflow.tools` adds single tools. Unknown group: `agent.stageflow_group_unknown`. Unknown tool: `agent.stageflow_tool_unknown`.

These decide things a person must decide. Granting them is `agent.stageflow_operator_only`:

- Group `gates.decide`
- Tools `get_started`, `answer_gate`, `decide_feedback_loop`, `approve_agent_action`, `deny_agent_action`

A coding agent acting for the user approves with `sf agents approve` only after the user decides. It does not grant that power to the project agent.

Put every granted tool whose risk is write, destructive, or external into `ask_first` as `stageflow.<tool>`. Read tools stay out. Destructive tools live in the `*.cleanup` groups so they are not included by accident.

| Group | Read (no ask-first) | Ask first |
|---|---|---|
| `discover` | `list_skills`, `list_pipelines`, `list_tasks`, `list_models`, `list_providers`, `get_health`, `preflight`, `validate`, `describe_pipeline`, `list_project_mcp` | `probe_project_mcp` (connects out) |
| `runs.read` | `list_runs`, `get_run`, `export_run`, `read_artifact`, `wait_run`, `list_stage_events`, `tail_stage_log`, `get_stage_verification`, `get_envelope`, `list_checkout_changes`, `get_run_diff`, `read_checkout_file` | |
| `runs.control` | | `start_run`, `run_stage`, `rerun`, `retry_stage`, `resume_stage`, `recover_manual_stage`, `stop_manual_recovery` |
| `runs.cleanup` | | `cancel_run`, `abandon_stage`, `delete_run`, `gc_runs` |
| `gates.read` | `list_waiting`, `get_waiting_summary` | |
| `triggers` | `list_triggers`, `get_trigger` | `create_trigger`, `update_trigger`, `set_trigger_enabled`, `fire_trigger` |
| `agents.read` | `list_agents`, `get_agent`, `validate_agent`, `list_agent_revisions`, `get_agent_revision`, `diff_agent_revisions`, `get_agent_session`, `list_agent_sessions` | |
| `agents.manage` | | `create_agent`, `save_agent`, `enable_agent`, `disable_agent`, `restore_agent_revision` |
| `agents.cleanup` | | `archive_agent` |
| `agents.converse` | | `agent_chat` (spends money), `stop_agent_session` |
| `pipelines.author` | `read_pipeline`, `validate_catalog_draft` | `create_pipeline`, `edit_pipeline`, `create_stage`, `edit_stage`, `create_task`, `edit_task`, `create_task_file`, `update_task_file`, `import_task_file`, `create_stage_file`, `write_catalog_file` |
| `connections` | `list_connections`, `validate_connection_target` | `create_connection`, `update_connection`, `test_connection` |
| `connections.cleanup` | | `remove_connection` |
| `memories` | `list_memories`, `get_memory` | `create_memory`, `write_memory`, `write_memory_card` |
| `memories.cleanup` | | `delete_memory_card` |
| `evals.read` | `list_evals`, `get_eval`, `validate_eval`, `get_eval_run`, `list_eval_runs`, `get_eval_results`, `get_eval_result`, `compare_eval_runs`, `get_eval_failure_suggestions`, `get_eval_failure_sort_status`, `get_eval_run_export`, `list_grader_calibrations` | |
| `evals.run` | | `run_eval`, `sort_eval_failures`, `calibrate_eval_grader`, `cancel_eval_run`, `try_eval_case` |
| `evals.write` | | `create_eval`, `update_eval`, `create_dataset`, `update_dataset_cases`, `convert_dataset`, `install_eval_sample`, `put_eval_review`, `accept_eval_failure_suggestions`, `dismiss_eval_failure_suggestions` |
| `evals.cleanup` | | `delete_eval_run` |

Web chat plus `get_agent_session` or `list_agent_sessions` warns `agent.web_chat_reads_conversations`: the public link's agent can read every agent's sessions. Do not combine them.

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

Who can decide: the Inbox (`#/inbox`), the session page, `sf agents approve|deny <id> <sessionId>`, or MCP `approve_agent_action` / `deny_agent_action`. `approvals.approvers.operators` stays `true`. `approvers.channel_ids` is ignored (warning `agent.channel_approvers_unused`). A channel cannot approve.

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

`enable_agent` checks the definition being enabled against those same rules. A new agent created through the API still starts disabled.
