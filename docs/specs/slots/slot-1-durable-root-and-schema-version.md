---
status: implementation-brief
slot: 1
---

# Slot 1 — Durable root and a store that knows its own version

## For the agent picking this up

**Stageflow** is a Node/TypeScript runtime for configurable multi-stage AI agent workflows. Users
author pipelines and tasks as YAML (`*.pipeline.yaml`, `*.task.yaml`, an optional `stageflow.yaml`
manifest); each stage runs in a fresh agent session and hands off to the next through typed
envelopes and artifacts. There are four ways to drive it:

- the CLI, `sf` (`sf run`, `sf runs`, `sf validate`, `sf ui`, `sf mcp`) — entry point `src/cli.ts`
- an HTTP Host that serves the operator console REST API, an MCP endpoint at `/mcp`, and an A2A
  endpoint (`src/server/`, `src/mcp/`, `src/a2a/`)
- SQLite for all run state, via `better-sqlite3` in WAL mode (`src/runstore/`)
- stages, which execute as **forked Node child processes** of the CLI (`internal run-stage`)
  hosting a "Pi" coding agent that has `read` / `write` / `edit` / `bash` tools
  (`src/runtime/stageProcessLauncher.ts`, `src/runtime/stageWorker.ts`, `src/agent/piAdapter.ts`)

The project is being prepared for **containerization**: one published image that an operator runs
anywhere, points their existing coding agent at over MCP, and gets what a laptop install gives them.
That preparation is split into nine build slots, described in
[`../pre-container-work.md`](../pre-container-work.md). **This is slot 1** — it covers Workstream 1
(durable root contract), section 12.1 (schema versioning), and two riders from 10.11.

Read [`../pre-container-work.md`](../pre-container-work.md) §"Build order", §1, and §12.1 for the
wider argument. This brief is meant to be sufficient on its own.

## Mission

Make the durable root an explicit, overridable, documented, single-level directory — and give the
SQLite store a real schema version with forward-only migrations applied by the Host alone, so that
rolling an image tag back cannot silently corrupt data.

## Why this matters

Three concrete failures.

1. **The durable root moves when you least want it to.** It is `path.join(os.homedir(),
   ".stageflow")`, hardcoded, with no override (`src/project/globalHome.ts:5-7`). `os.homedir()`
   reads the passwd entry and falls back to `$HOME`. Run the image as `--user 1000:1000` with no
   matching `/etc/passwd` entry and it can resolve to `/` or to an unset `$HOME`. Every durable
   path — the database, every run workspace, provider credentials — silently relocates, and the
   Host looks like it lost its data. A volume mounted at a path nothing writes to is the most
   confusing possible first-run experience.

2. **A rollback silently writes bad rows.** There is no `PRAGMA user_version` and no migrations
   table anywhere in `src/`. The schema evolves by probing `PRAGMA table_info(...)` and adding
   columns when they are absent — twelve such probes plus a full-table backfill, **on every
   connection open**, outside any transaction (`src/runstore/sqlite/SqliteRunStore.ts:491-511`).
   Today an *older* binary opens a *newer* database happily, finds the columns it knows about,
   ignores the rest, and writes rows the newer code will misread. On a laptop nobody downgrades. A
   container operator rolls back an image tag as a matter of routine. Containerizing is what
   creates this risk, which is why it lands before the first published image and not after.

3. **Every forked stage worker runs DDL.** Workers open their own store
   (`src/runtime/stageWorker.ts:33`), so N workers launching at once each try to take the exclusive
   lock that `ALTER TABLE` needs, against a 5000 ms `busy_timeout`. On a slow volume a worker dies
   with `SQLITE_BUSY` before doing any work. Each one also runs a full-table `UPDATE` and a
   legacy-tree `readdir` it has no business running.

And one correctness point that is nearly free: the foreign keys declared throughout the schema are
decoration today, because `PRAGMA foreign_keys` is never enabled.

