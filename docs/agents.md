# Agents

Project-owned agents live under `agents/<id>.agent.yaml`. They are separate from the stage `agent:` field (Pi vs Claude backend selection).

## Console, API, CLI, MCP

- Console: **Agents** (`#/agents`) — directory, create (with an author chat), edit (diff review, version history), detail, session and run inspector.
- REST: `/api/agents` — definitions, validate, revisions/diff/restore, sessions, approvals, chat (NDJSON), OTLP export.
- CLI: `sf agents` — [CLI reference](cli-reference.md#sf-agents).
- MCP: [Agent tools](mcp.md#agent-tools).

## Storage

Definitions stay in git-tracked YAML; the Host syncs them by content hash (a read never rewrites a file). Revisions, sessions, messages, turns, spans, approvals and schedules live in the run store SQLite database under `$STAGEFLOW_HOME` (`agent_*` tables). A turn left running when the Host stops is marked failed on restart.

## Definition

Schema: [YAML catalog — Agents](yaml-catalog.md#agents-agent-yaml). Every save is a revision with its source; a stale `baseRevision` is rejected as `agent.conflict`.

## Runtime

Each session keeps one Pi model session on the revision it started with. What the definition says is enforced:

- **Tools.** `tools.builtin` groups map to Pi tools (`read` = read/grep/find/ls, `write` = write/edit, `shell` = bash). MCP servers come from the project `.mcp.json`; only the tools named under `tools.mcp.<server>` are exposed (`"*"` for all). Skills load from `tools.skills`. Every call is checked against the grants again before it runs. Agent definitions and Stageflow state can never be written by an agent.
- **Ask first.** A call to a tool in `approvals.ask_first` pauses the turn (the session shows waiting) until an approver decides, from the console, CLI, MCP or an allowed channel. Approved runs once, denied tells the agent to continue without it. If nobody answers within `timeout_minutes`, `on_timeout: skip` lets the agent continue without the action; `deny` ends the turn. Pending approvals do not survive a Host restart: those turns are marked failed.
- **Sub-agents.** `sub_agents` become tools (`agent_<id>`); the callee runs in its own session (source `agent`) and its reply returns to the caller. Nesting stops at `sub_agent_depth`.
- **Limits.** A session refuses a new turn once it has used `max_turns`, `session_minutes` or `cost_usd`. When a restarted session replays a long transcript, `long_context` either drops (`truncate`) or condenses (`summarize`) the oldest messages.
- **Cursor models.** `cursor/*` models run Cursor's own file and shell tools beside Pi's, so grants and ask-first cannot hold. Agents refuse them (`agent.backend_unavailable`) unless the Host sets `STAGEFLOW_AGENTS_ALLOW_CURSOR_NATIVE_TOOLS=1`; use another provider's model for governed agents.
- **Not yet.** The `claude` backend and `execution: sandbox` fail with a clear error (the editor warns). `tools.browser` is stored but not wired.

## Traces and evals

Every turn records a span tree: an `invoke_agent` root with `chat` (model), `execute_tool`, approval (`gate`), sub-agent and guardrail children, with tokens and cost. `observability.capture` controls content: `off`, `metadata` (default) or `full` (secrets masked). Export a session as OTLP/JSON from the session page, `GET .../sessions/:sid/otlp`, or set `observability.otlp: true` and the Host pushes each finished turn to the collector named by `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, plus `OTEL_EXPORTER_OTLP_HEADERS`). A collector outage never fails a turn.

`evals.groundedness` scores (0–1) how well a reply that used tools is supported by those tool results; the average shows on the session page.

## Channels (inbound)

Bind an agent to connections with `channels: [{ connection_id }]`. Slack, Telegram and AgentMail connections accept an optional `inboundSecret` and then receive webhooks at `POST /api/agent-inbound/<connection id>`:

| Provider | `inboundSecret` is | Verified by |
|----------|--------------------|-------------|
| Slack | App signing secret | `x-slack-signature` + timestamp |
| Telegram | `secret_token` from `setWebhook` | `x-telegram-bot-api-secret-token` |
| AgentMail | Webhook secret | `x-agentmail-signature` (HMAC-SHA256 of the body) |

The route needs no console token; the signature is the credential. A message starts or continues the session for its thread, the agent's reply goes back to the sender on the same connection once per turn, and a redelivered event is ignored. Messages for a connection no enabled agent is bound to are dropped. Email and iMessage inbound are not wired yet.

## Schedules

`schedule: { cron, timezone?, message? }`. While the Host runs, the schedule source ticks (default 30s, `STAGEFLOW_AGENT_SCHEDULE_TICK_INTERVAL_MS`) and starts a turn when due.

## Web chat (public page)

Every new agent gets a shareable chat page: `/chat/<slug>` on the Host. It is a standalone page (assistant-ui, Stageflow theme tokens only, none of the console shell) where a visitor chats, starts new conversations and switches between earlier ones. Nothing else: no settings, tool details or feedback. Console, MCP and CLI stay as internal access.

Definition block (YAML `web_chat`; absent = off for hand-written files, on for agents created through the console, API, CLI or MCP):

```yaml
web_chat:
  enabled: true
  slug: k7x9m2qp4h8d3w6n   # random, 16 chars [a-z0-9]; the link is the credential; rotate = new revision
  rate_limit_per_minute: 10  # messages per visitor per minute (1-120)
  max_message_chars: 4000    # 1-20000
```

The page is live only while the agent is enabled and `web_chat.enabled` is true. Sessions are source `web`, `sourceRef` = visitor id.

### Public API (no console token; the slug is the credential)

Base `/api/public/chat/<slug>`. A visitor id (client-generated, kept in the browser) goes in the `x-visitor-id` header (16-64 chars `[A-Za-z0-9_-]`) on every call but the first. Visitors only ever see their own threads. Unknown slug, disabled agent or disabled web chat all answer `404 {"code":"web_chat.unavailable"}`.

| Call | Result |
|------|--------|
| `GET /` | `{ "agent": { "name", "greeting" } }` |
| `GET /threads` | `{ "threads": [{ "id", "title", "updatedAt" }] }`, newest first |
| `POST /threads` | `201 { "thread": { "id", "title", "updatedAt" } }` (empty conversation) |
| `GET /threads/<id>` | `{ "thread", "status": "open"\|"running"\|"waiting", "messages": [{ "id", "role": "user"\|"assistant", "text", "createdAt" }] }` |
| `POST /threads/<id>/messages` body `{ "text" }` | NDJSON stream, one JSON object per line: `{"type":"delta","text"}` (text increment), `{"type":"waiting"}` (an operator must approve a tool; stream stays open), `{"type":"done","message":{ "id","role":"assistant","text","createdAt" }}`, or `{"type":"error","code","message","retryAfterSec"?}` |

Error codes (always friendly `message`, never internals): `web_chat.rate_limited` (429, `retryAfterSec`), `web_chat.message_too_long` (413), `web_chat.busy` (409, a turn is already running for this thread), `web_chat.limit_reached` (409, agent max_turns / session_minutes / cost cap), `web_chat.unavailable` (404), `web_chat.failed` (500). Before streaming starts these are plain JSON with the HTTP status; once streaming they arrive as an `error` frame.

CORS: same-origin by default. `STAGEFLOW_PUBLIC_CHAT_ORIGINS` (comma-separated) lets a page hosted elsewhere call the API, so the chat page can be deployed separately later; it only needs its API base URL. Exposing the Host to the internet (restricting the console) is a later follow-up.
