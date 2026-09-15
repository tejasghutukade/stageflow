---
status: ready-for-agent
---

# Spec: Global Stageflow service

## Problem Statement

Today, one Stageflow host process serves exactly one project. Its run store,
catalog resolution, and default checkout are all fixed once, at process
bootstrap, from whatever directory the process happened to be launched in
(`bootstrapStageflowHost`, `src/server/bootstrap.ts:51-81`: `rootDir =
options.rootDir ?? ctx.projectRoot`, baked into one `RunManager` for the
life of the process). Practically, this means opening a second project or
git worktree and trying to run its own `sf ui`/`sf mcp` fails, because both
processes try to bind the same fixed port (`DEFAULT_PORT = 3847`,
`src/server/createHttpHost.ts:16`) for what the code assumes is "the"
project.

The real cause isn't the port — it's that the run store and catalog are
resolved once, globally-fixed-per-process, instead of per request. A
per-project discovery/port-fallback mechanism would only patch around that;
it wouldn't fix the deeper mismatch with how this project actually gets
used (many concurrent worktrees on one machine).

## Solution

Make Stageflow a single global, auto-starting service — the same pattern
already used by Claude Code, Pi, and Cursor for their own local background
processes: one process, one global run store, started automatically the
first time anything needs it, reachable at one well-known local address
regardless of which project a caller is working in.

- **Run store goes global.** It moves to the already-existing global home
  (`~/.stageflow/`, `globalStageflowHome()` /
  `src/project/globalHome.ts:5` — today used only for credentials) instead
  of `<project-root>/.stageflow/`. Every run already records which project
  it belongs to (`project_root`, threaded through
  `src/runtime/pipelineRunner.ts:149-164` into `store.createRun`), so a
  global store doesn't lose that information — it just stops being
  fragmented one-database-per-project.
- **Pipeline/task catalogs stay project-local for this pass.** No change to
  how a project's own `pipelines/`/`tasks/`/`stageflow.yaml` are discovered
  — only *where the store lives* changes, not where pipeline definitions
  live. A global catalog (pipelines reusable across every project) is an
  explicit fast-follow, not part of this spec.
- **Project identity is derived from the path already being passed**, not a
  new parameter. `start_run`'s `pipeline`/`task_path`, `describe_pipeline`,
  `validate`, etc. already carry a filesystem path; the service walks up
  from that path with the same `findProjectRoot`
  (`src/project/findProjectRoot.ts`) already used once at boot today — just
  invoked per call instead. A call with nothing to anchor to (a bare
  `list_pipelines`/`list_runs` with no filter) returns results spanning
  every project the store has seen, rather than requiring a new required
  field every caller would otherwise have to learn and pass.
- **The service auto-starts.** The first time anything needs it (a CLI
  command, a host extension) and it isn't already answering its health
  check, it's spawned in the background and stays running. Since there's
  only ever one instance now, the existing fixed `DEFAULT_PORT` stays
  exactly as-is — there's nothing left to collide with it, so no port
  fallback or discovery-file logic is needed at all.
- **The CLI becomes a client of the same service, not a second execution
  path.** Today `sf run` executes pipelines directly in its own process
  (`src/cli/runCommand.ts:172`: `createRunStore({ rootDir: projectRoot })`,
  own in-process `RunManager`) and explicitly refuses to do so when a host
  is already running (`guardHost()`, `src/cli/runsCommand.ts:409-419`) to
  avoid two things mutating the same store at once. Under an always-on
  global service, that guard would trip constantly. Rather than relaxing a
  guard that exists for a real reason, `sf run` (and similar mutating CLI
  commands) instead becomes a client: ensure the global service is running
  (auto-start if not), then drive it the same way a host extension would —
  no direct store access from the CLI process, so the conflict this guard
  protects against no longer exists to guard against.

## User Stories

1. As a user with several projects/worktrees open at once, I want to run
   pipelines in any of them without one blocking another over a port
   collision, so that I don't hit confusing startup failures.
2. As a host integration (Pi extension, Cursor hook, Claude Code subagent),
   I want to connect to one well-known local address regardless of which
   project I'm working in, so that I don't need per-project discovery logic.
3. As a user typing `sf run` in a terminal, I want it to keep behaving the
   same way I already expect — start, wait, see output — even though it now
   talks to a background service under the hood, so that my existing
   workflow doesn't change.
4. As a user, I want the service to start itself automatically the first
   time it's needed, so that there's nothing extra for me to remember to do
   first.
5. As a user with existing per-project `.stageflow/` run history from
   before this change, I want that old data left alone rather than silently
   migrated or altered, so that nothing about my existing projects
   surprises me on upgrade.
6. As a developer calling a tool that already includes a pipeline/task path,
   I want the service to figure out which project that is from the path
   itself, so that I don't need to learn and pass a brand-new parameter for
   the common case.
7. As a developer calling a tool with nothing project-specific to go on
   (browsing everything), I want a sensible "show results across every
   project" behavior instead of an error, so that global browsing just
   works.
8. As a developer, I want run records to keep saying which project they
   belong to, so that a global store doesn't lose the ability to scope a
   view to just one project when that's what's actually wanted.

## Implementation Decisions

- **Store location**: `createRunStore({ rootDir })`
  (`src/runstore/createStore.ts:34`, via `storeRootFor(rootDir)` in
  `src/runstore/paths.ts:12`) currently keys off the project root. Change
  `bootstrapStageflowHost` (`src/server/bootstrap.ts`) to pass the
  already-resolved `ctx.globalHome` (from `resolveStageflowContext`, built
  on `ensureGlobalHome()`) instead of `ctx.projectRoot` for the store's
  `rootDir`. This is the smallest, most contained part of the change — the
  SQLite store already runs in WAL mode with a busy timeout
  (`SqliteRunStore.ts:493-494`), so it already tolerates the
  multiple-reader/one-writer-at-a-time pattern a shared file needs; nothing
  new required there.
