# Artifact index (operate)

Find, inspect, publish, and delete **indexed** and **published** artifacts. Run workspace files without an index row still use `run_files` or `sf artifact read --run --path`.

## Contents

- [Console](#console)
- [CLI](#cli)
- [MCP](#mcp)
- [Backup](#backup)
- [Indexed versus published](#indexed-versus-published)
- [Confirm first](#confirm-first)

## Console

**Artifacts** is in the Activity group (`#/artifacts`). Filters match the list API: `kind`, `owner`, `tag`, `status` (`available` / `expired`), `sort`, `project_root`, and search `q`. A row opens `#/artifacts/<ownerKey>/<id>`; older versions use `?v=<N>`.

Run-scoped files stay under **Pipeline runs** → stage → **Artifacts** tab (`#/runs/<runId>/artifacts?path=…`).

## CLI

Host-down for list/show when the schema is current; publish and delete need a Host.

| Command | Purpose |
|---|---|
| `sf artifact list` | Table or `--json` page. Filters: `--project-root`, `--kind`, `--owner`, `--tag`, `--status`, `--live`, `--sort`, `--order`, `--q`, `--limit`, `--cursor`. |
| `sf artifact show <ownerKey>/<id>` | Summary; `--json` for the record. `--project-root` when ambiguous. |
| `sf artifact publish` | Copy a file into the keep store (`--owner`, `--id`, `--kind`, `--title`, `--file` or `--stdin`). Source recorded as `console`. |
| `sf artifact delete <ownerKey>/<id>` | Remove every published version (irreversible). Indexed-only rows → `artifact.not_deletable`. |
| `sf artifact read --run --path` | Read a **run workspace** file by path, not the index. |

Owner key form: `stage:<pipeline>:<stage>/<id>` or `agent:<id>/<id>` (CLI also accepts `pipeline:stage` for `--owner` on publish).

## MCP

Load toolset `artifacts` (`/mcp?toolsets=artifacts` or `all`). Groups: `artifacts.read`, `artifacts.write`, `artifacts.refresh` (external), `artifacts.cleanup`.

| Tool | Group | Use |
|---|---|---|
| `get_artifact` | read | `list: true` with the same filters as the API, or `key` + `view`: `record`, `versions`, `content`, `data` (live snapshots; static is `artifact.not_live`). |
| `save_artifact` | write | Same body as REST publish; explicit `owner`. `live.declarative` and `live.html` take `manifest`. Source `mcp`. |
| `refresh_artifact` | refresh | Runs read-only bindings. `key`, optional `binding_ids`. |
| `delete_artifact` | cleanup | Deletes all versions of a **published** artifact. |

Hidden eval publishes never appear. `project_root` disambiguates duplicate keys across projects.

## Backup

`sf backup` and `sf archive` copy **keep-class** paths: `state.db` artifact tables and the `artifacts/` directory under `$STAGEFLOW_HOME`. Run workspace bytes under `runs/` stay disposable unless you archive the whole tree. Restore without `artifacts/` bytes warns that rows may point at missing files.

## Indexed versus published

| | Indexed (`origin: indexed`) | Published (`origin: published`) |
|---|---|---|
| Created | Success envelope lists the path | `publish_artifact`, `sf artifact publish`, `save_artifact` |
| Bytes | Run workspace | `$STAGEFLOW_HOME/artifacts/<hash>/v<N>/` |
| Expiry | Follows run retention | Does not expire with the run |
| Delete | With run / retention | `sf artifact delete` / `delete_artifact` only |

## Confirm first

Ask before `sf artifact delete`, MCP `delete_artifact`, or `save_artifact` / `sf artifact publish` when the user did not ask to publish. Deletes are irreversible. Publishing overwrites the indexed row for the same key from then on (published wins).

Authoring stage `artifacts:` and prompts: `stageflow-pipelines` → `references/artifacts.md`. Agent grants: `stageflow-agents` → `references/tools-and-approvals.md`.