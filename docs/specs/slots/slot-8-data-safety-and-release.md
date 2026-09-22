---
status: implementation-brief
slot: 8
---

# Slot 8 — Backup, restore, provenance, and a stated egress posture

## For the agent picking this up

**Stageflow** is a Node/TypeScript runtime for configurable multi-stage AI agent workflows. Users
author pipelines in YAML (`*.pipeline.yaml`, `*.task.yaml`, optional repo-root `stageflow.yaml`
manifest); each stage runs in a fresh agent session and hands off to the next through typed
envelopes and artifacts. The CLI is `sf` (`src/cli.ts`).

Five facts about the architecture matter for this slot:

1. **There is one HTTP Host.** `sf ui` and `sf mcp` both call `createHttpHost`
   (`src/server/createHttpHost.ts`), which serves the operator REST API (`/api/*`), the MCP
   endpoint (`/mcp`), and — when configured — A2A on one port (`3847`). Everything this slot
   exposes remotely goes through those routes.
2. **All durable state is SQLite in WAL mode**, in one file. `SqliteRunStore` opens
   `<storeRoot>/state.db` and sets `journal_mode = WAL`
   (`src/runstore/sqlite/SqliteRunStore.ts:491-495`). A2A's tables live in the *same* file, sharing
   the run store's connection when one is available (`src/runstore/createStore.ts:32-39`,
   `src/a2a/store.ts:109-121`). The durable root today is `~/.stageflow`
   (`src/project/globalHome.ts:5-7`); slot 1 turns that into `$STAGEFLOW_HOME` and flattens the
   layout.
3. **Stages are forked Node child processes** running a "Pi" coding agent with a `bash` tool. A
   stage can run arbitrary shell, and each forked worker constructs its **own** `SqliteRunStore`,
   so `state.db` has several concurrent writers by design. That is why the WAL and the
   local-filesystem requirement below are load-bearing rather than pedantic.
4. **The `--json` output and exit codes are a public contract** (`docs/ci.md`,
   `tests/cli.*.test.ts`). Anything this slot adds to stdout must respect that.
5. **Nothing is containerized yet.** There is no Dockerfile, no compose file, and no
   `docs/docker.md` in the repo.

Stageflow is being containerized. The work is split into nine shipping slots; see
[`../pre-container-work.md`](../pre-container-work.md) for the full plan and build order. **This is
slot 8.** Slots 1–7 make the Host survivable in a container. Slot 8 is the set of promises a
self-hosted stateful service owes the people who run it: *you can get your data out, you can get it
back, you can tell what code is running, and you know what a stage can reach.*

You do not need to read the plan doc. Everything you need is below, and every claim about current
behaviour was re-verified in this worktree with a `file:line` citation.

---

## Mission

Ship five things:

1. **Backup and restore as a product feature** — `sf backup`, `sf restore`, both reachable over the
   API, plus the published "what must you keep" table that makes a backup small.
2. **The three unmade SQLite decisions** — `synchronous`, WAL size management on the crash path,
   and integrity checking — plus one loudly stated supported-configuration boundary: **the data
   volume must be local.**
3. **Release provenance** — a build SHA that ties a running container back to a commit, signed
   attestations, a pinned base image, OCI labels, and one verification snippet in the docs.
4. **A stated egress posture** — a written threat model, a reference compose on an
   `internal: true` network behind a domain-allowlisting proxy sidecar, and a health field that
   reports whether proxy variables are set. We are **not** building a proxy.
5. **Whole-instance export** — `sf export --all` and an API equivalent, so portability is a promise
   a remote harness can keep rather than something you need `docker exec` for.

Plus two riders that belong here because they are promises rather than plumbing: a **log-volume
budget** (an agent in a retry loop must not fill a VPS through `docker logs`) and a **declared
writable-path set** so `read_only: true` is a supported configuration.

---

## Why this matters

- **The failure this slot prevents is permanent.** Every other slot's worst case is downtime. This
  one's worst case is a user losing every run record they have, because they backed up their
  Stageflow instance the obvious way — `cp state.db` — and WAL mode made that a no-op or worse. We
  do it ourselves today: `publish.yml:193-195` and `release.yml:140-142` upload
  `.stageflow/state.db`, `-wal`, and `-shm` as three separate CI artifact paths. That happens to be
  fine because the run has ended by then; it is exactly the pattern that corrupts when it does not.
- **An image tag makes rollback routine.** Users will roll back, and restore-from-backup is the
  escape hatch when the store has already moved forward. Slot 1 stops a downgrade from writing bad
  rows; slot 8 is what gets you back to a known-good file.
- **We ship a tool that runs an agent with shell access against your repository.** "How do I know
  this image is the one you built" is a fair question, and "here is a signed attestation" is a
  better answer than "trust the tag." The npm side already sets this precedent —
  `npm publish --provenance --access public` (`publish.yml:65`).
- **A stage holding a `GITHUB_TOKEN` with unrestricted network is the blast radius of one prompt
  injection in a README.** We are not going to eliminate that. We can document it precisely enough
  that an operator can decide what to do about it, and ship a compose file that does the useful
  half.
- **Export is the anti-lock-in promise.** `sf export-run` exists for one run
  (`src/cli/exportRunCommand.ts`) and is CLI-only. Behind `docker exec` that is not portability a
  remote harness can rely on.

---

## Dependencies

| | |
|---|---|
| **Assumes shipped: slot 1** | `$STAGEFLOW_HOME` as the resolved, validated durable root; the flattened layout (`state.db` directly under it); `PRAGMA user_version` + a `schema_migrations` ledger + the downgrade guard. Backup records the schema version, restore refuses a file newer than the binary, and the layout is what the precious-vs-disposable table describes. Slot 1 also owns `PRAGMA foreign_keys` — **do not add it here.** |
| **Assumes shipped: slot 3** | Two-stage retention (SLIM / PURGE) and `sf runs gc`. Slot 8's log-volume item says transcripts stay in the run store "under slot 3's retention"; that sentence is only true once slot 3 exists. |
| **Assumes shipped: slot 4** | Graceful shutdown. Two hard dependencies: the clean-close `PRAGMA wal_checkpoint(TRUNCATE)` is **slot 4's**, specified in its brief as part of the ordered drain — slot 8 owns only the crash-path residual WAL and the explicit `wal_autocheckpoint` setting. And `POST /api/restore` works by staging a marker and initiating a graceful shutdown, which needs slot 4's drain to exist. |
| **Assumes shipped: slot 5** | The control token. Every route this slot adds is a mutating or disclosing route and must sit behind it. `POST /api/backup` writing a file and `GET /api/export` streaming every run's contents are both unacceptable unauthenticated. |
| **Assumes shipped: slot 6** | The proxy variables. Slot 6 lands `setGlobalDispatcher(new EnvHttpProxyAgent())` so `HTTPS_PROXY` actually affects Node's `fetch`, and the curated child environment that forwards proxy and CA variables to stages. **Slot 8 only reports whether they are set.** Reporting a proxy that the runtime ignores is worse than reporting nothing. |
| **Assumes shipped: slot 7** | `sf doctor` and the `/livez` / `/readyz` / `/api/health` split. The full `PRAGMA integrity_check` lives in `sf doctor`, which does not exist today (`rg doctor src/` finds only the *skill* doctor, `src/cli/skillsCommand.ts:36`). The egress health field and the build SHA go into slot 7's `/api/health` payload. |
| **Couples with slot 9** | Slot 9 persists inline pipelines with the run so `rerun` works. That is the same change that makes a run record self-contained enough to export. Design the export envelope's `pipeline_source` field in this slot and let slot 9 populate the body — see [8. Whole-instance export](#8-whole-instance-export-128). Slot 9 also owns the run manifest and lifting `export-run`'s terminal-status check; coordinate so you do not both edit `assertRunComplete`. |
| **Blocks** | The Dockerfile and the GHCR publish job. Both consume values this slot defines (`STAGEFLOW_BUILD_SHA`, the label set, the writable-path declaration, the compose reference). |

---

## Code work vs documentation work

This slot is unusually mixed. Sequence it so the code lands first and the docs describe something
real — every documentation item below has a code item it describes.

