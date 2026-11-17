# 08: Channel sender as an identity connection

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** 01, 02

## Why

Consumer identity knows two ways a person proves who they are: a signed handoff and OIDC. A channel gives a third: the provider tells us the phone number, Telegram user id or email address. To scope data per customer on a channel, that verified sender must map to a business account through the same store and the same checks.

## Read first

- `docs/consumer-identity.md` (all), `src/identity/store.ts`, `authorization.ts`, `types.ts`, `runtime.ts`, `src/server/identityRoutes.ts`.
- `src/agents/communications/` and tickets 01, 02.
- `docs/console-identity.md` and `ui/src/redesign/identity/`.

## What to build

1. A new connection kind, `channel`, pinned to one channel connection id and one agent. Its subject is the normalized sender (`+E.164`, Telegram numeric id, lowercased email).
2. Admission: on an inbound message for an agent that requires identity, look up the assignment for (connection, subject). Found and active → open or reuse a consumer session with a bounded Access Grant, as handoff does. Not found → the configured reply ("we could not match this number to an account") and no model call.
3. Sender resolution: live lookup first, the existing assignment table second (see Decisions made).
4. An assurance level on the connection, recorded on the grant: `provider_verified` (iMessage, Telegram id), `address_only` (email). 10 uses it.
5. Session lifetime: a channel has no sign-in moment. Proposal: the grant lasts for the session and is re-read from the store on every turn, so a revoke takes effect on the next message.
6. Multi-tenant: the connection takes a scope as input, never a literal (`AGENTS.md`, browser and credential rules).

## Acceptance

- [ ] A mapped sender gets a consumer session bound to their account; an unmapped sender gets the fixed reply and no turn runs.
- [ ] Revoking the person, the connection or the grant stops the next message.
- [ ] A `channel` subject cannot be used on web chat admission, and a handoff or OIDC subject cannot be used on a channel.
- [ ] Audit shows allow and deny with reason codes, no message text.
- [ ] Lookup down or malformed → sender is unmapped, fixed reply, no turn.
- [ ] After the cache window a sender the lookup no longer returns is refused on the next message.

## Decisions made (2026-11-16, do not revisit)

- An unmapped sender gets a fixed, operator-written reply (for example "We couldn't match this number to an account. Sign in at acme.com/help.") and no model call. An anonymous tool-less fallback may come later as an option that is off by default; it is not part of this ticket.
- Mappings come from a live lookup first. On the first message of a session the Host calls the customer's system on a third fixed endpoint beside the two order endpoints, `POST /stageflow/resolve-sender` with `{ workspaceId, channel, sender }`, and gets `{ accountId }` or not found. Same rules as the order adapter: fixed trusted HTTPS endpoint, the Host's downstream credential, no redirects, bounded response and time. The result is cached for a few minutes (pick the value in design; it bounds how long a changed phone number keeps working).
- A lookup that errors, times out or answers anything unexpected means unmapped. Fail closed.
- The existing assignment table stays as the manual and import path for small setups. When both exist, an explicit revoke in the table wins over a lookup allow.
- Document the new endpoint in `docs/order-api-contract.md`.

Flow the tests must cover: Jane texts from +14155550123 → lookup returns `cus_881` → session bound to `cus_881` → her own order is allowed → another account's order is denied and audited.

## Outcome

Done on this branch, not yet in a release (changelog is under Unreleased). The lookup cache is five minutes (`CHANNEL_SENDER_CACHE_MS`). A channel grant lasts 24 hours and is re-read on every message; revoking it blocks the next message until that grant would have expired. Assurance is chosen from the provider (`provider_verified` for iMessage and Telegram, `address_only` for email) and stored on the grant. The console lists a channel connection and does not yet offer a form to create one; creation is `POST /api/identity/connections/channel`. Running the channel turn under the consumer gate is ticket 09.
