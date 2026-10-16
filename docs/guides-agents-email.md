# Guide: an agent that answers email (AgentMail)

An agent can own one [AgentMail](https://docs.agentmail.to/) inbox. The Host opens a WebSocket for that inbox, so **no public URL is needed**. IMAP/SMTP mailboxes from [email accounts](email-accounts.md) cannot be an agent channel.

## 1. Connect the inbox

In the console open **Connections**, choose **Add connection** and pick AgentMail, or add it to `connections.yaml` ([Channels — AgentMail](channels.md#agentmail)):

```yaml
connections:
  - id: support-inbox
    provider: agentmail
    config:
      inbox: support@agentmail.to
    secrets:
      apiKey: env:AGENTMAIL_API_KEY
```

The key must read the inbox and send messages (`inbox_read`, `message_send`). Use **Check now** on the connection to confirm.

## 2. Bind an agent

```yaml
channel:
  connection_id: support-inbox
  allow_from: [jane@example.com, "@acme.com"]
limits:
  always_on: false
```

`allow_from` for email takes addresses, `@domain`, or `*`. An empty list lets nobody in. One connection has one agent, and two connections that reach the same inbox count as one: a second agent is refused with `agent.channel_in_use`.

## 3. Enable

When the agent is enabled the Host starts the listener (the agent page shows **Listening**, **Reconnecting** or the failure). It stops when the agent is disabled, and restarts if you change the connection.

## How it behaves

- One session per email thread. Replies go in the thread, with the new text only (no quoted history) and the subject kept.
- Only `message.received` events arrive, so spam, blocked and unauthenticated mail never reaches the agent.
- Mail from the agent's own inbox, `Auto-Submitted`, bulk/list precedence, `mailer-daemon`, `postmaster` and no-reply senders is ignored. Each sender may send 20 messages a minute; the rest are ignored.
- After a dropped stream reconnects (backoff 2 s to 60 s), mail from the last 15 minutes is answered too, deduplicated by message id.
- A turn only counts as succeeded once the reply reached the sender. See [Replies that do not arrive](agents.md#replies-that-do-not-arrive).
- `STAGEFLOW_AGENT_CHANNEL_LISTENERS=0` turns listening off for the whole Host.

### Webhooks instead of the stream

Set an optional **Webhook secret** (`inboundSecret`) on the connection and point AgentMail at `POST /api/agent-inbound/<connection id>`. The request must carry `x-agentmail-signature`, the HMAC-SHA256 of the raw body. The Host must be reachable from the internet and, if it sits behind a name, `STAGEFLOW_ALLOWED_HOSTS` must list it. The stream needs none of this and is the simpler choice.

## Troubleshooting

| You see | Cause and fix |
|---------|---------------|
| Agent never answers | Agent disabled; sender not in `allow_from`; listeners off (`STAGEFLOW_AGENT_CHANNEL_LISTENERS=0`); or the mail looks automated (see the ignore list) |
| **Reconnecting** / cannot connect | Bad key, wrong `region` (`us` or `eu`), or no network from the Host. Use **Check now** |
| `agent.channel_in_use` | Another agent already answers on that inbox |
| Webhook returns 401 | Signature does not verify: secret differs from the one AgentMail signs with |
| Webhook returns 404 | The connection id is unknown, or it has no `inboundSecret` |
| Webhook returns 400 | Body is not JSON or lacks an id, a thread id and text |
| Reply not delivered | See [Replies that do not arrive](agents.md#replies-that-do-not-arrive): **Resend** or **Mark as delivered** on the run page |
