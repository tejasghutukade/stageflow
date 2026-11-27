# Agent definition

An agent is one YAML file, `agents/<id>.agent.yaml`, in the project. This page is the field reference. For what the settings do while an agent runs, see [Agent runtime](agent-runtime.md); for the overview, see [Agents](agents.md).

Unknown keys are rejected (`agent.unknown_field`), so a typo is an error rather than a setting that silently does nothing.

## Minimal file

```yaml
id: support
name: Support
instructions: |
  Answer questions about our product. Say so when you do not know.
```

Everything else has a default. Saving through the console, API, CLI or MCP writes the **canonical** form: fixed key order, defaults left out, so a diff between two revisions shows only what someone set.

## Fields

### Identity

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| `id` | string | made from `name` | `^[a-z][a-z0-9_]{0,63}$`. Must match the file name. Fixed after creation (`agent.id_immutable`). `sessions`, `approvals` and `new` are reserved because they are part of the `/api/agents/` URLs. |
| `name` | string | required | 1–120 characters. |
| `description` | string | none | Up to 500 characters. |
| `greeting` | string | none | Up to 500 characters. Shown on the public web chat page. |
| `enabled` | boolean | `false` | A new agent is always created disabled; enabling is its own revision. |
| `instructions` | string | required | The system prompt. |
| `project_context` | boolean | `false` | Adds the project's `AGENTS.md` (or, if absent, `CLAUDE.md`) to the system prompt, first 20,000 characters. |

If you create an agent without an `id`, one is made from the name (lowercase, other characters become `_`, at most 56 characters, a number added if taken; `agent` when the name has no usable letters).

### `model`

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| `model.backend` | `pi` \| `claude` | `pi` | Only `pi` runs. `claude` saves, warns (`agent.backend_unavailable`) and fails when a session starts. |
| `model.id` | string | project default | A model id from a connected provider. An id no provider lists only warns (`agent.model_unknown`). |
| `model.thinking` | `off` \| `low` \| `medium` \| `high` | `medium` | How hard the model thinks, for models that support it. |

`execution` is `trusted-local` (default) or `sandbox`. `sandbox` needs a sandbox runner that is not installed yet: it warns (`agent.sandbox_unavailable`) and sessions fail.

