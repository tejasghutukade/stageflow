# 14: Freeze the identity contract and remove "experimental" (self-hosted)

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** 08–12

## Why

Phase 2 code is done: channel senders bind to identity (08), customer channel sessions run under the consumer gate (09), weak channels step up (10), resource tools cover orders and the account (11) and leakage evals exist (12). The docs and the console still call all of it experimental, so a self-hosted customer cannot rely on it.

Removing the label is a promise that identity, protected chat, customer channels and the customer API contract keep their shape between releases. This ticket makes that promise for self-hosted installs only. Cloud (13) is not required and graduates separately.

## Read first

- `docs/agents.md` (the "Still experimental" sentence and [Who should talk to a channel agent](../../agents.md#who-should-talk-to-a-channel-agent)), `docs/consumer-identity.md`, `docs/console-identity.md`, `docs/order-api-contract.md`, `docs/guides-agents-protected-chat.md`, `docs/guides-agents-web-chat.md`, `docs/agent-api.md`, `docs/agent-definition.md`, `docs/yaml-catalog.md` (agent section), `docs/environment-variables.md`, `README.md` (the "Experimental" paragraph).
- `src/identity/`, `src/server/http.ts` (`/api/identity`), `src/server/identitySetupRoutes.ts`, `src/agents/communications/inbound.ts`, `src/agents/sessions.ts`, `src/evals/graders/consumerScopeGrader.ts`.
- `ui/src/redesign/shell/navConfig.ts` (the `identity` entry), `ui/src/components/AppRail.tsx`, `AppRail.experimental.test.tsx`, `ui/AGENTS.md`.
- Tickets 07–12 Outcome sections.

## What to build

1. Contract review. List every surface below and mark each stable or still experimental. Anything renamed gets a dual-read.
   - Agent YAML: `web_chat.access: authenticated`, `channel.access: authenticated`, the resource tool names (`orders.status`, `orders.list`, `account.profile`) and their actions (`order:read`, `account:read`).
   - Public chat: `/api/public/chat/:slug/admission`, the bearer on thread routes, `/oidc/*`, the step-up link and its error code `identity.step_up_required`.
   - Identity API: `/api/identity/*` and `/api/identity/setup/*` (connections, including channel connections, assignments, audit).
   - Consumer error codes (`identity.*`) and audit event names, including `step_up_origin_missing`.
   - Customer API contract in `docs/order-api-contract.md`: request shape, actions, response and error shapes.
   - Host settings: `STAGEFLOW_PUBLIC_CHAT_URL`, `STAGEFLOW_PUBLIC_URL`.
   - Evals: the `consumer_scope` grader and the leakage sample (`examples/evals/leakage-sample.*`).
   - The embedder hook: `consumerAuthorization` on `startUiServer`.
2. Decide what stays experimental and say so in one place (`docs/consumer-identity.md`, linked from `docs/agents.md`). Proposed:
   - Writes in the customer API (returns, address change). Not built.
   - Per-tool assurance levels. Fixed in code (`orders.status` needs `provider_verified`), no YAML or console setting.
   - Slack for customers. Slack senders are never admitted, so an `authenticated` Slack agent refuses every sender. Document it as unsupported for customers, not experimental.
   - Cloud hosting of customer channels and public chat (13).
3. Remove the experimental flag from Identity in the nav. Keep it on A2A.
4. Docs:
   - Drop the experimental status lines from the identity pages and the order API contract.
   - Rewrite the `docs/agents.md` "Still experimental" sentence and the channel-trust section so customer-facing iMessage, Telegram and email agents are supported when `channel.access: authenticated`.
   - Fix `docs/guides-agents-protected-chat.md` and `docs/guides-agents-web-chat.md`, which still say only order status is supported.
   - State that the built-in `/chat/<slug>` page has no sign-in button; protected web chat needs an embedded client.
   - State that step-up needs `STAGEFLOW_PUBLIC_CHAT_URL` (or `STAGEFLOW_PUBLIC_URL`) set to an https origin, and what happens without it.
   - Update the "Behind a reverse proxy" section if step-up or `/oidc/*` adds paths to expose.
5. Correct the stale Outcome notes: 08 (the console can now add a channel connection) and 10 (step-up links are absolute when an origin is set).
6. Changelog entry and a minor version bump.

## Acceptance

- [ ] The contract list is in the PR description and every stable item has a test that pins its shape. List the gaps found, as 07 did.
- [ ] Nav tests updated; no "Exp" badge on Identity; A2A keeps its badge.
- [ ] `README.md` experimental paragraph matches the nav.
- [ ] No identity, protected chat or order API page says "experimental" except for the items step 2 keeps.
- [ ] `docs/agents.md` says which channels can serve customers, under which setting, and that Slack cannot.
- [ ] Manual check on a separate project with a self-hosted install: an `authenticated` Telegram or iMessage agent refuses an unbound sender, serves a bound sender only their own orders, and sends an absolute step-up link when the public URL is set.

## Decisions needed before starting

- Confirm the proposed "stays experimental" list in step 2.
- Ship in 0.67.0 (pull request #135, not yet published) or in a separate minor release after it.

## Outcome

Done in 0.67.0 (the unpublished release that already holds tickets 08–12). No separate version bump.

**Decisions taken**

- The proposed unfinished list stands. Writes (returns, address change) stay unfinished and are the only identity item still described that way.
- Per-tool assurance stays a fixed code rule. `orders.status`, `orders.list` and `account.profile` all require `provider_verified`.
- Slack for customers is unsupported. An authenticated Slack agent refuses every sender.
- Cloud (13) is unchanged and is not part of this graduation.

**Stable from this release (self-hosted)**

- Agent YAML: `web_chat.access: authenticated`, `channel.access: authenticated`.
- Resource tools `orders.status`, `orders.list`, `account.profile` and actions `order:read`, `account:read`.
- Public chat admission, the bearer on thread routes, `/api/public/chat/:slug/oidc/…`, `GET /api/public/chat/:slug/step-up`, error `identity.step_up_required`.
- `/api/identity/*` and `/api/identity/setup/*`, including channel connections.
- Audit events `step_up_issued`, `step_up_completed`, `step_up_origin_missing`, and the `step_up_denied_*` / `assurance_insufficient` denials.
- `STAGEFLOW_PUBLIC_CHAT_URL`, then `STAGEFLOW_PUBLIC_URL`, for the absolute step-up link.
- The `consumer_scope` grader and `examples/evals/leakage-sample.*`.
- The embedder hook `consumerAuthorization` on `startUiServer`.

**Still unfinished**

- Customer API writes.
- Slack sender admission.
- A sign-in button on the built-in `/chat/<slug>` page. Protected web chat uses an embedded client.
- Cloud hosting of customer channels and public chat (ticket 13).

**Tests that pin the shape**

- Nav: `ui/src/components/AppRail.experimental.test.tsx` (legacy rail markup and `NAV_GROUPS`: Identity has no Exp, A2A keeps it).
- Channel admission and refusal: `tests/identity.channel.test.ts`, `tests/agents.inbound.test.ts`.
- Step-up origin and link: `tests/identity.stepUp.test.ts`.
- Consumer gate on channel turns: `tests/agents.delivery.test.ts`.
- Resource tools and actions: `tests/identity.resources.test.ts` (`order:read`, `order:list`, `account:read`).
- Leakage grader: `tests/evals.consumerScopeGrader.test.ts`.

**Not done**

- No new test pins every `/api/identity` route and every `identity.*` error code one by one. The suites above hold the behaviors this ticket promises.
- The manual check on a separate self-hosted project (unbound sender refused, bound sender sees only their orders, absolute step-up link) was not run in this change.
- The contract list is recorded here. Pull request #135's description still needs this list when the branch is pushed.