- **Per-call project resolution**: `RunManager` currently takes one fixed
  `cwd`/`projectRoot` at construction (`src/server/bootstrap.ts`: `new
  RunManager({ ..., cwd, projectRoot: rootDir, ... })`) and every method
  implicitly trusts it. Path-bearing calls (`start_run`'s
  `pipeline`/`task_path`, `describe_pipeline`, `validate`) need to resolve
  their own project root per call — walking up from the given path via
  `findProjectRoot`, the same function already used once at boot, just
  invoked per call. Calls with no path to anchor to (bare `list_pipelines`,
  `list_runs` with no filter) query across every `project_root` value
  already present in the store rather than requiring one.
- **Auto-start helper**: a health-probe-then-spawn routine — check whether
  the well-known global address is already answering; if not, spawn `sf
  mcp`/`sf ui` in the background pointed at the global store, wait for it
  to report healthy, then proceed. Every entry point that needs the service
  (CLI commands now, host extensions per the companion Pi/Cursor/Claude
  Code integration docs) calls this first. This subsumes and replaces the
  earlier, narrower `sf mcp --ensure` idea from the original host-agnostic
  additions research — same mechanism, now serving the whole service
  instead of a per-project instance.
- **CLI as a client**: `sf run`'s current direct path
  (`src/cli/runCommand.ts:172`) is replaced with: ensure the global service
  is running (spawn if needed, per above), then issue the same `start_run`
  + poll-to-completion sequence a host extension would use — most likely
  against the console's existing REST endpoints (`sf ui`'s "Console
  REST/static" surface per `docs/mcp.md`) rather than a full MCP client,
  since the CLI only needs simple request/response, not MCP's
  session/subscribe machinery. The existing `guardHost()` conflict check
  (`src/cli/runsCommand.ts:409-419`) is removed entirely, along with its
  test coverage — there is no longer a CLI-vs-host conflict to guard
  against, since the CLI no longer touches the store directly.
- **Existing per-project data**: left untouched. `migrateLegacyStoreRoot`
  (`src/runstore/paths.ts:29`) already exists for a different, unrelated
  legacy-path migration; this change explicitly does not extend it to move
  project-rooted stores into the global one. Old per-project `.stageflow/`
  folders are simply no longer written to by anything new; nothing reads or
  writes them automatically after this ships.
- **Catalog resolution unchanged**: `resolveStageflowContext` /
  `resolveCatalogContext` keep resolving a project's own
  `pipelines/`/`tasks/`/`stageflow.yaml` exactly as they do today — only
  now invoked with the per-call derived project root instead of the
  once-at-boot one.

## Testing Decisions

- Unit test that `bootstrapStageflowHost` creates its `RunStore` rooted at
  the global home regardless of which directory the process was launched
  from (fixture: two different fake project directories both produce a
  store at the same global path).
- Unit test per-call project-root derivation: a `start_run` call with a
  pipeline path under fixture project A and another under fixture project B,
  handled by the same running service instance, resolve their own
  catalog/checkout defaults independently and correctly.
- Unit test the "no path to anchor to" fallback: `list_pipelines`/`list_runs`
  with nothing project-specific given returns results spanning multiple
  `project_root` values already present in a fixture store.
- Unit test the auto-start helper directly: given no service currently
  answering the health check, it spawns one and waits for health; given one
  already healthy, it's a no-op.
- Replace the existing `guardHost()` test coverage
  (`tests/cli.runs.*.test.ts`) with coverage asserting `sf run` now succeeds
  as a client while a global service is already running — the previous
  "conflict" case no longer applies.
- Integration-style test: `sf run` invoked from two different fake project
  directories in the same test run produces two runs in the same global
  store, each correctly attributed by `project_root`.

## Out of Scope

- A global pipelines/tasks catalog (pipelines reusable across every
  project) — explicit fast-follow, not this pass.
- Migrating existing per-project `.stageflow/` run history into the global
  store.
- Any port allocation, fallback, or discovery-file logic — moot once
  there's only one process; the existing fixed `DEFAULT_PORT` is unchanged.
- Remote/networked access to the service — it still binds to localhost only
  (existing `localhostHostValidation`/`localhostOriginValidation` in
  `createHttpHost.ts` is unchanged); this is a local-machine global
  service, not a multi-machine one.
- Adding an explicit `project` parameter to any tool schema — deliberately
  avoided in favor of path-derivation, per the decisions above.

## Further Notes

- This reframes what started as "item #3: avoid multi-project port
  collisions" into something bigger and more fundamental, after checking
  the actual code and finding the real constraint was store/catalog
  resolution being fixed once at process boot, not the port itself. The
  original port-collision problem disappears as a side effect rather than
  being directly patched.
- Independent of, and compatible with, the two companion specs
  ([stage-live-output-streaming.md](stage-live-output-streaming.md),
  [inline-pipeline-authoring.md](inline-pipeline-authoring.md)) — neither
  depends on where the store physically lives, since both operate on an
  already-resolved run/store regardless.
- Decided by direct discussion, including two mid-discussion corrections
  prompted by checking the actual code rather than assuming: first, that
  the run store (not just the checkout) is what's project-bound today;
  second, that the CLI's existing direct-execution-plus-host-guard behavior
  would silently break once a global service is always running, which
  reshaped the CLI into a client of the same service rather than a
  second execution path.
- `docs/adr/` is a recognized convention path in this repository but is
  gitignored/local-only; none exist in this worktree, so this spec is the
  record of record rather than a linked ADR.
