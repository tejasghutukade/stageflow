# Triggers readiness smoke catalog

Self-contained catalog for [Triggers readiness](../../docs/triggers-readiness.md). One trigger per checklist row, all targeting the minimal `readiness` pipeline.

| Trigger id | Kind | Default `enabled` | How to test |
|------------|------|-------------------|-------------|
| `readiness-manual` | manual | **true** | Triggers → **Fire** (or `sf trigger fire --run readiness-manual` via API id) |
| `readiness-schedule` | schedule | false | Enable in UI; cron `*/5 * * * *` UTC; needs Host scheduler |
| `readiness-github-pr` | event (`github.pull_request`) | false | Set `event.config.repo`, enable; needs `GITHUB_TOKEN` on Host |
| `readiness-webhook` | event (`webhook`) | false | Set `WEBHOOK_SECRET` on Host, enable; `POST /api/triggers/readiness-webhook/webhook` |
| `readiness-email` | event (`email.message`) | false | Edit IMAP `config`, set `EMAIL_PASSWORD`, enable; restart Host after create |
| `readiness-dynamic-manual` | manual (no `task`) | false | UI **Fire** disabled; `sf trigger fire readiness-dynamic-manual --task-inline '{"id":"t","goal":"Dynamic smoke"}'` |

## Validate and run pipeline (no trigger)

From the repository root:

```bash
sf validate --strict \
  --pipeline examples/triggers-readiness/readiness.pipeline.yaml \
  --task examples/triggers-readiness/readiness.task.yaml
sf run \
  --pipeline examples/triggers-readiness/readiness.pipeline.yaml \
  --task examples/triggers-readiness/readiness.task.yaml
```

## Docker Compose

The image copies this tree to `/opt/stageflow/catalog/triggers-readiness` and registers it via `STAGEFLOW_ENSURE_PROJECT_ROOTS`. After `docker compose up --build -d`, open **Triggers** — you should see six `readiness-*` triggers.

Optional `.env` for event triggers:

```bash
GITHUB_TOKEN=…          # readiness-github-pr
WEBHOOK_SECRET=…        # readiness-webhook (use a long random string)
EMAIL_PASSWORD=…        # readiness-email (after you point config at a real mailbox)
```

Webhook smoke (replace secret and use the trigger id from the console if namespaced):

```bash
BODY='{"hello":"triggers"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
curl -sS -X POST "http://127.0.0.1:3847/api/triggers/readiness-webhook/webhook" \
  -H "Content-Type: application/json" \
  -H "x-hub-signature-256: $SIG" \
  -d "$BODY"
```