| # | Item | Code | Documentation |
|---|---|---|---|
| 1 | Backup | `sf backup`, `POST /api/backup`, `GET /api/backup/<name>` | Why `cp state.db` corrupts; the backup/restore runbook |
| 2 | Restore | `sf restore`, `POST /api/restore` + boot-time apply | Restore preconditions; the "Host must be down" rule |
| 3 | Precious vs disposable | `sf backup` scope flags follow the table | **The table itself**, on the new docs page |
| 4 | SQLite pragmas | `synchronous = FULL`, explicit `wal_autocheckpoint`, boot `quick_check`, crash-path checkpoint | Tuning knobs and what they cost |
| 5 | Local-volume boundary | filesystem detection + refusal, `store_filesystem` on health | **Supported configuration**: no NFS/SMB, stated plainly |
| 6 | Provenance | `STAGEFLOW_BUILD_SHA` plumbed into the binary and health | Label table, cosign verification snippet, the release checklist |
| 7 | Egress posture | `egress` block on `/api/health` (report-only) | **The threat model**, the reference compose, the allowlist caveat |
| 8 | Whole-instance export | `sf export --all`, `GET /api/export` | The portability promise; the export format |
| 9 | Log volume | per-line byte cap, lifecycle-only stdout | `logging: driver: local` in the compose example, and why |
| 10 | Writable paths | audit + `TMPDIR`/`SQLITE_TMPDIR` handling | The `read_only: true` / `cap_drop: ALL` supported configuration |
| — | Docs landing | — | New `docs/docker.md`, linked from `docs/README.md` |

**Sequencing suggestion.** Items 4 and 5 are small and touch one file; do them first to warm up on
`SqliteRunStore`. Then 1 → 2 → 3 as one coherent change set. Then 8 (it reuses item 1's streaming
and safe-output-path work). Then 9 and 10. Then 6 and 7, which are mostly prose plus one small
health field each, and write `docs/docker.md` last so it can describe finished behaviour.

---

## Verified current state

Every line below was read in this worktree.

### What exists

| Fact | Evidence |
|---|---|
| The store opens `state.db` and sets exactly two pragmas: `journal_mode = WAL` and `busy_timeout` | `src/runstore/sqlite/SqliteRunStore.ts:491-495` |
| `busy_timeout` defaults to 5000 ms, overridable via `STAGEFLOW_SQLITE_BUSY_TIMEOUT_MS` | `src/runstore/sqlite/SqliteRunStore.ts:172-183` — **this is the precedent to copy for any pragma env knob you add** |
| Schema evolution is by `PRAGMA table_info(...)` probing, nine `ensure*` calls plus a backfill, **on every connection open**, outside a transaction | `src/runstore/sqlite/SqliteRunStore.ts:496-510` (helpers at `:187-370`) |
| A2A opens the same `state.db` and repeats the same two pragmas when it owns the connection | `src/a2a/store.ts:109-121` |
| A2A artifact bytes live on disk under the store root at `a2a-artifacts/<taskId>/` | `src/a2a/store.ts:121`, `:259` |
| The durable root is `path.join(os.homedir(), ".stageflow")`, hardcoded, with no override | `src/project/globalHome.ts:5-7` |
| The store root is `<rootDir>/.stageflow`, so the global store is `~/.stageflow/.stageflow/` | `src/runstore/paths.ts:11-14`, `src/runstore/createStore.ts:35-38` |
| Provider credentials: Stageflow-owned at `$HOME/.stageflow/agent/auth.json` (mode `0600`, dir `0700`), or Pi-owned at `$HOME/.pi/agent/auth.json` | `src/runtime/credentialBinding.ts:32-47`, `:59-71`; `src/project/globalHome.ts:9-20` |
| The credential-source choice itself is persisted in `settings.json`, alongside `maxConcurrent` | `src/runtime/settingsFile.ts:9`, `:24-40` |
| `sf export-run` exports **one** run, via `projectRun(detail)` | `src/cli/exportRunCommand.ts:158-174`, `src/projection/projectRun.ts:58` |
| `sf export-run` **refuses non-terminal runs** — only `succeeded` and `failed` pass | `src/cli/exportRunCommand.ts:108-113` |
| `sf export-run --out` refuses `..` segments and refuses to resolve outside the cwd | `src/cli/exportRunCommand.ts:93-106` |
| `GET /api/health` returns `CapacityHealth` and nothing else — slots, active runs, stage-process counts | `src/server/http.ts:745-748`; type at `src/runtime/runManager.ts:98-106`, built at `:294-` |
| MCP `get_health` is the only surface with a version, and it appends it client-side | `src/mcp/catalogTools.ts:179` — `{ ...manager.getHealth(), version: PACKAGE_VERSION }` |
| The version is a checked-in literal | `src/package-meta.ts:2` — `export const PACKAGE_VERSION = "0.24.0"`; `package.json:3` |
| npm publishing is manual-dispatch, main-only, with provenance | `.github/workflows/publish.yml:65` — `npm publish --provenance --access public` |
| `package.json` `files` ships `dist`, `skills`, `README.md`, `LICENSE` | `package.json:10-15` — `docs/` and `examples/` are **not** in the tarball |
| License is MIT; repo is `github.com/tejasghutukade/stageflow` | `package.json:55`, `:16-19` |
| Both release workflows upload `state.db`, `-wal`, and `-shm` as CI artifacts | `publish.yml:193-195`, `release.yml:140-142` |

### Confirmed absent

A repo-wide search over `src/` finds **no** matches for any of these:

| Thing | Search |
|---|---|
| Any backup of anything | `rg -i "backup" src/` → no matches |
| Any restore of anything | `rg -i "restore" src/` → no matches |
| `VACUUM`, `VACUUM INTO`, or better-sqlite3's `.backup()` | `rg -i "vacuum\|\.backup\(" src/` → no matches |
| `PRAGMA integrity_check` or `quick_check` | `rg -i "integrity_check\|quick_check" src/` → no matches |
| `PRAGMA synchronous` | `rg -i "synchronous" src/` → only two unrelated code comments (`src/envelope/preEmitChecks.ts:5`, `src/runtime/pipelineScheduler.ts:1155`) |
| `PRAGMA wal_checkpoint` or `wal_autocheckpoint` | no matches |
| `PRAGMA user_version` or a migrations table | no matches — **slot 1's job** |
| `PRAGMA foreign_keys` | no matches — **slot 1's job** |
| Any whole-instance export | the only export is `export-run` (`src/cli.ts:140`, dispatch at `:371`) |
| A build SHA or commit hash anywhere in the binary or on health | `rg -i "build_sha\|buildSha\|gitSha" src/` → no matches |
| `/livez`, `/readyz` | no matches — **slot 7's job** |
| `sf doctor` | no matches outside the skills subcommand — **slot 7's job** |
| `SqliteRunStore.close()`, or any `close` on the `RunStore` port | no matches — **slot 4 adds the clean-close path** |
| Dockerfile, compose file, `docs/docker.md` | not in the repo |
| Container image publishing | `publish.yml` publishes to npm only; no GHCR, no cosign, no SBOM |

### Where the plan document needs correcting

- The plan (12.3) says to "add a `wal_checkpoint(TRUNCATE)` to 4.1's clean close." **Slot 4's brief
  already specifies exactly that**, inside its ordered drain, with the checkpoint budgeted into the
  final 2 s of the grace period. Do not implement it twice. Slot 8's WAL work is the *explicit*
  `wal_autocheckpoint` setting and the *crash-path* residual-WAL handling — the case where there
  was no clean close.
- The plan (12.2) says "expose both over the API." A live Host cannot restore the database it is
  currently holding open. The API surface for restore therefore cannot be "do it now"; the design
  below stages the file and applies it at boot. That is a real difference from the one-line plan
  item and it is the only honest shape.
- The plan (12.3) describes `synchronous` as "probably right" at `FULL`. This brief decides it:
  `FULL`, with an env escape hatch. See item 4.

---

## The work

### 1. `sf backup` — a snapshot you can actually trust *(code + docs)*

**Today.** Nothing backs anything up.

**Target.** `sf backup [--out <file>] [--db-only] [--no-credentials] [--include-a2a-artifacts]
[--json]`, plus `POST /api/backup` and `GET /api/backup/<name>`.

The mechanism:

1. Snapshot the database with **`VACUUM INTO '<tmp>'`** against the live connection. SQLite takes a
   read transaction for the duration, so the output is a consistent, fully-checkpointed,
   defragmented single file with no `-wal` sibling. Concurrent writers are not blocked (WAL), they
   just cannot checkpoint past the snapshot while it runs.
2. Open the output **read-only** in a fresh connection and run `PRAGMA quick_check`. Read back
   `PRAGMA user_version` and assert it matches the source. Only then does the backup count.
3. Gather the rest of the precious set (see item 3) and write everything into a single
   uncompressed-or-gzip tar at `<out>.partial`, then `rename()` to `<out>`.
4. Print, and return on the API, `{ path, bytes, sha256, schema_version, stageflow_version,
   created_at, contents: [...] }`.

**Design decisions already made — do not relitigate:**

- **`VACUUM INTO`, not better-sqlite3's `.backup()`.** One statement, one consistent file, no
  partial-copy state machine, and the output is compacted — which is most of why a 40 MB backup
  stays 40 MB. `.backup()`'s only advantage is incremental progress reporting, which we do not
  need; keep it in your back pocket if a very large store makes a single statement unacceptable.
- **`VACUUM INTO` needs free space roughly equal to the database.** Check before starting and fail
  with a named error (`backup_insufficient_disk`) rather than dying mid-vacuum. Slot 3 already
  computes durable-root disk usage; reuse it.
- **Write to `<out>.partial` and rename.** An interrupted backup that looks like a good backup is
  worse than no backup. `rename()` within one filesystem is atomic; refuse an `--out` on a
  different device than the temp file, or stage the temp file beside the target.
- **Integrity-check the *output*, not the input.** Nothing is writing to the output file, so a full
  scan there is free of the read-lock problem that keeps `integrity_check` out of the boot path
  (item 4). `quick_check` on the fresh copy is sufficient and fast; use full `integrity_check` when
  `--json` is absent and the store is under a size threshold, if you want the stronger signal.
- **A backup is a tarball by default, not a bare `.db`.** It contains the snapshot plus
  `settings.json`, `agent/auth.json`, and a `manifest.json`. Reason: a backup that restores into a
  Host which then cannot authenticate to any model provider is not a backup of a working instance,
  and users will not discover the missing half until they need it. `--db-only` produces the bare
  snapshot for people who manage credentials out-of-band.
- **Credentials are in the default backup, and that is stated loudly.** The tar entry keeps mode
  `0600`, the tarball itself is created `0600`, and both the CLI and the docs say in one sentence
  that the file contains provider credentials and must be treated as a secret. `--no-credentials`
  is the opt-out for anyone whose credentials come from env or `*_FILE`.
- **A2A artifact bytes are opt-in.** They are payload bytes under `a2a-artifacts/<taskId>/`
  (`src/a2a/store.ts:259`), already bounded by A2A's own `pruneExpired` sweep, and they can be
  large. The rows that reference them are in `state.db` either way. Without `--include-a2a-artifacts`
  a restore will have artifact rows whose bytes are gone — **restore must detect and report that
  count** rather than letting a stranger discover it later. Document it as a known limitation.
- **Default output path is `$STAGEFLOW_HOME/backups/stageflow-<ISO>.tar.gz`, not the cwd.** Under
  item 10's `read_only: true` profile the cwd is not writable, and a default that fails in the
  supported configuration is not a default.
- **`POST /api/backup` writes server-side and returns metadata; `GET /api/backup/<name>` streams
  the bytes.** Two calls, because a synchronous "vacuum then stream a gigabyte" response is a
  request-timeout problem (slot 5 sets a finite `requestTimeout`) and because a harness usually
  wants to know a backup succeeded without pulling it. Both routes are behind slot 5's control
  token with `drive` and `read` scope respectively. `GET` resolves the name against
  `$STAGEFLOW_HOME/backups` with `..`-rejection and `realpath` containment — copy the existing
  containment shape from `src/mcp/readArtifact.ts:82-93` rather than inventing one.
- **Do not add a `retention` policy for backups.** Listing and deleting via the API is enough; an
  operator's cron or volume snapshots own rotation. One sentence in the docs.

**Files likely to touch.** New `src/runstore/backup.ts` (the snapshot + verify primitive, taking a
`Database` and a target path), new `src/cli/backupCommand.ts`, `src/cli.ts` (command list at
`:129-144` and dispatch near `:371`), `src/server/http.ts` (two routes),
`src/runstore/sqlite/SqliteRunStore.ts` (expose the snapshot through the store rather than leaking
the raw connection to a new caller — note `get connection()` at `:522` is deliberately documented
as having exactly one legitimate caller; do not become the second), `docs/docker.md`,
`docs/cli-reference.md`.

---

### 2. `sf restore` — and why `cp state.db` is the thing we are replacing *(code + docs)*

**Today.** Nothing restores anything, and the obvious user action is destructive.

**This paragraph should appear close to verbatim in the docs.** Stageflow's store runs in WAL mode
(`journal_mode = WAL`, `src/runstore/sqlite/SqliteRunStore.ts:494`). In WAL mode a committed
transaction is **not** necessarily in `state.db` — it is appended to `state.db-wal`, and
`state.db-shm` is the shared-memory index that tells every connected process where in that WAL each
page currently lives. Checkpointing is what folds the WAL back into the main file, and it happens
opportunistically. So:

- `cp state.db` alone silently loses every transaction committed since the last checkpoint. The
  copy opens fine. It is just missing the recent past, which is the part you wanted.
- `cp state.db state.db-wal state.db-shm` is worse, not better. The three files are mutually
  consistent only at an instant, `cp` is three non-atomic operations, and any writer active during
  the copy — Stageflow always has several, one per stage worker — yields a torn set that can open
  and serve wrong pages.
- `tar`, `rsync`, and a volume snapshot taken while the Host is running have the same problem for
  the same reason.

`sf backup` exists because there is no safe way for a user to do this by hand while the Host is up.

**Target.** `sf restore <file> [--force] [--json]`, plus `POST /api/restore`.

CLI mechanism:

1. **Verify the source before touching anything.** Extract to a temp directory, `quick_check` the
   snapshot, read `PRAGMA user_version`, and refuse when it exceeds the maximum version this binary
   knows — reusing slot 1's downgrade guard and its error naming the minimum required version.
   Refuse a manifest whose `stageflow_version` major differs, unless `--force`.
2. **Refuse while a Host is live**, by two independent checks:
   - probe `GET /api/health` at the configured host base URL, the way `ensureGlobalService` already
     does (`src/server/ensureGlobalService.ts:62`). A `200` means refuse.
   - attempt an exclusive lock on the existing `state.db` (open it and take a write transaction
     under `PRAGMA locking_mode = EXCLUSIVE`). `SQLITE_BUSY` means another process — a stage worker
     that outlived its Host, a stray `sf` — still has it. Refuse.

   Both, not either. The HTTP probe misses a worker; the lock probe misses a Host whose connection
   is momentarily idle in a way you should not reason about.
3. **`sf restore` must never autostart a Host.** `ensureGlobalService` spawns a detached `sf mcp`
   when nothing answers (`src/server/ensureGlobalService.ts:132-160`). Use the raw probe, not
   `ensureGlobalService`, and honour slot 4's `STAGEFLOW_NO_AUTOSTART`.
4. **Move the existing store aside; do not delete it.** `state.db` →
   `state.db.pre-restore-<ISO>`, and the same for any `-wal` / `-shm` siblings. A restore that was
   the wrong call must be undoable.
5. **Delete the stale `-wal` and `-shm` of the restored file.** A `VACUUM INTO` output has neither,
   but a restored file landing next to the previous run's leftovers is exactly how you get a
   database that recovers pages from a WAL belonging to a different database. Assert both are gone
   before the first open.
6. Restore `settings.json` and `agent/auth.json` unless `--no-credentials` was used at backup time
   or is passed here; re-apply mode `0600` / `0700` (`src/project/globalHome.ts:14-18` is the
   existing pattern). Report the count of artifact rows whose bytes are absent.
7. `quick_check` the restored file in place, then exit `0` and print the restored schema version.

**API mechanism — decided, and different from the CLI.** `POST /api/restore` cannot restore the
database the process is holding open. So:

1. `POST /api/restore` (control token, `drive` scope) accepts the uploaded archive, runs step 1's
   verification immediately and rejects a bad file synchronously — the caller gets a real error, not
   a deferred one.
2. On success it stages the verified archive under `$STAGEFLOW_HOME/restore-pending/` and writes a
   marker file naming it.
3. It then initiates slot 4's graceful shutdown and returns `202` with the staged path and the
   drain deadline.
4. **The boot path applies the marker before opening the store** — in `src/server/bootstrap.ts`,
   before the first `createRunStore(...)` — then renames the marker to `restore.applied` with the
   outcome recorded. Under `restart: unless-stopped` the container comes back with the restored
   store and one clear log line.

Reason for this shape: it is the only way to offer restore remotely without the Host writing over
its own open file, and the marker leaves an auditable trace. State the consequence in the docs
plainly: **`POST /api/restore` restarts your Host.**

**Design decisions already made:**

- **Restore is whole-store only.** No per-run restore, no merge, no "import these runs into the
  existing store." Merging two stores means reconciling run ids, and the export in item 8 is the
  right tool for moving a subset. Say so once in the docs so nobody asks.
- **A failed boot-time apply leaves the previous store in place and refuses to serve.** Do not fall
  back to the old store silently — an operator who asked for a restore and got their old data
  without noticing is the worst outcome here. Fail `readyz`, log the reason, keep both files.
- **Cap the retries.** If a staged restore fails to apply twice, rename the marker to
  `restore.failed` so `restart: unless-stopped` does not produce an infinite restore loop. Same
  argument slot 4 makes for capping resume cycles.

**Files likely to touch.** New `src/runstore/restore.ts`, new `src/cli/restoreCommand.ts`,
`src/cli.ts`, `src/server/http.ts`, `src/server/bootstrap.ts`, `docs/docker.md`,
`docs/cli-reference.md`.

---

### 3. Precious vs disposable *(docs, with code following the table)*

**This is the table that turns a 40 GB backup into a 40 MB one**, and it falls straight out of the
layout slot 1 writes down. Publish it on `docs/docker.md`; `sf backup --help` should point at it.

| Path under `$STAGEFLOW_HOME` | Verdict | Why |
|---|---|---|
| `state.db` (+ `-wal`, `-shm`) | **Irreplaceable** | Every run, stage, envelope, event, verification record, and all A2A rows. One file, small. Only ever copy it via `sf backup`. |
| `agent/auth.json` | **Irreplaceable** | Provider credentials (`src/runtime/credentialBinding.ts:36-38`). Re-obtainable only by redoing every provider login, and OAuth logins need a terminal. |
| `settings.json` | **Irreplaceable** | `maxConcurrent` and the credential-source choice (`src/runtime/settingsFile.ts:24-26`). Small, and annoying to reconstruct from memory. |
| `runs/<runId>/` | **Situational** | Stage workspaces, artifacts, `.pi-agent` session dirs. The *records* are in `state.db`; these are the bytes stage artifacts point at. Slot 3's SLIM reclaims them on a schedule anyway. Back up only if your pipelines produce deliverables you have not copied elsewhere. |
| `a2a-artifacts/<taskId>/` | **Situational** | Artifact payload bytes (`src/a2a/store.ts:259`). Bounded by A2A's own expiry sweep. `--include-a2a-artifacts` if you need them. |
| `repos/<host>/<owner>/<repo>.git` | **Disposable** | A bare-clone cache (slot 2). Re-clonable from the remote. This is the 40 GB. |
| `worktrees/<runId>/` | **Disposable** | Rebuildable from the `resolved_sha` recorded on the Run (slot 2). Slot 3 deletes them on SLIM. |
| `cache/` | **Disposable** | Shared dependency caches (slot 6). Re-downloadable by definition. |
| `backups/`, `restore-pending/` | **Disposable** | Outputs and staging for this slot's own commands. |

One sentence the docs should carry: *a volume snapshot of the whole data directory is not a
substitute for `sf backup` — it is larger, it includes the disposable half, and it is taken while
the WAL is moving.*

---

### 4. The three SQLite decisions *(code + a short docs section)*

**Today.** Two pragmas, set in one place, with a third env-configurable
(`src/runstore/sqlite/SqliteRunStore.ts:491-495`, `:172-183`). No durability setting, no WAL size
policy, no integrity check anywhere.

**Target — decided, with reasons:**

| Decision | Value | Reason |
|---|---|---|
| `PRAGMA synchronous` | **`FULL`**, env-overridable via `STAGEFLOW_SQLITE_SYNCHRONOUS` | better-sqlite3 leaves SQLite's WAL default of `NORMAL`, under which a committed transaction can be lost on power loss or a host-level kill because the WAL is not fsynced at commit. A run store's entire value is its history, and our write rate is events and envelopes, not rows per millisecond. Pay the fsync. |
| `PRAGMA wal_autocheckpoint` | Set **explicitly** to the SQLite default (1000 pages), plus a boot-time check | Not a behaviour change — a visibility change. The WAL policy stops being "whatever the library defaults to" and becomes a value you can find and a value health can report. |
| Crash-path WAL | At boot, if `state.db-wal` exceeds a threshold (say 64 MB), run one `PRAGMA wal_checkpoint(TRUNCATE)` before serving and log it | A Host that was SIGKILLed rather than drained inherits its WAL. Slot 4's clean close handles the graceful case and **owns that code** — this is only the ungraceful one. |
| Integrity at boot | `PRAGMA quick_check` | Fast, no full scan. On failure, refuse to serve with a named error (`store_integrity_failed`) whose message names `sf restore`. Silently serving a corrupt store is how a bad file becomes a bad backup. |
| Full integrity | `PRAGMA integrity_check` in **`sf doctor` only** (slot 7), and against `sf backup`'s output | It holds a read lock for the duration of a full-database scan and will stall writers. That is fine in a diagnostic a human ran and unacceptable on a boot path or a healthcheck interval. |

**Design decisions already made:**

- **One place sets pragmas, and it is the store constructor.** `src/a2a/store.ts:115-118` duplicates
  `journal_mode` and `busy_timeout` for the case where it opens its own connection. Any pragma you
  add must be added there too, or extracted into a shared `applyStorePragmas(db)` that both call.
  Prefer the extraction — three copies of a durability decision is a bug waiting to happen. This is
  a logic change, so it is a legitimate refactor.
- **Every forked stage worker opens its own connection** (`SqliteRunStore` is constructed
  per-process), so pragmas are per-connection and must be applied on every open. `synchronous` in
  particular is not a property of the file.
- **`quick_check` at boot, not per connection.** N workers each running a check at startup is
  slot 1's startup-contention problem again. Gate it to the Host's boot path.
- **Do not touch `foreign_keys`.** Slot 1 owns it.

**Files likely to touch.** `src/runstore/sqlite/SqliteRunStore.ts`, `src/a2a/store.ts`, new shared
pragma helper under `src/runstore/`, `src/server/bootstrap.ts` (boot checks).

---

### 5. The data volume must be local *(code + a loud docs statement)*

**Today.** Nothing checks, and nothing says.

**Why this is a supported-configuration boundary and not a tuning note.** SQLite in WAL mode
coordinates readers and writers through `state.db-shm`, a memory-mapped shared-memory file. That
requires real mmap and real POSIX locking across processes on one host. NFS and SMB provide neither
reliably. Stageflow is the bad case rather than the borderline one: the Host and **every forked
stage worker** hold their own connection to the same file at the same time. A VPS user who puts
`/data` on network storage because that is where the space is will discover this as corruption, at
the worst moment, with no error beforehand.

**Target.**

- At boot, resolve the filesystem type backing `$STAGEFLOW_HOME`. On Linux, read
  `/proc/self/mountinfo` and match the longest mount point that is a prefix of the resolved path.
- **Refuse to start** on `nfs`, `nfs4`, `cifs`, `smbfs`, `fuse.sshfs`, with a named error
  (`store_unsupported_filesystem`) that names the detected type and the path. Escape hatch:
  `STAGEFLOW_ALLOW_NETWORK_STORE=1`, which downgrades it to a loud startup warning and is
  documented as unsupported.
- **Warn only** on `9p` and `virtiofs` — these are Docker Desktop's bind-mount transports on macOS
  and Windows, they are what a developer trying the image will hit, and refusing there would break
  the first-run experience for a risk that is lower than NFS.
