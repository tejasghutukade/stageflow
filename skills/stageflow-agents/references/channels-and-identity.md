# Channels and identity

How people reach an agent outside the console: a connection, `allow_from`, webhooks, public web chat, and protected chat. The YAML fields are in [agent-definition.md](agent-definition.md).

## Contents

- [Web chat on a new agent](#web-chat-on-a-new-agent)
- [Connections](#connections)
- [Providers](#providers)
- [allow_from](#allow_from)
- [Webhooks and listeners](#webhooks-and-listeners)
- [Replies](#replies)
- [Public web chat](#public-web-chat)
- [Protected chat and identity](#protected-chat-and-identity)

## Web chat on a new agent

A new agent created through MCP `create_agent`, REST `POST /api/agents`, or the console, with `web_chat` left out, is saved as `{ enabled: true }` and given a public link. The link is `/chat/<slug>`.

Public chat is refused for any agent that has tools. The page answers `identity.setup_required` (HTTP 503, "This chat requires administrator setup"). The same refusal covers `project_context`, memories, skills, the browser, Stageflow tools, a non-`pi` backend, and any MCP grant other than exactly `orders: [status]`. Sub-agents are refused on a public agent. Validation does not warn about this. `sf agents validate` can return no issues for a public agent that will not chat.

Write `web_chat: { enabled: false }` unless the agent is a tool-less public helper (see `assets/examples/public_faq.agent.yaml`). For signed-in customers, set `access: authenticated` and finish [identity](#protected-chat-and-identity) before anyone uses the link.

A hand-written file does not get this default: omitted `web_chat` stays off, and `enabled: true` without a slug warns `agent.web_chat_slug_missing` and has no link. The Host mints the slug on a save through MCP, REST, or the console. `slug: ""` on that save rotates the link. Do not invent a slug. The link is the credential.

The page is live only while the agent is enabled and `web_chat.enabled` is true.

## Connections

One inbound `channel` per agent, and one agent per connection. Two connections that reach the same inbox or Photon project count as one: `agent.channel_in_use`. An unknown id warns `agent.connection_unknown`. A disabled connection is skipped.

A connection is host-level (`$STAGEFLOW_HOME/connections.yaml`, a project `connections.yaml` next to `stageflow.yaml` wins, `STAGEFLOW_CONNECTIONS_FILE` overrides both). It is separate from email accounts (`email.yaml`, IMAP/SMTP) and from MCP servers. IMAP/SMTP cannot be an agent channel. WhatsApp is send-only and cannot be an agent channel.

There is no `sf` command for connections. Create them in the console (Connections, `#/connections`) or with MCP / REST. Secret values travel in on create and are never returned. Never put a secret in YAML, a file, a log, or chat. Prefer the console so the user types the secret. A hand-written `connections.yaml` may use `env:NAME` only (the user exports `NAME`, or `NAME_FILE`); inline values are rejected, and a hand edit needs a Host restart. Console, MCP, and REST edits apply live and store the value as `store:`.

MCP (secret values are tool arguments; do not echo them): `list_connections`, `create_connection`, `update_connection`, `test_connection`, `validate_connection_target`, `remove_connection`. `test_connection` makes a live provider call. Confirm first. Checking a connection already saved, by id, is REST only: `POST /api/connections/<id>/check`. MCP cannot do that.

REST writes need `Origin: http://127.0.0.1:${STAGEFLOW_SERVICE_PORT:-3847}` (the same host). Bearer rules are in [control-surface.md](control-surface.md#http). Bodies are at most 64 KiB. Errors are codes, never the request body.

| Action | REST |
|---|---|
| List | `GET /api/connections` |
| Field guide | `GET /api/connections/meta` |
| Create | `POST /api/connections` |
| Test values without saving | `POST /api/connections/test` |
| Check a saved one | `POST /api/connections/<id>/check` |
| Replace a key, config, or enabled | `PATCH /api/connections/<id>` |
| Remove | `DELETE /api/connections/<id>` |

Create body: `{ "provider", "id"?, "displayName"?, "config"?, "secrets"?, "credential"? }`. `secrets` is field name to value. `credential` is an existing id, or `{ "id"?, "secrets" }` for iMessage. Provider ids: `agentmail`, `slack`, `telegram`, `imessage`, `whatsapp`.

After the connection exists, set:

```yaml
channel:
  connection_id: <id from list_connections>
  allow_from:
    - <one specific sender>
web_chat:
  enabled: false
```

## Providers

| Provider | What the user needs | `allow_from` entry | How mail or messages arrive |
|---|---|---|---|
| AgentMail `agentmail` | An existing inbox. `config.inbox`, `config.region` `us` or `eu` (default `us`). Secret `apiKey` with inbox read and message send. Optional `inboundSecret` | Email `jane@acme.com`, or a domain `@acme.com` | The Host holds a WebSocket per inbox. No public URL. Optional webhook if `inboundSecret` is set |
| Slack `slack` | Secret `secrets.botToken` (bot token with `chat:write`). Optional `config.teamId` (`T` plus capitals or digits). Optional secret `inboundSecret` is the app's signing secret, required to receive. Read `GET /api/connections/meta` before inventing keys | Slack user id: `U` or `W`, then 7 or more capitals or digits (`U02ABC1234`). Or `*` | Webhook only |
| Telegram `telegram` | BotFather token in `botToken`. Optional `config.botUsername`. `inboundSecret` is the `secret_token` passed to `setWebhook`. The person must have opened the bot | `@username`, 5 to 32 characters, a letter then letters, digits, or underscore, no dot. A user with no username can only match `*` | Webhook only |
| iMessage `imessage` | Photon project id and secret as a shared credential (`projectId`, `projectSecret`). Optional package `@spectrum-ts/imessage`; without it the check fails `CHANNEL_PROVIDER_UNSUPPORTED` | E.164 `+14155550123` | The Host holds a Photon stream. No public URL. Group chats are ignored. One session per sender |

WhatsApp (`whatsapp`) can send from a stage. It has no inbound path for an agent.

## allow_from

Empty `allow_from` lets nobody in (warning `agent.channel_nobody_allowed`). `*` lets anyone who can reach the connection in (warning `agent.channel_open_to_anyone`). Use specific entries for anything outsiders can message. Duplicates are an error.

A sender that does not match is dropped with HTTP 200 `{ "ignored": true }`. Nothing tells the sender they were refused. Mail loops are dropped the same way: the agent's own inbox, `Auto-Submitted` other than `no`, bulk or list precedence, and senders such as mailer-daemon, postmaster, and no-reply. One sender is limited to 20 messages a minute; the rest are ignored.

`allow_from` is not an approval list. Approvals are decided in the console, never from the channel.

## Webhooks and listeners

Webhook URL, for Slack, Telegram, and optional AgentMail: `POST /api/agent-inbound/<connectionId>`.

The route is exempt from the Stageflow control token. It accepts the call only when the connection has `inboundSecret` and the signature matches. Otherwise `404` (unknown connection or no secret) or `401`. A body over 1 MiB is `413`. A bad body is `400`.

| Provider | Header | Check |
|---|---|---|
| Slack | `x-slack-signature` and `x-slack-request-timestamp` | HMAC, timestamp within 5 minutes. A `url_verification` payload returns the `challenge` |
| Telegram | `x-telegram-bot-api-secret-token` | Equals `inboundSecret` |
| AgentMail | `x-agentmail-signature` | HMAC-SHA256 of the raw body |

Slack and Telegram need a public HTTPS URL, and that host listed in `STAGEFLOW_ALLOWED_HOSTS`. AgentMail and iMessage do not: the Host connects out. Status `200` bodies include `{ "ok": true }`, `{ "ignored": true }`, `{ "duplicate": true }`, and Slack's challenge.

`GET /api/agents/<id>/channel` reports the listener (absent for webhook providers and for a disabled agent) and the last undelivered reply. `GET /api/agents/<id>/channel/contact` is the address or number people use, when the provider can say.

## Replies

The Host sends the reply, not the agent. One reply per turn, back to the sender, tracked as a delivery. The text is capped at 3,500 characters.

A send that may have reached the provider is never resent automatically (`agent.reply_undelivered`). A definite failure retries after 5 seconds, 30 seconds, then 2 minutes. After that, a person resends or marks it delivered:

```bash
# REST only. <action> is resend or delivered. Agent routes do not need Origin.
# export STAGEFLOW_CONTROL_TOKEN="$(cat ~/.stageflow/control-token)"
curl -s -X POST "http://127.0.0.1:${STAGEFLOW_SERVICE_PORT:-3847}/api/agents/<id>/sessions/<sessionId>/turns/<turnId>/delivery/<action>" \
  -H "Authorization: Bearer $STAGEFLOW_CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

There is no CLI and no MCP tool for resend or mark-delivered. The console session page has the same buttons.

For an iMessage agent set `limits.always_on: true`. A turn the Host restart cut off is resumed for always-on agents; other channels are not.

## Public web chat

Tool-less agent, `web_chat.enabled: true`, `access` left as `public`. No `tools`, no `project_context`, no `memories`, no `tools.skills`, no `sub_agents`, `model.backend` left as `pi`. Set `limits.cost_usd`, `max_turns`, and `session_minutes`. Set `greeting` (shown on the page, up to 500 characters).

`rate_limit_per_minute` defaults to 10 (1–120): that many messages per visitor per minute. New conversations get twice that. Each IP address gets three times the visitor budget. `max_message_chars` defaults to 4000 (1–20000).

The visitor API is `/api/public/chat/<slug>/…`. It does not use the control token. A browser on another origin needs that origin in `STAGEFLOW_PUBLIC_CHAT_ORIGINS`. Anonymous callers send `X-Visitor-Id` (16 to 64 letters, digits, `_`, or `-`). Errors: `web_chat.unavailable` (404), `web_chat.invalid` (400), `web_chat.message_too_long` (413), `web_chat.rate_limited` (429), `web_chat.busy` (409), `web_chat.limit_reached` (409), `web_chat.failed` (500), `identity.setup_required` (503).

Rotate a leaked link by saving `web_chat.slug: ""` through MCP, REST, or the console. Then re-read the file: the Host rewrites it in canonical form and fills the new slug.

## Protected chat and identity

Experimental. `web_chat.access: authenticated`. The only tool the publication check allows is `tools.mcp.orders: [status]` (grant id `orders.status`), plus sub-agents that are themselves consumer-safe. Filesystem, shell, browser, skills, memory, other MCP servers, and Stageflow tools are refused at chat time with `identity.setup_required`. A channel binding is not part of the publication check. Identity has to be turned on or the same code is returned.

There is no CLI and no MCP tool for identity. Console: Identity, `#/identity`. REST needs the control token when the Host has one. Writes under `/api/identity/setup` also need `Origin`. Connection and assignment routes do not. `sf backup` does not include `identity/`.

Turn it on, in order:

1. `GET /api/identity/setup` to see `{ mode, enabled }`.
2. `POST /api/identity/setup/enable`.
3. A connection, one of:
   - Handoff: `POST /api/identity/connections/handoff`. `algorithms` is required here, not only on OIDC. A body that is only a JWKS is `identity.setup_required`. 201 is the connection summary.

     ```json
     {
       "id": "<connection id>",
       "issuer": "<issuer>",
       "agentId": "<agent id>",
       "audience": "<audience>",
       "algorithms": ["RS256"],
       "publicJwks": { "keys": [{ "kty": "RSA", "kid": "<kid>", "n": "<n>", "e": "AQAB" }] }
     }
     ```

     `algorithms` is a non-empty array of `RS256`, `ES256`, and/or `EdDSA`. `publicJwks` must be `{ "keys": [ ... ] }` with at least one public key. A key that carries `d` or `k` is rejected.

     The token `typ` must be `stageflow-agent-handoff+jwt`. It must carry `sub`, `jti`, `iat`, `exp`, `workspace`, and `agent`, and `exp - iat` must be at most 300 seconds. `workspace` must equal `workspaceId` from `GET /api/identity/connections`. `agent` must equal the connection's `agentId`, which is also the chat agent. Anything else is `identity.verification_required`. The client posts the token to `POST /api/public/chat/<slug>/admission` with `{ "connectionId", "assertion" }` and receives `{ "token", "tokenType": "Bearer", "expiresIn" }`.
   - OIDC: `POST /api/identity/connections/oidc`. All seven fields are required. Keys are camelCase. Missing `id` or `agentId` is `identity.setup_required`.

     ```json
     {
       "id": "<connection id>",
       "issuer": "<issuer>",
       "clientId": "<client id>",
       "clientSecret": "<client secret>",
       "agentId": "<agent id>",
       "redirectUri": "<redirect uri>",
       "algorithms": ["RS256"]
     }
     ```

     `algorithms` is a non-empty array of `RS256`, `ES256`, and/or `EdDSA`. `clientSecret` is 16–512 characters and must not contain a line break. `clientId` is 1–128 characters from `A–Z`, `a–z`, `0–9`, `.`, `_`, or `-`. `issuer` is an https origin with no path. `redirectUri` is https and its path ends with `/oidc/callback`. The client secret goes in this body once and is never returned. Do not put it in chat. Then `…/<id>/oidc/prepare`, `…/oidc/tested`, `…/oidc/activate`. Start sign-in with `POST /api/public/chat/<slug>/oidc/start` and body `{ "connectionId": "<id>" }` only. Any other key is `web_chat.invalid`. The callback is `GET …/oidc/callback`.
   - Service identity, for a schedule on a protected agent: `POST /api/identity/connections/service` with `{ id, accountId, scope, agents, resources? }`. A scheduled protected turn looks for exactly one active service principal whose agents include this agent. Zero or several is `identity.not_available`.
4. Assign people: `POST /api/identity/assignments`. `agents` is required (one or more agent ids). A missing or empty array is `identity.setup_required`.

   ```json
   {
     "connectionId": "<connection id>",
     "subject": "<stable user id, not an email>",
     "accountId": "<account id>",
     "scope": "own",
     "agents": ["<agent id>"]
   }
   ```

   Scopes are `own`, `assigned`, `selected`, `workspace`. When `scope` is `selected`, also send `resources` (one or more ids). Do not send actions. The server sets them to `order:read` and `conversation:use`. Optional `expectedRevision` (integer ≥ 0) guards a concurrent edit (`identity.conflict`). Optional `mappingSource` defaults to `operator`.
5. Optional Order API: `POST /api/identity/setup/orders` with `endpoint` (https, http only for loopback), `audience`, and optional `credential`. The customer's API implements `POST /stageflow/order-ownership` and `POST /stageflow/order-status`. `POST …/orders/signing-key` rotates the signing key and returns the public key. `POST …/orders/test` with `{ orderId }` checks it. `POST …/orders/clear` removes it.

Other routes: `POST /api/identity/setup/disable`, `POST …/setup/engine` (`{ "kind": "scope" }` or `{ "kind": "cerbos", "endpoint" }`), `POST …/engine/test`, `GET /api/identity/connections`, `POST …/connections/<id>/disable`, `POST …/connections/<id>/oidc/rotate`, `POST …/connections/<id>/revocation-source` with `{ "url": "…" }` or `{ "url": null }`, `GET /api/identity/assignments`, `POST …/assignments/<id>/revoke`, `POST /api/identity/preview`, `GET /api/identity/audit?limit=`.

Replies on a protected chat are held until the current authorization still allows them. Changing the agent revision invalidates protected conversations.

Public chat statuses: `identity.verification_required` 401, `identity.not_available` 404, `identity.setup_required` 503 ("This chat requires administrator setup.").

Identity REST statuses: `identity.verification_required` and `identity.conflict` are 409, `identity.not_available` is 404, and `identity.setup_required` is 400. A Host with no identity runtime returns 503 `identity.setup_required` before those handlers. `identity.managed_externally` is 409 from a POST under `/api/identity/setup` when this Host does not own setup. Do not treat every `identity.setup_required` as 503.
