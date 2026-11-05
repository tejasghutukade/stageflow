# Troubleshooting

What a code means and the change that clears it. Run `sf agents validate <file> --json` after every fix. Exit 0 with an empty `issues` array is the bar. Then read every warning to the user.

## Contents

- [How to read a failure](#how-to-read-a-failure)
- [Validation errors](#validation-errors)
- [Warnings](#warnings)
- [Runtime codes](#runtime-codes)
- [Web chat and channels](#web-chat-and-channels)
- [Memory codes](#memory-codes)
- [Symptom recipes](#symptom-recipes)
- [Product limitations](#product-limitations)

## How to read a failure

`--json` issues and warnings have `path`, `code`, and `message`. Fix the field at `path`. A code shaped `agent.<zod name>` (`agent.invalid_type`, `agent.too_small`, `agent.too_big`) means the value failed the schema; the `message` says how. Unknown keys at any level are `agent.unknown_field`.

`agent.invalid` on a save or enable wraps those issues. HTTP status is in [control-surface.md](control-surface.md#http).

## Validation errors

| Code | Fix |
|---|---|
| `agent.yaml_syntax` | Fix the YAML. `message` is the parser's first line; `line` and `column` are set when the parser has them |
| `agent.invalid_shape` | The file must be a mapping, not a list or a scalar |
| `agent.unknown_field` | Remove the key named in `message`. The allowed keys are in [agent-definition.md](agent-definition.md) |
| `agent.required` | Add the missing field (`id` in a file, `name`, `instructions`, and `connection_id` / `cron` inside their blocks) |
| `agent.invalid_value` | The value failed a cross-field check described in `message` |
| `agent.ask_first_not_granted` | The entry is not a granted tool, or it uses the model-facing name. Use `write`, `helpdesk.create_ticket`, `stageflow.start_run`, or `agent:<id>`. A `["*"]` MCP grant accepts `<server>.<tool>` for real tool names, not `<server>.*` as a pause-all |
| `agent.stageflow_group_unknown` | Use a group id from [tools-and-approvals.md](tools-and-approvals.md#stageflow-tools) |
| `agent.stageflow_tool_unknown` | Use a tool name from that same table, without the `stageflow_` prefix in YAML |
| `agent.stageflow_operator_only` | Remove `gates.decide`, `get_started`, `answer_gate`, `decide_feedback_loop`, `approve_agent_action`, or `deny_agent_action`. A person decides those |
| `agent.mcp_name_reserved` | Rename the MCP server. `stageflow` is Stageflow's own tools |
| `agent.sub_agent_self` | Remove the agent's own id from `sub_agents` |
| `agent.channel_in_use` | That connection, or another connection on the same inbox or Photon project, already belongs to an agent. Use one connection for one agent |
| `agent.memory_unavailable` | Create the memory first (`create_memory` or `POST /api/memories`), or remove the id. See [memories-and-schedules.md](memories-and-schedules.md) |
| `agent.id_mismatch` | `id` must equal the file name `agents/<id>.agent.yaml`. Validate of a definition object does not check the file name; the Host reports this when it loads the folder |
| `agent.id_immutable` | Keep the original id. A new id is a new agent |
| `agent.exists` | Pick another id, or edit the existing agent |
| `agent.conflict` | Re-read `sf agents get <id> --json`, reapply the change, retry with the new `baseRevision` |
| Empty `tools.mcp.<server>` | Put at least one tool name, or `["*"]` |
| `approvals.approvers` | `operators: false` with no `channel_ids` is an error. Keep `operators: true` |
| Invalid `schedule.cron` | Use a cron expression croner accepts. Quote it in YAML when it could be read as a number |

A missing `id` can still pass `sf agents validate` (the Host would fill one from `name` on create). The file then fails to load as `agent.required` or lands at revision 0. Always write `id`, equal to the file name.

## Warnings

Warnings do not block save. They do predict a session that will fail or a link that will be refused. Tell the user each one.

| Code | What to do |
|---|---|
| `agent.mcp_server_unknown` | The server is not in `.mcp.json` or the console catalog. Add it ([mcp-servers.md](mcp-servers.md)), or remove the grant. Expected and harmless for `orders` on a protected agent |
| `agent.skill_unknown` | Install the skill (`sf skills list`) or remove it. A session will not start |
| `agent.model_unknown` | The id is not listed by a connected provider. It is still tried. Connect the provider or unset `model.id` |
| `agent.model_native_tools` | A Cursor model. Sessions fail unless the Host sets `STAGEFLOW_AGENTS_ALLOW_CURSOR_NATIVE_TOOLS=1`. Pick another model |
| `agent.connection_unknown` | Create the connection, or fix `connection_id`. See [channels-and-identity.md](channels-and-identity.md) |
| `agent.channel_nobody_allowed` | `allow_from` is empty, so every inbound message is dropped. Add senders |
| `agent.channel_open_to_anyone` | `allow_from` contains `*`. Replace it with specific senders for anything outsiders can reach |
| `agent.shell_not_path_confined` | `bash` is granted. Every command asks first, and the shell is not limited to the project. Remove it unless the user accepted that |
| `agent.web_chat_reads_conversations` | Web chat is on and the agent can call `get_agent_session` or `list_agent_sessions`. Turn web chat off or drop those tools |
| `agent.web_chat_slug_missing` | Web chat is on in a hand-written file and has no slug. Save through MCP, REST, or the console to mint one, or set `enabled: false` |
| `agent.backend_unavailable` | `model.backend: claude`. Sessions fail. Leave the backend unset |
| `agent.sandbox_unavailable` | `execution: sandbox`. Sessions fail. Leave `execution` unset |
| `agent.channel_approvers_unused` | `channel_ids` is ignored. Approvals happen in the console. Remove the list |
| `agent.sub_agent_unknown` | That id is not an agent on this project. Create it or remove the entry |

## Runtime codes

| Code | Fix |
|---|---|
| `agent.not_found` | The id is wrong, or the file was never loaded. `sf agents list` |
| `agent.archived` | The agent was archived. History is readable. A new file with the same id can be created |
| `agent.disabled` | Enable it (`sf agents enable <id>`) after the user agrees. Approve is refused while disabled; deny still works |
| `agent.revision_not_found` | `sf agents history <id>` and use a revision that exists |
| `agent.session_not_found` | The session id is wrong, or it belongs to another agent |
| `agent.session_busy` | A turn or a different approval is already pending. Wait, stop the turn (`stop_agent_session` or `POST …/chat/stop`), or decide the open approval |
| `agent.session_eval_readonly` | That session belongs to an eval. Do not chat or approve it here. Use the `stageflow-evals` skill |
| `agent.tool_not_granted` | The call is not in the grants. Add the grant, or the model was given a tool the file does not allow |
| `agent.approval_not_required` | That tool is not in `ask_first` and is not `bash`. It runs without a person |
| `agent.approval_not_pending` | Nothing is waiting. The decision already landed, or the turn was stopped |
| `agent.approval_expired` | The wait passed `timeout_minutes`. With `on_timeout: deny` the turn ends. Raise the timeout or decide sooner |
| `agent.approval_forbidden` | `approvers.operators` is false. Set it back to true |
| `agent.approval_denied` | The user denied it. Leave it denied |
| `agent.unbound` | Inbound message for a connection no agent uses |
| `agent.sender_not_allowed` | The sender is not in `allow_from`. The webhook still returns 200 ignored |
| `agent.guardrail_blocked` | A `block_patterns` expression matched the finished reply. The reply is not stored and not sent. Fix the pattern (JavaScript, no flags) or the instructions that produced the match |
| `agent.delegate_not_allowed` | The callee is not in `sub_agents` |
| `agent.delegate_depth_exceeded` | Raise `sub_agent_depth` (max 5) or flatten the call |
| `agent.limit_reached` | The session hit `session_minutes`, `max_turns`, or `cost_usd`. Start a new session, or raise the limit the user agreed to. On web chat the code is `web_chat.limit_reached` |
| `agent.model_timeout` | The model sent nothing for 180 seconds (`STAGEFLOW_AGENT_STALL_SECONDS`). Retry. A stuck provider will fail the same way |
| `agent.backend_unavailable` | Pi could not start: claude backend, missing skill, missing MCP tool metadata, or no provider credentials. `sf providers status`, then the warning that matches |
| `agent.backend_failed` | The turn failed outside the mapped agent errors. Read the session and run `sf providers status` |
| `agent.host_restarted` | The Host stopped mid-turn. Pending approvals were expired. Run the turn again. Always-on iMessage resumes that turn once |
| `agent.reply_undelivered` | The channel reply failed or its outcome is unknown. Resend or mark delivered. See [channels-and-identity.md](channels-and-identity.md#replies) |
| `agent.outbound_unknown` | A keyed send whose outcome was already unknown, or whose submit threw. Do not retry an unknown outcome |
| `agent.stream_closed` | The CLI lost the chat stream before `done`. Read the session; the turn may have finished |
| `agent.store_unavailable` | The Host has no agent store. Restart `sf ui` or `sf mcp` |
| `identity.setup_required` | Public or protected chat is not allowed for this definition, or identity is off. See below |
| `identity.verification_required` | The caller is not signed in, or the protected session does not match |
| `identity.not_available` | No matching assignment, or a protected schedule has no single service identity |
| `identity.conflict` | An assignment `expectedRevision` was stale. Re-read and retry |
| `identity.managed_externally` | This Host does not serve `/api/identity/setup` writes |
| `unknown_project_root` | Register the project. The curl is in [control-surface.md](control-surface.md#http) |

Channel send failures use `CHANNEL_*` codes from `GET /api/connections/meta`. The ones that show up on an agent reply: `CHANNEL_AUTH_FAILED` (bad credential), `CHANNEL_SECRET_UNAVAILABLE` (an `env:` name is unset on the Host), `CHANNEL_RECIPIENT_REJECTED` (bot not in the channel, user did not start the bot, or the iMessage line was never texted), `CHANNEL_PROVIDER_UNSUPPORTED` (the Photon package is not installed), `CHANNEL_SEND_OUTCOME_UNKNOWN` (do not auto-resend).

## Web chat and channels

Public chat returns `identity.setup_required` when the agent has any tool, project context, a memory, a skill, a sub-agent, or a backend other than `pi`. Validation stays green. Set `web_chat.enabled: false`, or remove every tool and keep the agent tool-less.

A hand-written public agent with no slug warns `agent.web_chat_slug_missing` and the path `/chat/…` does not exist until a Host save mints the slug.

Protected chat returns the same code until identity is enabled and the definition is consumer-safe (`orders: [status]` only). A schedule on that agent returns `identity.not_available` until one service identity lists the agent.

Webhook `401`: the signing secret does not match. `404`: no `inboundSecret`, or the connection id in the URL is wrong. `200` with `ignored: true`: allow-list, loop mail, rate limit, or a disabled agent. The sender is not told.

## Memory codes

`MEMORY_NOT_FOUND`, `MEMORY_INVALID_ID`, `MEMORY_EXISTS`, `MEMORY_MISMATCH`, `MEMORY_UNREADABLE`, `MEMORY_INVALID_DESCRIPTION`, `MEMORY_INVALID_KEY`, `MEMORY_TOO_LARGE` (64,000 characters), `MEMORY_TOO_MANY_CARDS` (200), `MEMORY_CARD_EXISTS`, `MEMORY_CARD_NOT_FOUND`, `MEMORY_NOT_ATTACHED`, `MEMORY_NO_PREVIOUS`. Creating a card from the operator API is not implemented: a session's `add_memory_card` is the only create, and that call is currently refused by the grant check. See [memories-and-schedules.md](memories-and-schedules.md#what-a-session-is-given).

## Symptom recipes

| What you see | What to do |
|---|---|
| `sf agents list` shows revision 0 and issues | The file does not parse, or `id` does not match the file name. Fix, then list again |
| List does not show a file you wrote | The command's directory is not the project, or the Host is a different project. Run it from the folder that contains `stageflow.yaml`, or register that root |
| Enable rewrote the file and dropped comments | Expected. Canonical form omits defaults and comments. Re-read before the next edit, and keep `enabled: true` |
| Chat says the agent is disabled | `sf agents enable <id>` after the user agrees |
| The session stays `waiting` | Read `sf agents session <id> <sid> --json`, show the pending tool and arguments, then approve or deny only as the user decides |
| A second tool call fails `agent.session_busy` | Decide or stop the open approval first. One pending approval per session |
| After an edit, the old session still follows the old prompt | Sessions keep their starting revision. Omit `--session` |
| Public link 503 setup required | The agent has tools or the other consumer-safe checks failed. This is not a validator bug you can silence |
| Scheduled agent never runs | The Host must be running, the agent must be enabled, and the first tick only stores the next time. `STAGEFLOW_AGENT_SCHEDULE_TICK_INTERVAL_MS=0` disables the ticker |
| Morning digest cannot update its memory | The six memory tools are registered and then refused by the grant check, including the calls in `assets/examples/morning_digest.agent.yaml`. Seed the cover with `write_memory` and tell the user the agent cannot read it yet |

## Product limitations

Work around these. They are not flags you can turn on.

- No CLI and no MCP tool to add, remove, or secret a project MCP server, or to run MCP OAuth. REST and Settings → Project MCP only.
- No CLI and no MCP tool for consumer identity. REST and the Identity page only.
- No CLI for create, save, or archive. Write, edit, or delete the file, or use MCP.
- No CLI for one revision, a revision diff, or stopping a turn. MCP and REST have them. Diff the file with git when that is enough.
- No CLI for memories, connections, delivery resend, OTLP export, the all-agent session list, the pending-approvals list, or `GET /api/agents/stageflow-tools`.
- `create_agent` and the console turn public web chat on. Public chat then refuses any agent that has tools, and validate does not warn.
- `tools.browser`, `execution: sandbox`, and `model.backend: claude` are stored and do not run.
- `approvals.approvers.channel_ids` is ignored. Channels cannot approve.
- `bash` is not path-confined. The path guard covers path arguments on other tools.
- Memory session tools are not grant ids, so the gate refuses them. Operator `write_memory` still works. Nothing deletes a memory or adds a card except a session, and the session path is blocked by that gate.
- A2A publishes pipelines, not agents.
- MCP agent tools ignore the project you have open and use the Host's project.
- Pending approvals die on Host restart (`agent.host_restarted`).
- WhatsApp and IMAP/SMTP email accounts cannot be an agent channel.