## Dependencies

**Assumes shipped:** nothing. This is the first slot.

**Blocks:** slot 2 (the bare-clone cache at `$STAGEFLOW_HOME/repos/` and per-run worktrees at
`$STAGEFLOW_HOME/worktrees/`), slot 3 (GC, which needs to know what lives where), and slot 8
(backup and restore, which needs the keep/disposable distinction this layout defines). All three
write into the root this slot defines.

**Do not break:**

- existing local installs — anyone with data under `~/.stageflow/.stageflow/` must find it after
  upgrading, with no manual step
- the library export surface: `globalStageflowHome` and `ensureGlobalHome` are re-exported from
  `src/index.ts:6-8`
- the `sf run --json` output contract and CLI exit codes (`docs/ci.md`, `tests/cli.*.test.ts`)
- the shared-connection arrangement between the run store and the A2A store — `createRunStoreWithConnection`
  hands its `better-sqlite3` connection to `A2aStore` so both live in one `state.db` and one
  transaction domain (`src/runstore/createStore.ts:33-40`, `src/server/bootstrap.ts:69,116`,
  `src/a2a/store.ts:109-122`)

## Verified current state

Re-verify each of these before you start; line numbers drift.

| Fact | Evidence |
|---|---|
| Durable root is `path.join(os.homedir(), ".stageflow")`, hardcoded, no override | `src/project/globalHome.ts:5-7` |
| `ensureGlobalHome()` creates the root plus a `0700` `agent/` subdir, and is called at nearly every CLI entry | `src/project/globalHome.ts:9-20`, called from `src/project/resolveStageflowContext.ts:36` and `src/project/resolveProjectContext.ts:16` |
| No `STAGEFLOW_HOME` exists anywhere in `src/`, `tests/`, or the shipped docs | repo-wide search returns nothing outside planning docs |
| The Host opens the run store at `ctx.globalHome` | `src/server/bootstrap.ts:69` |
| `storeRootFor(rootDir)` appends `.stageflow`, so the store root is `~/.stageflow/.stageflow/` | `src/runstore/paths.ts:11-14`, applied at `src/runstore/createStore.ts:35-38` |
| `state.db` sits directly in that store root | `src/runstore/sqlite/SqliteRunStore.ts:491-493` |
| Run workspaces are `<storeRoot>/runs/<runId>/` | `src/runstore/paths.ts:58-64` |
| A2A artifact bytes are `<storeRoot>/a2a-artifacts/` | `src/a2a/store.ts:110,121` |
| `settings.json` is at `globalStageflowHome()/settings.json` — i.e. the *outer* dir, not the store root | `src/runtime/settingsFile.ts:25` |
| An existing legacy-rename migration already exists, moving `<root>/.software-factory` → `<root>/.stageflow` | `migrateLegacyStoreRoot`, `src/runstore/paths.ts:29-56`, called at `src/runstore/createStore.ts:35` |
| Store constructor sets only two pragmas: `journal_mode = WAL` and `busy_timeout` | `src/runstore/sqlite/SqliteRunStore.ts:494-495` |
| `busy_timeout` default 5000 ms, overridable by `STAGEFLOW_SQLITE_BUSY_TIMEOUT_MS` | `src/runstore/sqlite/SqliteRunStore.ts:172-184` |
| No `PRAGMA user_version`, no `schema_migrations` table, no `PRAGMA foreign_keys`, no `PRAGMA synchronous` anywhere in `src/` | repo-wide search |
| **Twelve** `ensure*` column/table probes run on every connection open, outside a transaction | `src/runstore/sqlite/SqliteRunStore.ts:497-508`; the probes themselves at `186-261`, `356-...` |
| `backfillVerificationOutcomes` runs a full-table `UPDATE` on every open | `src/runstore/sqlite/SqliteRunStore.ts:263-…`, called at `509` |
| `importDiskRunsIfEmpty` runs a legacy-tree scan on every open | `src/runstore/sqlite/SqliteRunStore.ts:510`, `src/runstore/sqlite/migrateFromDisk.ts:14` |
| Forked stage workers open their **own** store against the global home | `src/runtime/stageWorker.ts:33` |
| So do several CLI paths | `src/cli.ts:395`, `src/cli/runsCommand.ts:377`, `src/cli/exportRunCommand.ts:158`, `src/cli/envelopeCommand.ts:309`, `src/cli/artifactCommand.ts:132`, `src/cli/hostClient.ts:60` |
| Provider credentials live in **two** homes: `$globalHome/agent/auth.json` and `~/.pi/agent/auth.json` | `src/runtime/credentialBinding.ts:32-38` and `:40-47`; selection logic at `:73-109` |
| Pi's agent dir is already redirectable per stage via the `PI_CODING_AGENT_DIR` env var | `src/runtime/stageRoots.ts:23,51-60`, bound at `src/runtime/stageWorker.ts:75` |
| Artifact reads deny `.pi-agent` path segments and any `auth.json` basename, then enforce `realpath` containment | `src/mcp/readArtifact.ts:72-78` and `:82-93` |
| The agent's own tool allowlist is `read`, `bash`, `write`, `edit` plus custom tools — there is no path deny list on any of them | `resolveStageToolNames`, `src/agent/piAdapter.ts:102-122`; wired at `:1159-1174`, `:1242`, `:1307` |
| jiti is created with no cache configuration | `src/agent/piIsolatedMcp.ts:140-141` |

