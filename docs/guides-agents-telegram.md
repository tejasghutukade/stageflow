# Guide: an agent that answers in Telegram

Telegram agents receive messages by **webhook**, so the Host needs a URL Telegram can reach.

## 1. Create the bot

Talk to @BotFather, create a bot and copy the **bot token**. Pick a random string for the webhook secret.

## 2. Connect

```yaml
connections:
  - id: alerts-telegram
    provider: telegram
    config:
      botUsername: acme_alerts_bot
    secrets:
      botToken: env:TELEGRAM_BOT_TOKEN
      inboundSecret: env:TELEGRAM_WEBHOOK_SECRET
```

See [Channels — Telegram](channels.md#telegram).

## 3. Point Telegram at the Host

Expose the Host over HTTPS, add the hostname to `STAGEFLOW_ALLOWED_HOSTS`, and register the webhook with the same secret:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url="https://<host>/api/agent-inbound/alerts-telegram" \
  -d secret_token="$TELEGRAM_WEBHOOK_SECRET"
```

Telegram sends `x-telegram-bot-api-secret-token`; the Host compares it with `inboundSecret`. The route needs no console token.

## 4. Bind an agent

```yaml
channel:
  connection_id: alerts-telegram
  allow_from: ["@jane_doe"]
```

A Telegram sender is identified by **username**, so `allow_from` takes `@username` (case-insensitive) or `*`. A person with no Telegram username cannot be allowed by name; only `*` lets them in. Email, phone and `@domain` entries never match. One chat is one session; the reply goes to the same chat. The person must have opened a chat with the bot first.

## Troubleshooting

| You see | Cause and fix |
|---------|---------------|
| `getWebhookInfo` shows errors | Host not reachable over HTTPS, or hostname not in `STAGEFLOW_ALLOWED_HOSTS` |
| Webhook 401 | `secret_token` differs from `inboundSecret` |
| Webhook 404 | Unknown connection id, or no `inboundSecret` |
| Webhook 400 | Update has no text message (stickers, photos and edits are not handled) |
| Agent never answers | Agent disabled; username not in `allow_from` (dropped silently); another agent already bound |
| Reply not delivered | The user blocked the bot or never started it. See [Replies that do not arrive](agents.md#replies-that-do-not-arrive) |
