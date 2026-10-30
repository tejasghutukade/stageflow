# Agent API reference

Everything the console does with [agents](agents.md) goes through one HTTP surface, `/api/agents`. The `sf agents` CLI is a client of it, and the MCP agent tools call the same service. This page is the contract: routes, errors, streaming frames, inbound webhooks, the anonymous web chat API, and which of REST, CLI and MCP can do what.

For the YAML an agent is written in see [Agents](agents.md) and [YAML catalog — Agents](yaml-catalog.md#agents-agent-yaml).

## Conventions

**Auth.** `/api/agents/*` is protected like every other `/api/*` route when control tokens are configured: `GET` and `HEAD` need the **read** scope, everything else needs **drive** (`Authorization: Bearer <token>`). A loopback Host with no tokens set is open. See [MCP — Access control](mcp.md#access-control). Two groups are exempt from the token and carry their own credential: [inbound webhooks](#inbound-webhooks) (the provider's signature) and the [public web chat API](#public-web-chat-api) (the link slug).

**Project.** Agents belong to a project. By default that is the Host's own project. Add `?project_root=<path>` to act on another registered catalog root; it must be a known root, and writes need a writable one. A bad root answers `400` with the usual catalog path error body.

**Bodies.** JSON objects, at most 256 KiB. Anything else is `422 agent.invalid` ("Request body is not JSON", "must be a JSON object", "is too large").

**Errors.** A refused request answers with the stable `code`, the human `message` when it adds something, and field `issues` for validation:

```json
{
  "code": "agent.invalid",
  "message": "…",
  "issues": [{ "path": "instructions", "message": "Required" }]
}
```

Clients branch on `code`, never on `message`. Other statuses: `405 agent.method_not_allowed` for a known path with the wrong method, `400 agent.invalid` for a malformed percent-encoded path, `503 agent.store_unavailable` when the Host runs without the agent store.

| Code | HTTP | Meaning |
|------|------|---------|
| `agent.invalid` | 422 | Definition or request body failed validation (see `issues`) |
| `agent.not_found`, `agent.revision_not_found`, `agent.session_not_found` | 404 | Unknown agent, revision or session. A session id only opens under the agent it belongs to |
| `agent.exists` | 409 | An agent with that id exists |
| `agent.archived` | 409 | The agent is archived |
| `agent.disabled` | 409 | The agent is disabled (new sessions, turns and approving are refused; denying still works) |
| `agent.conflict` | 409 | `baseRevision` is not the current revision: someone saved in between |
| `agent.session_busy` | 409 | A turn is already running in that session |
| `agent.limit_reached` | 409 | The session hit `session_minutes`, `max_turns` or `cost_usd` |
| `agent.model_timeout` | 504 | The model did not answer in time |
| `agent.approval_forbidden` | 403 | The caller is not an allowed approver |
| `agent.sender_not_allowed` | 403 | Sender not in the channel `allow_from` |
| anything else (`agent.approval_not_pending`, `agent.approval_expired`, `agent.tool_not_granted`, `agent.guardrail_blocked`, `agent.backend_unavailable`, `agent.unbound`, `agent.delegate_*`, …) | 400 | Refused for a reason in the code |

An uncoded failure is a plain `500`.

## Routes

`:id` is the agent id (`^[a-z][a-z0-9_]{0,63}$`; `sessions`, `approvals` and `new` are reserved because they are fixed words in these URLs). Bodies and responses are JSON unless noted. "Detail" below is `{ agent, definition, yaml, warnings }`: `agent` is the summary the list shows, `definition` the parsed current revision (`null` when the file is invalid), `yaml` its canonical text and `warnings` non-blocking notices.

### Definitions

| Method and path | Body | Response |
|-----------------|------|----------|
| `GET /api/agents` | | `{ agents: [summary] }` |
| `POST /api/agents` | `{ definition }` | `201` Detail. Always created disabled. A missing `id` is generated from `name` |
| `POST /api/agents/validate` | `{ definition }` | `{ definition, issues, warnings, yaml }`. Writes nothing and never mints a web chat link |
| `GET /api/agents/:id` | | Detail |
| `POST /api/agents/:id/save` | `{ baseRevision, definition, summary? }` | Detail. `baseRevision` must be the current revision (`agent.conflict` otherwise) |
| `POST /api/agents/:id/enable`, `.../disable` | | Detail |
| `POST /api/agents/:id/archive` | | `{ archived: true }`. Sessions are kept; new ones are refused |
| `GET /api/agents/stageflow-tools` | | The Stageflow tool registry (groups, tools, risk) the console builds its pickers from |

Saves from these routes are recorded as revision source `console`.

### Revisions

| Method and path | Body | Response |
|-----------------|------|----------|
| `GET /api/agents/:id/revisions` | | `{ revisions: [{ agentId, revision, source, author, summary, restoredFrom, createdAt }] }`, newest first. `source` is `console`, `file`, `author`, `restore` or `api` |
| `GET /api/agents/:id/revisions/:n` | | One revision including `definition` and `yaml` |
| `GET /api/agents/:id/revisions/:from/diff/:to` | | `{ lines }` |
| `POST /api/agents/:id/revisions/:n/restore` | `{ baseRevision }` | Detail. Saves revision `n` as the newest revision |

### Sessions and approvals

| Method and path | Body | Response |
|-----------------|------|----------|
| `GET /api/agents/sessions` | | Sessions of every agent in the project. Query: `agent`, plus the filters below |
| `GET /api/agents/:id/sessions` | | `{ sessions, nextCursor, stats }` for one agent |
| `GET /api/agents/:id/sessions/:sid` | | `{ session, messages, turns, spans, approvals, pendingApproval, evalScores, deliveries }` |
| `GET /api/agents/:id/sessions/:sid/otlp` | | The session's traces as OTLP/JSON, sent as a download (`<sid>.otlp.json`) |
| `GET /api/agents/approvals` | | `{ approvals: [approval + agentId] }`: every pending approval in the project |
| `POST /api/agents/:id/sessions/:sid/approval/approve`, `.../deny` | | `{ approval, session }`. Decided as an operator. Approving a disabled agent is `agent.disabled`; denying always works |

Session list query: `status` (`open`, `running`, `waiting`, `held`, `closed`; anything else is `422`), `source` (`console`, `web`, `mcp`, a provider name), `q` (text search), `limit` (1–100, default 25), `cursor` (the previous `nextCursor`). `stats` holds the totals for the same agent set (`total`, `active`, `last7Days`, `waiting`, `costTotal`, `cost7d`, …).

### Chat

| Method and path | Body | Response |
|-----------------|------|----------|
| `POST /api/agents/:id/chat` | `{ message, sessionId?, stream? }` | One turn. Omit `sessionId` to open a session |
| `POST /api/agents/:id/chat/stop` | `{ sessionId }` | `{ stopped: boolean }`. `false` when nothing was running. The session stays open |

Without streaming the call waits for the whole turn and answers `200` with the session (same shape as the session `GET`). With `"stream": true` or `Accept: application/x-ndjson` the reply is [NDJSON](#ndjson-frames). The turn is attributed to the console. If the client disconnects mid-stream, the turn is stopped.

### Channel status and delivery

| Method and path | Response |
|-----------------|----------|
| `GET /api/agents/:id/channel` | `{ connectionId, listener?, lastUndelivered? }`. `listener` is the live state of the Host's stream (AgentMail, iMessage) and is absent for webhook providers and disabled agents. `lastUndelivered` is `{ turnId, sessionId, state, code, message, at }` for the latest reply that failed to send |
| `GET /api/agents/:id/channel/contact` | `{ connectionId, … }`: where people reach the agent (for iMessage, the number to text), when the provider can say |
| `POST /api/agents/:id/sessions/:sid/turns/:tid/delivery/resend` | Tries the failed reply once more (no automatic retries). Returns the session |
| `POST /api/agents/:id/sessions/:sid/turns/:tid/delivery/delivered` | Marks it delivered by hand. Returns the session |

## NDJSON frames

Streaming responses are `application/x-ndjson`, one JSON object per line, flushed as they happen. The HTTP status is `200` once the stream starts, so a failure arrives as a frame.

**`POST /api/agents/:id/chat`**

| Frame | When |
|-------|------|
| `{ "type": "session", "sessionId": "…" }` | Once, when a new session was opened |
| `{ "type": "delta", "text": "…" }` | Each piece of reply text |
| `{ "type": "done", "session": { … } }` | The turn finished; `session` is the full session |
| `{ "type": "error", "code": "agent.…", "message"?: "…" }` | The turn failed. Last frame |

A stream that ends with neither `done` nor `error` was cut off (the CLI reports `agent.stream_closed`). For an agent with `guardrails.block_patterns`, deltas are held back and released after the check, so text arrives in larger pieces.

**Public web chat message** (below) uses `delta`, `waiting`, `done` and `error` frames with a different `done` and `error` shape.

## Inbound webhooks

`POST /api/agent-inbound/:connectionId` receives messages for Slack and Telegram connections and for AgentMail connections that use a webhook. It needs no control token; the provider's signature against the connection's `inboundSecret` is the credential. (AgentMail and iMessage are normally received over a stream the Host opens itself; see [Agents — the Host listens](agents.md#agentmail-and-imessage-the-host-listens).)

| Provider | `inboundSecret` is | Header checked |
|----------|--------------------|----------------|
| Slack | App signing secret | `x-slack-signature` and `x-slack-request-timestamp` |
| Telegram | `secret_token` given to `setWebhook` | `x-telegram-bot-api-secret-token` |
| AgentMail | Webhook secret | `x-agentmail-signature` (HMAC-SHA256 of the raw body) |

| Status | Body | Meaning |
|--------|------|---------|
| `200` | `{ "ok": true }` | Accepted; the agent answers in the background and the reply goes out on the same connection |
| `200` | `{ "challenge": "…" }` | Slack `url_verification` |
| `200` | `{ "ignored": true }` | Dropped on purpose: a bot's own message, no enabled agent on this connection, sender not in `allow_from`, or sender over 20 messages a minute. Nothing is retried, and the sender cannot tell the difference |
| `200` | `{ "duplicate": true }` | This event id was already handled |
| `400` | | Body is not JSON, or not a message this provider recognises |
| `401` | | Signature does not verify |
| `404` | | No such connection, or it has no `inboundSecret` |
| `413` | | Body over 1 MiB |
| `503` | `{ "code": "agent.store_unavailable" }` | The Host runs without the agent store |

## Public web chat API

The anonymous chat page (`/chat/<slug>`, served from the Host) uses these routes for tool-less public agents without shared private context. The link slug is the public-access credential; there is no control token. They are only live while the agent is enabled and `web_chat.enabled` is true. Each visitor sends a stable id the page keeps in the browser as the `X-Visitor-Id` header (16–64 characters of `A–Z a–z 0–9 _ -`); conversations are scoped to it. Authenticated agents instead require verified admission and a bearer on every thread request. Their experimental embedded API, unsupported paths and migration limits are documented in [Consumer identity](consumer-identity.md); the existing page has no sign-in flow.

| Method and path | Response |
|-----------------|----------|
| `GET /api/public/chat/:slug` | `{ agent: { name, greeting } }` |
| `GET /api/public/chat/:slug/threads` | `{ threads: [{ id, title, updatedAt }] }` for this visitor (most recent 50) |
| `POST /api/public/chat/:slug/threads` | `201 { thread }`. At most 50 threads per visitor |
| `GET /api/public/chat/:slug/threads/:tid` | `{ thread, status, messages: [{ id, role, text, createdAt }] }`. `status` is `open`, `running` or `waiting` |
| `POST /api/public/chat/:slug/threads/:tid/messages` | Body `{ text }`. NDJSON reply stream |

Message stream frames: `{ "type": "delta", "text" }`, `{ "type": "waiting" }` (an operator has to approve something; it never says what), `{ "type": "done", "message": { id, role, text, createdAt } | null }` and `{ "type": "error", "code", "message", "retryAfterSec"? }`. Nothing here returns tool payloads, traces or another visitor's data.

Errors are `{ code, message, retryAfterSec? }` with a friendly `message`:

| Code | HTTP | Meaning |
|------|------|---------|
| `web_chat.unavailable` | 404 | Unknown or switched-off link, agent disabled or archived, thread not yours |
| `web_chat.invalid` | 400 | Missing or bad visitor id, empty text, wrong method |
| `web_chat.message_too_long` | 413 | Over `web_chat.max_message_chars` |
| `web_chat.rate_limited` | 429 | Over `web_chat.rate_limit_per_minute` per visitor (thread creation gets twice that) or three times it per IP address. `Retry-After` is set |
| `web_chat.busy` | 409 | The last message is still being answered |
| `web_chat.limit_reached` | 409 | The conversation hit its session limits, or too many threads |
| `web_chat.failed` | 500 | Anything else; also a guardrail block, with a neutral message |

**CORS.** Same-origin pages always work. A page hosted elsewhere must have its origin listed in `STAGEFLOW_PUBLIC_CHAT_ORIGINS` (comma separated); other origins, and `Origin: null`, get no CORS headers. Allowed headers are `content-type` and `x-visitor-id`.

## CLI, MCP and REST side by side

| Operation | REST | CLI (`sf agents`) | MCP tool |
|-----------|------|-------------------|----------|
| List | `GET /api/agents` | `list` | `list_agents` |
| Read one | `GET /api/agents/:id` | `get` | `get_agent` |
| Validate | `POST …/validate` | `validate <file>` | `validate_agent` |
| Create | `POST /api/agents` | | `create_agent` |
| Save | `POST …/:id/save` | | `save_agent` |
| Enable, disable | `POST …/enable`, `…/disable` | `enable`, `disable` | `enable_agent`, `disable_agent` |
| Archive | `POST …/archive` | | `archive_agent` |
| Revisions | `GET …/revisions` | `history` | `list_agent_revisions` |
| One revision, diff | `GET …/revisions/:n`, `…/diff/:to` | | |
| Restore | `POST …/revisions/:n/restore` | `restore --base` | `restore_agent_revision` |
| Sessions of one agent | `GET …/:id/sessions` | `sessions` | `list_agent_sessions` |
| Sessions of all agents | `GET …/sessions` | | |
| One session | `GET …/sessions/:sid` | `session` | `get_agent_session` |
| Chat | `POST …/chat` (JSON or NDJSON) | `chat` (streams) | `agent_chat` (waits for the whole turn) |
| Stop a turn | `POST …/chat/stop` | | `stop_agent_session` |
| Pending approvals | `GET /api/agents/approvals` | | |
| Approve, deny | `POST …/approval/approve`, `…/deny` | `approve`, `deny` | `approve_agent_action`, `deny_agent_action` |
| OTLP export, channel status, delivery resend, tool registry | REST only | | |

Differences worth knowing:

- **Who it is recorded as.** REST (and so the CLI) saves revisions as source `console`; MCP saves them as source `api` with author `mcp`. Chat turns are tagged `console` or `mcp` the same way.
- **Errors.** REST answers `{ code, message?, issues? }` with an HTTP status. MCP returns a tool result with `isError: true` and the same object as its text. The CLI prints the message (and issues) and exits `1`; with `--json` it prints the object.
- **Session scoping.** Every session call takes the agent id and refuses a session of another agent as `agent.session_not_found`, on all three surfaces.
- **No MCP/CLI create-from-prose.** The agent author chat is a console feature (`/api/agent-author/chat`); scripts send a full definition to `create_agent` or `POST /api/agents`.
- **Approvals through MCP.** `approve_agent_action` and `deny_agent_action` are operator actions. They sit in the `gates.decide` group, which cannot be granted to an agent, so one agent can never decide another's approval. An agent also cannot touch approvals on its own sessions.

See [MCP — Agent tools](mcp.md#agent-tools) for the tool inputs and outputs and [CLI reference — `sf agents`](cli-reference.md#sf-agents) for flags and exit codes.