**Where the plan document is wrong.** Three small corrections, none of which change the work:

- §12.1 says "nine such probes." There are **twelve** `ensure*` calls
  (`SqliteRunStore.ts:497-508`), plus `backfillVerificationOutcomes` and `importDiskRunsIfEmpty`.
- §12.1 cites the constructor as `493-510`. It is `491-511`.
- §1.2 cites A2A artifacts as `src/a2a/store.ts:120`. The `storeRootFor` call is at `110` and the
  `a2a-artifacts` join is at `121`.

## The work

### 1. Introduce `STAGEFLOW_HOME`

**Today.** `globalStageflowHome()` returns `path.join(os.homedir(), ".stageflow")` with no override
(`src/project/globalHome.ts:5-7`).

**Target.** `STAGEFLOW_HOME` env var, default `~/.stageflow`. Resolved **once** and validated at
boot: the path exists or can be created, is a directory, and is writable. Surfaced in health output
by a later slot.

**Design decisions already made — do not relitigate:**

- **Env var only, no CLI flag.** A flag has to be threaded through every `sf` subcommand and every
  forked worker; the env var is inherited by forks for free and is what a container sets anyway.
- **Resolve inside `globalStageflowHome()`**, not at each call site. There are a dozen callers
  (see the table above) and they must not diverge. Relative values are resolved against
  `process.cwd()` and stored absolute.
- **Resolve once per process and memoize.** A value that changes mid-process because something
  mutated `process.env` is a bug factory. Tests that need a different root get an explicit reset
  helper exported from the same module.
- **Validate at Host boot, not at every CLI call.** A read-only `sf --help` should not fail on a
  bad volume.

**Files likely to touch:** `src/project/globalHome.ts` (the whole change lives here), plus whatever
boot-time validation hook you add in `src/server/bootstrap.ts`.

### 2. Flatten the layout, document it, migrate existing installs

**Today.** `storeRootFor(globalHome)` produces `~/.stageflow/.stageflow/`
(`src/runstore/paths.ts:11-14`, `src/runstore/createStore.ts:35-38`). Inside it: `state.db`
(+ `-wal`, `-shm`), `runs/<runId>/`, `a2a-artifacts/`. One level up sit `agent/auth.json`,
`settings.json`, and `service.log`. Nothing documents the tree.

**Target.** One documented layout directly under `$STAGEFLOW_HOME`:

