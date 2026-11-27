# 13: Cloud: Core bump, public chat route, keep-awake

**Epic:** [Agents graduation](README.md) · **Status:** cloud-landed · **Blocked by:** 07 (Core publish) · **Repo:** stageflow-cloud

## Why

Hosted Workspaces must offer the same agents. Known from the Cloud parity matrix and a quick read of the gateway (not tested live):

- The gateway forwards `/api/agent-inbound/<connection>` (`apps/gateway/src/webhookEndpoints.ts`). No route for `/chat/<slug>` or `/api/public/chat/*` was found; this needs confirming.
- iMessage (Photon stream) and AgentMail WebSocket need the Host awake while enabled.
- `docs/consumer-identity.md` says Cloud is on a Core release without the identity exports.

## What to do

1. Confirm whether a hosted agent's web chat link works from the public internet today. If not, add the public route with rate limiting and `STAGEFLOW_ALLOWED_HOSTS` / `STAGEFLOW_PUBLIC_CHAT_ORIGINS` set by Cloud.
2. Keep-awake: the Host reports that an enabled agent has a stream channel; Cloud keeps that Workspace awake and bills accordingly. Webhook channels keep the wake-and-replay path.
3. Bump Core to the graduated release. Cloud constructs `ConsumerAuthorization` from the package exports and resolves downstream secrets through its vault; it does not reimplement admission.
4. `STAGEFLOW_WORKSPACE_ID` is set per Workspace so the identity database is bound correctly.
5. Volume backup covers `identity/` (06).

## Acceptance

- [ ] A hosted agent answers on web chat, Telegram (webhook, from asleep) and iMessage (stream, kept awake).
- [ ] Protected chat works on a hosted Workspace with the hosted test IdP.
- [ ] Every production change follows the Cloud approval rule; no secret is read or moved by an agent.

## Outcome (2026-11-16)

**Landed in stageflow-cloud (not deployed):**

- **Public chat routing** was missing; added `publicChatPassthrough` on `<slug>-public.<tenant>` only (`/chat/<slug>`, `/api/public/chat/*`, static assets). Console origin returns 404 for those paths. Rate limits match design. Stopped hosts: GET `/chat/...` shows a waking page and starts wake; API gets 503 with `Retry-After`.
- **Provisioner metadata / sf-firstboot:** `STAGEFLOW_ALLOWED_HOSTS` includes public hostname; sets `STAGEFLOW_PUBLIC_URL`, `STAGEFLOW_PUBLIC_CHAT_URL`, `STAGEFLOW_PUBLIC_CHAT_ORIGINS`, `STAGEFLOW_WORKSPACE_ID`, and `STAGEFLOW_AGENT_CHANNEL_LISTENERS` (`0` on free-tier billing policy).
- **Keep-awake:** probe reads `/api/agents` + `/api/connections` for enabled AgentMail/iMessage stream channels; `holdsAwake` treats paid-plan stream listeners like triggers (vm_runtime metering unchanged). Free tier disables listeners via metadata.
- **Slug:** `-public` suffix reserved (migration + web validation).
- **Hosted copy:** one sentence on Usage panel for free-tier stream channel limits.

**Not done (needs human):**

- **Core pin:** npm latest is **0.65.1**; **0.66.0** not published — no VM image bump, no `ConsumerAuthorization` wiring from package exports.
- **Edge Worker** must route `<slug>-public` like tenant hostnames (`infra/edge/apply.sh` / Cloudflare).
- **Deploy** gateway, run Supabase migration `20261116090000_slug_public_suffix.sql`, **re-bake** VM image after Core 0.66+ is on npm.
- **Live acceptance:** web chat, Telegram webhook wake, iMessage stream keep-awake, protected chat + IdP — unverified here.

**Volume / identity:** GCE disk snapshots at sleep still cover the full data disk (includes `$STAGEFLOW_HOME/identity/`); no second secret store added.

## Decisions made (2026-11-16, do not revisit)

- Keep-awake for stream channels (iMessage, AgentMail WebSocket) is for paid plans. The free tier gets webhook channels, which wake the Workspace on request. The console says why a stream channel is unavailable on a free Workspace.
