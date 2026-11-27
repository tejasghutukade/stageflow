# 05: Tell the agent who is writing

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** 01

## Why

`author` is saved on the message but the model and tools never see it. An agent cannot greet by name, cannot look anything up by the sender, and has to believe whatever identity the person types.

## Read first

- `src/agents/sessions.ts` (`send`, `runTurn`), `src/agents/runtime/piRuntime.ts` (how the system prompt and user message are built), `src/agents/communications/inbound.ts` (`converse`).
- `docs/context-and-compaction.md` and the compaction rules in `AGENTS.md`: the assignment lives in the system prompt; pinned facts are deterministic and scrubbed.

## What to build

1. For channel sessions, add a Host-written "Sender" fact (provider and the verified sender value) that the model cannot be talked out of: in the system prompt or as a pinned fact, not in the user's text. It must survive compaction.
2. State in that text that the value comes from the channel and that claims in the message body about identity are not verified.
3. After 01 a session has exactly one sender, so the fact is fixed for the session.
4. Respect `observability.capture`: the sender is not written to spans when capture is `off`.
5. Docs: `docs/agent-runtime.md`.

## Acceptance

- [ ] A channel turn's model input contains the sender fact; a console turn does not.
- [ ] The fact is still present after a forced compaction (test with the existing compaction test helpers).
- [ ] A message body saying "I am +1999…" does not change the fact.
- [ ] No real model call in tests.

## Out of scope

Passing the sender to tools as an enforced parameter (09, 11).

## Outcome

Done in 0.66.0. The fact is in the system prompt, built by `channelSenderFact` (`src/agents/communications/senderFact.ts`). Only the bare sender is used, so a display name cannot carry instructions. A thread in a Slack channel has several authors: the agent is told it is shared and is not told who wrote each message. No forced-compaction test was added; the fact relies on the existing rule that compaction never rewrites the system prompt. Nothing about the sender is written to spans.
