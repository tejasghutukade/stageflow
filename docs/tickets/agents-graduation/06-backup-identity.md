# 06: Back up identity data

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** —

## Why

`docs/consumer-identity.md` says `sf backup` does not include `identity/` or the secrets file. Losing `consumer-identity.db` loses account mappings, revocations and replay protection. A stable feature needs a restore story.

## Read first

- The backup and archive code (`src/archive/`, `src/cli/` backup and archive commands) and `docs/data-directory.md`.
- `src/identity/runtime.ts`, `src/identity/store.ts` (Workspace binding on open).

## What to build

1. Include `identity/consumer-identity.db` (a consistent SQLite copy, not a file copy of a live WAL database) and `identity/settings.json` in the backup.
2. Restore refuses a database bound to another Workspace, the same way the store does.
3. Secrets follow whatever rule the backup already applies to `channel-secrets.json`; do not invent a second rule.
4. Docs: `docs/consumer-identity.md`, `docs/data-directory.md`.

## Acceptance

- [ ] Backup then restore into an empty home: a mapped person can sign in, a revoked person cannot, a used handoff `jti` is still refused.
- [ ] No secret or signing key appears in the backup unless the existing secrets rule includes it.

## Decisions made (2026-11-16, do not revisit)

- Identity secrets (order API credential, signing key) are opt-in, under the same flag and rule the backup uses for other secrets. Never included by default.
- Restoring without them leaves the order API unconfigured: people can sign in and stay mapped, and no private order is read until the operator re-enters the credential. Say so in the docs.

## Outcome

Done in 0.66.0, mostly by what `sf archive` (0.65.0) already did: it copies the identity database consistently, `identity/settings.json`, and `identity-secrets.json` only with `--include-secrets`. Found and fixed here: the database itself holds OIDC client secrets and provider refresh tokens, and a no-secrets archive copied them. They are now removed from the copy (`src/identity/archiveCopy.ts`). `sf backup` still does not include identity; the docs point to `sf archive`. Restore does not check the Workspace itself: the store refuses a database from another Workspace when it opens (tested).