- Report `store_filesystem` on slot 7's `/api/health` so a bug report contains it.
- On non-Linux, skip detection rather than guessing. Say so.

**Design decisions already made:**

- **Detect, do not probe.** Do not attempt to infer support by taking locks and seeing what happens
  — the failure modes are silent and intermittent, which is the whole problem.
- **Named volumes are the documented default.** `docker volume create` puts the data on the local
  graph driver and sidesteps this entirely. A bind mount is documented as "fine on Linux, fine for
  development on Docker Desktop, never onto a network mount."

**Files likely to touch.** New `src/runstore/storeFilesystem.ts`, `src/server/bootstrap.ts`,
slot 7's health payload, `docs/docker.md`.

---

### 6. Release provenance *(mostly docs, one small code change)*

**Today.** `npm publish --provenance --access public` on manual dispatch from `main`
(`publish.yml:65`). No container publishing, no signing, no SBOM. And nothing in the binary knows
what commit it came from: the only version is the checked-in literal in `src/package-meta.ts:2`,
and `/api/health` does not even carry that (`src/server/http.ts:745-748`).

**The code half — this is the part that must land in slot 8.**

Plumb a build SHA:

```
src/package-meta.ts
  export const PACKAGE_VERSION = "0.24.0";          // unchanged, checked in
  export const BUILD_SHA = process.env.STAGEFLOW_BUILD_SHA ?? "unknown";
```

Read from the environment at module load rather than generating a file at build time: the npm
tarball has no git context, and a generated file in the repo is a diff on every build. The image
sets `ARG STAGEFLOW_BUILD_SHA` / `ENV STAGEFLOW_BUILD_SHA=...`. Surface it on slot 7's
`/api/health` as `build_sha`, and on `sf --version --json`.

**The key tie-in, stated as a requirement on the future publish job:** the value passed as
`STAGEFLOW_BUILD_SHA` and the value set as `org.opencontainers.image.revision` are **the same
`${{ github.sha }}`**, so an operator looking at a running container can get back to a commit with
one `docker inspect` or one authenticated `GET /api/health`. A mismatch between those two is a bug,
and it is worth a CI assertion in the publish job that reads the label back off the built image and
compares it to the health output of a booted container.

**The documentation half.** `docs/docker.md` publishes the release-integrity contract:

| Label | Value |
|---|---|
| `org.opencontainers.image.source` | `https://github.com/tejasghutukade/stageflow` |
| `org.opencontainers.image.revision` | `${{ github.sha }}` — **identical to `STAGEFLOW_BUILD_SHA`** |
| `org.opencontainers.image.version` | the `package.json` version, `x.y.z` |
| `org.opencontainers.image.created` | build timestamp, RFC 3339 |
| `org.opencontainers.image.licenses` | `MIT` (`package.json:55`) |
| `org.opencontainers.image.title` | `Stageflow` |
| `org.opencontainers.image.description` | one line from `package.json:4` |
| `org.opencontainers.image.base.name` | the base image reference as written |
| `org.opencontainers.image.base.digest` | the base image digest it resolved to |

And the requirements on the build:

- `docker buildx build --provenance=true --sbom=true`, so the registry carries a SLSA provenance
  attestation and an SBOM alongside the manifest.
- The base image is pinned **by digest** (`FROM node:22-bookworm-slim@sha256:...`), not by tag. A
  tag is mutable; the provenance of an image built on a moving base is a provenance of nothing.
- Sign **by digest** with cosign — `cosign sign ghcr.io/…/stageflow@sha256:…` using keyless OIDC
  from the workflow. Never sign a tag: tags move, digests do not.
- Publish **one** verification snippet, and keep it correct:

  ```bash
  cosign verify \
    --certificate-identity-regexp '^https://github\.com/tejasghutukade/stageflow/' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    ghcr.io/tejasghutukade/stageflow@sha256:<digest>
  ```

- **State plainly that labels are not evidence.** Anyone with push access can type any label they
  like; `org.opencontainers.image.revision` is a hint that makes debugging possible, not a claim you
  can verify. The signed provenance attestation is the evidence. One sentence, in the docs, next to
  the label table — otherwise the label table reads as a security control.

**Deliberately out of slot 8:** the GHCR publish job itself, because it builds a Dockerfile that
does not exist until after all nine slots. What slot 8 owes is the code prerequisite (the build-SHA
plumbing), the exact values the job must use, and the docs page it will point at. Whoever writes the
job implements this table; they do not redesign it.

**Files likely to touch.** `src/package-meta.ts`, slot 7's health payload, `src/cli.ts` (the
`--version` path at `:316`), `docs/docker.md`. `.github/workflows/publish.yml` gains the GHCR job
later, not now.

---

### 7. Egress posture *(docs, plus one report-only health field)*

**Today.** Nothing addresses where a stage can reach. Slot 5 secures inbound; slot 6 curates the
environment a stage inherits and makes proxy variables actually work. The gap between them is the
network.

**Decided: we are not building a proxy.** Not an allowlist enforcer, not a TLS-intercepting egress
gateway, not per-stage network namespaces. Those are infrastructure, they need privileges the docs
tell users never to grant, and a half-built one invites more trust than it earns.

**What we owe users instead, and all of it ships in this slot:**

1. **A written threat model** — the section below, lifted onto `docs/docker.md` as-is.
2. **A reference compose** putting the Host on an `internal: true` network behind a
   domain-allowlisting forward proxy sidecar (see the snippet below).
3. **A health field reporting whether proxy variables are set** — presence and hostname only, never
   the full value, because a proxy URL can carry `user:password@`. Something like:

   ```json
   "egress": {
     "http_proxy": "set",
     "https_proxy": "set",
     "no_proxy": "set",
     "proxy_host": "egress-proxy:3128",
     "extra_ca_certs": "set",
     "dispatcher_installed": true
   }
   ```

   `dispatcher_installed` is slot 6's `EnvHttpProxyAgent` — report the variable *and* whether the
   runtime is honouring it, because "the variable is set" was exactly the plan's original mistake
   about proxy support.

**The reference compose.** Ship this in `docs/docker.md` and keep it runnable.

```yaml
services:
  stageflow:
    image: ghcr.io/tejasghutukade/stageflow@sha256:<digest>
    networks: [internal]            # no route to the internet except via the proxy
    environment:
      STAGEFLOW_HOME: /data
      STAGEFLOW_BIND: 0.0.0.0
      STAGEFLOW_CONTROL_TOKEN_FILE: /run/secrets/control_token
      TMPDIR: /data/tmp
      HTTPS_PROXY: http://egress-proxy:3128
      HTTP_PROXY: http://egress-proxy:3128
      NO_PROXY: 127.0.0.1,localhost,egress-proxy
    volumes:
      - stageflow-data:/data       # named volume: local filesystem, see item 5
    read_only: true                # see item 10
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    logging:
      driver: local                # see item 9
      options: { max-size: "10m", max-file: "5" }
    restart: unless-stopped

  egress-proxy:
    image: <a domain-allowlisting forward proxy, e.g. Squid>
    networks: [internal, egress]
    volumes:
      - ./allowlist.conf:/etc/squid/conf.d/allowlist.conf:ro

  gateway:
    image: <your reverse proxy / TLS terminator>
    networks: [internal, egress]
    ports: ["443:443"]

networks:
  internal:
    internal: true                 # the Host has no default route out
  egress: {}

volumes:
  stageflow-data: {}
```

Note `NO_PROXY` must include the loopback host — `ensureGlobalService`'s own health probe goes to
`127.0.0.1` (`src/server/ensureGlobalService.ts:62`) and routing that through a proxy breaks
autostart detection.

**Files likely to touch.** Slot 7's health payload (one `egress` block, report-only),
`docs/docker.md`.

---

### 8. Whole-instance export *(code + docs)*

**Today.** `sf export-run --run <id>` exports one run through `projectRun(detail)`
(`src/cli/exportRunCommand.ts:158-174`). It **refuses non-terminal runs** — only `succeeded` and
`failed` pass `assertRunComplete` (`:108-113`) — it refuses an `--out` path outside the cwd
(`:93-106`), and it has no API equivalent, so behind `docker exec` it is not a promise a remote
harness can keep.

