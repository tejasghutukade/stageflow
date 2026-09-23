---
layout: default
title: Docker and self-hosting
---

# Docker and self-hosting

This page describes Stageflow’s **finished** data-safety and ops contracts for self-hosted Hosts (including containers). The Dockerfile / GHCR publish job consume these values; they are not shipped in this slot.

See also [Data directory](data-directory.md), [CLI reference](cli-reference.md), and [MCP](mcp.md).

## Precious vs disposable

| Path under `$STAGEFLOW_HOME` | Verdict | Why |
|---|---|---|
| `state.db` (+ `-wal`, `-shm`) | **Irreplaceable** | Every run, stage, envelope, event, verification record, and A2A rows. Only ever copy via `sf backup`. |
| `agent/auth.json` | **Irreplaceable** | Provider credentials. |
| `settings.json` | **Irreplaceable** | Concurrency and credential-source choice. |
| `runs/<runId>/` | Situational | Artifact bytes; records live in `state.db`. |
| `a2a-artifacts/` | Situational | Opt in with `sf backup --include-a2a-artifacts`. |
| `repos/`, `worktrees/`, `cache/` | Disposable | Re-clonable / rebuildable. |
| `backups/`, `restore-pending/` | Disposable | Products of backup/restore. |

A volume snapshot of the whole data directory is **not** a substitute for `sf backup` — it is larger, includes disposable trees, and is taken while the WAL is moving.

## Why `cp state.db` corrupts

Stageflow runs SQLite in **WAL mode**. Committed transactions often live in `state.db-wal`, not yet folded into `state.db`. Concurrent Host + stage workers hold their own connections.

- `cp state.db` alone silently drops recent commits.
- Copying `state.db` + `-wal` + `-shm` as three separate operations tears consistency under multi-writer load.
- Live `tar` / `rsync` / volume snapshots have the same problem.

Use `sf backup` (`VACUUM INTO` + verified archive) while the Host is up.

## Backup / restore runbook

```bash
# Live backup (default archive includes credentials at mode 0600 — treat as a secret)
sf backup --json

# Restore requires Host down (CLI probes GET /livez; never autostarts)
sf restore "$STAGEFLOW_HOME/backups/stageflow-….tar.gz" --json
```

HTTP (control token, **drive** scope for backup create/download and restore):

- `POST /api/backup` → metadata `{ path, bytes, sha256, schema_version, stageflow_version, created_at, contents }`
- `GET /api/backup/<name>` → archive bytes (name resolved under `$STAGEFLOW_HOME/backups`)
- `POST /api/restore` with `{ "backup": "<name>" }` → verify → stage → **202** → graceful drain; next boot applies before opening the store

Failed apply twice → `restore.failed`; readiness and API/MCP refuse until the marker is cleared. Previous store files are left in place (never silently served as a successful restore).

MCP tools for backup/restore are deferred; agents should use the HTTP path above while a Host is running. See [MCP](mcp.md#backup-export-and-restore).

## Local volume boundary

`$STAGEFLOW_HOME` must sit on a **local** filesystem. Boot refuses `nfs` / `nfs4` / `cifs` / `smbfs` / `fuse.sshfs` (`store_unsupported_filesystem`) unless `STAGEFLOW_ALLOW_NETWORK_STORE=1` (loud warning, unsupported). `9p` / `virtiofs` warn only (Docker Desktop). Detection is Linux `mountinfo` longest-prefix; non-Linux skips. Overlay/bind-over-NFS may report a local fstype — prefer named volumes.

Rich health reports `store_filesystem`.

## Writable paths and `read_only: true`

Supported writable set: `$STAGEFLOW_HOME` and an explicit writable `TMPDIR` (also used as `SQLITE_TMPDIR` when unset). Boot fails with `tmpdir_unusable` if `TMPDIR` is missing or not writable.

## Logging budget

Stdout is lifecycle-oriented. Per-line bytes are capped (`STAGEFLOW_LOG_MAX_LINE_BYTES`, default `8192`) with truncation markers. Transcripts stay in the run store under retention. Prefer a Docker `logging.driver: local` with size rotation in compose.

## Upgrade / rollback

- Patch releases: interchangeable store-wise when schema is unchanged.
- Minor: upgrade-only for schema advances (Slot 1 downgrade guard).
- Cross-minor rollback: restore from a backup taken before the upgrade.

## Provenance

| OCI label | Value |
|---|---|
| `org.opencontainers.image.source` | `https://github.com/tejasghutukade/stageflow` |
| `org.opencontainers.image.revision` | `${{ github.sha }}` — **identical to `STAGEFLOW_BUILD_SHA`** |
| `org.opencontainers.image.version` | `package.json` version |
| `org.opencontainers.image.created` | RFC 3339 build time |
| `org.opencontainers.image.licenses` | `MIT` |
| `org.opencontainers.image.title` | `Stageflow` |
| `org.opencontainers.image.base.name` / `.base.digest` | pinned base |

`BUILD_SHA` is `process.env.STAGEFLOW_BUILD_SHA ?? "unknown"` and appears on `/api/health`, MCP `get_health`, and `sf --version --json`.

**Labels are hints; attestations are evidence.** Anyone with push access can set labels. Verify digests with cosign:

```bash
cosign verify \
  --certificate-identity-regexp '^https://github\.com/tejasghutukade/stageflow/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/tejasghutukade/stageflow@sha256:<digest>
```

## Egress threat model (report-only)

Stages run with shell tools and inherit curated proxy/CA variables. Stageflow does **not** ship an allowlisting egress proxy. Health reports whether proxy vars are set (hostname only, never userinfo) and whether the Node `EnvHttpProxyAgent` dispatcher is installed.

Reference posture: Host on an `internal: true` network behind a domain-allowlisting forward proxy; `NO_PROXY` must include loopback for Host self-probes.

### Reference compose (documentation only — not a shipped file)

```yaml
services:
  stageflow:
    image: ghcr.io/tejasghutukade/stageflow@sha256:<digest>
    networks: [internal]
    environment:
      STAGEFLOW_HOME: /data
      STAGEFLOW_BIND: 0.0.0.0
      STAGEFLOW_CONTROL_TOKEN_FILE: /run/secrets/control_token
      STAGEFLOW_BUILD_SHA: "<git sha>"
      TMPDIR: /data/tmp
      HTTPS_PROXY: http://egress-proxy:3128
      HTTP_PROXY: http://egress-proxy:3128
      NO_PROXY: 127.0.0.1,localhost,egress-proxy
    volumes:
      - stageflow-data:/data
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    logging:
      driver: local
      options: { max-size: "10m", max-file: "5" }
    restart: unless-stopped
  egress-proxy:
    image: <your-allowlisting-proxy>
    networks: [internal, egress]
networks:
  internal:
    internal: true
  egress:
volumes:
  stageflow-data:
```

## Continuous replication

Litestream (or similar) can replicate `state.db` for disaster recovery; it is **not** a substitute for `sf backup` under live multi-writer WAL. Prefer `sf backup` for operator restore points.
