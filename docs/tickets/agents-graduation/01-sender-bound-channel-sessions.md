# 01: Bind channel sessions to their sender

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** —

## Why

`receive` (`src/agents/service.ts`) finds the session by thread key only. A second allowed sender who writes into the same email thread, Telegram group or Slack thread continues the first person's session and sees an answer built on their history. `sourceRef` records only the first sender.

## Read first

- `src/agents/service.ts` (`receive`, `resumableTurns`), `src/agents/communications/port.ts`, `inbound.ts`, each provider parser in `src/agents/communications/`.
- `src/agents/store.ts` (`findSessionByThread`, `clearSessionThread`, the thread index).
- `docs/agents.md` ("Channels (inbound)").

## What to build

1. Include the normalized sender in the session key for AgentMail, iMessage and Telegram, so one thread with two senders is two sessions. A message with no sender never continues an existing session.
2. Migration: existing sessions keep working for the sender in `sourceRef`; any other sender starts a new session. `resumableTurns` splits `threadKey` by position, so keep it working (test).
3. Slack: a DM is one session per user; a channel thread stays shared (see Decisions made).
4. Docs: update the session rules in `docs/agents.md` and the channel guides.

## Acceptance

- [ ] Two allowed senders in one AgentMail thread get two sessions; neither reply contains the other's history (test).
- [ ] Same for a Telegram chat id with two `from` users.
- [ ] iMessage always-on resume after restart still answers once (existing test passes).
- [ ] Rollover at turn/time limit and the 24-hour cost rule are unchanged per sender.
- [ ] Redelivered events are still ignored.
- [ ] Two messages from one user in a Slack DM continue one session; a channel thread with two users is one session (tests).

## Out of scope

Mapping a sender to a customer account (08).

## Decisions made (2026-11-16, do not revisit)

- A Slack DM is one session per user: key it by the DM channel and the user, not by message `ts`. Confirm how the event marks a DM (`channel_type: im`) against Slack's current Events API docs before relying on it.
- A Slack channel thread stays one shared session keyed by thread. A thread is visible to its channel, so sharing it discloses nothing new. Document that.

## Outcome

Done in 0.66.0. The key carries the sender for AgentMail, email accounts and Telegram; iMessage was already per sender. A Slack DM is detected by `channel_type: "im"`, taken from Slack's Events API as remembered, not re-read from the docs: confirm against a real DM event before relying on it.