**Target.** `sf export --all [--since <ISO>] [--status <s>] [--project-root <p>] [--out <file>]`,
plus `GET /api/export` behind slot 5's control token with `read` scope.

**Design decisions already made:**

- **NDJSON, not one JSON document.** One object per line: a header line
  `{ "type": "stageflow_export", "stageflow_version": …, "schema_version": …, "created_at": …,
  "build_sha": …, "run_count": … }`, then one `{ "type": "run", … }` per run carrying the existing
  `projectRun` projection. Reason: an instance with ten thousand runs must not be assembled in
  memory, streaming keeps the HTTP route cheap, and a truncated NDJSON file is still readable up to
  the truncation. A truncated JSON array is garbage.
- **Reuse `projectRun`, do not invent a second projection.** `src/projection/projectRun.ts:58` is
  the shape `sf export-run` already emits and the shape any consumer already parses.
- **Lift the terminal-status requirement.** A hung run is exactly the run you want to export, and it
  is the first thing anyone attaches to a bug report. `sf export --all` includes non-terminal runs
  with their current status. **Coordinate with slot 9**, which lifts the same check on
  `sf export-run` for the same reason — one of you edits `assertRunComplete`, not both.
- **Keep the cwd-containment rule for anything reachable from the API; relax it for the CLI.** The
  CLI accepts an absolute `--out` (you will be writing to `/data/backups` under `docker exec`, which
  is not under the cwd), but refuses to write inside `$STAGEFLOW_HOME/worktrees/` or any run
  workspace — writing an export into a worktree dirties a PR. The `..`-rejection stays everywhere.
- **Export is data, not a backup.** It contains run projections; it does not contain credentials,
  settings, or the database. `sf restore` does not accept an export. Say both sentences on the docs
  page, adjacent, because the two features will otherwise be confused.
- **Artifact bytes are referenced, not embedded, by default.** `--include-artifacts` can bundle
  them into a tar alongside the NDJSON, but the default export stays a text stream you can `jq`.

**The slot 9 coupling, and what to build now.** A run started from an **inline** pipeline — the
mount-free path we recommend to every remote harness — has no pipeline file to point at, which is
why `rerun` currently hard-requires `meta.pipeline_path`. Slot 9 persists the inline pipeline with
the run to fix that, and the same change is what makes an exported run self-contained. So:

- Define the field in the export header/run envelope **now**: `pipeline_source: "inline" | "path"`,
  plus an optional `pipeline` body.
- Populate `pipeline_source` from what the store already has, and emit `pipeline` as `null` with an
  explicit `"unavailable_until_slot_9"` note for inline runs.
- Slot 9 fills the body. The format does not change when it does. **Review each other's design
  before either ships** — this is the one place the two slots share a data contract.

**Files likely to touch.** New `src/cli/exportAllCommand.ts` (or extend
`src/cli/exportRunCommand.ts` with an `--all` mode — prefer a new file; the arg parsing there is
already a hand-rolled loop), `src/cli.ts`, `src/server/http.ts`, `src/runstore/port.ts` (a streaming
list-runs iterator, so the route does not materialise every run), `docs/cli-reference.md`,
`docs/docker.md`.

---

### 9. Log volume *(code + a compose line and its explanation)*

**Today.** Ad-hoc `console` output; slot 4 replaces it with one JSON-lines logger to stdout. Slot 4
sets the **format**. Nobody has set the **budget**.

**The failure.** Docker's default `json-file` log driver has **no rotation**. An agent in a retry
loop, with full transcripts on stdout, fills the host disk through `docker logs` alone — and that is
a failure mode slot 3's disk watch does not catch, because slot 3 watches `$STAGEFLOW_HOME` and this
disk is consumed outside it. The first symptom is a full VPS with a Stageflow data volume that looks
completely healthy.

**Target.**

- **stdout carries lifecycle events only.** Run and stage start/finish/status transitions, gates
  opened and answered, verify outcomes, GC sweeps, boot and shutdown. Not transcript bodies, not
  tool call payloads, not artifact contents.
- **A per-line byte cap**, `STAGEFLOW_LOG_MAX_LINE_BYTES`, default 8192. Over the cap, truncate and
  mark the record — `"truncated": true, "original_bytes": N` — so a consumer can tell truncation
  from a short message. Never drop the line.
- **Full transcripts stay in the run store**, where slot 3's retention governs them and
  `tail_stage_log` already serves them.
- **Redaction happens at the sink**, not per call site, so a new log line cannot leak by omission.
  Slot 6 owns the redaction mechanism; slot 8 wires the logger's serializer through it.
- **Ship the compose example with `logging: driver: local`** and `max-size` / `max-file` (see the
  snippet in item 7). The `local` driver rotates and compresses by default. Explain in one sentence
  *why* it is there, because a user who copies the compose file without the sentence will delete the
  block the first time they want `docker logs` to behave like they expect.

**Files likely to touch.** Slot 4's logger module, `docs/docker.md`.

---

### 10. Declare which paths must be writable *(code audit + docs)*

**Today.** Nothing states it, so nothing can be locked down.

**Target.** Exactly two writable paths, documented as the supported set:

1. **`$STAGEFLOW_HOME`** — the data volume. Everything durable is under it (slot 1).
2. **An explicitly-set `TMPDIR`**, pointing either at a path under the data volume (`/data/tmp`) or
   at a `tmpfs`.

With those two declared, `read_only: true`, `cap_drop: [ALL]`, and
`security_opt: [no-new-privileges:true]` become a **supported configuration** rather than something
users discover by breaking it.

**Do the audit, because the declaration is only true if it is.** Find and fix everything that writes
outside those two paths:

- `SQLITE_TMPDIR` — SQLite's temp files for sorts and large statements do not follow `TMPDIR` on all
  builds. Set it explicitly alongside `TMPDIR`, or set `PRAGMA temp_store = MEMORY` for the store
  connection. Note `VACUUM INTO` (item 1) writes to its named target, but plain `VACUUM` uses temp
  space — another reason to prefer `VACUUM INTO`.
- `os.tmpdir()` call sites anywhere in `src/` — each must honour `TMPDIR` or move under the data
  volume.
- **`service.log` in the data root.** `ensureGlobalService` writes it
  (`src/server/ensureGlobalService.ts:134-152`); slot 4's `STAGEFLOW_NO_AUTOSTART` makes that path
  unreachable in the container profile. Verify it, do not assume it.
- jiti's runtime-TypeScript cache (`src/agent/piIsolatedMcp.ts:125-147`) needs a writable cache dir —
  slot 1 points it under `$STAGEFLOW_HOME`. Verify.
- `sf backup`'s default output is under `$STAGEFLOW_HOME`, not the cwd (item 1). This is why.
- Stage workspaces are already under the data root. Confirm nothing in the stage launch path writes
  relative to the process cwd.

**Design decision already made:** `TMPDIR` is **explicitly set**, never inherited or defaulted to
`/tmp`. Under `read_only: true` an unset `TMPDIR` means `/tmp` on a read-only root filesystem, and
the failure surfaces as an unrelated-looking `EROFS` deep inside a dependency. Set it in the image
and validate at boot that it is writable, with a named error if not.

**Files likely to touch.** `src/server/bootstrap.ts` (boot validation),
`src/runstore/sqlite/SqliteRunStore.ts` (`temp_store` / `SQLITE_TMPDIR`), whatever the `os.tmpdir()`
audit turns up, `docs/docker.md`.

---

## The threat model, stated

*This section is written to be lifted onto `docs/docker.md` with minimal editing. Keep the honesty;
the caveats are the point.*

### What a stage can do

A Stageflow stage runs an AI coding agent with a `bash` tool. Assume a stage can run any command
available in the container, as the container's user. That is not a bug — it is the product. Also
assume that the content a stage reads (a repository, an issue body, a README, a previous stage's
envelope) can influence what it does, because prompt injection is not a solved problem. The
practical consequence: **treat a stage's capabilities as the capabilities of whoever can get text in
front of it.**

Within the container, a stage can:

- read and write its own worktree and run workspace;
- run arbitrary shell, including network calls;
- use the secrets **declared** for that stage, and no others (slot 6). A stage that only writes code
  does not hold the `GITHUB_TOKEN` that a PR-raising stage holds.

