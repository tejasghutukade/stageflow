---
layout: default
title: Docker and self-hosting
---

# Docker and self-hosting

This page describes Stageflow’s data-safety and ops contracts for self-hosted Hosts (including containers). A multi-stage `Dockerfile` at the repo root builds the image. Multi-arch GHCR publish (`ghcr.io/tejasghutukade/stageflow`) lands with the release workflow (Slot 10 unit U3); until then, build locally with Compose or `docker build`.

See also [Data directory](data-directory.md), [CLI reference](cli-reference.md), and [MCP](mcp.md) (including [CLI-only capabilities](mcp.md#cli-only-capabilities-decision-table) and [docker exec commands](#cli-via-docker-exec) below).

## Never mount the Docker socket

**Never mount `/var/run/docker.sock` (or any Docker API socket) into a Stageflow container.** Mounting the socket is a host-root escape: the process inside the container can control the Docker daemon as root on the host. Stageflow does not need Docker-in-Docker; do not use `--privileged` or grant extra capabilities for that purpose either.

The shipped root [`docker-compose.yml`](../docker-compose.yml) has no socket mount, no `privileged`, and no extra caps. The [hardened egress reference](#hardened-egress-reference-compose) below is documentation only — it is not a second product compose file.

## Local try (Compose)

From the repo root, generate a drive token (≥32 characters, no whitespace), then start the Host. The compose file builds the local `Dockerfile`, mounts a named volume at `/data`, publishes port **3847**, and sets `STAGEFLOW_HOME=/data` and `TMPDIR=/data/tmp` (`STAGEFLOW_BIND=0.0.0.0` is already in the image). This is a **local try** surface — not the hardened egress sandbox.

```bash
# Generate a 32+ character control token (required: image binds 0.0.0.0)
export STAGEFLOW_CONTROL_TOKEN="$(openssl rand -hex 32)"
# or: python3 -c 'import secrets; print(secrets.token_hex(32))'

docker compose up --build -d

# Health probe (no bearer; Host/Origin from localhost is fine)
curl -fsS http://127.0.0.1:3847/livez
# → {"ok":true,"status":"live",…}
```

Prefer a file secret when the token must not appear in the process environment on the host:

```bash
openssl rand -hex 32 > .stageflow-control-token
chmod 600 .stageflow-control-token
# Point STAGEFLOW_CONTROL_TOKEN_FILE at that path inside the container
# (e.g. bind-mount the file and set STAGEFLOW_CONTROL_TOKEN_FILE=/run/secrets/…),
# or pass STAGEFLOW_CONTROL_TOKEN from the env as above.
```

Override the default `sf mcp` command only when you need the operator console (`sf ui`); MCP-first remains the container default.

## Image smoke (CI / local)

Automated gate that the image boots and becomes live — **not** `sf doctor`. From the repo root (Docker daemon required):

```bash
./scripts/docker-smoke.sh
# → builds with STAGEFLOW_BUILD_SHA from git, runs with a temp volume +
#   32+ char control token, polls http://127.0.0.1:<port>/livez until 200,
#   tears down container/volume, exits 0
```

Mandatory bar: `GET /livez` → 200. Optional stretch flags: `--readyz`, `--check-build-sha` (asserts `/api/health` `build_sha` matches the baked SHA when the control token is sent). CI runs the same script from the `docker-smoke` job in `.github/workflows/ci.yml` when packaging-related paths change on a PR (always on `main`).

## Pull and run (GHCR)

Intended image name: **`ghcr.io/tejasghutukade/stageflow`**. After GHCR publish ships (U3), pull a digest-pinned tag and run with a named volume + control token:

```bash
export STAGEFLOW_CONTROL_TOKEN="$(openssl rand -hex 32)"
docker pull ghcr.io/tejasghutukade/stageflow:x.y.z   # or @sha256:<digest>
docker run --rm \
  -e STAGEFLOW_HOME=/data \
  -e TMPDIR=/data/tmp \
  -e STAGEFLOW_CONTROL_TOKEN \
  -v stageflow-data:/data \
  -p 3847:3847 \
  ghcr.io/tejasghutukade/stageflow:x.y.z
```

Verify cosign attestations with the [snippet below](#provenance) once digests are published. Prefer digest pins (`@sha256:…`) over floating tags for production.

To use a published image with the shipped compose file instead of a local build, set `image: ghcr.io/tejasghutukade/stageflow:x.y.z` (or a digest) and omit or skip `build:`.

## Derived images

The base image does **not** install `gh` or other pipeline-specific CLIs. When a catalog’s `requires:` needs extra tools, derive:

```dockerfile
FROM ghcr.io/tejasghutukade/stageflow:x.y.z
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends <your-tools> \
  && rm -rf /var/lib/apt/lists/*
USER stageflow:stageflow
```

Stageflow does not build derived images from `requires:` automatically — `requires` tells operators (and `sf doctor` / preflight) what the image must provide.

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

### Hardened egress reference compose {#hardened-egress-reference-compose}

Documentation only — **not** a shipped root file. Do not replace [`docker-compose.yml`](../docker-compose.yml) with this unmarked. Adapt for your proxy image and secrets store; still never mount `docker.sock`.

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

## CLI via `docker exec` {#cli-via-docker-exec}

A remote harness drives the Host over MCP/REST with a control token. Some CLI commands stay **exec-only** on purpose — see the decision table in [MCP — CLI-only capabilities](mcp.md#cli-only-capabilities-decision-table). Below are literal commands assuming the container is named `stageflow` (replace with your compose service / container id). Prefer catalog-relative paths the Host already knows; mount or bake catalog into the image as your deployment does.

### Exec-only commands

```bash
# ASCII pipeline diagram (humans). Harnesses: MCP describe_pipeline / get_run.
docker exec -it stageflow sf graph --pipeline examples/hello-world/hello.pipeline.yaml

# Rewrite legacy YAML keys in a checkout (authors on a laptop; not a Host API).
docker exec -it stageflow sf migrate-yaml /workspace/my-catalog --write

# Durable skill install for image bake or a mounted workspace.
# Harnesses: prefer start_run.skills (Slot 9) instead of install.
docker exec -it stageflow sf skills install --from-path /workspace/skills/my-skill
docker exec -it stageflow sf skills install --from-zip "https://example.com/skill.zip" \
  --skill-name my-skill

# A2A deployment config (boot-read; restart Host after changes).
# Read whether A2A is enabled without exec: GET /api/a2a/status (read token).
docker exec -it stageflow sf a2a validate --config /data/a2a.yaml
docker exec -it stageflow sf a2a list --config /data/a2a.yaml
docker exec -it stageflow sf a2a add-caller procurement --config /data/a2a.yaml

# Provider OAuth (interactive / browser). API keys: boot env, not exec — see below.
docker exec -it stageflow sf providers login anthropic --type oauth
```

### Provider API keys (no exec)

Set at Host boot so the container self-configures without `docker exec`:

```bash
# compose / k8s env (example)
STAGEFLOW_PROVIDER_ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_api_key
# or STAGEFLOW_PROVIDER_ANTHROPIC_API_KEY=…
# optional: STAGEFLOW_REQUIRE_PROVIDERS=anthropic
```

See [Providers — Non-interactive Host boot credentials](providers.md#non-interactive-host-boot-credentials).

### Worktree escape hatch {#worktree-escape-hatch}

When you need a shell inside a run's checkout (diff inspection, one-off git, post-mortem), obtain the path from the run projection, then exec:

1. Call MCP `get_run` with the `runId`, or `GET /api/runs/<runId>` with a **read** token.
2. Read `binding.checkout_root` (absolute path inside the container). Unbound runs omit it — there is nothing to enter. Repository-bound runs typically use `$STAGEFLOW_HOME/worktrees/<runId>/`.
3. Open a shell (or run a one-shot command) with that path as the working directory:

```bash
RUN_ID=run_…
# From the Host REST detail (token required when bind is non-loopback):
CHECKOUT=$(curl -fsS -H "Authorization: Bearer $STAGEFLOW_READ_TOKEN" \
  "http://127.0.0.1:3847/api/runs/$RUN_ID" | jq -r '.binding.checkout_root // empty')
test -n "$CHECKOUT"
docker exec -it -w "$CHECKOUT" stageflow bash
# one-shot example:
docker exec -it -w "$CHECKOUT" stageflow git status
```

There is no MCP shell/`exec` tool — this is the supported escape hatch.

### Post-mortem debug bundle {#debug-bundle}

Failed and cancelled runs keep worktrees/logs for **30 days** by default before SLIM (succeeded stays **3 days**). Override with `STAGEFLOW_SLIM_FAILED_MS` / `STAGEFLOW_SLIM_CANCELLED_MS`.

Pull a capped, Slot-6-redacted attachable bundle (export projection + manifest + stage events + verification evidence + `get_run_diff` + stream-log tails + redacted host config):

```bash
# Inside the container (or via docker exec):
docker exec stageflow sf debug-run "$RUN_ID" --out /tmp/debug-$RUN_ID.json

# Remote Host — same shape, read scope (parity with GET …/export):
curl -fsS -H "Authorization: Bearer $STAGEFLOW_READ_TOKEN" \
  "http://127.0.0.1:3847/api/runs/$RUN_ID/debug-bundle" \
  -o "debug-$RUN_ID.json"
```

For a live shell on the binding path after you have the bundle, use the [worktree escape hatch](#worktree-escape-hatch) above.

## Continuous replication

Litestream (or similar) can replicate `state.db` for disaster recovery; it is **not** a substitute for `sf backup` under live multi-writer WAL. Prefer `sf backup` for operator restore points.
