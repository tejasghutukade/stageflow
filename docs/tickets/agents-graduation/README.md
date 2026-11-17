# Agents graduation: tickets

Goal: take Agents out of experimental. Two phases.

- **Phase 1 (01–07):** agents stable for internal and allow-listed use. Identity and customer-facing channels stay experimental.
- **Phase 2 (08–13):** a customer on iMessage, Telegram or email can only reach their own data. Then customer support on channels graduates.

Background (found by code reading, 2026-11-16):

- One agent has one connection and a connection has one agent (`channelConflicts`, `src/agents/service.ts`).
- A channel session is keyed by provider + connection + thread (`agentThreadKey`, `src/agents/communications/port.ts`), not by sender.
- Channel sessions are not `external` in `runTurn` (`src/agents/sessions.ts`), so no per-sender check runs and every granted tool is available. An `authenticated` agent refuses channel sources.
- Customer-scoped access (`src/identity/`) covers declared resource tools (`orders.status`, `orders.list`, `account.profile`) over one customer API.
- The sender (`author`) is stored on the message but never given to the model or tools.

| # | Ticket | Phase | Blocked by |
|---|--------|-------|------------|
| 01 | Bind channel sessions to their sender | 1 | — |
| 02 | Telegram: stable user ids, no groups | 1 | — |
| 03 | Save-time guard for open channels with tools | 1 | — |
| 04 | AgentMail webhook hardening | 1 | — |
| 05 | Tell the agent who is writing | 1 | 01 |
| 06 | Back up identity data | 1 | — |
| 07 | Freeze the contract and remove "experimental" | 1 | 01–06 |
| 08 | Channel sender as an identity connection | 2 | 01, 02 |
| 09 | Run customer channel sessions under the consumer gate | 2 | 08 |
| 10 | Step-up verification for weak channels | 2 | 08 |
| 11 | Customer-scoped tool contract beyond order status | 2 | 09 |
| 12 | Evals for cross-customer leakage | 2 | 09 |
| 13 | Cloud: Core bump, public chat route, keep-awake | 2 | 07 |

Every Core ticket: `npm test`, `npm run ui:test`, `npm run typecheck`, docs updated in the same change, version bump and changelog.

All owner decisions were made on 2026-11-16 and are recorded in each ticket.

Phase 1 (01-07) shipped in 0.66.0. Each ticket has an Outcome section with what was left out.

08 is implemented on this branch (see its Outcome). 09 is done (see its Outcome). 10 is done (see its Outcome). 11 is done (see its Outcome). 12 is done (see its Outcome). 13 remains: cloud readiness in the `stageflow-cloud` repository.