A stage cannot:

- read `state.db`, `agent/auth.json`, or another run's workspace — those are outside its reach by
  path deny list (slot 1);
- see the Host's control token, provider keys, or any undeclared secret (slot 6);
- reach the Docker daemon. **We never mount the Docker socket**, we add **no capabilities**, and we
  do not run `--privileged`. If a document or a blog post tells you to mount
  `/var/run/docker.sock` into Stageflow, it is wrong: that is a host root escape, and nothing in
  Stageflow needs it.

### What the operator controls

| Control | Mechanism |
|---|---|
| Inbound access | Bind address, allowed hosts, and a control token (slot 5) |
| Which secrets a stage holds | `secrets:` declarations per stage (slot 6) |
| CPU and memory | `docker run --cpus --memory`. Stageflow owns time, disk, and tokens; the operator owns CPU and memory — enforcing those inside Stageflow needs privileges we tell you never to grant |
| Outbound reach | Network topology: an `internal: true` network plus a domain-allowlisting proxy sidecar (item 7) |
| Filesystem | `read_only: true`, `cap_drop: ALL`, `no-new-privileges`, with the two writable paths in item 10 |

### The honest caveat about egress allowlisting

A domain allowlist reduces the blast radius. It does not eliminate it, and the reason matters:
**a broad allowed host is an exfiltration channel.** If `github.com` is on your allowlist — and it
will be, because that is where the repositories are — then a stage holding a token can create a
gist, push a branch, open an issue, or write a comment containing anything it has read. The
allowlist saw a permitted host and let it through. The same is true of any allowed model provider
endpoint, which is by definition a channel for arbitrary text.

So the allowlist is worth having: it stops the long tail of arbitrary destinations and it turns a
silent egress into something your proxy logs. But do not read it as containment. **The controls that
actually bound this are scoping the credential (a fine-grained token on one repository rather than
an org-wide one) and choosing what you point a stage at.** We state the limit here because a user
who believes the allowlist is containment will make a worse decision about the token than a user who
knows it is not.

---

## Out of scope

- **The Dockerfile, the compose file, and the GHCR publish job.** They come after all nine slots.
  This slot defines the values they must use — `STAGEFLOW_BUILD_SHA`, the label table, the writable
  paths, the reference compose — and writes the docs page they point at. The compose snippets in
  this brief are documentation content, not a shipped `docker-compose.yml`.
- **Litestream or any continuous-replication scheme.** Rejected. It is a second daemon, a second
  failure mode, and an object-store dependency, in exchange for an RPO improvement over
  `sf backup` on a cron that almost no self-hosted Stageflow user needs. **One sentence on the docs
  page pointing at Litestream for users who want continuous replication is the entire deliverable**
  — it is a real tool and a reasonable choice, it is just not something we build, test, or support.
- **Admission-controller or runtime signature enforcement.** We publish signed attestations and one
  verification command. Whether you enforce that with Sigstore policy-controller, Kyverno, an
  admission webhook, or a human running `cosign verify` before `docker pull` is your deployment
  choice, not ours.
- **Per-run restore, store merging, or importing an export back into a live store.** Item 2 states
  the reason.
- **Building the egress proxy.** Item 7 states the reason.
- **Backup rotation and scheduling.** Cron and volume snapshots own it. The API can list and delete.
- **Encrypting backups at rest.** Mode `0600`, a loud sentence that the file contains credentials,
  and `--no-credentials` for people who want the file to be non-secret. Key management is not a
  feature we can ship responsibly in this slot.
- **`PRAGMA foreign_keys`, `PRAGMA user_version`, the migrations ledger, the downgrade guard**
  (slot 1); **the clean-close WAL checkpoint and the exit-code table** (slot 4); **the control token**
  (slot 5); **making proxy variables work** (slot 6); **`sf doctor` and the health split** (slot 7);
  **persisting inline pipelines and the run manifest** (slot 9).

---

## Acceptance criteria

**Backup and restore**

1. `sf backup` against a store with an active run produces a file that opens, passes
   `PRAGMA quick_check`, and contains the rows committed immediately before the backup started.
2. The backup output has no `-wal` or `-shm` sibling, and its `user_version` equals the source's.
3. An interrupted `sf backup` leaves no file at the target path — only an orphaned `.partial`.
4. `sf backup` on a volume with less free space than the database fails with
   `backup_insufficient_disk` before writing anything substantial.
5. The default backup contains the snapshot, `settings.json`, `agent/auth.json`, and a
   `manifest.json`; the tarball and the `auth.json` entry are mode `0600`; `--db-only` and
   `--no-credentials` each produce exactly what their name says.
6. `sf restore` refuses while `sf mcp` is running, and refuses while any other process holds
   `state.db`, each with a distinct named error.
7. `sf restore` never spawns a Host, even with no Host running and `STAGEFLOW_NO_AUTOSTART` unset.
8. `sf restore` moves the previous `state.db`, `-wal`, and `-shm` aside rather than deleting them,
   and the restored file has no stale `-wal` / `-shm` beside it on first open.
9. `sf restore` of a backup whose `user_version` exceeds the binary's maximum refuses with slot 1's
   downgrade-guard error.
10. A restore of a backup taken without `--include-a2a-artifacts` reports the number of artifact rows
    whose bytes are absent, rather than failing or staying silent.
11. `POST /api/restore` rejects a corrupt archive synchronously; accepts a good one with `202`,
    a staged path, and a drain deadline; the Host restarts and boots with the restored store; the
    marker ends as `restore.applied`. Two failed applies produce `restore.failed` and no loop.
12. `POST /api/backup` and `GET /api/backup/<name>` both refuse without a control token, and
    `GET /api/backup/../../etc/passwd` is rejected, not served.

**SQLite and the filesystem boundary**

13. `PRAGMA synchronous` reads `FULL` (`2`) on both a Host connection and a forked stage worker's
    connection; `STAGEFLOW_SQLITE_SYNCHRONOUS=NORMAL` changes it on both.
14. Pragmas are applied from one shared helper; `src/a2a/store.ts`'s self-opened connection gets the
    same set as `SqliteRunStore`'s.
15. A store whose `state.db` is corrupt fails boot with `store_integrity_failed`, and the message
    names `sf restore`. Serving does not begin.
16. A boot with a WAL over the threshold logs one checkpoint and leaves a small WAL behind.
17. Full `integrity_check` appears only in `sf doctor` and in `sf backup`'s output verification —
    never on a boot path, never on a health route.
18. Starting with `$STAGEFLOW_HOME` on an NFS or CIFS mount refuses with
    `store_unsupported_filesystem` naming the detected type; `STAGEFLOW_ALLOW_NETWORK_STORE=1`
    downgrades it to a warning; `9p` / `virtiofs` warn without refusing; `/api/health` reports
    `store_filesystem`.

**Provenance**

19. `BUILD_SHA` is `"unknown"` in a plain `npm run build`, and equals `STAGEFLOW_BUILD_SHA` when set.
20. `/api/health` reports `version` and `build_sha`; `sf --version --json` reports the same values.
21. `docs/docker.md` contains the full label table, the pinned-base-by-digest requirement, the
    `--provenance=true --sbom=true` requirement, the cosign snippet, the statement that
    `revision` and `build_sha` are the same value, and the statement that labels are hints and only
    attestations are evidence.

**Egress and logs**

22. `/api/health` reports the `egress` block, including `dispatcher_installed`, and never includes a
    proxy URL's userinfo.
23. The reference compose in the docs runs as written, with the Host on `internal: true` reaching a
    model provider only through the sidecar.
24. `docs/docker.md` contains the threat model section, including the "Docker socket is never
    mounted, no added capabilities, no `--privileged`" statement and the allowlist caveat.
25. A log record over `STAGEFLOW_LOG_MAX_LINE_BYTES` is truncated and marked, never dropped; no
    transcript body reaches stdout; the full transcript is still retrievable from the run store.

**Export and writable paths**

26. `sf export --all` emits a header line then one line per run, streams without materialising all
    runs, and includes non-terminal runs.
27. Each exported run carries `pipeline_source`, with inline-pipeline runs explicitly marked as
    having no pipeline body yet.
28. `GET /api/export` refuses without a control token and produces byte-identical NDJSON to the CLI
    for the same filters.
