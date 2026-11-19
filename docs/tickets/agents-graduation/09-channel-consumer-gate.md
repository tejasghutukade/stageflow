# 09: Run customer channel sessions under the consumer gate

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** 08

## Why

In `runTurn` (`src/agents/sessions.ts`) only `web_consumer`, `web`, `web_public` and service schedules are `external`. A channel session skips `checkConsumer`, `assertDelivery`, the consumer tool list and output buffering, and an `authenticated` agent rejects channel sources outright. This ticket makes a channel session with a channel identity run exactly like a protected web conversation.

## Read first

- `src/agents/sessions.ts` (`send`, `runTurn`, `delegateConsumer`), `src/agents/consumerSafety.ts`, `src/agents/runtime/piRuntime.ts` (`consumerTools`, `consumerSafeSubAgents`).
- `src/agents/communications/inbound.ts`, `delivery.ts`.
- `docs/consumer-identity.md` ("Implemented boundary").

## What to build

1. Agent definition: a way to say the channel requires identity. Proposal: `channel.access: allow_list | authenticated`, mirroring `web_chat.access`. `authenticated` requires `isConsumerSafeAgent` and a `channel` identity connection, checked on save like `assertConsumerWebChatPublication`.
2. `receive` and `converse` pass the consumer session id from 08 into `chat.send`; the session is treated as `consumer` in `runTurn`.
3. Delivery: re-check authorization immediately before `ReplyDelivery.deliver`, and before every automatic retry and manual **Resend**. A denied re-check drops the reply and fails the turn with a safe code.
4. Rollover: a rolled-over session gets a fresh binding; history from the old session is not carried unless the same principal still passes the disclosed-resource recheck.
5. Always-on resume after restart re-validates before retrying the turn.
6. Remove "channels" from the list of unsupported protected paths in `docs/consumer-identity.md` only for what this ticket covers; outbound `send_message` from a protected agent stays unsupported.
7. Stage channel rules still hold: recipients pinned, an unknown-outcome send never resent.

## Acceptance

- [x] Customer A on iMessage asks for customer B's order → denied by the engine, audit shows the deny, the reply contains no data about B (test with the order fixture).
- [x] Customer A asks for their own order → allowed.
- [x] Revoke between model output and delivery → nothing is sent.
- [x] A non-eval, non-consumer session's gate path is byte-identical (existing tests unchanged).
- [x] An `authenticated` channel agent with a generic MCP tool cannot be saved as enabled.

## Outcome

Shipped: `channel.access`, consumer `runTurn` path, delivery re-check, rollover history gated on `validateConversation`, resume re-admission from ticket 08, docs and acceptance tests.

Left out: Slack sender admission (`admitChannelSender` still returns `not_required` for Slack). Console editor control for `channel.access` (YAML only). UI docs beyond `consumer-identity.md` and changelog.