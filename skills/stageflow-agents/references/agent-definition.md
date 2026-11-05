# Agent definition reference

Every field of `agents/<id>.agent.yaml`, as the Host validates it. Unknown keys at any level are errors (`agent.unknown_field`). Errors block load, save and enable; warnings do not.

## Contents

- [File, id and lifecycle](#file-id-and-lifecycle)
- [Top-level fields](#top-level-fields)
- [model](#model)
- [tools](#tools)
- [approvals](#approvals)
- [sub_agents, guardrails, evals, observability](#sub_agents-guardrails-evals-observability)
- [channel](#channel)
- [memories](#memories)
- [web_chat](#web_chat)
- [schedule](#schedule)
- [limits](#limits)
- [Canonical form and revisions](#canonical-form-and-revisions)
- [Minimal and full examples](#minimal-and-full-examples)

## File, id and lifecycle

- Location: `<project root>/agents/<id>.agent.yaml`. The project root is the folder with `stageflow.yaml`. Agents are not listed in `stageflow.yaml`.
- `id` must match `^[a-z][a-z0-9_]{0,63}$` (lowercase, digits, underscore; no hyphens), equal the file name, and is fixed after creation (`agent.id_immutable`). `sessions`, `approvals` and `new` are reserved.
- Required: `id`, `name`, `instructions`. Everything else has a default.
- Created disabled. A file with `enabled: true` is honored on load, so write `enabled: false` (or leave it out) and enable with `sf agents enable <id>` after the user agrees.
- The Host reads the folder whenever agents are listed or used. A changed file becomes a new revision (source `file`); a formatting-only change does not. An unparsable edit keeps the last good revision running and shows the issues; a brand-new unparsable file appears with revision `0` and its issues.
- Deleting the file archives the agent (history and sessions kept; the id can be reused).

## Top-level fields

| Field | Type, default | Rules |
|---|---|---|
| `id` | string, required | See above. An API or MCP create without `id` generates one from `name`; a file must have it |
| `name` | string, required | 1 to 120 characters |
| `description` | string | Up to 500 characters. Shown in lists |
| `greeting` | string | Up to 500 characters. Shown on the web chat page |
| `enabled` | boolean, `false` | See lifecycle |
| `instructions` | string, required | The system prompt. Use a YAML block (`|`) |
| `project_context` | boolean, `false` | Adds the project's `AGENTS.md` (or `CLAUDE.md` when there is none), first 20,000 characters. Must stay `false` for any publicly reachable agent |
| `execution` | `trusted-local` (default) or `sandbox` | `sandbox` is not installed: warning `agent.sandbox_unavailable`, sessions fail. Do not set it |
| `model` | object | [model](#model) |
| `tools` | object | [tools](#tools) |
| `approvals` | object | [approvals](#approvals) |
| `sub_agents` | list of agent ids, `[]` | [sub_agents](#sub_agents-guardrails-evals-observability) |
| `sub_agent_depth` | integer 1 to 5, `1` | |
| `guardrails` | object | |
| `evals` | object | |
| `observability` | object | |
| `channel` | object, optional | [channel](#channel) |
| `memories` | list of memory ids, optional | [memories](#memories) |
| `web_chat` | object | [web_chat](#web_chat) |
| `schedule` | object, optional | [schedule](#schedule) |
| `limits` | object | [limits](#limits) |

The older `channels: [{ connection_id }]` list still loads as `channel`; more than one entry is an error. Write `channel`.

## model

| Field | Values, default | Notes |
|---|---|---|
| `backend` | `pi` (default) or `claude` | Only `pi` runs agents. `claude` saves with `agent.backend_unavailable` and sessions fail |
| `id` | `provider/model`, optional | Unset means the project default model. An id no connected provider lists only warns (`agent.model_unknown`) and is still tried. Cursor models (`cursor/…`) warn `agent.model_native_tools` and sessions fail unless the Host sets `STAGEFLOW_AGENTS_ALLOW_CURSOR_NATIVE_TOOLS=1`, because Cursor runs its own file and shell tools and grants cannot hold |
| `thinking` | `off`, `low`, `medium` (default), `high` | |

## tools

| Field | Type, default | Notes |
|---|---|---|
| `builtin` | list of groups, `[]` | `read` = read, grep, find, ls. `write` = write, edit. `shell` = bash. No duplicates |
| `builtin_tools` | list of single tools, `[]` | `read grep find ls write edit bash`, added on top of the groups |
| `mcp` | map server → list of tool names, `{}` | Server name `^[A-Za-z0-9_.-]{1,64}$`. Each list needs at least one entry (`["*"]` for every tool; `[]` is an error). `stageflow` is reserved (`agent.mcp_name_reserved`). A server the Host does not know warns `agent.mcp_server_unknown` |
| `skills` | list of skill names, `[]` | A skill the Host cannot find warns `agent.skill_unknown`, and sessions fail to start |
| `browser` | boolean, `false` | Stored but wired to nothing. Do not set |
| `stageflow.groups` | list of group ids, `[]` | Stageflow's own tools by group. Unknown group `agent.stageflow_group_unknown`; `gates.decide` is `agent.stageflow_operator_only` |
| `stageflow.tools` | list of tool names, `[]` | Single Stageflow tools. Unknown `agent.stageflow_tool_unknown`; `get_started`, `answer_gate`, `decide_feedback_loop`, `approve_agent_action`, `deny_agent_action` are operator-only |

Grant ids (used in `approvals.ask_first`): builtin tool name (`write`, `bash`), `<server>.<tool>` for MCP, `stageflow.<tool>` for Stageflow tools, `agent:<id>` for sub-agents. Groups and tool lists: [tools-and-approvals.md](tools-and-approvals.md).

## approvals

| Field | Type, default | Notes |
|---|---|---|
| `ask_first` | list of grant ids, `[]` | Each must be a granted tool (`agent.ask_first_not_granted`). With `mcp.<server>: ["*"]`, any `<server>.<tool>` is accepted. `bash` always asks whether listed or not |
| `approvers.operators` | boolean, `true` | Keep `true`. `false` with no `channel_ids` is an error; `false` with `channel_ids` validates but leaves nobody who can approve |
| `approvers.channel_ids` | list, `[]` | Reserved and ignored (warning `agent.channel_approvers_unused`) |
| `timeout_minutes` | integer 1 to 10080, `30` | |
| `on_timeout` | `skip` (default) or `deny` | `skip`: the model is told the action was skipped and continues. `deny`: the turn ends with `agent.approval_expired` |

## sub_agents, guardrails, evals, observability

| Field | Type, default | Notes |
|---|---|---|
| `sub_agents` | agent ids, `[]` | No duplicates, not itself (`agent.sub_agent_self`). Unknown id warns `agent.sub_agent_unknown`. Each becomes a tool `agent_<id>`, grant id `agent:<id>` |
| `sub_agent_depth` | 1 to 5, `1` | Nesting cap. Over it: `agent.delegate_depth_exceeded` |
| `guardrails.block_patterns` | list of JavaScript regular expressions, `[]` | No flags (write `[Pp]assword`, not `(?i)password`). Checked on the finished reply; a match fails the turn with `agent.guardrail_blocked` and the reply is neither stored nor sent. Streaming is held back for agents with patterns |
| `evals.groundedness` | boolean, `false` | Scores tool-using replies with one extra model call per turn (same model) |
| `observability.capture` | `off`, `metadata` (default), `full` | `off` stores no spans. `full` stores prompt, reply, tool arguments and results after secret redaction; keep `metadata` for personal or confidential content |
| `observability.otlp` | boolean, `false` | Pushes each finished turn to the collector in `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` (Host environment); does nothing without one |

## channel

One inbound channel per agent. Setup per provider: [channels-and-identity.md](channels-and-identity.md).

| Field | Type, default | Notes |
|---|---|---|
| `connection_id` | string, required inside `channel` | A connection on the Host. Unknown warns `agent.connection_unknown`. One connection has one agent, and two connections reaching the same inbox or Photon project count as one: `agent.channel_in_use` (error) |
| `allow_from` | list, `[]` | Who may message the agent. Empty lets nobody in (warning `agent.channel_nobody_allowed`); `*` lets anyone in (warning `agent.channel_open_to_anyone`). Entries: an email `jane@acme.com`, a domain `@acme.com`, an E.164 phone `+14155550123`, a Slack user id `U02ABC1234` (`U` or `W` then 7 or more capitals or digits), a Telegram `@username` (5 to 32 characters, no dot), or `*`. Duplicates are an error |

## memories

List of memory ids (`^[a-z][a-z0-9_-]{0,63}$`, no duplicates). Each must already exist on the Host: a missing one is `agent.memory_unavailable` and blocks validate, save and enable. Sub-agents do not inherit them. Create and use: [memories-and-schedules.md](memories-and-schedules.md).

## web_chat

| Field | Type, default | Notes |
|---|---|---|
| `enabled` | boolean, `false` in a file | A create through MCP, REST or the console that leaves out `web_chat` gets `{ enabled: true }` and a public link. Always write the block |
| `access` | `public` (default) or `authenticated` | `public` requires a tool-less agent; `authenticated` requires consumer identity. See [channels-and-identity.md](channels-and-identity.md) |
| `slug` | 16 to 32 `[a-z0-9]` | The link `/chat/<slug>`; it is the credential. Minted by the Host on a save through MCP, REST or the console when web chat is on and no slug is set. A hand-written file without one warns `agent.web_chat_slug_missing` and has no link. `slug: ""` in a save rotates the link. A save that leaves `web_chat` out keeps the current block |
| `rate_limit_per_minute` | 1 to 120, `10` | Per visitor; new conversations get twice that; per IP address three times |
| `max_message_chars` | 1 to 20000, `4000` | |

## schedule

| Field | Type, default | Notes |
|---|---|---|
| `cron` | cron expression, required inside `schedule` | Validated on load and save |
| `timezone` | IANA name | Defaults to the Host's timezone |
| `message` | string, `Scheduled check-in.` | The user turn each run starts with |

Behavior: [memories-and-schedules.md](memories-and-schedules.md#schedules).

## limits

Checked when a turn starts; a running turn is not cut short. All refuse with `agent.limit_reached` (`web_chat.limit_reached` on web chat).

| Field | Type, default | Refuses a new turn when |
|---|---|---|
| `session_minutes` | 1 to 1440, `10` | The session is that old |
| `max_turns` | 1 to 1000, `40` | The session has that many turns |
| `cost_usd` | number > 0 or `null` (default, no cap) | The session's turns cost that much. With `always_on`, the last 24 hours |
| `long_context` | `summarize` (default) or `truncate` | When a rebuilt session's history exceeds 60,000 characters: one-line digest of dropped messages, or drop them |
| `always_on` | boolean, `false` | The session never ends by time or turns and resumes after a failure. Recommended for iMessage |

## Canonical form and revisions

Any save through the Host (enable, disable, restore, MCP, REST, console) rewrites the file in canonical form: fixed key order (`id name description greeting enabled instructions project_context execution model tools approvals sub_agents sub_agent_depth guardrails evals observability channel memories web_chat schedule limits`), every other default omitted, `enabled` always written, `instructions` as a block. Comments in a hand-written file are lost at that point. `sf agents validate --json` returns this canonical text in `yaml`.

Revisions are numbered from 1. Sources: `file` (hand edit), `console` (REST, which includes the CLI), `api` (MCP, author `mcp`), `restore`, `author`. Every save and restore carries the revision it was based on; a stale one is `agent.conflict`. An identical save is a no-op. Sessions are pinned to the revision they started on.

## Minimal and full examples

Minimal valid file:

```yaml
id: support
name: Support
instructions: |
  Answer questions about our product. Say so when you do not know.
```

Shapes to copy live in `assets/examples/`: `research_helper`, `support_inbox`, `morning_digest`, `public_faq`. `morning_digest` does not validate until the `digest_notes` memory exists. `support_inbox` warns `agent.mcp_server_unknown` and `agent.connection_unknown` until the helpdesk server and the `support-inbox` connection exist. `public_faq` warns `agent.web_chat_slug_missing` until a Host save mints the slug.
