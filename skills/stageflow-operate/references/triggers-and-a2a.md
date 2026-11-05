# Triggers and A2A

Fire and inspect triggers. Manage who can call published pipelines. Designing the trigger or the publication YAML is the `stageflow-pipelines` skill. This file is the operate path.

Confirm before `fire_trigger`, `sf trigger fire`, `create_trigger`, `update_trigger`, `set_trigger_enabled`, and any `sf a2a` change that enables the server, adds a caller, or publishes a pipeline. Firing calls models. An enabled schedule or event trigger starts runs on its own. A caller token and a publication are visible outside this machine.

## Contents

- [Triggers on the CLI](#triggers-on-the-cli)
- [Create, update, enable](#create-update-enable)
- [Trigger secrets](#trigger-secrets)
- [A2A on the CLI](#a2a-on-the-cli)
- [A2A with no CLI verb](#a2a-with-no-cli-verb)

## Triggers on the CLI

`sf trigger` always starts a Host when one is not up. Verbs, from `sf trigger --help`:

| Command | Role |
|---|---|
| `sf trigger list --json` | Catalog triggers. |
| `sf trigger show <id> --json` | One trigger. |
| `sf trigger fire <id> [--task-inline '<json>'] --json` | Start a run. Same completion contract and exit codes as `sf run` (0 succeeded, 1 failed, 2 waiting). |

`--task-inline` is required for a dynamic trigger (one with no catalog task) and rejected for a trigger that already names a task. The object matches a task file: `id`, `goal`, and optional `context`, `constraints`, `input`, and either `repository` plus `ref` or `checkout`.

MCP equivalents, which return immediately: `list_triggers`, `get_trigger` (`id`, optional `project_root`), `fire_trigger` (`id`, optional `project_root`, optional `task`). `fire_trigger` returns `{ "runId" }` or `{ "runId", "queued": true, "queuePosition" }`. A disabled trigger fails with status 409. An unknown id is 404. The same id in two catalog roots is 409 until you pass `project_root`.

There is no delete verb on the CLI, in MCP, or in REST. To stop a trigger from firing, disable it.

## Create, update, enable

The CLI cannot create or enable a trigger. Use MCP or REST.

| Action | MCP | REST |
|---|---|---|
| Create | `create_trigger` | `POST /api/triggers` |
| Replace the definition | `update_trigger` | `PUT /api/triggers/<id>` |
| Enable or disable | `set_trigger_enabled` with `{ "id", "enabled" }` | `PATCH /api/triggers/<id>` with `{ "enabled": true \| false }` |

`create_trigger` fields: `directory`, `id`, `pipeline`, optional `task` (omit for a dynamic trigger), optional `enabled`, optional `project_root`, and `kind`.

| `kind` | Also required |
|---|---|
| `manual` | nothing else |
| `schedule` | `schedule.cron`, optional `schedule.timezone` |
| `event` | `event.source`, optional `event.match`, optional `event.config` |

`update_trigger` sends the full definition (`pipeline`, `kind`, `enabled`, and the schedule or event). The id does not change. An enabled schedule starts runs without another confirmation later, so say that in the confirm you ask for now.

List and status routes that have no MCP twin: `GET /api/triggers/<id>/status` and `GET /api/triggers/<id>/fires`. Webhook intake is `POST /api/triggers/<id>/webhook`. Callers authenticate with the trigger's HMAC, not with the control token. Do not invent a signature.

## Trigger secrets

Webhook, `github.*`, and `email.message` event triggers can hold a signing secret. The CLI does not set it. MCP `create_trigger` and `update_trigger` have no secret argument.

The user enters it in the operator console, or you pass it once on REST, from the harness secret prompt, never from chat:

- `POST /api/triggers` or `PUT /api/triggers/<id>` may include `"secret": "<from the harness secret prompt>"`.
- On edit only, `"clear_secret": true` removes it. Do not send `secret` and `clear_secret` together.
- The response includes `secret_set: true` or `false` and never the secret.

The Host stores it under a `store:` reference derived from the trigger id. A plain env name in `event.config.secretRef` is the other form (the variable or `<NAME>_FILE` on the Host). Prefer the console or the REST `secret` field so the value is not written into the trigger file.

## A2A on the CLI

Two families. The management verbs talk to the Host and autostart it. `validate`, `list`, and `add-caller` edit or read a file and do not start a Host.

Management (`--json` prints the response body on success):

| Command | REST |
|---|---|
| `sf a2a status` | `GET /api/a2a/status` |
| `sf a2a enable [--public-url <url>]` | `POST /api/a2a/enable` |
| `sf a2a reload` | `POST /api/a2a/reload` |
| `sf a2a caller list` | `GET /api/a2a/callers` |
| `sf a2a caller create <id>` | `POST /api/a2a/callers` |
| `sf a2a caller revoke <id>` | `DELETE /api/a2a/callers/<id>` |
| `sf a2a publication list` | `GET /api/a2a/publications` |
| `sf a2a publication create <file>` | `POST /api/a2a/publications` |
| `sf a2a publication edit <id> <file>` | `PATCH /api/a2a/publications/<id>` |
| `sf a2a publication remove <id>` | `DELETE /api/a2a/publications/<id>` |

`sf a2a caller create` prints the new caller's token once. The Host stores only the SHA-256. Copy it into the user's secret store. Do not repeat it in chat. If the command ran without `--json`, the token is on stdout in the human lines. With `--json`, it is inside the JSON body: still do not quote it back.

File verbs:

| Command | Role |
|---|---|
| `sf a2a validate [--config <path>]` | Check the file. |
| `sf a2a list [--config <path>]` | Validate and print the publications. A running Host picks this up only after `sf a2a reload`. |
| `sf a2a add-caller <id> [--config <path>] [--token-env <NAME>]` | Append a caller that reads `token_env`. The command prints a generated token once and tells the user which variable to export. The running Host reads that variable at start. For a caller that works without a restart, use `sf a2a caller create` instead. |

When `--config` is omitted, `STAGEFLOW_A2A_CONFIG` wins. Otherwise an existing `a2a.yaml` next to `stageflow.yaml` is used, then an existing `$STAGEFLOW_HOME/a2a.yaml`. `validate` and `list` stop if none of those exist. `add-caller` creates `<project>/a2a.yaml` in that case.

A publication file is YAML or JSON:

| Field | Required |
|---|---|
| `id`, `name`, `description`, `project_root`, `pipeline`, `goal`, `allowed_callers`, `results.stage` | yes |
| `results.include_payload` | defaults to true |
| `results.artifacts` | defaults to `[]` |
| `caller_answerable_stages` | defaults to `[]` |
| `input_schema` | path inside the project; omitted means the entry stage's `io.input.schema` |
| `repository` and `ref` | both, or neither |

`project_root` is a catalog project. `pipeline` and `input_schema` are paths inside it. `allowed_callers` names caller ids that already exist.

There is no MCP tool for A2A. REST uses the same paths as the table above, with a drive token.

## A2A with no CLI verb

These exist only on REST:

| Action | Call |
|---|---|
| Disable the A2A server | `POST /api/a2a/disable` |
| One publication | `GET /api/a2a/publications/<id>` |
| Preview a publication body | `POST /api/a2a/publications/preview` |
| Stages a pipeline can publish | `GET /api/a2a/pipeline-stages?project_root=&pipeline=` |

`sf a2a` has no `disable`, `show`, or `preview`. When the user asks to turn A2A off, call `POST /api/a2a/disable`. Do not invent an `sf a2a disable` command.

An autostart failure on the management verbs is a stderr line and exit `1`, including when `--json` was passed. See [control-surface.md](control-surface.md#autostart).