```
$STAGEFLOW_HOME/
  state.db, state.db-wal, state.db-shm   the run store
  runs/<runId>/                          run + stage + attempt workspaces
  repos/<host>/<owner>/<repo>.git        bare clone cache        (slot 2)
  worktrees/<runId>/                     per-Run working tree    (slot 2)
  agent/auth.json                        provider credentials
  a2a-artifacts/
  cache/                                 shared dependency caches (slot 6)
  settings.json
```

Plus a first-boot migration that moves an existing `~/.stageflow/.stageflow/*` up one level.

**Design decisions already made — do not relitigate:**

- **Keep `storeRootFor` as a function, change what it returns for the global home.** Per-project
  store roots (`<gitRoot>/.stageflow/settings.json`, `src/runtime/settingsFile.ts:28-39`) still
  need the `.stageflow` suffix. Only the *global* root flattens. The cleanest shape is a distinct
  resolver for the global store root; do not make every caller remember which one to use.
- **Model the migration on `migrateLegacyStoreRoot`** (`src/runstore/paths.ts:29-56`): probe the
  directory state, skip when the destination is already populated, rename, tolerate the
  already-migrated race. Same idempotence contract, and reuse its `directoryState` helper.
- **The migration must run before the first `new SqliteRunStore(...)`**, exactly where
  `migrateLegacyStoreRoot` runs today (`src/runstore/createStore.ts:35`). Moving a `state.db` with
  live `-wal`/`-shm` siblings out from under an open connection corrupts it.
- **Move, do not copy.** A copy doubles disk on a volume that may be nearly full, and leaves two
  divergent stores.
- **The `~/.pi` question is decided: bring it under one roof.** Set `PI_CODING_AGENT_DIR` to a path
  under `$STAGEFLOW_HOME` for the Host and for stage workers, so a single volume covers all
  credentials. The mechanism already exists and is already used per stage
  (`src/runtime/stageRoots.ts:51-60`, `src/runtime/stageWorker.ts:75`). The `pi_home` credential
  source stays supported for laptop users who already have an authenticated `~/.pi`
  (`src/runtime/credentialBinding.ts:73-109`) — the change is that the container profile defaults to
  `sf_owned` and never needs a second volume. Reason: "two volumes or your credentials vanish" is a
  support burden with no upside.
- **Documenting the tree is part of the deliverable, not a follow-up.** Add it to the public docs
  under `docs/`, with a column marking each entry **keep** (`state.db`, `agent/auth.json`,
  `settings.json`) or **disposable** (`repos/`, `worktrees/`, `cache/`). Slot 8's backup story is
  built directly on that distinction, and it turns a 40 GB backup into a 40 MB one.

**Files likely to touch:** `src/runstore/paths.ts`, `src/runstore/createStore.ts`,
`src/project/globalHome.ts`, `src/runtime/settingsFile.ts`, `src/a2a/store.ts`,
`src/cli/hostClient.ts`, `src/runtime/stageRoots.ts` (for the `PI_CODING_AGENT_DIR` default),
`docs/` (new or extended page), `docs/README.md` index.

### 3. Put the store and credentials out of the agent's reach

**Today.** Artifact reads over MCP deny `.pi-agent` segments and any `auth.json` basename, then
enforce `realpath` containment inside the run workspace (`src/mcp/readArtifact.ts:72-78, 82-93`).
The agent's own tools have no equivalent: `resolveStageToolNames` hands Pi `read`, `bash`, `write`,
`edit` unrestricted (`src/agent/piAdapter.ts:102-122`).

**Target.** A path deny list applied to the agent's file tools covering all of `$STAGEFLOW_HOME`
**except** the run's own workspace (and, from slot 2, its own worktree). Denied reads and writes
fail with a named error rather than a bare `EACCES`.

**Design decisions already made — do not relitigate:**

