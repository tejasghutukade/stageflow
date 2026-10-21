# Guide: an agent that answers in Slack

Slack agents receive messages by **webhook** (Slack Event Subscriptions), so the Host needs a URL Slack can reach.

## 1. Create the Slack app

In your workspace create an app with a bot user. Scopes: `chat:write` to reply, plus the event scopes for what the agent should read (for example `app_mentions:read` or `im:history`). Install it and copy the **bot token** (`xoxb-…`) and, from Basic Information, the **signing secret**.

## 2. Connect

```yaml
connections:
  - id: ops-slack
    provider: slack
    secrets:
      botToken: env:SLACK_BOT_TOKEN
      inboundSecret: env:SLACK_SIGNING_SECRET
```

`inboundSecret` is the signing secret. Without it the connection cannot receive: the webhook answers 404. See [Channels — Slack](channels.md#slack).

## 3. Make the Host reachable

- Expose the Host over HTTPS (a tunnel or reverse proxy). Forward only `POST /api/agent-inbound/<connection id>`; that route needs no console token because the signature is the credential.
- Add the public hostname to `STAGEFLOW_ALLOWED_HOSTS`.
- In the Slack app, turn on **Event Subscriptions** and set the request URL to `https://<host>/api/agent-inbound/ops-slack`. Slack's URL check is answered automatically.

## 4. Bind an agent

```yaml
channel:
  connection_id: ops-slack
  allow_from: [U02ABC1234]
```

A Slack sender is a **user id** (`U…` or `W…`, from the profile menu → Copy member ID), so `allow_from` takes Slack user ids or `*`. Email, phone and `@domain` entries never match a Slack sender. The reply goes to the same channel; each Slack thread is one session. Messages from bots are ignored.

## Troubleshooting

| You see | Cause and fix |
|---------|---------------|
| Slack says the URL failed verification | Host not reachable, not in `STAGEFLOW_ALLOWED_HOSTS`, or 404 because the connection has no `inboundSecret` |
| Webhook 401 | Wrong signing secret, or the request is older than 5 minutes (clock skew) |
| Webhook 404 | Unknown connection id, or no `inboundSecret` |
| Webhook 400 | Body is not JSON or has no text |
| Agent never answers | Agent disabled; user id not in `allow_from` (it is dropped silently); another agent already bound to the connection |
| Reply not delivered | Bot lacks `chat:write` or is not in the channel. See [Replies that do not arrive](agents.md#replies-that-do-not-arrive) |