### `tools`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `tools.builtin` | list of `read`, `write`, `shell` | `[]` | Whole groups: `read` = read, grep, find, ls; `write` = write, edit; `shell` = bash. |
| `tools.builtin_tools` | list of `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash` | `[]` | Single tools on top of the groups. |
| `tools.mcp` | map: server name → list of tool names | `{}` | Names match `^[A-Za-z0-9_.-]{1,64}$`. Each list needs at least one tool; `"*"` allows every tool of the server. `stageflow` is reserved. |
| `tools.skills` | list of skill names | `[]` | Skills must be installed, or a session fails to start. |
| `tools.browser` | boolean | `false` | Stored but not wired to anything yet. |
| `tools.stageflow.groups` | list of group ids | `[]` | See [Stageflow tools](agent-runtime.md#stageflow-tools). Artifact groups: `artifacts.read` (ask-first id `stageflow.get_artifact`, model tool `stageflow_get_artifact`), `artifacts.write` (ask-first id `publish_artifact`, model tool `publish_artifact`), `artifacts.cleanup` (ask-first id `stageflow.delete_artifact`, model tool `stageflow_delete_artifact`), `artifacts.refresh` (ask-first id `stageflow.refresh_artifact`, model tool `stageflow_refresh_artifact`). Refresh runs only an artifact this agent owns in the session's project. |
| `tools.stageflow.tools` | list of tool names | `[]` | Single Stageflow tools on top of the groups. |

The console shows one checkbox per tool and stores the compact form: a full group as the group, a partial one as single tools.

Operator-only Stageflow tools (`gates.decide` and `get_started`) cannot be granted: `agent.stageflow_operator_only`.

### `ui`

Off unless `present` is true. This is the grant for `present_ui`, the tool an agent uses to draw a card in its reply. One setting, `persistence`, decides where cards live and what they can do:

| `persistence` | Where a card lives | What a card can do | Public chat page |
|---------------|--------------------|--------------------|------------------|
| `conversation` (default) | Inside the chat message. Nothing is written to the artifact store; the card is deleted with the conversation. | Show what the agent writes into it: layouts, tables, numbers, markdown. No live data, no buttons, no existing artifacts. | Opens. Visitors see the cards. |
| `artifacts` | Saved as a session artifact (kept 30 days unless promoted). | Also show existing artifacts by key, load live data from `ui.functions`, run buttons, and use every presentable kind. | Does not open (the agent counts as having tools). |

The smallest setup is:

```yaml
ui:
  present: true
```

That draws `live.declarative` and `static.markdown` cards kept in the conversation. To change a card, ask the agent: it calls `present_ui` again with the whole updated program, and the new card appears in its reply. Earlier cards stay as they were. A program that does not parse comes back on the tool result so the model can fix it; chat shows a skeleton while the call streams and a short error card if it gives up.

For live data and buttons:

```yaml
ui:
  present: true
  persistence: artifacts
  kinds: [static.markdown, live.declarative]
  functions: [weekly_sales]
```

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| `ui.present` | boolean | `false` | The model can call `present_ui` only when this is true. Kinds or functions with it off is `agent.ui_present_required`. |
| `ui.persistence` | `conversation` or `artifacts` | `conversation` | See the table above. |
| `ui.kinds` | list of artifact kinds | both card kinds, or every presentable kind with `artifacts` | Filled in when `present` is true and the list is empty. Each must be `static.markdown`, `static.image`, `static.table`, `static.text`, `static.html`, `live.declarative`, or `live.html` (`agent.ui_kind_unknown`). With `conversation`, only `live.declarative` and `static.markdown` (`agent.ui_kind_needs_artifacts`). No duplicates (`agent.ui_kind_duplicate`). A call for another kind is refused (`ui.kind_not_granted`). |
| `ui.functions` | list of function ids | `[]` | Only with `persistence: artifacts` (`agent.ui_functions_need_artifacts`). Function ids a card may call for live data. Each id matches `^[a-z][a-z0-9_-]{0,63}$` (`agent.ui_function_invalid`). No duplicates (`agent.ui_function_duplicate`). A binding query whose function is not listed is `agent.ui_function_not_granted`. |

When `live.declarative` or `live.html` is in `ui.kinds`, the agent's prompt carries that kind's vocabulary, syntax and an example, so it can write a program without reading the docs. A reply holds at most four cards; failed attempts do not count. A card kept in the conversation is at most 64 KB and refuses bindings and actions (`ui.card_display_only`) and artifact keys (`ui.key_needs_artifacts`). With `artifacts`, a key from another project is refused (`ui.cross_project`), a missing key is `artifact.not_found`, and a deleted or expired artifact renders as an unavailable card. Email, Telegram, iMessage and Slack get a card's plain-text fallback (a markdown card sends its text). Eval sessions stub `present_ui` and do not run it.

### `approvals`

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| `approvals.ask_first` | list of tool ids | `[]` | Each must be a tool the agent is granted (`agent.ask_first_not_granted`). `bash` is always ask-first when granted, listed or not. |
| `approvals.approvers.operators` | boolean | `true` | People deciding in the console, CLI or MCP. |
| `approvals.approvers.channel_ids` | list of strings | `[]` | **Reserved.** Nothing decides from a chat channel yet; ids listed here are ignored and save with the warning `agent.channel_approvers_unused`. |
| `approvals.timeout_minutes` | integer | `30` | 1–10,080. |
| `approvals.on_timeout` | `skip` \| `deny` | `skip` | `skip` lets the agent continue without the action; `deny` ends the turn. |

At least one approver must be allowed, so `operators: false` with no `channel_ids` is an error (`approvals.approvers`). Because `channel_ids` is reserved, `operators: false` leaves nobody able to decide: do not use it.

Tool ids in `ask_first`: a builtin name (`edit`, `bash`), `stageflow.<tool>`, `publish_artifact` when `artifacts.write` is granted, `<server>.<tool>` for an MCP tool, or `agent:<id>` for a sub-agent. `artifacts.read` grants the ask-first id `stageflow.get_artifact`; the model calls `stageflow_get_artifact`. `artifacts.cleanup` grants the ask-first id `stageflow.delete_artifact`; the model calls `stageflow_delete_artifact`. `artifacts.refresh` grants the ask-first id `stageflow.refresh_artifact`; the model calls `stageflow_refresh_artifact`, and only for an artifact this agent owns in the session's project. `artifacts.write` grants the ask-first id `publish_artifact`, which is also the name the model calls. `save_artifact` is the operator MCP tool and is not an agent ask-first id. How asking works is in [Agent runtime](agent-runtime.md#asking-first).

### `sub_agents`

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| `sub_agents` | list of agent ids | `[]` | No duplicates; an agent cannot list itself (`agent.sub_agent_self`). An id with no agent warns (`agent.sub_agent_unknown`). |
| `sub_agent_depth` | integer | `1` | 1–5. How deep nested calls may go. |

### `guardrails`, `evals`, `observability`

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| `guardrails.block_patterns` | list of regular expressions | `[]` | Each must compile. Matched against the finished reply (JavaScript `RegExp`, no flags). |
| `evals.groundedness` | boolean | `false` | Scores replies that used tools. See [Observability](agent-observability.md#groundedness). |
| `observability.capture` | `off` \| `metadata` \| `full` | `metadata` | See [Observability](agent-observability.md#what-is-recorded). |
| `observability.otlp` | boolean | `false` | Push each finished turn to an OTLP collector. |

### `channel`

```yaml
channel:
  connection_id: support-inbox
  allow_from: [jane@example.com, "@acme.com", "+14155550123"]
```

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| `channel.connection_id` | string | none | The [connection](channels.md) this agent answers on. One agent per connection; two connections that reach the same inbox or line also count as one (`agent.channel_in_use`). An unknown id warns (`agent.connection_unknown`). |
| `channel.access` | `allow_list` or `authenticated` | `allow_list` | `authenticated` runs admitted senders under the consumer gate with every declared customer resource tool (`orders.status`, `orders.list`, `account.profile`). Needs identity, a channel identity connection for this agent and connection, and a consumer-safe agent; see [Consumer identity](consumer-identity.md). |
| `channel.allow_from` | list of strings | `[]` | Who may message the agent. No duplicates. Empty lets nobody in and warns (`agent.channel_nobody_allowed`); `*` or a public mail domain (`@gmail.com`) lets anyone in and warns (`agent.channel_open_to_anyone`); with tools, skills, memories, project context or sub-agents the agent then cannot be enabled (`agent.channel_open_with_tools`). A Telegram `@username` entry warns (`agent.channel_username_entry`); use the numeric user id. |

An `allow_from` entry is one of:

| Entry | Matches | Used by |
|-------|---------|---------|
| `jane@example.com` | That address (case-insensitive; `Jane <Jane@X.com>` is read as `jane@x.com`) | AgentMail |
| `@example.com` | Everyone at that domain | AgentMail |
| `+14155550123` | That phone number (E.164; spaces, dashes and brackets in the sender are ignored) | iMessage |
| `U02ABC1234` | That Slack user id (starts with `U` or `W`; 8 or more capitals and digits in all) | Slack |
| `@bob_smith` | That Telegram username (5–32 letters, digits, `_`; written with the `@`, case-insensitive) | Telegram |
| `*` | Anyone | any |

A message from a sender who matches nothing is ignored. The earlier `channels: [{ connection_id }]` list still loads as the one `channel`; more than one is an error.

### `memories`

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| `memories` | list of ids | none | Each id is `[a-z][a-z0-9_-]{0,63}` and must already exist under `$STAGEFLOW_HOME/memories/`. Duplicates are rejected. An empty list is omitted when the file is written. |

Every session of this agent can call `read_memory` and `replace_memory` for the cover, and `add_memory_card`, `update_memory_card`, `read_memory_card`, and `search_memory_cards` for cards on those ids. The prompt lists the memory ids and descriptions. It does not include the cover or any card body, and the session never receives a file path. `add_memory_card` refuses an existing key. `update_memory_card` refuses a missing key. `read_memory_card` returns the current body. `search_memory_cards` is a case-insensitive word scan of the current keys and bodies, at most 20 hits, snippet only. A session cannot delete a card and cannot read the previous copy. A missing, unreadable, or mismatched id is `agent.memory_unavailable`: create, save, and enable all fail. Enable checks the data directory again even when the agent file has not changed. Sub-agents do not inherit the list.

Create the memory in the console (**Memories**) before attaching it. The operator can edit the cover there, and can delete a card (the current card and the previous copy; that cannot be undone). A session adds cards. See [YAML catalog — Memories](yaml-catalog.md#memories).

### `web_chat`

```yaml
web_chat:
  enabled: true
  access: public
  slug: k7x9m2qp4h8d3w6n
  rate_limit_per_minute: 10
  max_message_chars: 4000
```

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| `web_chat.enabled` | boolean | `false` in a hand-written file | A new agent created through the console, API, CLI or MCP starts with it on. |
| `web_chat.access` | `public` or `authenticated` | `public` | Anyone with a public link can chat and see cards kept in the conversation, without signing in. The link opens only for an agent with no tools, skills, memories, project context or sub-agents, and whose cards are not saved as artifacts. Otherwise the page says the chat is not open yet, and the agent's page in the console says what to remove (`agent.web_chat_needs_setup`). Authenticated chat needs identity turned on and a consumer-safe agent; see [Protect an agent's chat with customer sign-in](guides-agents-protected-chat.md) and [Consumer identity](consumer-identity.md) and restrictions. |
| `web_chat.slug` | string | made on save | 16–32 lowercase letters or digits. The link grants access to public chat, not protected identity. An enabled block with no slug gets a random one when saved through the console, API, CLI or MCP; a hand-written file shows the warning `agent.web_chat_slug_missing` until then. Saving with `slug: ""` rotates the link. |
| `web_chat.rate_limit_per_minute` | integer | `10` | 1–120 messages per visitor per minute. |
| `web_chat.max_message_chars` | integer | `4000` | 1–20,000. |

A client that leaves `web_chat` out of a save (CLI, MCP, scripts) keeps the agent's current link and limits. The public page and its API are in [Agents](agents.md#web-chat-public-page).

### `schedule`

```yaml
schedule:
  cron: "0 9 * * 1-5"
  timezone: Europe/London
  message: Post the morning summary.
```

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| `schedule.cron` | string | required | A valid cron expression. |
| `schedule.timezone` | string | Host's local zone | An IANA zone name. |
| `schedule.message` | string | `Scheduled check-in.` | What the scheduled turn says. |

See [Schedules](agents.md#schedules) for when it fires.

### `limits`

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| `limits.session_minutes` | integer | `10` | 1–1,440. Refuses a new turn after this many minutes with no messages. Waiting on an approval does not count as idle. |
| `limits.max_turns` | integer | `40` | 1–1,000. |
| `limits.cost_usd` | number or `null` | `null` | Above 0. A session that has spent this much refuses a new turn. |
| `limits.long_context` | `summarize` \| `truncate` | `summarize` | How a replayed transcript is cut down. |
| `limits.always_on` | boolean | `false` | Skips `session_minutes` and `max_turns`; `cost_usd` then counts per day. |

Limits are checked when a turn starts, not during it. See [Agent runtime](agent-runtime.md#limits).

## Validation: issues and warnings

Validating, creating or saving returns two lists.

- **Issues** stop the save. The API answers `422` with `agent.invalid` and the list; each issue has a dotted `path` (for example `tools.mcp.notion` or `approvals.ask_first.0`), a `code` and a `message`.
- **Warnings** are advice. The agent saves and, if enabled, runs.

Issue codes:

| Code | Meaning |
|------|---------|
| `agent.required` | A required field is missing. |
| `agent.unknown_field` | A key the schema does not have. |
| `agent.invalid_value`, `agent.invalid_type`, `agent.too_small`, `agent.too_big`, `agent.invalid_format`, … | A value of the wrong type, range or shape. The message says what is expected. |
| `agent.yaml_syntax`, `agent.invalid_shape` | The file is not valid YAML, or is not a mapping. |
| `agent.id_mismatch` | The `id` differs from the file name. |
| `agent.id_immutable` | A save tried to change the id. |
| `agent.ask_first_not_granted` | An `ask_first` tool the agent does not hold. |
| `agent.stageflow_group_unknown`, `agent.stageflow_tool_unknown` | Not a Stageflow group or tool. |
| `agent.stageflow_operator_only` | A group or tool only a person may use. |
| `agent.mcp_name_reserved` | `tools.mcp.stageflow`. |
| `agent.sub_agent_self` | The agent lists itself. |
| `agent.channel_in_use` | The connection (or the inbox behind it) already answers for another agent. |
| `agent.memory_unavailable` | A `memories` id is missing, unreadable, or does not match its file. |

Warning codes:

| Code | Meaning |
|------|---------|
| `agent.shell_not_path_confined` | `bash` is granted; see [Agent runtime](agent-runtime.md#the-path-guard-and-bash). |
| `agent.backend_unavailable`, `agent.sandbox_unavailable` | `claude` backend or `sandbox` execution: sessions fail. |
| `agent.model_unknown` | No connected provider lists the model. |
| `agent.model_native_tools` | The provider runs its own file and shell tools beside the agent's, so grants and approvals cannot hold; sessions fail unless the Host opts in. |
| `agent.mcp_server_unknown` | The server is in neither the project `.mcp.json` nor the servers saved from the console. |
| `agent.skill_unknown` | The skill is not installed. |
| `agent.sub_agent_unknown` | No agent has that id. |
| `agent.connection_unknown` | No connection has that id. |
| `agent.channel_nobody_allowed`, `agent.channel_open_to_anyone` | An empty `allow_from`, or one with `*` or a public mail domain. |
| `agent.channel_open_with_tools` | An allow-list channel (not `access: authenticated`) open to anyone, and the agent has tools, skills, memories, project context or sub-agents. A warning while the agent is off; an error when enabling, and an enabled agent stops answering on its channel. |
| `agent.channel_username_entry` | `allow_from` has a Telegram `@username`, which can change hands. Use the numeric user id. |
| `agent.channel_approvers_unused` | `approvals.approvers.channel_ids` is reserved and ignored. |
| `agent.web_chat_slug_missing` | Web chat is on with no link yet. |
| `agent.web_chat_reads_conversations` | Web chat is on and the agent can read every agent's sessions, including visitors' messages. |

## Files, revisions and sync

Definitions stay in git-tracked YAML. The Host keeps a copy of every version in the run store database under `$STAGEFLOW_HOME`.

- **A revision** is one saved version, numbered from 1, with a source: `console` (the editor, and anything that goes through the REST API, including the CLI), `api` (the MCP tools; the author is recorded as `mcp`), `restore` (restoring an older version) or `file` (the YAML was edited by hand). A summary is optional.
- **A stale save is rejected.** Every save and restore carries the revision it was based on; if the agent has moved on the answer is `agent.conflict` (409).
- **Saving something identical is a no-op**: no new revision.
- **Restoring** an old revision saves it as the newest one and keeps the agent's current enabled state.
- **Enabling and disabling** are revisions too ("Enabled", "Disabled"). Enabling is refused while the file on disk has issues.
- **Sync from disk.** The Host reads `agents/*.agent.yaml` when the agents are used and notices a change by its content hash. A read never rewrites a file. Editing a file by hand adds a `file` revision if the meaning changed (formatting alone does not). A file that no longer parses keeps the last good revision in use and shows its issues; a new file that never parsed appears with its issues and no revision.
- **Removing the file archives the agent.** History stays readable and its id can be used again. Archiving from the console, CLI or MCP does the same: it deletes the file and keeps revisions and sessions.
- **Sessions are pinned.** A session keeps the revision it started on; later edits reach new sessions only. An agent that is disabled or archived still refuses new turns on old sessions.