- **Reuse the shape in `readArtifact.ts`, do not invent a second one.** Resolve with `realpath`,
  then check containment with `isInsideDir` (`src/runstore/workspaceLayout.ts`). Symlink escape is
  the failure mode that matters and `realpath` is what closes it. Factor the check into one module
  both call sites use.
- **Allow, then deny, in that order.** The run's own workspace is inside `$STAGEFLOW_HOME`, so a
  flat "deny everything under the root" rule locks the agent out of its own scratch area.
- **This is defence in depth, not a sandbox, and the brief must say so.** `bash` is in the same
  tool list and can read any file the process can. The honest claim is that the accidental path is
  closed and the guarantee "the store is outside the Checkout" becomes deliberate rather than
  incidental. Do not try to path-restrict `bash` in this slot — that is a much larger argument
  about stage isolation, and it belongs to slot 6.

**Files likely to touch:** `src/agent/piAdapter.ts` (tool wiring around `:1159-1174`), a new shared
containment module alongside `src/runstore/workspaceLayout.ts`, `src/mcp/readArtifact.ts` (to
consume the shared module).

### 4. `PRAGMA user_version`, a migrations ledger, and a downgrade guard

**Today.** See the evidence table: twelve probe-and-`ALTER` helpers plus a full-table backfill plus
a legacy-tree scan, on every connection open, in every process, outside any transaction
(`src/runstore/sqlite/SqliteRunStore.ts:491-511`).

**Target.**

- `PRAGMA user_version` holds the integer schema version the on-disk database is at.
- A `schema_migrations` ledger table records each applied migration: version, name, and applied
  timestamp. `user_version` is the fast check; the ledger is what a human reads in a bug report.
- Migrations are **forward-only**, numbered, and each runs inside **one transaction** with the
  `user_version` bump in the same transaction. A half-applied migration must be impossible.
- Migrations are applied **by the Host only**. Workers and CLI store-openers assert the version and
  **refuse** with a named error rather than mutating schema.
- The Host **refuses to start** when the on-disk `user_version` is **greater** than the maximum the
  binary knows, with an error naming the on-disk version, the binary's version, and the minimum
  Stageflow version that can open it.
- `PRAGMA foreign_keys = ON` on every connection.

**Design decisions already made — do not relitigate:**

- **Integer `user_version` plus a ledger, not a ledger alone.** `user_version` is a header read with
  no query and no lock, which is exactly what a worker's assert-and-refuse path needs.
- **Forward-only. No down migrations.** Down migrations for a run store that holds the only copy of
  a user's history are a way to lose data confidently. Rollback is "restore a backup" — slot 8.
- **Host applies, workers assert.** This is what removes the `SQLITE_BUSY` startup contention and
  the per-worker full-table `UPDATE`. The migration entry point needs an explicit opener mode
  (something like `{ migrate: true }` for the Host, the default being assert-only) threaded from
  `createRunStore` / `createRunStoreWithConnection` down into the `SqliteRunStore` constructor.
- **The existing `ensure*` probes become migration 1, transcribed, not redesigned.** An install
  that has been through all twelve probes and a fresh install that runs `SCHEMA_SQL` must both land
  at version 1 with identical schema. Write the baseline detection carefully: an existing database
  with no `user_version` that already has, say, `runs.checkout_root` is at the current shape and
  should be stamped, not re-migrated. Keep the probes' idempotence (`IF NOT EXISTS`, column checks)
  inside migration 1 so stamping a partially-evolved legacy database is safe.
- **`backfillVerificationOutcomes` and `importDiskRunsIfEmpty` move behind the same gate.** They are
  one-shot data migrations wearing a per-open costume. `importDiskRunsIfEmpty` is already
  async-and-awaited through `ready()` (`SqliteRunStore.ts:510-516`); preserve that contract.
- **Named error codes, stable, on both refusal paths.** Use `store_schema_too_new` for the
  downgrade guard and `store_schema_migration_required` for a worker that finds an unmigrated
  database. Slot 5's error taxonomy and slot 7's `/readyz` both branch on these.
