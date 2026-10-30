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

Behind a reverse proxy every visitor shares the proxy's address, so the per-IP limit then applies to everyone together: raise `rate_limit_per_minute` or put the limit at the proxy.

## Behind a reverse proxy

- Forward `GET /chat/<slug>`, its assets, and `/api/public/chat/<slug>/…` (streamed NDJSON, so disable response buffering and use a long read timeout). Do not forward the rest of `/api`.
- Add the public hostname to `STAGEFLOW_ALLOWED_HOSTS`.
- The page works same-origin. To host the page elsewhere, list its origin in `STAGEFLOW_PUBLIC_CHAT_ORIGINS` (comma-separated) so the browser may call the API.
- The console shows links using the address you opened it from. There is no separate "public base URL" setting; open the console through the public address (or copy the path `/chat/<slug>`) when sharing.

## Safety

- Anonymous public agents must be tool-less, with project context, shared memory, browser, skills and sub-agents off. Unsafe publications return `identity.setup_required`; old unscoped histories are not adopted.
- Protected tools require [consumer identity](consumer-identity.md), explicit Host setup and an authenticated embedded client. Only the constrained order binding is supported in this experimental increment. Its ask-first tools still wait for an operator and reauthorize after the wait.

## Troubleshooting

| You see | Cause and fix |
|---------|---------------|
| "This chat isn't available" (`web_chat.unavailable`, 404) | Wrong or rotated link, agent disabled, or web chat off |
| `web_chat.rate_limited` (429) | Over the visitor or address limit; wait `retryAfterSec` |
| `web_chat.message_too_long` (413) | Over `max_message_chars` |
| `web_chat.busy` (409) | A turn is already running on that conversation |
| `web_chat.limit_reached` (409) | The agent hit `max_turns`, `session_minutes` or `cost_usd`; start a new conversation |
| Browser CORS error from another site | Origin not in `STAGEFLOW_PUBLIC_CHAT_ORIGINS` |
| Reply appears all at once | The agent has `guardrails.block_patterns`, so streamed text is held until the check passes; or a proxy is buffering |
