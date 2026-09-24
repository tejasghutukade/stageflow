---
layout: default
title: Data Directory
---

# Data directory

Stageflow keeps the SQLite run store, run workspaces, Host Pi agent files, and related state under one **durable root**. Override it with `STAGEFLOW_HOME`. When unset, the default is `~/.stageflow`.

The Host is **machine-global**: where `sf ui` / `sf mcp` was started does not define which projects exist. Catalog roots are **seeded** examples plus **registered** absolute project folders stored in the durable SQLite store (not only past-run history). Local `sf run` registers its resolved project folder before start; remote MCP/HTTP may only use already-registered or seeded roots. See [MCP — catalog roots](mcp.md#catalog-roots-and-project_root) and [CLI — `sf run`](cli-reference.md#sf-run).

Per-project settings stay at `<git-root>/.stageflow/settings.json`. They are not the run store.

See also [CLI reference — Storage locations](cli-reference.md#storage-locations) and [Providers](providers.md).

## Layout

| Path under `$STAGEFLOW_HOME` | Keep / disposable | Notes |
|------------------------------|-------------------|-------|
| `state.db` (+ `-wal`, `-shm`) | **keep** | Run store (SQLite, WAL mode), including the durable **projects registry** |
| `settings.json` | **keep** | Global settings (credential source, concurrency, …) |
| `agent/auth.json` | **keep** | Stageflow-owned provider credentials (`sf_owned`) |
| `agent/` | **keep** | Host Pi agent directory (`PI_CODING_AGENT_DIR` for the Host process) |
| `runs/` | disposable | Per-run workspaces, stage attempts, artifacts |
| `a2a-artifacts/` | disposable | A2A artifact bytes |
| `repos/` | disposable | Shared bare-clone cache (`repos/<host>/<owner>/<repo>.git`); Host-owned, used for repository-bound runs |
| `worktrees/` | disposable | Per-run checkouts (`worktrees/<runId>`); Host-owned, created on repository-bound start |
| `cache/` | disposable | Reserved name; this release creates `cache/jiti` when the jiti MCP fallback runs |
| `backups/` | disposable | `sf backup` archives (default output) |
| `restore-pending/` | disposable | Staged API restore archives + marker |
| `service.log` | disposable | Detached Host autostart log (stays at the root) |

For the operator keep-table and why `cp state.db` is unsafe, see [Docker and self-hosting](docker.md).

Stage workers do **not** use `$STAGEFLOW_HOME/agent/` as their Pi agent directory. Each stage attempt binds `PI_CODING_AGENT_DIR` to a per-attempt directory under that run's workspace (`runs/<runId>/stages/<stageId>/attempts/<n>/.pi-agent`).

Credential choice is unchanged: a saved setting, otherwise a usable `~/.pi/agent/auth.json`, otherwise `agent/auth.json` under the durable root.

Stage agents' Pi `read`, `write`, and `edit` tools deny paths whose real path is inside the durable root and outside that run's workspace (`stageflow_path_denied`). That is defence in depth, not a sandbox — `bash` is not path-restricted.

## Container image user and volumes

The published image runs as **`10001:10001`** (`stageflow`). Named volumes are the default mount for the durable root. The process never recursively changes ownership of the data root on boot — if the volume is not writable by that uid/gid, startup fails with a message that includes the live uid and a `chown` hint.

## Version support

- **Patch versions** of Stageflow are interchangeable against the same database schema.
- **Minor versions** are upgrade-only: a newer binary may migrate the store forward; an older binary that cannot read the on-disk schema version refuses to open it.
- Rolling a **newer database** back to an older Stageflow binary means **restoring a backup**, not opening the newer file with the older image.
