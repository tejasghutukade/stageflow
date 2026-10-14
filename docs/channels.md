# Communication channels

Channels let a stage send a message over an external service. You define a **connection** once in `connections.yaml`, then a stage lists it under [`channels:`](yaml-catalog.md#stage-channels) with the recipient pinned. The agent gets one tool, `send_message`, and cannot pick a different recipient.

> **Status: send path built.** Sending works for AgentMail, Slack, Telegram, iMessage and WhatsApp. Channels are send-only; stages never receive messages. The `send_message` tool is available on the Pi backend only; a stage with `channels:` on the Claude backend fails at start instead of running without it.

Channels are separate from [email accounts](email-accounts.md) (`email.yaml`, IMAP/SMTP), which keep working unchanged.

## connections.yaml

You can connect providers from the console (Connections, **Add connection**) or edit `connections.yaml` yourself. Connections belong to the host, like provider credentials, so the default file is `$STAGEFLOW_HOME/connections.yaml` (`~/.stageflow/connections.yaml`, or `/data/connections.yaml` in Docker) and every project on that host sees the same connections. A `connections.yaml` in a project root (next to `stageflow.yaml`) takes precedence for that project when it exists, which suits CI and checked-in setups, and `STAGEFLOW_CONNECTIONS_FILE` overrides both. The console edits whichever file is in effect, keeps your comments, and applies the change without a restart. A file you edit by hand is read at start, so restart the host after a manual change. Copy [`connections.example.yaml`](../connections.example.yaml) to begin. A missing file means no connections. A file that does not validate stops the stages that use channels, with a safe error code and no file content in the message.

```yaml
version: 1
connections:
  - id: support-inbox
    provider: agentmail
    displayName: Support inbox
    config:
      inbox: support@agentmail.to
    secrets:
      apiKey: env:AGENTMAIL_API_KEY
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Letters, digits, `.`, `_`, `-`. Stages refer to it. Changing it makes a new connection |
| `provider` | yes | A provider that is implemented (see below) |
| `displayName` | no | Defaults to `id` |
| `enabled` | no | Defaults to `true`. A disabled connection fails validation for any stage that uses it |
| `config` | no | Provider settings. Unknown keys are rejected |
| `secrets` | per provider | Map of secret name to `env:NAME` |
| `credential` | per provider | Id of a shared entry under top-level `credentials` (providers that share one credential) |

The file is limited to 256 KiB, 100 connections and 20 credentials. Duplicate ids, duplicate YAML keys and YAML aliases are rejected.

### Secrets

A secret is always a reference, never a value in the file. There are two kinds: `env:NAME` (you set the variable on the host) and `store:NAME` (written by the console).

**`env:NAME`.** Stageflow reads `NAME` from the host environment, or from the file named by `NAME_FILE` (one trailing newline is trimmed). Setting both is an error. **Inline secret values are rejected**, unlike `email.yaml`. Use this for CI.

**`store:NAME`.** When you connect a provider in the console, the key you type is saved in `channel-secrets.json` in the credential root (`STAGEFLOW_CREDENTIAL_HOME`, default `~/.stageflow`), mode `0600`, and `connections.yaml` gets only `store:connection.<id>.<field>`. The API never returns a value and a failed save removes what it wrote. This file has the same trust level as provider auth in the same directory: a process running as the same user can read it, so on a shared machine keep using `env:`. Replacing a key in the console stores the new value and switches that field to `store:`. Disconnecting deletes the entry and its stored values.

Secrets are read on the host when a message is sent or a check runs. They are never written to run state, logs, envelopes or artifacts, never returned by the API, and never passed to the stage worker: the host removes every variable referenced in `connections.yaml` (and its `_FILE` form) from the worker environment, and the worker asks the host to send over a private channel.

## What happens at run time

1. **`sf validate`** checks that every `channels:` entry points at an enabled connection, the provider supports the operation, and the target is valid. No network, no secrets.
2. **Run start** (also the MCP `preflight` tool and `sf doctor`) makes a live check of each connection a pipeline uses. Only transient failures (network error, timeout, 5xx, rate limit) are retried, twice. Anything else blocks the run with `channel_check_failed`. See [MCP `preflight`](mcp.md#preflight).
3. **Sending.** The host sends with the pinned target. The agent's operation key is bound to the run, stage and channel. A repeated key with the same content returns the first result without sending again. A failure that might have reached the provider is recorded as unknown and never resent, even after a restart. A definite failure is also remembered for that key; use a new key to try again.

Acceptance means the provider took the message, not that anyone read it.

## Error codes

Tool errors carry only `{ code, retryable }`.

| Code | Meaning |
|------|---------|
| `CHANNEL_INVALID_INPUT` | The request or configuration is not valid |
| `CHANNEL_NOT_FOUND`, `CHANNEL_DISABLED` | The connection is not defined or is disabled |
| `CHANNEL_UNAUTHORIZED` | The stage did not declare this channel or operation, or the provider refused the credential's permission |
| `CHANNEL_AUTH_FAILED` | The provider rejected the credential |
| `CHANNEL_SECRET_UNAVAILABLE` | A referenced environment variable is missing or ambiguous |
| `CHANNEL_TARGET_INVALID` | The pinned target is not valid for the provider |
| `CHANNEL_RATE_LIMIT` | The provider is throttling (retryable) |
| `CHANNEL_CONNECTION_FAILED`, `CHANNEL_TIMEOUT` | The provider could not be reached (retryable) |
| `CHANNEL_RECIPIENT_REJECTED` | The provider refused this recipient: unknown channel or chat, a bot that was not added or was blocked, or an iMessage user not registered in the Photon project |
| `CHANNEL_WINDOW_CLOSED` | WhatsApp only: the 24-hour window is closed, so the stage must pin an approved `template` |
| `CHANNEL_PROVIDER_UNSUPPORTED` | The provider is unknown to this Stageflow version, or its SDK (`@spectrum-ts/*` for iMessage and WhatsApp) is not installed |
| `CHANNEL_SEND_OUTCOME_UNKNOWN` | The message may or may not have been sent. Do not retry with a new key |
| `CHANNEL_OPERATION_CONFLICT` | The same operation key was reused with different content |

## Connections page and API

The operator console's **Connections** page lists the channels from `connections.yaml` next to the email accounts and the `.mcp.json` tool servers. Secrets are never shown. You can connect, replace a key, disable and disconnect from it. The host re-checks each enabled connection every 5 minutes (with jitter, backing off after failures) and the page shows the last result, or "Not checked yet". **Check now** runs one live check; it never sends a message.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/connections` | Connects a provider: validates, stores secrets, edits `connections.yaml`, reloads, runs a check and returns `{ id, health }`. Body: `{ provider, id?, displayName?, config, secrets, credential? }`. |
| `POST /api/connections/test` | Same body, checks the values without saving anything. |
| `PATCH /api/connections/{id}` | Replace secrets, enable or disable, rename, change config. |
| `DELETE /api/connections/{id}` | Disconnect: removes the entry, its stored secrets and a shared credential nothing else uses. |
| `GET /api/connections` | `{ connections: [{ id, provider, displayName, enabled, identity?, health? }], error? }`. `error` is a code when `connections.yaml` could not be loaded; the host keeps running and only stages that use channels fail. |
| `POST /api/connections/{id}/check` | Runs one live check and returns `{ state, checkedAt, error? }`. `404` with `CHANNEL_NOT_FOUND` for an unknown or disabled connection. Needs a same-origin `Origin` header and the `drive` scope. |

The listing is for the workspace the host was started in.

## Providers

### AgentMail

Sends plain-text mail from one **existing** AgentMail inbox through the REST API. Stageflow does not create inboxes or domains. Receiving mail is not supported.

```yaml
- id: support-inbox
  provider: agentmail
  config:
    inbox: support@agentmail.to    # the inbox address (its inbox id)
    region: us                      # optional: us (default) or eu
  secrets:
    apiKey: env:AGENTMAIL_API_KEY
```

- **Key permissions.** The key must be able to read the inbox (used by the live check) and send messages. If you restrict permissions on the key, grant `inbox_read` and `message_send`. Whether an inbox-scoped key may read its own inbox was not verified, so test a scoped key with `sf doctor` first.
- **Targets.** `to` is one address or a list of up to 20, optionally with `cc` (up to 20). All recipients get one message. `bcc` is not supported.
- **Subject.** The agent may pass `subject` to `send_message`. Without one, the subject is `Message from Stageflow`.
- **Body.** `text` is sent as plain text, up to 64 KiB. There are no attachments or HTML.
- **Redirects** are refused so the key never goes to another host.
- A 5xx response or a connection dropped mid-request is an unknown outcome. A refused connection (nothing sent) and a 429 are retryable failures.

Provider reference: <https://docs.agentmail.to/>.

### Slack

Posts as a Slack bot with `chat.postMessage`. Stageflow does not install the app; create it in your workspace and give Stageflow the bot token. Receiving is not supported.

```yaml
- id: ops-slack
  provider: slack
  config:
    teamId: T0123ABCD    # optional: the live check fails if the token belongs to another workspace
  secrets:
    botToken: env:SLACK_BOT_TOKEN    # xoxb-...
```

- **Scopes.** `chat:write` is required. Add `chat:write.public` to post to public channels the bot has not joined, and `im:write` to message a user directly.
- **Targets.** `to` is one Slack id: a channel (`C...`), private channel (`G...`), DM (`D...`) or user (`U...`). Names like `#general` are not accepted, because they can be renamed. A private channel needs the bot invited first.
- **Subject.** Slack has no subject. If the agent passes one it is bolded on the first line.
- **Body.** Sent as Slack text. Links are not unfurled and `@` names are not linked.
- **Live check.** `auth.test`. A revoked or invalid token fails the run before it starts.
- Slack reports most failures as HTTP 200 with an error name. Auth errors map to `CHANNEL_AUTH_FAILED`, missing scopes to `CHANNEL_UNAUTHORIZED`, an unknown or archived channel or a bot that is not a member to `CHANNEL_RECIPIENT_REJECTED`, and `ratelimited` to a retryable `CHANNEL_RATE_LIMIT`. Server errors are an unknown outcome.

Provider reference: <https://api.slack.com/methods/chat.postMessage>.

### Telegram

Sends through the Telegram Bot API with a bot token from @BotFather. Receiving is not supported.

```yaml
- id: alerts-telegram
  provider: telegram
  config:
    botUsername: acme_alerts_bot    # optional: the live check fails if the token is another bot
  secrets:
    botToken: env:TELEGRAM_BOT_TOKEN
```

- **Targets.** `to` is a numeric chat id (users are positive, groups and channels negative) or a public channel `@username`. A person cannot be addressed by phone number or username.
- **The recipient must start the bot first.** A bot cannot message a user who has not opened a chat with it; the send fails with `CHANNEL_RECIPIENT_REJECTED`, as it does if the user blocked the bot or the bot is not a member of the group or channel.
- **Subject.** If the agent passes one it is put on the first line, followed by a blank line.
- **Body.** Plain text, up to 4096 characters; longer text is rejected before anything is sent. Link previews are off.
- **Live check.** `getMe`. The token travels in the request path, as the Bot API requires; Stageflow never logs URLs or response bodies.

Provider reference: <https://core.telegram.org/bots/api>.

### iMessage (Photon)

Sends an iMessage DM through a [Photon](https://photon.codes) (Spectrum) project. The Photon project credentials are a shared `credential`; connections reference it. Receiving is not supported, and neither are group chats.

```yaml
credentials:
  - id: photon-main
    provider: photon
    secrets:
      projectId: env:PHOTON_PROJECT_ID
      projectSecret: env:PHOTON_PROJECT_SECRET
connections:
  - id: alerts-imessage
    provider: imessage
    credential: photon-main
```

- **SDK.** The send uses the Spectrum packages `@spectrum-ts/core`, `@spectrum-ts/imessage` and `@spectrum-ts/whatsapp-business`, declared as optional dependencies (about 100 MB with their gRPC dependencies). If you install with `--omit=optional`, add them yourself. Without them, a send fails with `CHANNEL_PROVIDER_UNSUPPORTED`.
- **Targets.** `to` is an E.164 phone number (`+14155550123`) or an Apple ID email. One recipient per entry.
- **Free and Pro projects** use a shared line and can only message users registered in the project. The run-start check looks the recipient up and blocks the run with `CHANNEL_RECIPIENT_REJECTED` if they are missing. Stageflow never registers users; add them in the Photon dashboard. Business projects have dedicated lines and skip this lookup. **A listed user must also text their assigned line once before Stageflow can message them.** The assigned line is the "Texts on" number next to the user in the Photon dashboard (also `assignedPhoneNumber` in the users API). Until that first inbound text, a send fails with `CHANNEL_RECIPIENT_REJECTED`; the run-start check cannot see it, because Photon does not expose it. Verified against a real Free project: rejected before the user texted the line, accepted right after. A recipient can also be listed and still be rejected at send time with `CHANNEL_RECIPIENT_REJECTED` (Photon: "Target not allowed for this project") when the handle you added is not the one Apple actually sends iMessage from, for example an email instead of the phone number. Message <https://debug.photon.codes> from that phone, add the exact handle it reports under Users, and use the same value as the pinned recipient. The run-start check cannot see this case.
- **Limits.** Photon documents 5,000 messages per server per day and 50 new conversations per line per day, and warns that unsolicited messages can get a line flagged. Message only people who opted in.
- **Live check.** Issuing an iMessage token proves the project id and secret work.
- Each send starts the SDK, sends, and stops it, so nothing stays connected between sends. Telemetry is not enabled.
- **Not verified against a real project:** the exact shape of Photon's users lookup (Stageflow matches the recipient anywhere in the response) and whether the SDK opens inbound streams while it is alive. An opt-in smoke test, `tests/channels.imessage.smoke.test.ts`, checks both.

Provider reference: <https://photon.codes/docs/spectrum-ts/providers/imessage>.

### WhatsApp (Photon)

Sends WhatsApp Business messages, 1:1 only, through the same shared `photon` credential as iMessage. Enable WhatsApp for the project in the Photon dashboard first. Receiving is not supported.

```yaml
connections:
  - id: orders-whatsapp
    provider: whatsapp
    credential: photon-main
```

```yaml
# in a stage
channels:
  - connection: orders-whatsapp
    to: "+14155550123"
    template:
      name: order_update
      languageCode: en_US
      bodyParams: ["Order team", "{{message}}"]
    operations: [send]
```

- **The 24-hour rule.** WhatsApp accepts free-form text only within 24 hours after the recipient last wrote to your number. Outside that window the send fails with `CHANNEL_WINDOW_CLOSED` (Meta error 131047). A stage that writes first, such as a scheduled run, must pin an **approved template**. Without `template`, the entry sends free-form text and is only safe for replies to recent conversations.
- **Templates.** `name` is the approved template name, `languageCode` its language (`en`, `en_US`), `bodyParams` the positional body parameters (`{{1}}`, `{{2}}`, up to 10, 1024 characters each). Only body text parameters are supported; header and button components are not. Put `{{message}}` in a parameter and Stageflow fills it with the agent's message (a subject becomes a prefix `Subject: ...`). Newlines and tabs are replaced with spaces because template parameters cannot hold them. A message that makes a parameter empty or too long is refused before sending.
- **Targets.** `to` is an E.164 number. Lists and `cc` are rejected.
- **Live check.** Issuing a WhatsApp token proves the credentials work and that the project has at least one WhatsApp line. It cannot know whether a recipient's window is open.
- **SDK.** Same optional Spectrum packages as iMessage. Each send starts and stops it.
- Not supported yet: connecting your own Meta app directly (without Photon), template header and button components, and media.
- **Not verified against a real project:** how the SDK surfaces Meta error codes. Stageflow reads the code from the error's `code`, a nested `error.code`, or the message text; anything else is an unknown outcome and is never resent.

Provider reference: <https://photon.codes/docs/spectrum-ts/providers/whatsapp-business>.