29. `sf export --all --out` refuses a path inside `$STAGEFLOW_HOME/worktrees/` or a run workspace,
    and refuses `..` segments.
30. With `$STAGEFLOW_HOME` and `TMPDIR` writable and every other path read-only, a full pipeline run
    completes: repository bind, stage execution with `verify`, envelope emit, GC sweep, `sf backup`.
    An unset `TMPDIR` fails at boot with a named error, not at run time with `EROFS`.

**Docs**

31. `docs/docker.md` exists, is linked from `docs/README.md` under "Operating Stageflow", and carries
    the precious-vs-disposable table, the "why `cp state.db` corrupts" explanation, the
    backup/restore runbook, the upgrade and rollback procedure, the threat model, the reference
    compose, and the one-sentence Litestream pointer.
32. `docs/cli-reference.md` documents `sf backup`, `sf restore`, and `sf export --all` in the shape
    the rest of that page uses.

---

## Testing

### Automated — repo convention

Tests live in `tests/*.test.ts` (Vitest), one file per surface, named after the thing under test.
`tests/cli.exportRun.test.ts` is the closest existing model for the CLI ones.

| File | Covers |
|---|---|
| `tests/runstore.backup.test.ts` | `VACUUM INTO` snapshot against a store with writes in flight; `quick_check` on the output; `user_version` match; no `-wal` sibling; `.partial` cleanup on a simulated failure |
| `tests/runstore.restore.test.ts` | the live-Host refusal (both probes), moving the old store aside, stale `-wal`/`-shm` removal, downgrade refusal, missing-artifact reporting |
| `tests/runstore.pragmas.test.ts` | `synchronous` on Host and worker connections, the env override, the shared helper applying to A2A's self-opened connection |
| `tests/runstore.storeFilesystem.test.ts` | mount-type classification against **injected** `mountinfo` fixtures — do not require a real NFS mount |
| `tests/cli.backup.test.ts`, `tests/cli.restore.test.ts` | arg parsing, `--json` shape, exit codes, help text |
| `tests/cli.exportAll.test.ts` | NDJSON header + per-run lines, non-terminal inclusion, `pipeline_source`, out-path refusals |
| `tests/server.backupRoutes.test.ts` | token enforcement, path traversal rejection, `POST /api/restore` staging + `202`, marker lifecycle |
| `tests/server.export.test.ts` | streaming NDJSON parity with the CLI, token enforcement |

Run `npm test`, `npm run ui:test`, and `npm run typecheck` before finishing (`AGENTS.md`).

### Manual — what the automated tests cannot reach

These are the ones that matter, because the failure this slot prevents is a filesystem-level one.

1. **The corruption you are replacing.** Start `sf mcp`, start a long pipeline, and while it runs
   `cp ~/.stageflow/.stageflow/state.db /tmp/naive.db`. Open `/tmp/naive.db` and count rows against
   the live store. Then `sf backup --out /tmp/good.tar.gz` during the same run and compare. Write
   the numbers down — they belong in the docs page.
2. **Restore round trip, on a real volume.** Back up, stop the Host, delete the data directory,
   restore, start, and confirm every run, envelope, and gate reply is present and the operator
   console renders them.
3. **The `read_only: true` profile.** Run the Host with the data volume and `TMPDIR` writable and
   everything else read-only, and execute a full pipeline including a `verify` command that installs
   dependencies. This is where an unaudited `os.tmpdir()` shows up.
4. **`POST /api/restore` under `restart: unless-stopped`.** Confirm the Host drains, the boot path
   applies the marker, and the container comes back restored — and that a deliberately corrupt
   archive is rejected before anything is staged.
5. **The compose reference, as written.** Bring up the three services, confirm a stage cannot reach
   an off-allowlist host and can reach the model provider, and confirm `/api/health`'s `egress`
   block matches reality.
6. **Provenance, end to end.** Once an image exists: `docker inspect` the `revision` label,
   `GET /api/health` on the running container, and confirm the two SHAs are identical. Run the
   documented `cosign verify` command verbatim from the docs and confirm it passes — and that it
   fails against an unsigned local build.

---

## Repo conventions

- **Read `AGENTS.md` first.** Minimal focused diffs; match the patterns in the area you touch; no
  comments unless the logic is non-obvious; never commit secrets.
- **`--json` output and exit codes are a public contract** (`docs/ci.md`, `tests/cli.*.test.ts`).
  New commands need their exit codes chosen deliberately and documented, and they must coordinate
  with slot 4's exit-code table.
- **CLI command shape.** New commands register in the list at `src/cli.ts:129-144` and dispatch
  near `:371`, with the implementation in `src/cli/<name>Command.ts` and a hand-rolled arg loop plus
  a `*_USAGE` constant — `src/cli/exportRunCommand.ts:9-71` is the model. Inject IO through an
  `Io`-style object with a `defaultIo` (`:12-20`) so tests can capture output.
- **Env var naming.** `STAGEFLOW_*`, with `STAGEFLOW_SQLITE_BUSY_TIMEOUT_MS`
  (`src/runstore/sqlite/SqliteRunStore.ts:172-183`) as the model for a parsed, defaulted,
  validated knob. Secret-bearing variables get a `_FILE` variant.
- **Path containment.** Reuse the existing shape — `..`-rejection plus `realpath` containment —
  from `src/mcp/readArtifact.ts:72-93` and `src/cli/exportRunCommand.ts:93-106`. Do not write a
  third one.
- **Store access.** Go through the `RunStore` port (`src/runstore/port.ts`). `SqliteRunStore`'s
  `get connection()` (`:518-524`) is documented as having exactly one legitimate caller; do not
  become the second.
- **Docs.** Public pages live in `docs/` and are indexed in `docs/README.md` (Jekyll front matter:
  `layout: default`, `title`, `permalink` — see `docs/README.md:1-5`). `docs/` is **not** in
  `package.json` `files`, so the page ships via GitHub Pages, not npm. Put `docs/docker.md` under
  "Operating Stageflow" in the index table.
- **Positioning.** User-facing copy leads with configurable stages and pipelines; SDLC is one
  example among others.
- **Do not commit.** Leave the work staged for review.

---

## Open questions for the human

1. **Backup credentials by default — confirm.** The default `sf backup` output contains
   `agent/auth.json`, making the file a secret. The alternative is credentials-excluded by default,
   which is safer but produces backups that restore into a Host that cannot call a model. This brief
   chose "include, mode `0600`, say so loudly." Confirm, because it is the one decision here with a
   real argument on both sides.
2. **`synchronous = FULL` cost on slow volumes.** `FULL` is right for durability. On a cheap VPS with
   network-backed block storage it could measurably slow event writes, which happen often. Worth a
   measurement before shipping? Or ship `FULL` with the env knob and treat a complaint as the signal?
3. **Refuse or warn on NFS.** This brief refuses on `nfs`/`cifs` with an env escape hatch. A refusal
   turns "silent eventual corruption" into "it won't start," which is better but will generate
   support traffic from users who had it apparently working. Confirm the refusal.
4. **Where does `docs/docker.md` stop?** It is going to be a long page: install, the data volume,
   backup and restore, upgrade and rollback, the threat model, the compose reference, provenance
   verification, derived images. Split it now (`docker.md` + `security.md` + `backup.md`) or write
   one page and split when it hurts?
5. **The upgrade/rollback promise, precisely.** The plan says "patch versions interchangeable, minor
   versions upgrade-only." Slot 1 implements the guard; slot 8 publishes the promise. Is that the
   final wording, and does a rollback across a minor version get "restore from backup" as the only
   supported path?
6. **Does `sf backup` belong behind a gate at all?** `POST /api/backup` is behind the control token,
   but a backup is a read of everything — including credentials — so a `read`-scoped token being
   able to trigger one and then `GET` it would be a privilege escalation. This brief puts `POST` at
   `drive` scope and `GET` at `read`. Should the `GET` also require `drive`?
7. **`/api/export` and A2A.** Should an A2A caller be able to export? A2A already has per-caller
   identity (`src/a2a/store.ts:11-29`), so scoping an export to one caller's runs is possible —
   but that is slot 9's attribution work, and until it lands an export is all-or-nothing. Defer, or
   block export on A2A entirely for now?
