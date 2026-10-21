# Guide: an agent that answers iMessage (Photon)

The Host holds a stream open to a [Photon](https://photon.codes) (Spectrum) project, so **no public URL is needed**.

## 1. Prerequisites

- The optional packages `@spectrum-ts/core` and `@spectrum-ts/imessage` (`npm install --omit=optional` leaves them out; add them yourself). Without them the connection is `CHANNEL_PROVIDER_UNSUPPORTED`.
- A Photon project id and secret.

## 2. Connect

```yaml
credentials:
  - id: photon-main
    provider: photon
    secrets:
      projectId: env:PHOTON_PROJECT_ID
      projectSecret: env:PHOTON_PROJECT_SECRET
connections:
  - id: agent-imessage
    provider: imessage
    credential: photon-main
```

Or use **Connections → Add connection** in the console. Details: [Channels — iMessage](channels.md#imessage-photon).

## 3. Bind an agent

```yaml
channel:
  connection_id: agent-imessage
  allow_from: ["+14155550123"]
limits:
  always_on: true
```

`allow_from` takes E.164 phone numbers (or `*`). Group chats are ignored. One conversation per sender; `always_on: true` is recommended, and then an interrupted turn is retried once after a Host restart without asking the question twice.

## Which number do people text?

Numbers belong to the Photon project, not the agent.

| Photon project | Who texts what |
|----------------|----------------|
| Free / Pro (shared pool) | Register each person as a user in Photon; each is assigned a number (it can differ per person) and must text it once first |
| Business (dedicated lines) | Everyone texts the project's line |

The agent editor shows it ("Jane (+1415…) texts +1999…", "Text +1415… to reach this agent") and warns when an allowed phone is not registered. An agent that needs its own number needs its own Photon project and credential; one project cannot serve two agents (`agent.channel_in_use`).

## Troubleshooting

| You see | Cause and fix |
|---------|---------------|
| No answer | Agent disabled; sender not in `allow_from`; the person has not texted their assigned line once; or it is a group chat |
| **Reconnecting** | Project id or secret wrong, or no network. Use **Check now** on the connection |
| `CHANNEL_RECIPIENT_REJECTED` on a reply | The sender is not a project user, or the handle in Photon is not the one Apple sends from (see [Channels](channels.md#imessage-photon)) |
| Warning that an allowed phone is not registered | Add that number under Users in the Photon dashboard |
| `CHANNEL_PROVIDER_UNSUPPORTED` | The `@spectrum-ts/*` packages are missing |
| Reply not delivered | [Replies that do not arrive](agents.md#replies-that-do-not-arrive) |
