# Guide: set up web chat

Web chat gives an agent a shareable page at `/chat/<slug>` on the Host: a plain chat window, new conversations, earlier conversations, nothing else. Reference: [Agents — Web chat](agents.md#web-chat-public-page).

## Turn it on

Agents created from the console, API, CLI or MCP start with it on and a generated link. For a hand-written file:

```yaml
web_chat:
  enabled: true
  rate_limit_per_minute: 10
  max_message_chars: 4000
```

A save that turns it on without a `slug` gets one (16–32 lowercase letters or digits). The page is live only while the agent is **enabled** and `web_chat.enabled` is true. The agents list shows the link with open and copy buttons.

## The link is the credential

Anyone with the link can talk to the agent, and spend its cost limits. To revoke it, **rotate**: save with `slug: ""` (the editor has a button) and a new link is made in a new revision; the old one answers "This chat isn't available".

## Limits

| Limit | Value |
|-------|-------|
| Messages per visitor per minute | `rate_limit_per_minute` (1–120, default 10); new conversations get twice that |
| Messages per IP address per minute | three times the visitor limit, counted on the connecting socket |
| Message length | `max_message_chars` (1–20000, default 4000) |
| Conversations per visitor | 50 |

The agent's own `limits` apply to each conversation too: `max_turns` counts messages, `session_minutes` closes the conversation after that many minutes with no messages (waiting on an approval does not count as idle), and `cost_usd` counts what it spent. The default `session_minutes` is 10, which suits a live chat; raise it (up to 1,440) when people may come back later after a break. When a limit is hit, the page says which one ended it and offers **Start a new chat**.

The open conversation is kept in the address as `?c=<id>`, so a refresh reopens it. The id only opens for the browser that started the conversation; anyone else, or an id that is gone, gets a new chat.

Behind a reverse proxy every visitor shares the proxy's address, so the per-IP limit then applies to everyone together: raise `rate_limit_per_minute` or put the limit at the proxy.

## Behind a reverse proxy

- Forward only the public routes: `GET /chat/<slug>` and its assets, `/api/public/chat/<slug>/…` including admission, the OIDC callback and step-up links (streamed NDJSON on message routes, so disable response buffering and use a long read timeout) and, for Slack and Telegram agents, `POST /api/agent-inbound/<connection id>`. Do not forward the rest of `/api`, `/mcp` or the console: those are for operators and stay on the private network or loopback.
- Pass the browser's original `Host` through to Stageflow unchanged. The Host allow-list still applies on public chat; a rewritten or internal hostname is refused.
- Add the public hostname to `STAGEFLOW_ALLOWED_HOSTS`.
- The page works same-origin. To host the page elsewhere, list its origin in `STAGEFLOW_PUBLIC_CHAT_ORIGINS` (comma-separated) so the browser may call the API.
- The console builds the shareable link from `STAGEFLOW_PUBLIC_CHAT_URL` when set, otherwise from `STAGEFLOW_PUBLIC_URL`, otherwise from the address you opened it from. Set `STAGEFLOW_PUBLIC_CHAT_URL` when public chat is served from its own hostname, so the copied link and the identity sign-in redirect point at that hostname.
- A container on a cloud host follows the same rules. See [Docker — Publishing customer chat](docker.md#publishing-customer-chat) for the hostname settings, the private console path, the shared per-address limit, and response buffering.

## Safety

- Anonymous public agents must be tool-less, with project context, shared memory, browser, skills and sub-agents off; cards kept in the conversation are allowed. Unsafe publications return `identity.setup_required` (see [Why a link does not open](#why-a-link-does-not-open)); old unscoped histories are not adopted.
- Protected tools require [consumer identity](consumer-identity.md) (turn it on from **Identity** in the console), an `authenticated` agent and an embedded client that signs people in. The built-in chat page has no sign-in button. The step-by-step is [Protect an agent's chat with customer sign-in](guides-agents-protected-chat.md). Supported customer resource tools are `orders.status`, `orders.list`, and `account.profile`. Ask-first tools still wait for an operator and reauthorize after the wait.

## Troubleshooting

| You see | Cause and fix |
|---------|---------------|
| "This chat isn't available" (`web_chat.unavailable`, 404) | Wrong or rotated link, agent disabled, or web chat off |
| `web_chat.rate_limited` (429) | Over the visitor or address limit; wait `retryAfterSec` |
| `web_chat.message_too_long` (413) | Over `max_message_chars` |
| `web_chat.busy` (409) | A turn is already running on that conversation |
| `web_chat.limit_reached` (409, or an `error` frame) | The conversation hit `max_turns`, `session_minutes` or `cost_usd`; `limit` says which (`turns`, `minutes`, `cost`). Start a new conversation |
| Browser CORS error from another site | Origin not in `STAGEFLOW_PUBLIC_CHAT_ORIGINS` |
| Reply appears all at once | The agent has `guardrails.block_patterns`, so streamed text is held until the check passes; or a proxy is buffering |

## Cards in public chat

An agent with `ui: { present: true }` draws cards (layouts, tables, numbers, markdown) in its replies, and visitors see them on the public page. The cards are kept in the conversation: the program travels in the message, nothing is saved to the Artifacts page, and the card is deleted with the conversation. Ask the agent to change a card and it draws an updated one. See [Agent definition: ui](agent-definition.md#ui).

## Why a link does not open

The public page answers anonymous visitors, so it only opens for an agent that can do nothing but talk and draw cards kept in the conversation. Tools, skills, memories, project context, sub-agents or `ui.persistence: artifacts` keep it closed. The visitor sees "This chat isn't open to the public yet"; the agent's page in the console and the **Web chat** section of its form say exactly what to remove. To keep those abilities and still let people chat, protect the chat with sign-in ([Protect an agent's chat with customer sign-in](guides-agents-protected-chat.md)).
