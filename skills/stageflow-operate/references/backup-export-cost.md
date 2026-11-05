# Backup, export, retention, and cost

Snapshot the Host's store, copy run records out, and read what a run cost. Confirm before `sf backup` and `sf restore`. A default backup can hold provider credentials. A restore replaces the store.

## Contents

- [Backup](#backup)
- [Restore](#restore)
- [Export](#export)
- [Retention](#retention)
- [Cost](#cost)

## Backup

`sf backup` reads the store. It starts a Host only when `state.db` is missing or the schema is older than this binary.

```
sf backup [--out <file>] [--db-only] [--no-credentials] [--include-a2a-artifacts] [--json]
```

The default `--out` is under `$STAGEFLOW_HOME/backups/`. The default archive includes provider credentials and is mode `0600`. Treat that file as a secret: do not commit it, paste it, or attach it to chat. Pass `--no-credentials` when the user wants a snapshot without those secrets. `--db-only` writes the database without the credential files. `--include-a2a-artifacts` adds A2A artifact bytes, which the default archive leaves out.

`--json` prints `{ "path", "bytes", "sha256", "schema_version", "stageflow_version", "created_at", "contents" }`. `contents` is a list of `state.db`, `settings.json`, `agent/auth.json`, `a2a-artifacts`, and `manifest.json`, depending on the flags. Exit `0` on success, `1` on failure. The CLI also prints a credential warning on stderr when the archive may contain them.

REST, with the Host up and a drive token: `POST /api/backup` creates one. An empty body uses the same defaults as the CLI. Optional fields are `out`, `db_only`, `no_credentials`, and `include_a2a_artifacts`. `GET /api/backup/<name>` downloads a file under `backups/`. Both require drive scope, including the GET.

## Restore

`sf restore` refuses while a Host is up.

```
sf restore <file> [--force] [--json]
```

It probes `GET /livez`. If that returns 200 and JSON, the command exits `1` with `restore_host_live` and does not spawn a Host. Stop `sf ui` or `sf mcp` first, then restore. The previous `state.db` is moved aside, not deleted.

`--json` on success is `{ "ok": true, "schema_version", "missing_a2a_artifact_rows", "pre_restore_stamp" }`. `missing_a2a_artifact_rows` counts A2A artifact rows whose bytes were not in the archive. A version mismatch (archive major version different from this binary) fails with `restore_version_mismatch`.

With the Host still up, do not use the CLI. `POST /api/restore` with `{ "backup": "<name under backups/>" }` stages the archive, returns 202 `{ "ok": true, "staged", "drain_deadline" }`, and drains the Host. The next boot applies it. `path` is accepted as an alias of `backup`. This route does not take an arbitrary filesystem path outside the backups directory.

An export stream is not a backup. `sf restore` will not apply it.

## Export

| Command | What it writes | Host |
|---|---|---|
| `sf export-run --run <id> [--from <sf-run.json>] [--out <file>]` | One run as JSON. `--out` must stay under the current directory. | Starts a Host only if the store needs a migration. |
| `sf export --all [--status <status>] [--since <iso>] [--pipeline <id>] [--out <file>]` | NDJSON: a header line, then one projected run per line, including runs that are not finished. | Same. |
| `sf debug-run <runId> [--out <file>]` | A capped, redacted post-mortem. | Same. |
| MCP `export_run` | One run, while the Host is up. | Required. |

The `sf export --all` header is `{ "type": "stageflow_export", "version": 1, "stageflow_version", "created_at", "filter"? }`. There is no `--json` flag; the stream is the output. It is a copy of run records for inspection. It does not restore a Host.

REST: `GET /api/runs/<id>/export`, `GET /api/runs/<id>/debug-bundle`, `GET /api/export`.

## Retention

Terminal runs are slimmed, then purged, by age of `finished_at`. Defaults:

| Status | Slim after | Purge after |
|---|---|---|
| `succeeded` | 3 days | 30 days |
| `failed` | 30 days | 90 days |
| `cancelled` | 30 days | 90 days |

Overrides, in milliseconds: `STAGEFLOW_SLIM_SUCCEEDED_MS`, `STAGEFLOW_PURGE_SUCCEEDED_MS`, and the same pair with `FAILED` and `CANCELLED`. A bare cache older than `STAGEFLOW_BARE_CACHE_TTL_MS` (default 30 days) is evicted with the sweep. Slim keeps artifacts up to `STAGEFLOW_SLIM_ARTIFACT_MAX_BYTES` (default 1 MiB) and drops the rest of the workspace bulk.

The Host runs this sweep on its own. To run it now:

| Surface | Dry run | Execute |
|---|---|---|
| CLI | `sf runs gc --dry-run --json` | `sf runs gc --json` executes. It is not a dry run. |
| MCP | `gc_runs` with `execute` omitted or false | `gc_runs` with `execute: true` |

Confirm before an executing sweep. Slim and purge cannot be undone. JSON is `{ "slimmed": ["<runId>"], "purged": ["<runId>"], "bareCachesEvicted": ["<runId>"] }`. A dry run fills those arrays with the candidates and changes nothing. A run that is not terminal is left alone. `sf runs show` includes `slimmed_at` after a slim.

`sf runs delete --run <id> --json` removes one run. A run that is not finished needs `--force` (MCP `delete_run` with `force: true`). Confirm first. Success is `{ "ok": true, "runId" }`.

## Cost

Stageflow reports cost when a stage or a session recorded provider usage. Absent means not reported. Do not invent a number, and do not promise a cost before a run: the product does not estimate it.

| Where | Field |
|---|---|
| `sf run --json`, `sf runs show --json`, `get_run` | `total_cost_usd` on the run, `cost_usd` on each stage that reported usage. Omitted when nothing was reported. |
| `sf runs list --json` | `total_cost_usd` on each summary that has it. |
| `GET /api/overview?range=24h\|7d\|30d` | `totals.cost_usd`, `previous.cost_usd`, and `pipelines[].cost_usd` for runs in that window. No CLI or MCP twin. |
| `list_agent_sessions` | `costUsd` per session (null if unreported). |
| `get_health` | Disk and capacity, not spend. |

Say "not reported" when the field is missing. Per-stage figures are the ones to show next to `total_cost_usd` so a single expensive stage is visible. Agent-session cost is separate from pipeline-run cost; add them only when the user asked for a combined figure and label the two sources.
