# Agents

Project-owned agents live under `agents/<id>.agent.yaml`. An agent is a configured assistant: instructions, a model, the tools it may use, who may talk to it, and how it is recorded. They are separate from the stage `agent:` field (Pi vs Claude backend selection).

| Page | What it covers |
|------|----------------|
| This page | The overview, ways to reach an agent, channels, schedules, web chat |
| [Agent definition](agent-definition.md) | Every YAML field, defaults, ranges, validation codes, revisions and file sync |
| [Agent runtime](agent-runtime.md) | How a turn runs: tools, the gate, asking first, limits, sub-agents, restarts, environment variables |
| [Agent observability](agent-observability.md) | Traces, capture modes, the run page, groundedness evals, OTLP export |

## Console, API, CLI, MCP

- Console: **Agents** (`#/agents`) — directory, create (with an author chat), edit (diff review, version history), detail, session and run inspector.
  - The directory shows how each agent is reached: the web chat link (open or copy), the channel provider with its connection, or the schedule; otherwise "Console only". It also shows all-time cost per agent and in total, a clear Enabled / Disabled / Needs setup status, and the first tools and approvals with a **View all** dialog for the rest. Search matches reach too.
  - **Disable agent** (on the agent page) asks first. The agent stops accepting new sessions, and its web chat page and channel stop answering. A turn that is already running finishes; nothing new starts, and an approval that is waiting can only be denied, not approved. Nothing is deleted, and you can enable the agent again at any time. Stop a running turn from its session page if it should end now.
  - The run page has five tabs: Steps, Waterfall, Messages, Logs and Configuration ([details](agent-observability.md#where-you-see-it)).
  - Approvals waiting on a person appear in the **Inbox**; with desktop notifications on (Settings → Notifications) the console also raises one when an agent asks.
- REST: `/api/agents` — definitions, validate, revisions/diff/restore, sessions, approvals, chat (NDJSON), OTLP export.
- CLI: `sf agents` — [CLI reference](cli-reference.md#sf-agents).
- MCP: [Agent tools](mcp.md#agent-tools). Deciding an approval (`approve_agent_action`, `deny_agent_action`) is for people only and cannot be granted to an agent.

## Storage

Definitions stay in git-tracked YAML; the Host syncs them by content hash (a read never rewrites a file). Revisions, sessions, messages, turns, spans, approvals and schedules live in the run store SQLite database under `$STAGEFLOW_HOME` (`agent_*` tables). A turn left running when the Host stops is marked failed on restart ([Restarts](agent-runtime.md#restarts)). Files and sync rules: [Agent definition](agent-definition.md#files-revisions-and-sync).

## Definition

Every field, default and validation code is in [Agent definition](agent-definition.md). Every save is a revision with its source; a stale `baseRevision` is rejected as `agent.conflict`. The schema summary is also in [YAML catalog — Agents](yaml-catalog.md#agents-agent-yaml).

## Runtime

Each session keeps one Pi model session on the revision it started with, and every tool call is checked against the grants before it runs. [Agent runtime](agent-runtime.md) covers the tools an agent can have (builtin, MCP servers from the project `.mcp.json` or the console, skills, sub-agents, Stageflow's own tools), [asking first](agent-runtime.md#asking-first), the [path guard and `bash`](agent-runtime.md#the-path-guard-and-bash), [guardrails](agent-runtime.md#guardrails-and-streaming), [limits](agent-runtime.md#limits), [restarts](agent-runtime.md#restarts) and the environment variables.

## Traces and evals

Every turn records a span tree, and `evals.groundedness` can score replies. See [Agent observability](agent-observability.md).

You can also **evaluate an agent**: play scripted or simulated users against it, grade the conversations and tool calls, and compare a change to its instructions, model or tools before you save it. See [Evals for agents](evals.md#evals-for-agents). Each eval conversation runs in a hidden **eval session** with tools read-only by default; eval sessions do not appear in the lists below, the Inbox or counts ([Agent observability: eval sessions](agent-observability.md#eval-sessions)). An agent's page shows its evals and an **Evaluate** button. The **Agent sessions** page in the sidebar lists sessions across all agents (`GET /api/agents/sessions`, same filters as the per-agent list plus `agent`); an agent's own page lists only its sessions.

## Channels (inbound)

An agent answers on **one** connection, and a connection has one agent:

```yaml
channel:
  connection_id: support-inbox
  allow_from: [jane@example.com, "@acme.com", "+14155550123"]   # "*" lets anyone in; empty lets nobody in
limits:
  always_on: true     # one conversation that never ends by time or turns, and carries on after a failure
```

`allow_from` decides who may message the agent; a message from anyone else is ignored. What an entry looks like depends on what the provider tells us about the sender:

| Provider | Entries that can match | Sender seen as |
|----------|------------------------|----------------|
| AgentMail | Email address, `@domain` | The `From` address |
| iMessage | `+` phone number (E.164) | The sender's number |
| Slack | Slack user id such as `U02ABC1234`, or `*` | The user id of the message author |
| Telegram | `@username`, or `*` | The sender's username (no `@`). A sender with no username can only get in through `*`. |

`always_on` skips `session_minutes` and `max_turns`; `cost_usd` then counts per day. The older `channels: [{ connection_id }]` list still loads as the one `channel` (more than one is an error). A saved agent shows `agent.channel_nobody_allowed` or `agent.channel_open_to_anyone` when the list is empty or `*`. See [Agent definition](agent-definition.md#channel) for the grammar.

How messages arrive depends on the provider:

| Provider | How the Host gets messages | Details |
|----------|----------------------------|---------|
| AgentMail | The Host holds a WebSocket open to the inbox; a webhook also works | [below](#agentmail-and-imessage-the-host-listens) |
| iMessage (Photon) | The Host holds a stream open to the project | [below](#agentmail-and-imessage-the-host-listens) |
| Slack | Webhook | `inboundSecret` on the connection |
| Telegram | Webhook | `inboundSecret` on the connection |

Slack, Telegram and AgentMail connections accept an optional `inboundSecret` and then receive webhooks at `POST /api/agent-inbound/<connection id>`:

| Provider | `inboundSecret` is | Verified by |
|----------|--------------------|-------------|
| Slack | App signing secret | `x-slack-signature` + timestamp |
| Telegram | `secret_token` from `setWebhook` | `x-telegram-bot-api-secret-token` |
| AgentMail | Webhook secret | `x-agentmail-signature` (HMAC-SHA256 of the body) |

The route needs no console token; the signature is the credential. A message starts or continues the session for its thread, the agent's reply goes back to the sender on the same connection once per turn, and a redelivered event is ignored. A webhook reply goes into the conversation: Slack in the channel, Telegram to the chat, AgentMail as a reply to the message. Messages for a connection no enabled agent is bound to are dropped.

## Schedules

`schedule: { cron, timezone?, message? }`. While the Host runs, the schedule source ticks (default 30s, `STAGEFLOW_AGENT_SCHEDULE_TICK_INTERVAL_MS`; `0` turns schedules off) and starts a turn when due, with `message` (default "Scheduled check-in.") as the user message. The first time a tick sees a scheduled agent it only stores the next run and does not fire. A Host that was down past a due time fires once, not once per missed occurrence. A schedule edited to fire sooner does not wait out the old next run.

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

## AgentMail and iMessage: the Host listens

For AgentMail and iMessage the Host opens the stream itself, so no public URL is needed (webhooks stay for Slack and Telegram):

| Provider | Stream | Conversation | Reply |
|----------|--------|--------------|-------|
| AgentMail | WebSocket per inbox (`message.received` only, so spam, blocked and unauthenticated mail never reaches an agent) | One session per email thread | Replies in the thread (`messages/<id>/reply`), the new text only (no quoted history), subject kept |
| iMessage (Photon/Spectrum) | `app.messages` on the project | One session per sender (always-on recommended); group chats are ignored | A text back to the sender |

- A listener runs for each enabled agent with a channel, starts on enable, restarts when the connection changes and stops when the agent is disabled. A dropped stream reconnects with backoff (2 s up to 60 s). After a reconnect AgentMail mail from the last 15 minutes is answered too (deduped by message id). The agent page shows "Listening", "Reconnecting" or the failure. `STAGEFLOW_AGENT_CHANNEL_LISTENERS=0` turns listening off.
- Mail loops are cut off: the agent's own inbox, `Auto-Submitted`, bulk/list precedence, `mailer-daemon`, `postmaster` and no-reply senders are ignored. Each sender may send 20 messages a minute; the rest are ignored.
- **Always on:** with `limits.always_on: true` a session never ends by time or turns. If the Host restarts mid-turn, the interrupted iMessage turn is retried once on start (the message is not asked twice), and the next message continues the same conversation.
- One inbox has one agent: two connections that reach the same AgentMail inbox (or the same Photon project) count as one channel, so a second agent is refused with `agent.channel_in_use`, and the Host opens a single stream for them.
- **Which number to text (iMessage).** Numbers belong to the Photon project, not to the agent. On a Free or Pro project (shared pool) you register each person as a user in Photon, who is then assigned a number to text (it can differ per person); on a Business project (dedicated lines) everyone texts the project's line. The agent editor shows it: "Jane (+1415…) texts +1999…", "Text +1415… to reach this agent", or a warning when an allowed phone is not registered in Photon. An agent needing its own number needs its own Photon project and credential; one project cannot serve two agents.
- iMessage on a Free or Pro Photon project: only registered project users can message the line, and each must text it once first.

## Replies that do not arrive

On a channel the system, not the agent, sends the reply, and a turn only counts as succeeded once the reply has reached the person. Each reply is tracked (`agent_deliveries`):

| What happened | What the system does |
|---------------|----------------------|
| Delivered | Turn succeeded. |
| Definitely not sent and possibly transient (network, rate limit) | Retried automatically after 5 s, 30 s and 2 min. The turn shows as succeeded until the retries run out. |
| Definitely not sent and not transient (credentials rejected, recipient refused, an error on this side) | Turn fails at once as `agent.reply_undelivered`, with the reason. |
| Outcome unknown (timeout after the send left, restart mid-send) | Never resent on its own, because it could arrive twice. Turn fails as `agent.reply_undelivered`. |

The run page shows the reason with **Resend** (one attempt, no automatic retries) and **Mark as delivered** (when you can see it arrived). A resend or a confirmation puts the turn back to succeeded. The agent's channel status line shows the last reply that failed to send. API: `POST /api/agents/<id>/sessions/<session>/turns/<turn>/delivery/resend` and `.../delivery/delivered`. Retries survive a restart; sends a restart cut off become "unknown".