- **Scope: `user_version` and the ledger only.** `PRAGMA synchronous` and WAL checkpoint policy are
  §12.3 and belong to a later slot; do not change them here.

**Files likely to touch:** `src/runstore/sqlite/SqliteRunStore.ts`, a new
`src/runstore/sqlite/migrations/` directory, `src/runstore/createStore.ts`,
`src/server/bootstrap.ts`, `src/runtime/stageWorker.ts`, `src/a2a/store.ts` (its own
`db.exec(SCHEMA_SQL)` at `:120` runs on the shared connection and needs the same treatment).

### 5. The fixed non-root UID contract

**Today.** Nothing addresses uid. There is no Dockerfile yet.

**Target.** Pick and document a fixed non-root uid/gid for the image, and make the failure legible
from the Node side — which is the part that is code work and therefore in this slot.

When `$STAGEFLOW_HOME` is not writable, fail at boot with a **named error** that prints:

- the effective uid and gid the process is running as (`process.getuid?.()`, `process.getgid?.()`)
- the resolved `$STAGEFLOW_HOME`
- the exact `chown` command that fixes it, with the real numbers substituted

**Design decisions already made — do not relitigate:**

- **Named volumes are the documented default.** Docker initialises a named volume's ownership from
  the image's declared user; a bind mount does not, which is the entire source of this class of
  bug.
- **Never recursively `chown` the data root on boot.** On a volume with a hundred thousand run
  files that is minutes of startup, and it needs root at entrypoint time, which defeats running as
  a fixed non-root uid in the first place.
- **Fail loudly, do not fall back to a writable temp directory.** A Host that silently relocates its
  database is the failure mode this whole slot exists to prevent.

**Files likely to touch:** `src/project/globalHome.ts` (the writability probe), `src/server/bootstrap.ts`
(the boot-time assertion and the error), `docs/`.

### 6. Point jiti's cache at a writable path under `$STAGEFLOW_HOME`

**Today.** `createJiti(import.meta.url)` with no options (`src/agent/piIsolatedMcp.ts:140-141`).
This is the fallback path for loading Pi's MCP adapter when Node cannot type-strip `.ts` under
`node_modules`. jiti's filesystem cache defaults to a temp or `node_modules`-adjacent location.

**Target.** Configure jiti's cache to a path under `$STAGEFLOW_HOME` (`$STAGEFLOW_HOME/cache/jiti`
fits the layout above).

**Design decisions already made — do not relitigate:**

- **Under `$STAGEFLOW_HOME`, not `TMPDIR`.** The declared writable-paths contract for the container
  is "the data volume plus an explicitly set `TMPDIR`", and a cache that survives restarts is worth
  more than one that does not. It lives under `cache/`, which slot 8 marks disposable.
- **Do not change the jiti-versus-native-import fallback order.** Preferring built entries and
  turning a raw `SyntaxError` into a named error is also listed in §10.11, but it is a different
  change with a different blast radius; keep this slot to the cache path.
- Check the installed `jiti` version's option name before writing the call — verify it against the
  package in `node_modules`, do not guess.

**Files likely to touch:** `src/agent/piIsolatedMcp.ts`.

## Out of scope

- **Backup and restore** (`sf backup` / `sf restore`, `VACUUM INTO`) — slot 8. This slot only
  defines the keep/disposable distinction the backup story consumes.
- **Reporting the schema version on a health surface** — slot 7 builds `/livez`, `/readyz`, and the
  authenticated `/api/health`. This slot builds the mechanism they read.
- **`PRAGMA synchronous`, WAL checkpoint policy, `quick_check` at boot** — §12.3, a later slot.
- **`repos/` and `worktrees/`** — slot 2 creates them. This slot only reserves and documents the
  names so slot 2 does not have to relocate anything.
- **`cache/` being populated and exported as `npm_config_cache` and friends** — slot 6. This slot
  only reserves the directory and uses it for jiti.
