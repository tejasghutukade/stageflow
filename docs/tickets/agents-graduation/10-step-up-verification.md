# 10: Step-up verification for weak channels

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** 08

## Why

A phone number on iMessage and a Telegram user id are asserted by the provider. An email `From` address depends on the provider's SPF/DKIM/DMARC handling, and any of them can be a lost or shared device. Some data should need more than "the message came from this address".

## Read first

- 08's assurance level. `src/identity/oidc.ts` and `handoff.ts` for how a web sign-in becomes a session.
- What AgentMail reports about authentication results on a received message (check current docs).

## What to build

1. A required assurance per permission or per tool: `address_only`, `provider_verified`, `signed_in`.
2. When a tool needs more than the session has, the Host (not the model) replies with a one-time sign-in link to the agent's protected web chat or the customer's own login (handoff), bound to this channel session and short-lived. Completing it raises the session's assurance for a bounded time.
3. Email: a sender is mapped only when the provider reports a passing aligned DMARC result, and is then `address_only`. No private resource accepts `address_only`.
4. Audit records each step-up.

## Acceptance

- [x] A tool marked `signed_in` is denied on a fresh channel session and allowed after the link is completed by the same mapped account.
- [x] A link completed by a different account does not raise the session.
- [x] The link is single-use and expires.

## Decisions made (2026-11-16, do not revisit)

- Step-up is a one-time sign-in link to the agent's protected web chat or the customer's own login (handoff). No one-time code on a second channel.
- Default assurance for order status: iMessage and a Telegram user id are enough (`provider_verified`). Email always needs step-up.
- Email never unlocks private data on its own, even with a passing aligned DMARC result. DMARC pass is still required for an email sender to be treated as mapped at all (greeting, non-private help, being offered the link).

## Outcome

Done on this branch (changelog under Unreleased). TTLs: step-up link **10 minutes** (`STEP_UP_LINK_MS`), elevated `signed_in` assurance **12 hours** (`SIGNED_IN_ELEVATION_MS`). Code: `src/identity/assurance.ts`, `stepUp.ts`, assurance checks in `authorization.ts`, DMARC gating in `channel.ts` and `agentmailListener.ts`, host reply on channel turns in `sessions.ts`, web completion in `publicChat.ts`. Tests: `tests/identity.stepUp.test.ts` plus existing `tests/identity.channel.test.ts`.

Left out: per-tool assurance configuration in the console or YAML (requirements are in code; `orders.status`, `orders.list` and `account.profile` all require `provider_verified`). Slack sender admission unchanged.

Corrected in ticket 14: step-up links are absolute when `STAGEFLOW_PUBLIC_CHAT_URL` or `STAGEFLOW_PUBLIC_URL` is a usable origin. With no origin the Host records `step_up_origin_missing` and issues no token.