# Connections and channels

Create, check, replace, enable, and remove Host connections, and handle a stage send. Authoring a stage's `channels:` block is the `stageflow-pipelines` skill. This file is the operate path.

There is no `sf` verb for connections. Use MCP when the Host is up, or REST on the same base URL as [control-surface.md](control-surface.md). Drive scope is required for every method except `GET`.

## Contents

- [Secrets](#secrets)
- [Providers](#providers)
- [Create](#create)
- [Check](#check)
- [Replace a key, rename, enable](#replace-a-key-rename-enable)
- [Remove](#remove)
- [Stage send](#stage-send)

## Secrets

The user enters a secret in the operator console's connection form, or through this harness's secret prompt. The value goes straight into the tool argument or the REST body. It never appears in chat, a command line you echo, YAML, a log, or a file you write.

`create_connection` and `update_connection` take secret values as arguments (`secrets`, and for Photon `credential.secrets`). The Host stores them and does not return them. `list_connections` shows each secret field as `"env"` or `"store"`. A failure answer is a code, never the request body.

YAML that refers to a secret uses an env reference the user already exported, such as `botToken: env:SLACK_BOT_TOKEN`. Do not put the raw value in that file.

Confirm before `create_connection`, `update_connection`, `remove_connection`, and `test_connection`. `test_connection` makes a live provider call with the values you pass.

## Providers

`GET /api/connections/meta` returns each provider's field list (which keys are secrets, which are config) and the error codes. It returns no secret values. Prefer that list when the Host is up. The providers in this checkout:

| Provider id | Secret keys | Config keys | How the secret is passed |
|---|---|---|---|
| `slack` | `botToken` (required), `inboundSecret` (optional) | `teamId` (optional) | `secrets` |
| `telegram` | `botToken` (required), `inboundSecret` (optional) | `botUsername` (optional) | `secrets` |
| `agentmail` | `apiKey` (required), `inboundSecret` (optional) | `inbox` (required), `region` (`us` or `eu`, default `us`) | `secrets` |
| `imessage` | `projectId`, `projectSecret` (Photon credential) | none | `credential.secrets` |
| `whatsapp` | same Photon credential | none (a template is pinned on the stage, not on the connection) | `credential.secrets` |

iMessage and WhatsApp share a Photon credential. Sending needs the optional Spectrum packages on the Host. A missing package fails with `CHANNEL_PROVIDER_UNSUPPORTED`.

Recipients are pinned on the stage. The connection does not choose who receives a message. `validate_connection_target` checks a recipient against the provider rules. It does not call the network and does not read the secret. Arguments: `id`, `to`, optional `cc`, optional `template`.

## Create

MCP `create_connection`. REST `POST /api/connections` (201). Same body.

```json
{
  "provider": "slack",
  "id": "ops-slack",
  "displayName": "Ops Slack",
  "config": { "teamId": "T0123ABCD" },
  "secrets": { "botToken": "<from the harness secret prompt>" }
}
```

Omit `id` to let the Host choose one. Photon:

```json
{
  "provider": "imessage",
  "credential": {
    "secrets": {
      "projectId": "<from the harness secret prompt>",
      "projectSecret": "<from the harness secret prompt>"
    }
  }
}
```

`credential` may instead be the id of a credential that already exists. Success is `{ "id", "health" }`. `health` is `{ "state": "ok" | "failed", "checkedAt", "error"?: { "code", "retryable" } }`. The secret is not in the result.

`test_connection` takes the same body as create, calls the provider, and writes nothing. The tool is annotated read-only. It still sends the secrets you pass and makes a live call. Confirm first. REST: `POST /api/connections/test`.

## Check

A re-check of a saved connection is REST only:

`POST /api/connections/<id>/check`

There is no MCP tool and no CLI verb for that path. `test_connection` does not read a saved connection. `GET /api/connections` returns the last health the monitor has, which can be stale. Use `check` when the user asks whether a saved connection works now.

Success is the health object. An unknown id is 404 `{ "code": "CHANNEL_NOT_FOUND" }`.

## Replace a key, rename, enable

MCP `update_connection`. REST `PATCH /api/connections/<id>`.

| Change | Arguments |
|---|---|
| Replace one secret | `secrets` with the fields to replace. Omitted secret fields stay as they are. |
| Enable or disable | `enabled: true` or `enabled: false`. A disabled connection cannot be used by a stage. |
| Rename | `displayName`, or `null` to clear it. |
| Non-secret settings | `config`. |

```json
{
  "id": "ops-slack",
  "secrets": { "botToken": "<from the harness secret prompt>" }
}
```

When the connection stays enabled, the result is `{ "health" }`. When it is disabled, the result is `{}`. Secret values are not in the result.

## Remove

MCP `remove_connection` with `{ "id" }`. REST `DELETE /api/connections/<id>`. Both delete the connection and its stored secrets. Result: `{ "removed": true }`. Confirm first. This cannot be undone.

## Stage send

A stage sends with its `send_message` tool. The recipient comes from the stage definition. Arguments are `text`, `operationKey`, and optional `channel` (when the stage declares more than one alias) and `subject`. You do not call `send_message` from this skill. You interpret the outcome the stage recorded, and you do not tell the stage to send again until the user decides.

| Code | What to do |
|---|---|
| `CHANNEL_SEND_OUTCOME_UNKNOWN` | The message may have reached the provider. Ask the user to check the destination. Do not send it again, and do not retry with a new `operationKey`. Stageflow will not resend it on its own, including after a restart. |
| `CHANNEL_OPERATION_CONFLICT` | That `operationKey` was already used for different content. Leave it. |
| Definite failure (`CHANNEL_CONNECTION_FAILED` on a refused connection, DNS or TLS error, or a 4xx such as `CHANNEL_AUTH_FAILED`, `CHANNEL_TARGET_INVALID`) | Retryable only when the user asks, and only under a new `operationKey`. |
| `CHANNEL_RATE_LIMIT`, `CHANNEL_TIMEOUT` | Retryable provider limits. Still confirm before another send. |
| `CHANNEL_RECIPIENT_REJECTED` | The provider refused that pinned recipient. Fix the stage or the provider setup. Do not pick a new recipient in chat. |
| `CHANNEL_WINDOW_CLOSED` | WhatsApp's 24-hour window is closed. A template pinned on the stage is what sends first. |
| `CHANNEL_SECRET_UNAVAILABLE` | The env secret is not set on this Host. The user sets the variable or replaces the stored key. |

Acceptance means the provider accepted the submit. It does not mean a person read it.