- **Anything about binding, tokens, or `STAGEFLOW_BIND`** — slot 5.
- **The Dockerfile, compose file, and registry publishing** — after all nine slots. A Dockerfile
  written before this slot lands has to be rewritten after it.
- **Path-restricting `bash`, or the curated stage environment** — slot 6.
- **The `queued` / `cancelled` status schema changes** — slots 3 and 11.3, and they must land in a
  single schema pass. Your migration framework is what they will use; do not add their columns.

## Acceptance criteria

1. Setting `STAGEFLOW_HOME=/tmp/sf-test` and running any `sf` command places all durable state
   under `/tmp/sf-test` and nothing under `~/.stageflow`.
2. With `STAGEFLOW_HOME` unset, the durable root is `~/.stageflow` — unchanged behaviour for
   existing users.
3. A relative `STAGEFLOW_HOME` is resolved to an absolute path once, and every subsystem
   (store, settings, credentials, A2A artifacts, run workspaces) agrees on the same value.
4. On a fresh install, `$STAGEFLOW_HOME/state.db` exists and `$STAGEFLOW_HOME/.stageflow/` does not.
5. Starting against an existing `~/.stageflow/.stageflow/` containing `state.db`, `runs/`, and
   `a2a-artifacts/` moves all three up one level on first boot, the pre-existing runs are listed by
   `sf runs list`, and the old nested directory is gone. Running it a second time is a no-op.
6. The whole tree is documented in a public page under `docs/`, linked from `docs/README.md`, with
   each entry marked keep or disposable.
7. `$STAGEFLOW_HOME/agent/auth.json` is the only credential path the container profile needs;
   `PI_CODING_AGENT_DIR` resolves under `$STAGEFLOW_HOME` for the Host and for stage workers, and
   the `pi_home` credential source still works for a laptop user who has one.
8. A stage agent's `read` tool on `$STAGEFLOW_HOME/agent/auth.json` and on
   `$STAGEFLOW_HOME/state.db` fails with a named denial; its `write` tool inside its own run
   workspace still succeeds; a symlink inside the run workspace pointing at `state.db` is also
   denied.
9. A freshly created store has a non-zero `PRAGMA user_version` and a `schema_migrations` row per
   applied migration.
10. An existing database created before this change is stamped to the current version without data
    loss, and all of its rows remain readable.
11. When the on-disk `user_version` exceeds the maximum the binary knows, the Host refuses to start
    with `store_schema_too_new`, and the message names the on-disk version, the binary's maximum,
    and the minimum Stageflow version that can open it.
12. A forked stage worker opening an unmigrated database fails with
    `store_schema_migration_required` and applies no DDL. Verified by opening the store with the
    worker's opener mode against a database at an older version.
13. `PRAGMA foreign_keys` reports `1` on both the run store connection and the A2A store's use of
    the shared connection.
14. Migrations run inside a single transaction: a migration that throws part-way leaves
    `user_version` and the schema unchanged.
15. When `$STAGEFLOW_HOME` is not writable, boot fails with a named error whose message contains
    the running uid, the resolved path, and a `chown` command with the real uid and gid
    substituted. Nothing is silently relocated.
16. jiti's filesystem cache resolves under `$STAGEFLOW_HOME/cache/`, and the MCP adapter still
    loads on the fallback path.

## Testing

Repo conventions: **vitest**; tests live in `tests/*.test.ts`; YAML fixtures under
`tests/fixtures/` (`pipelines/`, `stages/`, `tasks/`) and are canonical — extend them rather than
inlining YAML. Run `npm test` and `npm run typecheck` before finishing.

Nearby existing tests worth reading first: `tests/runstore.storeRoot.test.ts`,
`tests/runstore.sqlite.test.ts`, `tests/runstore.adapter.contract.test.ts`,
`tests/runtime.storeResolution.test.ts`, `tests/project.resolveStageflowContext.test.ts`.

