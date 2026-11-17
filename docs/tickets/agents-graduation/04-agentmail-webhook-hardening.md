# 04: AgentMail webhook hardening

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** —

## Why

AgentMail has two inbound paths. The WebSocket listener (`agentmailListener.ts`) subscribes to `message.received` only and drops the agent's own mail, bounces, auto-replies and no-reply senders. The webhook path (`parseAgentMailInbound` in `agentmail.ts`) has none of those checks, does not look at the event type, and reads a flat payload (`id`, `from`, `text`) that has not been checked against AgentMail's real webhook body or signature scheme.

## Read first

- `src/agents/communications/agentmail.ts`, `agentmailListener.ts`, `inbound.ts`.
- AgentMail's current webhook documentation: event envelope, signature header and algorithm. Verify, do not assume.
- `tests/` for both paths.

## What to build

1. Check the webhook body and signature against the provider's documentation and fix the parser and verifier to match. Record the doc version checked in a code comment.
2. Accept only `message.received`; answer `200 { ignored: true }` for anything else.
3. Move the loop and system-sender filter out of the listener into one shared function used by both paths.
4. A fixture captured from the documented example body, used by the parser test.

## Acceptance

- [ ] The documented example webhook parses to the same `AgentInboundMessage` the listener produces for the same mail.
- [ ] A `message.sent` or bounce event is ignored.
- [ ] Mail from the agent's own inbox, `Auto-Submitted` mail and no-reply senders are ignored on the webhook path (tests shared with the listener).
- [ ] A bad signature is still `401` with no detail.

## Decisions made (2026-11-16, do not revisit)

- If step 1 shows the webhook cannot give the same filtering as the WebSocket (`message.received` only: no spam, blocked or unauthenticated mail), remove webhook mode for agents: `POST /api/agent-inbound/<id>` answers `404` for an AgentMail connection, and the docs and connection form drop the AgentMail `inboundSecret`. Steps 2 to 4 then apply to the listener only.
- If it can, keep both paths behind the one shared filter.

## Outcome

Done in 0.66.0 by removal. Step 1 (docs.agentmail.to/webhooks-overview and /webhook-verification, read 2026-11-16) found: webhooks are delivered through Svix (`svix-id`, `svix-timestamp`, `svix-signature`, a `whsec_` secret), the body is `{ event_type, event_id, message: { from_, inbox_id, thread_id, message_id, labels, text, ... } }`, and the message carries no mail headers. The old route checked `x-agentmail-signature` and a flat body, so it never worked against the real service, and without headers an automatic reply cannot be told apart. Spam, blocked and unauthenticated mail are separate event types, as on the WebSocket. Per the decision, webhook mode was removed for agents.
