---
layout: default
title: Triggers readiness
---

# Triggers readiness checklist

Use this checklist when authoring triggers in the **operator console** (Triggers page, `NewTriggerModal`) or in `*.trigger.yaml`. It maps each UI option to what the Host actually runs today.

**Scope:** Catalog triggers (`*.trigger.yaml`) started through `fireTrigger` — the same path as `sf trigger fire`, `POST /api/triggers/:id/fire`, and MCP `fire_trigger`. This does **not** cover the separate legacy **email rules** API (`/api/email/triggers`), which is not on the redesign Triggers page.

**Prerequisites (all automatic triggers):**

- [ ] A running Host (`sf ui`, `sf mcp`, or Docker `command: ["sf", "ui"]`) — adapters do not run in the CLI alone.
- [ ] Trigger `pipeline` (and catalog-mode `task`) resolve in the catalog; unknown refs fail at fire time.
- [ ] `enabled: true` — disabled triggers return `409` on fire.
- [ ] For **catalog mode** (`task` set): pipeline + task ids exist and validate.

See [YAML catalog — Triggers](yaml-catalog.md#triggers-trigger-yaml), [`sf trigger`](cli-reference.md#sf-trigger), and [Architecture](architecture.md) for schema and runtime boundaries.

---

## Legend

| Symbol | Meaning |
|--------|---------|
| **Auto** | Host adapter or route fires without manual action |
| **UI Fire** | **Fire** / **F** in the operator console |
| **CLI Fire** | `sf trigger fire` or `POST /api/triggers/:id/fire` (optional `task` / `--task-inline`) |

**Works** in the tables below means: implemented and expected to succeed when the checklist items for that row are satisfied.

---

## Kind: Manual

| Check | Auto | UI Fire | Works |
|-------|------|---------|-------|
| Catalog task set | — | Yes | **Yes** |
| Dynamic task (no `task` in YAML) | — | No (Fire disabled) | **Partial** — CLI/API with `--task-inline` or `task` body only |

**Checklist**

- [ ] `kind: manual`
- [ ] `pipeline` and (for UI Fire) `task` set
- [ ] Fire from UI, CLI, or MCP when you want a run

---

## Kind: Schedule

| Check | Auto | UI Fire | Works |
|-------|------|---------|-------|
| Catalog task + valid `schedule.cron` | Yes (~30s tick, `STAGEFLOW_TRIGGER_TICK_INTERVAL_MS`) | Yes | **Yes** |
| Dynamic task (no catalog `task`) | No — timer calls `fireTrigger` without a task | No | **No** for auto; **Partial** for manual CLI/API with task |
| `enabled: false` | No | No | — |

**Checklist**

- [ ] `kind: schedule`
- [ ] `schedule.cron` valid (5-field cron; validated on create)
- [ ] `schedule.timezone` optional (empty = host default; UI offers common IANA zones)
- [ ] **Catalog task** — UI blocks **Schedule + Dynamic task** on save
- [ ] Host running so `ScheduleSource` ticks; one missed occurrence is caught up once on boot (not one run per missed interval)
- [ ] Console shows scheduler health when the Host is healthy

**Not supported:** automatic fires for schedule + dynamic mode (by design).

---

## Kind: Event — GitHub pull request

UI tile **GitHub pull request** → `event.source: github.pull_request` (any `github.*` prefix uses the same poller).

| Check | Auto | UI Fire | Works |
|-------|------|---------|-------|
| Catalog task + repo + token | Yes (~60s poll, `STAGEFLOW_GITHUB_POLL_INTERVAL_MS`) | Yes | **Yes** |
| Dynamic task + repo + token | Yes (task built from PR) | No | **Partial** — auto/CLI; not UI Fire |
| `match.action` (required) / `match.author` | Yes (exact match on normalized fields) | — | **Yes** |

**Checklist**

- [ ] `kind: event`, `event.source` starts with `github.`
- [ ] `event.config.repo` = `owner/repo`
- [ ] `event.config.secretRef` or host env **`GITHUB_TOKEN`** / **`GH_TOKEN`** with repo read access (Docker: set in compose `.env`)
- [ ] Required `match.action`: `opened` \| `synchronize` \| `updated` \| `merged` \| `closed` (`synchronize` = head SHA changed / push; `updated` = other activity with the same head)
- [ ] Optional `match.author` (exact login match)
- [ ] Expect **first poll to seed only** — no runs for PRs that already existed before the cursor
- [ ] **PR list only** — not issues, pushes, or other GitHub event types

---

## Kind: Event — Signed webhook

UI tile **Signed webhook** → `event.source: webhook`.

| Check | Auto | UI Fire | Works |
|-------|------|---------|-------|
| Catalog task + signing config | On `POST /api/triggers/:id/webhook` | Yes | **Yes** |
| Dynamic task + signing config | On POST (task from JSON body) | No | **Partial** |
| Wrong/missing signature | — | — | **401** (by design) |

**Checklist**

- [ ] `kind: event`, `event.source: webhook`
- [ ] `event.config.secretRef` and `event.config.header` set (UI defaults: `WEBHOOK_SECRET`, `X-Hub-Signature-256`)
- [ ] Optional `event.config.scheme`: `hex` (default) \| `base64`
- [ ] Secret available to the Host via `readSecretFromEnvOrFile`
- [ ] Sender computes HMAC-SHA256 over the **raw body** on the configured header
- [ ] Optional `event.match` — subset match on JSON object; no match → `200 { fired: false }`
- [ ] **Reachability:** default Host bind is loopback — external senders need a tunnel (ngrok, cloudflared) or a deployment that exposes the Host

**Note:** The webhook route does not require a bearer token; it authenticates via HMAC only (see [YAML catalog — Webhook adapter](yaml-catalog.md#webhook-adapter-eventsource-webhook)).

---

## Kind: Event — Email (catalog)

UI tile **Email** → `event.source: email.message` (any `email.*` prefix uses `EmailSource`).

| Check | Auto | UI Fire | Works |
|-------|------|---------|-------|
| Catalog task + IMAP config | Yes (IMAP IDLE) | Yes | **Yes** *with real mailbox* |
| Dynamic task + IMAP config | Yes (task from message) | No | **Partial** |
| Optional subject filter | Yes | — | **Partial** — **exact** subject only, not substring |

**Checklist**

- [ ] `kind: event`, `event.source` starts with `email.`
- [ ] `event.config.host`, `port`, `user`, `secretRef` (UI default password ref: `EMAIL_PASSWORD`)
- [ ] Dedicated mailbox recommended; credentials in Host env, not in YAML
- [ ] Optional `match.subject` — must equal the full subject line
- [ ] **v1:** no attachment handling (subject, from, date, body text only)
- [ ] After **creating or changing** email triggers, **restart the Host** if the mailbox does not connect — catalog email triggers are discovered at `EmailSource.start()` (unlike schedule/GitHub, which rescan each tick)

---

## Kind: Event — other `event.source`

| Check | Auto | UI Fire | Works |
|-------|------|---------|-------|
| Any source not `github.*`, `webhook`, or `email.*` | No | No (dynamic) / Yes (catalog) | **No** auto — YAML loads and validates only |

**Checklist**

- [ ] Use only if you will fire manually: `sf trigger fire --task-inline '…'` or `POST .../fire` with a `task` body for dynamic mode
- [ ] Do not expect polling or inbound routes until an adapter exists ([Architecture](architecture.md))

---

## Target: Catalog vs dynamic task

| Mode | YAML | Auto adapters | UI **Fire** | CLI / API fire |
|------|------|---------------|-------------|----------------|
| **Catalog** | `task: <id>` set | Yes (when kind/source supports it) | Yes | Yes (no task override; `trigger.task_override_not_allowed` if you try) |
| **Dynamic** | `task` omitted | Event sources can build task; **schedule cannot** | **Disabled** (“needs a task payload”) | Yes with `task` / `--task-inline` (`trigger.task_required` if missing) |

**Checklist**

- [ ] Pick **Catalog task** in the UI for anything you want to **Fire** from the console or for **schedule** automation
- [ ] Pick **Dynamic** only when an adapter or webhook supplies the task, or you always fire via CLI/API with inline task JSON

---

## Operator console (redesign) — UI-only checks

- [ ] **Create / edit / duplicate** — writes `*.trigger.yaml` via `POST /api/triggers` / `PATCH`
- [ ] **YAML preview** in the modal matches saved file
- [ ] **Enabled** switch maps to `enabled` in YAML
- [ ] **Fire** and shortcut **F** only when `enabled` and catalog `task` are set
- [ ] Filter tabs (Schedule, Event, Manual, Disabled, Needs attention) are views only — no separate runtime
- [ ] **Needs attention:** schedule without catalog task, or `adapter_status.state === "error"`

---

## Quick matrix (reference)

| UI / YAML | Auto | Works end-to-end |
|-----------|------|------------------|
| Manual + catalog task | — | Yes |
| Schedule + catalog task | Cron tick | Yes |
| Schedule + dynamic | — | No (auto) |
| Event GitHub PR + catalog | Poll | Yes |
| Event webhook + catalog | POST | Yes (if reachable + secrets) |
| Event email + catalog | IMAP IDLE | Yes (if mailbox + secrets) |
| Event other source | — | Manual fire only |
| Any kind + dynamic | Varies | UI Fire no; CLI/API with task |

---

## Smoke catalog (Docker and local)

The [`examples/triggers-readiness/`](../examples/triggers-readiness/) bundle ships in the Docker image at `/opt/stageflow/catalog/triggers-readiness` (registered via `STAGEFLOW_ENSURE_PROJECT_ROOTS` in [`docker-compose.yml`](../docker-compose.yml)). See [examples/triggers-readiness/README.md](../examples/triggers-readiness/README.md) for trigger ids and test commands.

---

## Related docs

- [YAML catalog — Triggers](yaml-catalog.md#triggers-trigger-yaml) — authoritative field reference
- [`sf trigger`](cli-reference.md#sf-trigger) — CLI fire and `--task-inline`
- [MCP trigger tools](mcp.md) — `fire_trigger`, `create_trigger`, error codes
- [Docker and self-hosting](docker.md) — running the Host and provider secrets