Tests this slot needs:

- **`STAGEFLOW_HOME` precedence** — set / unset / relative / absolute, and the memoization
  behaviour (set the env, resolve, change the env, confirm the resolved value does not move without
  an explicit reset). Extend `tests/project.resolveStageflowContext.test.ts` or add a
  `tests/project.globalHome.test.ts`.
- **Layout migration, forward** — build a temp root containing a populated nested
  `.stageflow/.stageflow/` with a real `state.db`, `runs/<id>/`, and `a2a-artifacts/`; open the
  store; assert the flattened layout, that run rows survive, and that a second open is a no-op.
  Mirror the cases `tests/runstore.storeRoot.test.ts` already covers for
  `migrateLegacyStoreRoot`: destination populated, destination empty, source missing.
- **Schema migration forward** — a store created at the pre-migration shape is stamped and readable;
  a fresh store and a migrated legacy store produce identical `PRAGMA table_info` for every table.
- **Downgrade refusal** — write a `user_version` above the binary's maximum, open, assert the
  failure is `store_schema_too_new` and that no DDL ran.
- **Worker assert-and-refuse** — open with the worker opener mode against an older version, assert
  `store_schema_migration_required` and that `user_version` did not change.
- **Migration atomicity** — inject a migration that throws, assert `user_version` and the schema are
  unchanged.
- **Non-writable home error** — `chmod` a temp directory to `0500`, assert the named error and that
  the message contains the uid and a `chown`. Guard it on POSIX and skip when running as root,
  where the `chmod` does not bite.
- **Agent path deny list** — denial for `agent/auth.json` and `state.db`, allow inside the run
  workspace, and a symlink-escape case. Model the assertions on the existing artifact-deny tests.
- **`PRAGMA foreign_keys`** — assert it reads `1`, and add one case where an insert violating a
  declared FK now actually fails.

## Repo conventions

From [`AGENTS.md`](../../../AGENTS.md):

- Match existing patterns in the area you touch; keep diffs minimal and focused.
- No comments unless the logic is genuinely non-obvious.
- Do not refactor code that a logic change does not require.
- Run `npm test` and `npm run typecheck` before finishing. (`npm run ui:test` too if you touch
  anything under `ui/` — this slot should not.)
- Treat `tests/fixtures/` as canonical YAML and keep `examples/` in sync when behaviour changes.
- Public docs live under `docs/` and are indexed by `docs/README.md`. `docs/plans/`,
  `docs/ideation/`, and `docs/adr/` are gitignored and local-only.
- Never commit secrets or `.env` files.
- Do not commit unless you are explicitly asked to.

## Open questions for the human

1. **What is the fixed uid/gid?** `1000:1000` is conventional and matches what `--user 1000:1000`
   users already type; some registries and base images prefer a higher, collision-unlikely number
   such as `10001`. Needs a decision before the Dockerfile, but only the docs text in this slot.
2. **Does the flattening migration need an escape hatch?** For example
   `STAGEFLOW_SKIP_LAYOUT_MIGRATION=1` for an operator who wants to move the data themselves. Adds
   a supported half-migrated state, which argues against it.
3. **What is the starting `user_version`?** Stamping today's shape as `1` is simplest. Starting
   higher (say `100`) leaves numbering room if we ever need to retro-fit a migration under the
   baseline — probably unnecessary given the ledger.
4. **Is the published support policy in scope here or in the release docs?** §12.1 proposes "patch
   versions interchangeable, minor versions upgrade-only." The downgrade guard's error message
   needs to reference *some* policy, so at minimum the wording has to be settled.
5. **Should `service.log` move or disappear?** It is written into the durable root by the detached
   autostart path (`src/server/ensureGlobalService.ts:133-134`). Slot 4 makes that path unreachable
   in the container profile. This slot has to place it in the documented tree regardless — keep it
   at the root, or leave it undocumented as something slot 4 removes?
