---
status: implementation-brief
slot: 7
---

# Slot 7 — Several repos, three health surfaces, a catalog that ships

## For the agent picking this up

**Stageflow** is a Node/TypeScript runtime for configurable multi-stage agent workflows. Users author
pipelines in YAML (`*.pipeline.yaml`, `*.task.yaml`, plus a per-project `stageflow.yaml` manifest
that declares which directories the catalog covers); each stage runs in a fresh agent session, and
stages hand off through typed envelopes and artifacts. The CLI is `sf`.

Five facts about the architecture matter for this slot:

1. **There is one HTTP host, on one port.** `sf ui` and `sf mcp` both call `createHttpHost`
   (`src/server/createHttpHost.ts`), which serves the operator REST API (`/api/*`), the MCP endpoint
   (`/mcp`), and — when an `a2a.yaml` is discovered — A2A (`/a2a`,
   `/.well-known/agent-card.json`) on port `3847`. `sf mcp` mounts the **full** REST API, not just
   health.
2. **The Host resolves exactly one project at boot.** `bootstrapStageflowHost` calls
   `resolveStageflowContext(invocationCwd)` once (`src/server/bootstrap.ts:56`) and carries `cwd` and
   `rootDir` for the whole process lifetime. Everything single-project about Stageflow flows from
   that one line.
3. **The catalog is manifest-driven and git-rooted.** `browseCatalog` walks the directories named in
   `stageflow.yaml`, and it returns an empty catalog unless the context is a git project
   (`src/config/browseCatalog.ts:88-92`).
4. **Run state lives in SQLite** under the global home, outside any checkout. The store knows every
   project root it has ever recorded a run for (`RunStore.listProjectRoots()`,
   `src/runstore/port.ts:476`).
5. **Stages are forked Node child processes** running a "Pi" coding agent with `bash`, `read`,
   `write`, and `edit` tools, plus stage MCP servers resolved from a project-root `.mcp.json`.

Stageflow is being containerized. The work is split into nine shipping slots; see
[`../pre-container-work.md`](../pre-container-work.md) for the full plan and build order. **This is
slot 7** — workstreams 7 and 8, plus 13.3, 12.6, and two items from 10.11. It is the slot where the
Host stops pretending it serves one repository, where configuration and health stop being ad hoc,
and where a first-run user gets something to run without authoring a single file.

You do not need to read the plan doc to do this work. Everything you need is below, and every claim
about current behaviour has been re-verified in this worktree with a `file:line` citation. Where the
plan document is wrong, this brief says so.

---

## Mission

Make one Host coherently serve several repositories, and make it self-describing enough to run
unattended:

- **One** catalog resolution path behind both REST and MCP, with an optional `project_root` filter.
- A path contract that is **stated and enforced**: inline pipeline + inline task is the mount-free
  path; file references are catalog-relative; a host-absolute path from a remote caller is refused
  with an explanation.
- Per-project concurrency caps alongside the global one.
- Credentials that configure themselves from env or files, with no TTY.
- One validated config surface where unknown keys are errors, echoed redacted on health.
- **Three** health surfaces with three different jobs, not one endpoint doing all three badly.
- `sf doctor` as a human preflight — and explicitly not the container healthcheck.
- Stable error codes on MCP and REST, instead of prose a harness has to regex.
- `examples/` shipped into the image as a read-only catalog root, plus a `get_started` MCP tool.
- A trust boundary on where pipelines, tasks, MCP server definitions and skills may come from.
- The A2A configuration error that is currently thrown away.

---

## Why this matters

- **The console and the harness disagree about what exists today.** MCP `list_pipelines` merges
  across every project root the store knows (`src/mcp/catalogTools.ts:27-30`, used at `:91`);
  `GET /api/pipelines` browses only the boot `cwd` (`src/server/http.ts:636-640`). Mount three repos
  into a container and the operator console shows one catalog while the coding agent driving it sees
  three. Any bug report about "the pipeline I can run isn't in the list" starts here.
- **A remote harness cannot guess the container's filesystem.** It sends
  `/Users/you/proj/x.pipeline.yaml` and gets a bare `ENOENT`, which reads as "Stageflow is broken"
  rather than "that is not how paths work here."
- **A healthcheck that reports everything restarts the container for reasons restarting cannot
  fix.** This is the single most consequential decision in the slot; see 8.3.
- **A fresh container has nothing in it.** No catalog, no credential, and no authored YAML. Today
  first-run means: install, log in to a provider, read the docs in a browser, author YAML, run. In a
  container that is worse, not better, because there is no editor and no files. Item 13.3 is the
  cheapest fix in the entire plan — it turns `list_pipelines` on a cold container into 38 working
  pipelines.
- **After slot 2, a caller can make the Host clone an arbitrary remote.** Stage MCP servers and
  skills currently resolve against whatever project root the run carries. If that ever becomes the
  cloned worktree, a pull request can add an MCP server definition and a stage will start it. Item
  12.6 makes the resolution order a stated boundary rather than an accident.

---

## Dependencies

| | |
|---|---|
| **Assumes slot 1** | `STAGEFLOW_HOME` exists and is validated at boot, and the store has a `PRAGMA user_version` plus a `schema_migrations` ledger. The rich `/api/health` payload reports both; **this slot reports them, slot 1 builds them.** If slot 1 has not landed, stub the schema-version field and say so in the PR rather than inventing a mechanism. |
| **Assumes slot 5** | `STAGEFLOW_CONTROL_TOKEN` and the scoped bearer gate exist. The rich `/api/health` goes behind slot 5's `read` scope. Slot 5 deliberately left `/api/health` open and left a comment at `src/server/http.ts:745` saying slot 7 removes the exemption — **you are the slot that removes it**, and doing so means repointing the autostart probe (see 8.3). |
| **Assumes slot 2 exists or is coming** | Slot 2's repository binding is what makes 12.6 urgent: before it, nothing clones a caller-supplied remote, so config-from-the-worktree is a latent risk rather than a live one. Build 12.6 in this slot regardless; it is a resolution-order decision plus an origin field, and retrofitting it after slot 2 ships means a window where the risk is real. |
| **Blocks** | The Dockerfile (its `HEALTHCHECK` points at `/livez`, its `ENV` block is validated by 8.2, and its seeded catalog root comes from 13.3). Slot 9's `preflight` tool reuses 8.4's toolchain checks. |
| **Adjacent, do not absorb** | Slot 3 adds `queued` / `cancelled` statuses and round-robin dequeue across project roots, which eventually subsumes 7.3's static per-project cap — build the cap anyway, it is small and it is what the plan calls for. Slot 6 curates the stage environment; 8.1's `*_FILE` reading is Host-side and does not depend on it. Slot 8 owns backup, restore, provenance, and the egress threat model, including its own proxy-presence health field — coordinate on the health payload shape, do not write slot 8's fields. |

---

## Verified current state

Every line below was read in this worktree.

### Catalog resolution

| Fact | Evidence |
|---|---|
| MCP merges catalogs across every recorded project root plus the boot cwd | `catalogRootsFor`, `src/mcp/catalogTools.ts:27-30` |
| …used by `list_pipelines`, `list_tasks`, and `validate` (full scope) | `src/mcp/catalogTools.ts:91`, `:115`, `:300` |
| Unreadable roots are silently skipped by an empty `catch` | `src/mcp/catalogTools.ts:99-101`, `:123-125`, `:307-309` |
| MCP `list_models` is **single-project** — it browses only `cwd`, unlike its two siblings | `src/mcp/catalogTools.ts:139` |
| REST `GET /api/tasks` browses only the boot cwd | `src/server/http.ts:630-634` |
| REST `GET /api/pipelines` browses only the boot cwd | `src/server/http.ts:636-640` |
| REST `GET /api/models`, `GET /api/skills` likewise single-project | `src/server/http.ts:709`, `:735` |
| `browseCatalog` accepts either a cwd string or an already-resolved context | `src/config/browseCatalog.ts:203-209` |
| **Per-context helpers already exist** and are the seam to build on | `listPipelinesForContext` / `listTasksForContext` / `listModelsForContext`, `src/config/browseCatalog.ts:243-263` |
| A catalog is only non-empty when the context **is a git project** | `catalogReadyFromStageflow`, `src/config/browseCatalog.ts:88-92` |
| A non-git directory resolves to `isGitProject: false`, `manifestStatus: "not_git"`, and `projectRoot = os.homedir()` | `src/project/resolveStageflowContext.ts:38-48` |
| The manifest lives at `<projectRoot>/stageflow.yaml` | `manifestPathForProject`, `src/config/loadStageflowManifest.ts:16-18` |
| **Manifest catalog entries must be repo-relative; absolute paths are already rejected** | `src/config/loadStageflowManifest.ts:49-57` — the precedent 7.2 extends to the wire |
| Manifest parsing ignores unknown top-level keys rather than erroring | `parseStageflowManifestOutcome`, `src/config/loadStageflowManifest.ts:109-213` — no strict-key check anywhere |
| Catalog entries expand to directories walked recursively, filtered by basename pattern, minus `exclude` prefixes | `scanCatalogPaths`, `src/config/scanCatalogPaths.ts:77-102`; `isExcluded`, `:11-23` |
| The Host resolves one context at boot and carries `cwd` + `rootDir` forever | `src/server/bootstrap.ts:52-63`, `:89-96` |
| A parity test between the two surfaces already exists | `tests/surface.catalogParity.test.ts` |

### Concurrency

| Fact | Evidence |
|---|---|
| `CapacityHealth` is the whole health payload today | `src/runtime/runManager.ts:98-106` |
| One global run cap, default 3 | `DEFAULT_MAX_CONCURRENT`, `src/runtime/runManager.ts:160`; resolution order at `:250-253` (constructor option → global settings file → `STAGEFLOW_MAX_CONCURRENT_RUNS`) |
| No per-project cap of any kind | repo-wide search: nothing keys capacity by project root |
| Over capacity, `start_run` hard-fails | `BusyCode`, `src/runtime/runManager.ts:82`; raised at `:1716` and `:1726` |

### Health

| Fact | Evidence |
|---|---|
| `GET /api/health` returns `manager.getHealth()` verbatim — capacity only, **no version** | `src/server/http.ts:745-748`; payload built at `src/runtime/runManager.ts:294-311` |
| MCP `get_health` adds `version`; REST does not | `src/mcp/catalogTools.ts:172-180` |
| No `/livez`, no `/readyz`, nowhere | repo-wide search returns nothing |
| The CLI autostart probe hits `/api/health` unauthenticated and requires `200` **plus parseable JSON** | `probeGlobalServiceDetailed`, `src/server/ensureGlobalService.ts:56-75`, fetch at `:62` |
| No disk usage, no git version, no toolchain manifest, no proxy/CA state, no `STAGEFLOW_HOME`, no build SHA reported anywhere | search |

### Credentials and config

| Fact | Evidence |
|---|---|
| `sf providers login --api-key-env VAR` is the only headless login path | `src/cli/providersCommand.ts:261-275`; `--api-key` is explicitly refused at `:118-122` |
| OAuth requires a terminal: readline on `process.stdin`, output to stderr | `src/cli/providersCommand.ts:276-289`; `createTerminalAuthInteraction`, `src/cli/terminalAuthInteraction.ts:16-33`, `:35-60` |
| **Nothing reads provider credentials at Host boot.** There is no boot-time provider configuration step at all | `src/server/bootstrap.ts` — `providerAuthContext` is passed through, never populated from env |
| **No `*_FILE` env variant exists anywhere in `src/`** | repo-wide search for `_FILE` matches only unrelated identifiers (`STAGE_FILE_WIRING_KEYS`, `MCP_CATALOG_FILENAME`, …) |
| Config is genuinely scattered: env vars, `stageflow.yaml`, `settings.json`, `a2a.yaml`, `.mcp.json`, with no single validated resolution | `src/runtime/settingsFile.ts`, `src/a2a/configDiscovery.ts`, `src/config/resolveStageMcpServers.ts` |
| Existing `STAGEFLOW_*` variables, all read ad hoc at point of use | `STAGEFLOW_A2A_CONFIG`, `_ACTIVITY_TEXT_LIMIT`, `_ACTIVITY_VERBOSE`, `_AUTOSTART_TIMEOUT_MS`, `_CURSOR_EXTENSION`, `_LEGACY_YAML`, `_MAX_ACTIVE_STAGES_PER_RUN`, `_MAX_ACTIVE_STAGE_PROCESSES`, `_MAX_CONCURRENT_RUNS`, `_MCP_SERVER_NAME`, `_MCP_STATELESS`, `_OPERATOR_AGENT_DIR`, `_OPERATOR_CWD`, `_PI_MCP_EXTENSION_NAME`, `_RETRY_ROOT_WAIT_TIMEOUT_MS`, `_RUN_WORKSPACE`, `_SERVICE_PORT`, `_SQLITE_BUSY_TIMEOUT_MS`, `_STAGE_ARTIFACTS_DIR`, `_STAGE_EXECUTION`, `_YAML` |

### `sf doctor`

| Fact | Evidence |
|---|---|
| **`sf doctor` does not exist.** No such command, no such file | `src/cli.ts:37-73` (the `USAGE` block) and `ls src/cli/` |
| The only `doctor` in the repo is the *skill* doctor a skill package ships | `docs/cli-reference.md:397`, `:404`; `src/cli/skillsCommand.ts:28` |
| `sf validate` checks that every stage `mcp:` name exists in `.mcp.json` — and **nothing more**. It never resolves `command` against `PATH` | `findingsForStageMcpCatalog`, `src/config/validateCatalog.ts:414-460`; the only assertion is `assertMcpAllowlistKnown` at `:449` |

### Error taxonomy

| Fact | Evidence |
|---|---|
| Two real codes exist, both about capacity | `BusyCode = "busy_capacity" \| "busy_checkout"`, `src/runtime/runManager.ts:82` |
| One more, on wait | `code: "aborted"`, `src/mcp/waitRun.ts:148`, `:206` |
| **Retry error codes are inferred by regexing English prose** — the anti-pattern this item replaces | `inferRetryStageErrorCode`, `src/server/operatorResults.ts:6-14` |
| `mapStartFailure` forwards `reason` as `error` and attaches no code | `src/server/operatorResults.ts:24-29` |
| Store lookups map to a status and a coarse `kind`, still keyed off message text | `mapStoreLookupError`, `src/server/operatorResults.ts:41-60` |
| MCP tool errors are `{ error, status? }` text results | e.g. `src/mcp/catalogTools.ts:190-196`, `:230-236` |

### Shipping `examples/`

| Fact | Evidence |
|---|---|
| `package.json` `files` is `dist`, `skills`, `README.md`, `LICENSE` — **`examples/` is not shipped** | `package.json:9-14` |
| `verify-pack` requires three paths and forbids `src/`, `ui/src/`, `tests/`, `docs/`, `.cursor/` | `scripts/verify-pack.ts:8`, `:63-96` — **`examples/` is neither required nor forbidden, so adding it passes as-is** |
| 20 example directories on disk, each with its own `README.md` | `ls examples/`; 20 READMEs |
| **18 of those 20 are registered** in the repo-root manifest; `feature-loop` and `ship-feature` are documented in `examples/README.md` but absent from `stageflow.yaml` | `stageflow.yaml:3-40` vs `examples/README.md:35-36` |
| Registered roots resolve to **38 pipelines and 26 tasks** after `exclude` | `stageflow.yaml:44-46` excludes `tests/fixtures` and `examples/route-wiring-smoke-test/rejected` (26 deliberately-invalid pipelines) |
| Whole tree is ~1.0 MB | `du -sh examples` |
| No `.mcp.json` inside `examples/`; the repo has exactly one, at the root | `find . -name .mcp.json` |

> **Correction to the plan document.** `pre-container-work.md:970` and `:976` say "twenty-one
> runnable examples." There are **20 example directories**, of which **18** are registered in the
> manifest, resolving to **38 pipelines** and **26 tasks**. Use those numbers; the "21" appears to
> count `examples/README.md` as an example.

### Config origin (12.6)

| Fact | Evidence |
|---|---|
| Stage MCP servers resolve against a **project root**, not the checkout — today's behaviour is already the safe one | `resolveAttemptMcpServers` passes `projectRoot: factoryCwd`, `src/runtime/stageAttemptBootstrap.ts:119-120` |
| `factoryCwd` is the project root, from three places | `pipelineScheduler.ts:662` (`projectRoot ?? cwd ?? process.cwd()`), `runManager.ts:774` (`detail.project_root ?? this.projectRoot`), `resumeReconstruct.ts:86` (`meta.project_root ?? ctx.factoryCwd ?? cwd`) |
| `.mcp.json` is read from `<projectRoot>/.mcp.json`, and a server `cwd` must be inside that root | `mcpCatalogPath`, `src/config/resolveStageMcpServers.ts:51-53`; `isInsideProjectRoot`, `:259-266`; enforced in `stampSpawnRoot`, `:283-300` |
| `.mcp.json` values are interpolated from the environment | `src/config/resolveStageMcpServers.ts:227` |
| **Skills resolve through Pi's loader with `projectTrusted: true`** | `openSkillCatalogLoader`, `src/config/listSkills.ts:52-64`; called from `resolveSkillByName`, `:66-78` |
| Skill resolution uses the operator catalog's `cwd`, which is the Host boot cwd | `resolveStageSkillForRun`, `src/runtime/stageAttemptBootstrap.ts:86-103`; `operatorCatalog: { cwd, agentDir }`, `src/server/bootstrap.ts:95` |
| Pi's `Skill` already carries provenance we can record | `SkillListing.scope` / `.source`, `src/config/listSkills.ts:9-18`, mapped at `:40-49` |
| Nothing records the origin of a resolved MCP server, skill, or verify command on the run | search |

### A2A configuration errors (10.11)

```251:258:src/a2a/server.ts
    try {
      registry = await loadPublicationRegistry(configPath, env);
      status.configPath = registry.configPath;
      status.state = "enabled";
      invocations = createA2aInvocations(registry, runtime.manager, runtime.runStore, runtime.rootDir, runtime.connection);
    } catch {
      status.state = "configuration_error";
    }
```

The plan's citation of `src/a2a/server.ts:251-259` is accurate. What that bare `catch` discards:

| Lost error | Source |
|---|---|
| `public_url must be an HTTPS origin (HTTP allowed on loopback)` | `src/a2a/registry.ts:58` |
| `Caller <id> requires a token of at least 32 characters in <ENV>` | `src/a2a/registry.ts:154` |
| `Duplicate caller ID` / `publication ID` / `caller credential` | `requireUnique`, `src/a2a/registry.ts:50` |
| `Publication <id> refers to an unknown caller` | `src/a2a/registry.ts:164` |
| Publication shape failures (non-fixed terminal stage, incompatible entry input, non-`free_text` answerable stage, artifact without an emit check, non-object input schema) | `src/a2a/registry.ts:67`, `:72`, `:78`, `:84`, `:91` |
| Any `realpath` failure on the config path, a publication's `project_root`, its `pipeline`, or its `input_schema` | `src/a2a/registry.ts:146`, `:166`, `:168-169` |
| Any zod parse error on the config document | `src/a2a/registry.ts:147` |

Related facts: the status shape is `{ state: "disabled" | "enabled" | "configuration_error";
configPath?: string }` (`src/a2a/server.ts:233-239`); it is served by `GET /api/a2a/status`
(`src/server/createHttpHost.ts:72-75`), which is documented as an operator's only way to tell
whether a config change was picked up (`docs/a2a.md:41`); and config discovery is
`STAGEFLOW_A2A_CONFIG` then `<projectRoot>/a2a.yaml` (`src/a2a/configDiscovery.ts:16-19`), wired at
`src/server/bootstrap.ts:115-118`.

### Case sensitivity (10.11)

| Fact | Evidence |
|---|---|
| Path containment goes through `realpath`, so the runtime is correct | `src/a2a/registry.ts:146`; `src/config/resolveStageMcpServers.ts:259-266`; `toCheckoutLeaseKey`, `src/runtime/runManager.ts:174-183` |
| `sf validate` has no case-mismatch check of any kind | `src/config/validateCatalog.ts` — the only filename-shaped check is `checkStageIdFilename` at `:341-375`, which compares a stage id to its basename |

---

## The work

### 7.1 — One catalog resolution path, with a `project_root` filter

**Today.** Two implementations of "what does this Host have." MCP merges across
`store.listProjectRoots()` plus `deps.cwd` (`src/mcp/catalogTools.ts:27-30`), swallowing failures
per root. REST calls `browseCatalog(cwd)` on the boot directory (`src/server/http.ts:630-640`). MCP
`list_models` matches neither and browses only `cwd` (`src/mcp/catalogTools.ts:139`).

**Target.** One module — call it `src/config/resolveCatalogRoots.ts` plus a
`src/config/multiProjectCatalog.ts` — exposing something like:

```
registeredCatalogRoots(store, opts): Promise<CatalogRoot[]>
browseRegisteredCatalog(store, { project_root?, kind? }): Promise<MultiProjectCatalog>
```

Both `GET /api/pipelines`, `GET /api/tasks`, `GET /api/models`, MCP `list_pipelines`, `list_tasks`,
`list_models`, and MCP `validate` (full scope) call it. Every listing entry carries `project_root`,
as MCP's already does. An optional `project_root` filter narrows to one root — as a query parameter
on REST (`?project_root=…`) and an optional input field on the MCP tools.

**Design decisions already made — do not relitigate:**

- **Build on the per-context helpers that already exist.** `listPipelinesForContext`,
  `listTasksForContext`, and `listModelsForContext` (`src/config/browseCatalog.ts:243-263`) take a
  resolved context and do the work. The new module resolves N contexts and fans out to them. Do not
  write a second manifest walker.
- **Root set = registered roots ∪ boot cwd ∪ seeded roots.** Registered roots come from
  `store.listProjectRoots()` (`src/runstore/port.ts:476`) and from the manifest; the boot cwd is
  always included so a project with zero runs still sees its own catalog (today's MCP comment at
  `src/mcp/catalogTools.ts:23-26` states exactly this intent — keep it); seeded roots are 13.3's
  read-only `examples/`.
- **Each root carries a kind.** `boot` | `registered` | `seeded`, plus a `read_only` flag. 13.3 needs
  it, 12.6 needs it, and the console needs it to explain why a root it cannot write to is listed.
- **Stop swallowing per-root failures silently.** Today three empty `catch` blocks hide an
  unreadable root (`src/mcp/catalogTools.ts:99-101`, `:123-125`, `:307-309`). Keep skipping the root
  — a stale path recorded on an old run must not break the whole listing — but return the failures as
  a `root_errors: [{ project_root, code, message }]` array on the response. An operator whose repo
  vanished should be able to see that, and a container operator whose mount is missing definitely
  should.
- **`project_root` values on the wire are opaque identifiers, not instructions.** An unknown or
  unregistered `project_root` is an error (`unknown_project_root`), never a hint to go browse a new
  directory. That is half of 7.2 and most of 12.6.
- **`validate` full-scope keeps merging** and keeps the summed-counts shape it has today
  (`src/mcp/catalogTools.ts:311-320`), now with `root_errors` and an optional `project_root` filter.
- **Do not make the Host multi-*context* beyond the catalog in this slot.** The run store, the
  global home, and the A2A config stay Host-wide. This item is about listing and validating, not
  about giving each project its own store.

**Files likely to touch:** `src/config/multiProjectCatalog.ts` (new),
`src/config/resolveCatalogRoots.ts` (new), `src/mcp/catalogTools.ts`, `src/server/http.ts`,
`src/config/browseCatalog.ts` (export what the new module needs, nothing more),
`ui/src/api/client.ts` and whichever console page lists pipelines (to show `project_root`).

### 7.2 — The path contract, stated and enforced

**Today.** Every path a caller sends is resolved on the Host's filesystem. MCP `start_run` takes a
`pipeline` string resolved relative to the Host's cwd, and `describe_pipeline` resolves it through
`projectRootForPath` (`src/mcp/catalogTools.ts:32-36`). A harness on another machine sending
`/Users/you/proj/x.pipeline.yaml` gets whatever `ENOENT` text the loader produces.

**Target.** Three rules, written in `docs/mcp.md` and enforced in code:

1. **Inline pipeline + inline task is the mount-free path**, and the recommended one for a remote
   harness. It already works: `start_run` accepts an inline pipeline object
   (`inlinePipelineSchema`, `src/mcp/catalogTools.ts:54-62`) and an inline task
   (`taskFileSchema`, `:38-45`). Document it as the default, not the exotic option.
2. **File references are catalog-relative.** A path is interpreted relative to a `project_root` from
   the registered set — explicitly supplied, or the single boot root when there is only one.
3. **An absolute path from a remote caller is refused with a contract error**, not an `ENOENT`.

**Design decisions already made — do not relitigate:**

- **The manifest already enforces exactly this rule for its own entries.**
  `src/config/loadStageflowManifest.ts:49-57` rejects an absolute `catalog.pipelines` entry with
  "entries must be repo-relative paths". 7.2 is that same rule, applied to the wire. Reuse the
  wording so users see one contract, not two.
- **Refuse, do not silently reinterpret.** Do not strip a leading `/`, do not try the basename, do
  not search the roots for a matching filename. Guessing produces a run against the wrong file,
  which is worse than an error.
- **The error names the contract.** Code `absolute_path_not_allowed`, and a message that says what
  to do instead: send an inline pipeline, or send a catalog-relative path with a `project_root`.
  Include the registered roots in the error payload — that is the one piece of information the
  caller cannot obtain any other way.
- **`..` escaping a root is `path_outside_project_root`**, a separate code. Containment via
  `realpath`, matching the pattern at `src/config/resolveStageMcpServers.ts:259-266`.
- **The local CLI is unaffected.** `sf run --pipeline ./x.pipeline.yaml` and absolute paths from the
  CLI keep working. The restriction is on the *network* surfaces — `/mcp`, `/api/*`, A2A — where the
  caller does not share the filesystem. Do not enforce it inside `loadPipeline`; enforce it at the
  request boundary, once, in the shared resolver from 7.1.
- **Applies to every path-bearing field on every network surface**, not just `start_run.pipeline`:
  `task_path`, `describe_pipeline.pipeline`, `validate.pipeline` / `.task`, and the REST equivalents.
  One helper, called from every entry point.

**Files likely to touch:** `src/config/catalogRelativePath.ts` (new),
`src/mcp/catalogTools.ts`, `src/server/http.ts`, `docs/mcp.md`, `docs/cli-reference.md`.

### 7.3 — Per-project concurrency caps

**Today.** One global cap, default 3, resolved from constructor option → global settings file →
`STAGEFLOW_MAX_CONCURRENT_RUNS` (`src/runtime/runManager.ts:250-253`, default at `:160`). Over
capacity, `start_run` returns `busy_capacity` (`:1716`). One busy repo starves every other repo in
the container.

**Target.** A per-project cap enforced alongside the global one. Both must have room for a run to
start.

**Design decisions already made — do not relitigate:**

- **`STAGEFLOW_MAX_CONCURRENT_RUNS_PER_PROJECT`, a single number applying to every project.** Not a
  per-project map. A map needs a config file keyed by absolute host paths, which is exactly the
  container-hostile shape 8.2 is trying to eliminate. Default: unset, meaning "no per-project cap,"
  so existing behaviour is unchanged.
- **The global cap stays authoritative.** The per-project cap can only reduce what a project may
  take; it can never raise a project above the global cap.
- **Reuse the existing failure, add the detail.** Keep `busy_capacity` as the code — a harness
  already branches on it (`src/cli/runOutput.ts:38`, `src/a2a/service.ts:311`) — and add
  `scope: "global" | "project"` plus the project's own `activeCount` / `maxConcurrent` to the
  payload, alongside the fields `busyFailure` already attaches.
- **Key capacity by the run's `project_root`**, the same value the store already records
  (`src/runstore/sqlite/SqliteRunStore.ts:576`) and `listProjectRoots` already returns. Do not
  invent a second project identity.
- **Report per-project capacity on `/api/health`**, not on `/livez` or `/readyz`.
- **Accept that slot 3 will likely supersede this.** Slot 3's queue dequeues round-robin across
  project roots, which is a better answer than a static cap. Build the cap anyway: it is small, it
  is what the plan schedules here, and round-robin still wants a ceiling.

**Files likely to touch:** `src/runtime/runManager.ts`, `src/runtime/settingsFile.ts` (only if you
surface it there too — env is sufficient), `docs/cli-reference.md`.

### 8.1 — Fully non-interactive credentials

**Today.** `sf providers login <id> --type api_key --api-key-env VAR` works without a TTY
(`src/cli/providersCommand.ts:261-275`). OAuth does not: it builds a readline interface on
`process.stdin` (`src/cli/terminalAuthInteraction.ts:16-33`). And **nothing configures providers at
Host boot** — `bootstrapStageflowHost` accepts a `providerAuthContext` and never populates one from
the environment. So a fresh container starts with no credential and no way to acquire one except
`docker exec`.

**Target.** A container with an API key in its environment self-configures at boot, with no exec
step.

**Design decisions already made — do not relitigate:**

- **Boot-time provider configuration, reusing `loginWithApiKey`.** At Host boot, read the
  environment, and for each provider with a key present call the same
  `loginWithApiKey(cwd, providerId, apiKey, ctx)` (`src/agent/providerAuth.ts:303`) that the CLI
  calls. One code path, so the persisted credential is byte-identical to the one `sf providers
  login` writes.
- **Naming: `STAGEFLOW_PROVIDER_<ID>_API_KEY` and `..._API_KEY_FILE`**, with `<ID>` the provider id
  uppercased and non-alphanumerics replaced by `_`. Do not read raw upstream names like
  `OPENAI_API_KEY` at boot — that turns an ambient variable that happens to be present into a
  credential Stageflow owns and writes to disk. Pi's own detection of ambient keys is a separate,
  existing mechanism (`detectPiHome`, `src/agent/providerAuth.ts:416`); leave it alone.
- **A `*_FILE` variant for every secret-bearing variable, without exception.** Today there are
  none. The list to cover in this slot: `STAGEFLOW_PROVIDER_*_API_KEY_FILE`, and — reading the
  plan's other slots — `STAGEFLOW_CONTROL_TOKEN_FILE` (slot 5 builds it, do not duplicate),
  `GITHUB_TOKEN_FILE` / `GH_TOKEN_FILE` (slot 2), and the A2A caller token envs
  (`src/a2a/registry.ts:154`). Build **one** helper — `readSecretFromEnvOrFile(env, name)` — and use
  it everywhere, because the trailing-newline trim and the both-set error must behave identically in
  every case.
- **Semantics of the helper, fixed here:** `*_FILE` wins is *not* the rule — setting both the plain
  variable and its `_FILE` sibling is a **startup error**. A half-migrated config should be loud.
  Trim exactly one trailing newline; do not trim other whitespace, because some credentials end in
  meaningful characters.
- **Boot-time configuration failures are loud but not fatal by default.** An unreadable
  `*_FILE`, or a key the provider rejects, logs a named error and leaves the provider
  unconfigured; the Host still starts, and `/api/health` reports which providers configured and
  which failed. A Host that refuses to boot because one of four providers has a stale key is worse
  than one that serves the three that work. Offer `STAGEFLOW_REQUIRE_PROVIDERS=<ids>` for operators
  who want the strict behaviour.
- **OAuth stays an explicit `docker exec` flow.** `docker exec -it <container> sf providers login
  <id> --type oauth`. Document it in `docs/providers.md` with the `-it` flag called out, because
  without a TTY `createTerminalAuthInteraction` fails in a way that reads as a Stageflow bug. Do not
  build a headless device-code relay in this slot.
- **Never log a credential value, and never echo one on health.** Health reports
  presence and source (`env` | `file` | `interactive`), never the value or its length.

**Files likely to touch:** `src/config/secretFromEnvOrFile.ts` (new),
`src/agent/bootProviderConfig.ts` (new), `src/server/bootstrap.ts`, `src/cli.ts` (so `sf run`'s
in-process path gets it too), `docs/providers.md`, `docs/cli-reference.md`.

### 8.2 — One validated config surface, unknown keys as errors

**Today.** Twenty-one `STAGEFLOW_*` variables (listed in **Verified current state**), each read at
its point of use, most with a silent fallback on a bad value — `parseMaxConcurrent` returns the
default `3` for any unparseable input (`src/runtime/runManager.ts:166-171`). Plus
`stageflow.yaml`, `$STAGEFLOW_HOME/settings.json`, a per-project `.stageflow/settings.json`,
`a2a.yaml`, and `.mcp.json`. There is no single resolution, and `parseStageflowManifestOutcome`
(`src/config/loadStageflowManifest.ts:109-213`) ignores unknown top-level keys.

**Target.** One `HostConfig`, assembled once at boot from env plus an optional file, validated, and
echoed in redacted form on `/api/health`.

**Design decisions already made — do not relitigate:**

- **Scope is the *host* config, not the catalog.** `stageflow.yaml` is a project artifact authored by
  users and validated by `sf validate`; it is out of scope here and its lenient unknown-key handling
  stays. What 8.2 owns is the `STAGEFLOW_*` surface plus an optional
  `$STAGEFLOW_HOME/config.yaml`.
- **Unknown keys are errors, in the file and in the env namespace.** An unrecognised key in
  `config.yaml` fails boot. An unrecognised `STAGEFLOW_*` environment variable fails boot too — that
  is the one that catches `STAGEFLOW_MAX_CONCURRENT_RUN` (singular) in a compose file, which is
  precisely the class of bug this item exists for. Provide `STAGEFLOW_ALLOW_UNKNOWN_CONFIG=1` as a
  documented escape hatch for anyone whose environment is shared with other tooling, and warn when
  it is used.
- **Precedence: explicit CLI flag > env > file > default.** File *below* env, because compose and
  Kubernetes deliver per-deployment values as env and a baked file must not override them.
- **Invalid values fail at boot, they do not fall back.** Replace the silent-default behaviour at
  `src/runtime/runManager.ts:166-171` with validation in the config loader. "Misconfiguration should
  fail at startup with a message, not at run time with a mystery" is the whole point of the item.
- **Redaction is by declaration, not by pattern-matching the value.** Each field is marked secret or
  not in the schema; secrets render as `"set"` / `"unset"` on health, never as a masked prefix and
  never with a length. A `<redacted>` that leaks eight characters is still a leak.
- **Do not build a config-reload path.** Boot-time only, matching A2A's existing deliberate
  no-reload decision. Restart is the supported way to change configuration, and slot 4 makes
  restarting routine.
- **Do not migrate every existing variable's read site in this slot.** Introduce `HostConfig`, move
  the variables this slot and slots 1 and 5 actually need, and register the remainder as known keys
  so the unknown-key check does not reject a valid existing configuration. A twenty-one-site
  refactor buried inside this change set makes it unreviewable.

**Files likely to touch:** `src/config/hostConfig.ts` (new), `src/server/bootstrap.ts`,
`src/cli.ts`, `src/runtime/runManager.ts`, `docs/cli-reference.md`.

### 8.3 — Three health surfaces

**Today.** One route: `GET /api/health` returns `manager.getHealth()` verbatim
(`src/server/http.ts:745-748`) — `{ ok, activeRunIds, activeCount, maxConcurrent, slotsAvailable,
activeStageProcesses, maxActiveStageProcesses }` (`src/runtime/runManager.ts:98-106`,
`:294-311`). No version, no paths, no disk, no toolchain. MCP `get_health` adds `version`
(`src/mcp/catalogTools.ts:179`) and REST does not, which is itself a parity bug.

**Target.**

| Surface | Contents | Auth | Cost per call | Used by |
|---|---|---|---|---|
| `GET /livez` | in-process only: the process is up and the event loop is turning. **No disk stat, no DB query, no `git` spawn.** Sub-100 ms, and in practice sub-millisecond | open | none | the container `HEALTHCHECK`, **and only this** |
| `GET /readyz` | store openable, `$STAGEFLOW_HOME` writable, migrations complete, `git` present. Result cached a few seconds | open | one cached probe | orchestrators, startup gating, compose `depends_on: condition: service_healthy` |
| `GET /api/health` | everything: version, build SHA, `STAGEFLOW_HOME`, store schema version, `git --version`, toolchain manifest, proxy and CA state, disk usage by category, global and per-project capacity, registered catalog roots, provider configuration state, **and the A2A configuration error when there is one** | slot 5's control token, `read` scope | expensive — stats disk, spawns `git` | bug reports, the console, operators |

**Why the split, stated so nobody merges them back:** a healthcheck that fails when disk is filling
or a credential expired turns a degraded-but-serving Host into a restart loop — **and restarting
frees no disk.** The Host that was answering requests and could have been drained gracefully instead
gets SIGKILLed mid-run every thirty seconds, which destroys the in-flight work slot 4 went to
trouble to make survivable. Liveness must answer exactly one question: *is this process wedged?*
Everything an operator wants to *know* goes on the surface an operator *reads*.

**Design decisions already made — do not relitigate:**

- **`/livez` must not touch the disk or the store.** Not a `stat`, not a `PRAGMA`, not a `spawn`. If
  you find yourself adding anything with an `await` on I/O, it belongs on `/readyz`.
- **`/livez` and `/readyz` are unauthenticated.** A container runtime cannot hold a bearer token,
  and neither surface discloses anything: `/livez` returns a fixed shape, `/readyz` returns booleans
  and a failure code, never a path or a version.
- **`/livez` returns `200` with a JSON body.** This is load-bearing: `probeGlobalServiceDetailed`
  (`src/server/ensureGlobalService.ts:56-75`) requires status `200` **and** a body that
  `JSON.parse` accepts. **Repoint that probe from `/api/health` to `/livez`** in the same commit
  that gates `/api/health` — slot 5 explicitly deferred this and left a comment at
  `src/server/http.ts:745` saying so. If you gate `/api/health` without moving the probe, `sf run`
  breaks on every machine that has a token configured.
- **`/readyz` is cached, `/livez` is not.** A 3–5 second cache on `/readyz`, because an orchestrator
  may poll it every second and `git --version` is a process spawn. `/livez` needs no cache because
  it does no work.
- **`/readyz` returns `503` when not ready**, with a machine-readable `checks` object and a `code`
  naming the first failing check. `200` with `{"ready": false}` is a trap for every orchestrator
  that only looks at the status line.
- **Disk usage on `/api/health` is by category**, matching the layout slot 1 documents:
  `state.db`, `runs/`, `repos/`, `worktrees/`, `a2a-artifacts/`, `cache/`, plus filesystem free
  space. Slot 3's GC consumes the same numbers.
- **Move `version` into the shared payload** so REST and MCP `get_health` stop disagreeing.
  `PACKAGE_VERSION` already exists (`src/package-meta.ts`).
- **`/api/health` is a superset of what exists today**, with the current `CapacityHealth` fields
  under a `capacity` key. Keep the old top-level keys as well for one release; the console reads
  `maxConcurrent` off it (`src/server/http.ts:751-757`, `ui/src/api/client.ts:151`).
- **Document that a failing Docker healthcheck restarts nothing by itself** — `restart:
  unless-stopped` plus the runtime's unhealthy handling is what restarts, and `HEALTHCHECK
  --start-period` is the right way to cover boot rather than weakening the interval.
- **No Prometheus endpoint in this slot.** The plan permits at most one opt-in metrics endpoint;
  it is not scheduled here.

**Files likely to touch:** `src/server/healthSurfaces.ts` (new), `src/server/createHttpHost.ts`
(`/livez` and `/readyz` must be dispatched before the auth gate), `src/server/http.ts`,
`src/server/ensureGlobalService.ts`, `src/runtime/runManager.ts`, `src/mcp/catalogTools.ts`,
`docs/ci.md`, `docs/mcp.md`.

### 8.4 — `sf doctor`: a human preflight

**Today.** `sf doctor` does not exist — it is absent from `USAGE` (`src/cli.ts:37-73`) and from
`src/cli/`. The only doctor in the repo is the one a *skill* package ships, which
`sf skills install` invokes after copying (`docs/cli-reference.md:404`).

**Target.** `sf doctor [--json]`, exiting non-zero when any check fails. Checks:

| Check | What "pass" means | Notes |
|---|---|---|
| `git` present, version | on `PATH`, version printed | slot 2 makes this a hard requirement |
| `bash` present | on `PATH` | plan item 10.3 makes `verify` commands run under `bash -c`; without it every bashism in a `verify` fails with a terse exit 2 |
| Node version | ≥ the real floor | note: `package.json:52-54` says `>=20`, but Pi and `better-sqlite3` need `>=22`. Report the discrepancy; **changing `engines` is not this slot's job** |
| `$STAGEFLOW_HOME` writable, and the uid that owns it | writable by the running uid | print the running uid and the exact `chown` when it fails — the `--user 1000:1000` failure mode |
| Store schema state | on-disk version vs what this binary knows | slot 1 builds the mechanism |
| Credential availability | which providers are configured, and from where | presence only, never values |
| Outbound TLS reachability | a TLS handshake to each configured provider's host succeeds | catches a missing CA bundle behind an intercepting proxy — the `UNABLE_TO_VERIFY_LEAF_SIGNATURE` class |
| Free disk | above a configurable floor | |
| Every `command` in catalog `.mcp.json` resolves against `PATH` | each `command` is found | **`sf validate` checks only that allowlisted names exist in the catalog** (`src/config/validateCatalog.ts:450`); nothing resolves the binary. A stage whose server is `npx -y @modelcontextprotocol/server-…` fails as a bare "failed to connect" in an image without `npx` |

**`sf doctor` is not the container `HEALTHCHECK`. Do not wire it to one.** It spawns a fresh Node
process on every interval, inside the same memory cgroup as the Host. Under a `--memory` limit that
is a way to OOM-kill the thing you are monitoring — and the OOM killer may take the Host rather than
the probe. It is a first-run diagnostic and a bug-report attachment, which is where it is genuinely
good. The `HEALTHCHECK` points at `/livez`, full stop.

**Design decisions already made — do not relitigate:**

- **`--json` from day one.** This output gets pasted into issues; a stable shape is worth more than
  pretty prose. Follow the existing `--json` conventions (`docs/ci.md`,
  `src/cli/validateOutput.ts`).
- **Two severities: `error` (non-zero exit) and `warn` (exit 0, printed).** A missing `git` is an
  error; a `TLS` check that could not run because no provider is configured is a warning.
- **Skip, do not fail, on checks that cannot apply.** No configured provider means no TLS check to
  run, and reporting `skipped` is honest.
- **Share the check implementations with `/readyz` and `/api/health`.** `git --version`, home
  writability, and schema state are wanted by all three; write them once in
  `src/diagnostics/` and have all three consume them. This is also what keeps `sf doctor` and the
  health surfaces from drifting into three different opinions of "ready."
- **No `--pipeline` scoping and no `preflight` MCP tool in this slot.** Those are slot 9's
  `requires:` work; 8.4 builds the check library they will reuse.
- **`integrity_check` on the store belongs in `sf doctor`, not on a health surface** — it holds a
  read lock for the whole scan and will stall writers. That decision is slot 8's to implement; do
  not put a full integrity check on `/readyz`.

**Files likely to touch:** `src/cli/doctorCommand.ts` (new), `src/diagnostics/` (new),
`src/cli.ts` (`USAGE` and dispatch), `docs/cli-reference.md`.

### 8.5 — A stable error-code taxonomy

**Today.** Three real codes — `busy_capacity`, `busy_checkout`
(`src/runtime/runManager.ts:82`), and `aborted` (`src/mcp/waitRun.ts:148`). Everything else is
prose. Worse, `inferRetryStageErrorCode` (`src/server/operatorResults.ts:6-14`) **regexes English
error messages** to synthesise a code — `/retry already in progress/i`,
`/waiting for input/i`, `/run is not failed/i`. Rewording an error message silently changes the API.
`mapStoreLookupError` does the same for not-found detection (`:41-60`).

**Target.** One `ErrorCode` union, a small number of families, on every MCP and REST error response.

**Design decisions already made — do not relitigate:**

- **`{ code, error, ...detail }`.** Keep `error` as the human-readable message so nothing that reads
  it today breaks; `code` is the new machine-readable field. Do not rename `error` to `message`.
- **Codes are `snake_case`, flat, and stable.** No hierarchical dotted namespaces, no numbers. The
  existing `busy_capacity` sets the convention; follow it.
- **Codes are produced at the site that knows the reason, never inferred from a message.** Delete
  `inferRetryStageErrorCode`'s regexes by having the retry path return a code in the result object.
  This is the whole point of the item, and leaving the regexes in place while adding codes elsewhere
  gets you a taxonomy that is half-real.
- **Keep the three existing codes exactly as they are.** `busy_capacity` and `busy_checkout` are
  branched on in shipped code (`src/cli/runOutput.ts:38`, `src/a2a/service.ts:311`) and documented
  in the `start_run` tool description (`src/mcp/catalogTools.ts:186`).
- **The code set is a documented contract in `docs/mcp.md`**, in the same spirit as the exit-code
  and JSON contracts `docs/ci.md` already publishes. Adding a code is a minor change; changing the
  meaning of one is breaking.
- **Codes this slot must introduce**, at minimum: `unknown_project_root`,
  `absolute_path_not_allowed`, `path_outside_project_root`, `catalog_root_unreadable`,
  `config_invalid`, `config_unknown_key`, `provider_not_configured`, `a2a_configuration_error`,
  `untrusted_config_origin`, `command_not_on_path`, `not_ready`. Other slots add their own —
  slot 2's git taxonomy (`repository_auth_failed`, `ref_not_found`, …) plugs into the same union.
- **Do not attempt to code every error in the codebase.** Cover the network surfaces' error paths
  and the ones other slots' harnesses need to branch on. An uncoded internal error returns a generic
  `internal_error`, which is honest.

**Files likely to touch:** `src/errors/codes.ts` (new), `src/server/operatorResults.ts`,
`src/runtime/runManager.ts`, `src/mcp/*.ts`, `src/server/http.ts`, `docs/mcp.md`, `docs/ci.md`.

### 13.3 — Ship `examples/`, and add `get_started`

**This is the best impact-to-cost item in the whole plan, and it is worth saying so plainly.** It is
one `package.json` line, one registered read-only catalog root, and one MCP tool that composes
information four other items in this slot already compute. In exchange, a cold container stops being
an empty box.

**Today.** `package.json:9-14` ships `dist`, `skills`, `README.md`, `LICENSE`. `examples/` is not in
that list, so it is absent from the published tarball and would be absent from any image built from
it. There are 20 example directories on disk (each with a `README.md`), 18 of them registered in the
repo-root `stageflow.yaml`, resolving to 38 pipelines and 26 tasks, totalling about 1.0 MB.

**Before and after, concretely.**

*Today, a user who has just started the container and pointed their coding agent at it:*

```
get_health        → { ok: true, activeRunIds: [], activeCount: 0, maxConcurrent: 3,
                      slotsAvailable: 3, version: "0.24.0" }
list_pipelines    → { pipelines: [] }
list_tasks        → { tasks: [] }
```

Three calls, nothing learned, nothing runnable. The agent's only remaining move is to author a
pipeline and a task from scratch against documentation it has to find on the web, and then discover
it cannot reference them by path because there is no mount. The next thing that happens is a support
question.

*After this item:*

```
get_started       → { host: { version, build_sha, stageflow_home, schema_version },
                      providers: [{ id, configured: true, source: "env" }, …],
                      toolchain: { git: "2.43.0", bash: "5.2.21", node: "22.19.0" },
                      catalog_roots: [{ project_root: "/opt/stageflow/examples",
                                        kind: "seeded", read_only: true,
                                        pipelines: 38, tasks: 26 }],
                      next_steps: [
                        "describe_pipeline { pipeline: 'hello-world/hello.pipeline.yaml',
                                             project_root: '/opt/stageflow/examples' }",
                        "start_run { pipeline: 'hello-world/hello.pipeline.yaml',
                                     task_path: 'hello-world/my-task.task.yaml',
                                     project_root: '/opt/stageflow/examples' }",
                        "wait_run { runId }"
                      ] }
```

One call, then the three it names, and the user has watched a real pipeline run end to end without
authoring a byte or mounting a volume.

**Design decisions already made — do not relitigate:**

- **Add `examples` to `package.json` `files`.** `verify-pack` requires three paths and forbids
  `src/`, `ui/src/`, `tests/`, `docs/`, `.cursor/` (`scripts/verify-pack.ts:8`, `:63-96`);
  `examples/` is in neither list, so this passes with no script change. Add `examples/README.md` to
  `REQUIRED` so the directory cannot silently fall out of the tarball later.
- **Registered as a seeded, read-only catalog root**, through 7.1's root set with
  `kind: "seeded"` and `read_only: true`. `POST /api/pipelines` and any other write path must refuse
  it with a named code. In the image it lives outside the data volume — somewhere like
  `/opt/stageflow/examples` — so an image upgrade updates it and nothing in it competes with user
  data for volume space.
- **You will hit the git-project requirement, and the fix is explicit.** `browseCatalog` returns an
  empty catalog unless `ctx.isGitProject` (`src/config/browseCatalog.ts:88-92`), and
  `resolveStageflowContext` reports `not_git` with `projectRoot = os.homedir()` for a
  non-repository directory (`src/project/resolveStageflowContext.ts:38-48`). A seeded
  `/opt/stageflow/examples` is not a git repository. **Do not `git init` it at image build time** —
  that is a workaround that leaves a writable `.git` inside the image and makes GC and the slot 2
  worktree logic reason about a repository that means nothing. Instead, let a seeded root carry an
  explicit `projectRoot` and skip the git inference: the git check exists to find the manifest, and
  a seeded root states its root directly. This is the one real code change in the item; budget for
  it.
- **Ship a `stageflow.yaml` alongside the seeded copy**, listing the example directories with paths
  relative to that root. Do **not** reuse the repo-root manifest — its entries are
  `examples/hello-world`, relative to the repo root, and the seeded root is the `examples` directory
  itself. Generate it at build time from the repo-root manifest so the two cannot drift, and while
  you are there decide whether `feature-loop` and `ship-feature` — documented in
  `examples/README.md:35-36` but missing from `stageflow.yaml:3-40` — should be registered. They
  probably should; that is a one-line manifest fix worth making.
- **Exclude `examples/route-wiring-smoke-test/rejected`**, as the repo manifest already does
  (`stageflow.yaml:44-46`). Those 26 pipelines are deliberately invalid and would make
  `sf validate` on a fresh container report 26 errors, which is the opposite of a good first
  impression.
- **`get_started` composes, it does not compute.** Everything in its payload comes from work this
  slot already does: 8.2's resolved config, 8.1's provider state, 8.4's toolchain checks, 7.1's root
  set, 8.3's health. It is roughly one file in `src/mcp/`.
- **`get_started` is read-only and requires no arguments.** It is the first call a fresh agent makes
  and it must never fail because an argument was wrong.
- **Register it in `registerMcpTools`** (`src/mcp/tools.ts:13-19`) and document it in `docs/mcp.md`
  under `## Tools`. Consider naming it first in the docs — it is the entry point.
- **No REST equivalent required.** The console already shows all of this across its pages; the tool
  exists because a coding agent has no console.

**Files likely to touch:** `package.json`, `scripts/verify-pack.ts`, `src/mcp/getStartedTool.ts`
(new), `src/mcp/tools.ts`, `src/config/resolveCatalogRoots.ts`, `src/config/browseCatalog.ts`,
`scripts/` (a small generator for the seeded manifest), `docs/mcp.md`, `examples/README.md`,
`stageflow.yaml`.

### 12.6 — Config origin is a trust boundary

**Today, the good news:** stage MCP servers already resolve against a **project root**, not the
checkout. `resolveAttemptMcpServers` passes `projectRoot: factoryCwd`
(`src/runtime/stageAttemptBootstrap.ts:119-120`), `factoryCwd` is the project root from all three
call paths (`src/runtime/pipelineScheduler.ts:662`, `src/runtime/runManager.ts:774`,
`src/runtime/resumeReconstruct.ts:86`), `.mcp.json` is read from `<projectRoot>/.mcp.json`
(`src/config/resolveStageMcpServers.ts:51-53`), and a server `cwd` must be inside that root
(`isInsideProjectRoot`, `:259-266`, enforced at `:283-300`).

**Today, the bad news:** none of that is *stated*, nothing records it, and skills are looser. Skill
resolution goes through Pi's loader constructed with **`projectTrusted: true`**
(`src/config/listSkills.ts:52-64`) against `catalog.cwd`, which is the Host boot cwd
(`src/server/bootstrap.ts:95`). And after slot 2, `project_root` on a run is a value the Host
computed from a caller's instruction. The moment anything points a resolution root at the cloned
worktree, a pull request can add an MCP server definition and a stage will start it — the documented
failure mode across disclosed agent-sandbox escapes.

**Target.** A stated boundary plus recorded provenance.

**Design decisions already made — do not relitigate:**

- **Pipelines, tasks, stage `mcp` definitions, `.mcp.json`, and skills come from the catalog or the
  inline request. Never from the cloned worktree.** Write this down in `docs/yaml-catalog.md` and
  `docs/mcp.md` as a security property, not an implementation note.
- **The opt-in is per project, on the host side, and it is not a YAML key.** A project in a cloned
  worktree must not be able to declare itself trusted — that is the vulnerability, not the fix. Make
  it host configuration through 8.2 (`trust_workspace_config: [<project_root>, …]`), so the person
  who granted the trust is the person who runs the Host.
- **Record origin on the run for every resolved MCP server, skill, and `verify` command.**
  `{ name, origin: "catalog" | "inline" | "workspace" | "seeded", path }`. Pi already gives us most
  of it for skills — `SkillListing` carries `scope` and `source`
  (`src/config/listSkills.ts:9-18`, mapped at `:40-49`). Reuse slot 9's run-scoped-skills origin
  mechanism if it has landed; otherwise write the field and let slot 9 adopt it.
- **`projectTrusted: true` gets a comment and a decision, at minimum.** Auditing what Pi's
  `projectTrusted` actually enables is in scope; changing it is only in scope if the audit shows it
  reads configuration from the checkout. Report what you find in the PR either way — this is the one
  place in the slot where the honest answer may be "it is fine, and here is why."
- **A `verify` command's origin matters as much as an MCP server's.** Those run through
  `spawn(command, { shell: true })` (`src/runtime/completionCheckRunner.ts:195-199`) with no agent
  involvement at all. Record where the pipeline that declared them came from.
- **Refuse, with `untrusted_config_origin`, rather than warn.** A warning in a log nobody reads is
  not a boundary.

**Files likely to touch:** `src/config/configOrigin.ts` (new),
`src/runtime/stageAttemptBootstrap.ts`, `src/config/resolveStageMcpServers.ts`,
`src/config/listSkills.ts`, `src/runstore/port.ts` (the origin field on the run record),
`docs/yaml-catalog.md`, `docs/mcp.md`.

### 10.11 rider — A2A configuration errors are swallowed

**Today.** The bare `catch` at `src/a2a/server.ts:251-258` sets
`status.state = "configuration_error"` and discards the error entirely. The **Verified current
state** section above enumerates the twelve-odd distinct failures that vanish — including the two
most container-relevant ones: a caller token under 32 characters
(`src/a2a/registry.ts:154`) and a non-HTTPS `public_url` (`:58`). An operator's only signal is
`GET /api/a2a/status` (`src/server/createHttpHost.ts:72-75`), which `docs/a2a.md:41` presents as the
way to tell whether a config change was picked up, and which currently says only
`{"state":"configuration_error"}`.

**Target.** Keep the message, log it once at boot, expose it on `/api/a2a/status` and on the rich
`/api/health`.

**Design decisions already made — do not relitigate:**

- **Extend the status type**, don't replace it:
  `{ state, configPath?, error?: { code, message } }` (`src/a2a/server.ts:233-239`). The three
  existing `state` values stay.
- **The error message is safe to expose, with one caveat.** These messages name a config path, a
  publication id, and an env var *name* — all fine. `loadPublicationRegistry` never puts a token
  value into a message (`src/a2a/registry.ts:154` names the variable, not its contents); keep it
  that way, and redact defensively at the boundary.
- **Log at boot with the message.** A2A config failure is silent today; `docker logs` is the only
  observability a container operator has by default.
- **Still fail closed.** A configuration error keeps A2A disabled and keeps returning `503`
  (`src/a2a/server.ts:285`). This item makes the failure *legible*, not tolerated.
- **Do not add config reload.** The plan explicitly rejects A2A hot reload.
- **Code it as `a2a_configuration_error`** in 8.5's taxonomy.

**Files likely to touch:** `src/a2a/server.ts`, `src/server/createHttpHost.ts`,
`src/server/healthSurfaces.ts`, `docs/a2a.md`.

### 10.11 rider — A case-mismatch check in `sf validate`

**Today.** The runtime is correct: containment goes through `realpath`
(`src/config/resolveStageMcpServers.ts:259-266`, `src/runtime/runManager.ts:174-183`). But a
`skill:` name, a `uses:` path, or an artifact path with the wrong case resolves happily on
case-insensitive APFS and `ENOENT`s on Linux. `sf validate` has no check for this; its only
filename-shaped check compares a stage id to its basename
(`checkStageIdFilename`, `src/config/validateCatalog.ts:341-375`).

**Target.** A validation finding when a referenced path exists but its on-disk casing differs from
what the YAML wrote.

**Design decisions already made — do not relitigate:**

- **Compare against a directory listing, not against `realpath`.** On a case-insensitive filesystem
  `realpath` may echo back the requested casing. `readdir` the parent and look for an entry that
  matches case-insensitively but not exactly — that is the actual detection.
- **Severity `error` under `--strict`, `warning` otherwise.** It is a portability defect, not a
  local failure; failing a laptop `sf validate` on it would be surprising.
- **Cover `uses:` stage paths, `skill:` names, and `.mcp.json` `command` / `args` paths.** Follow
  the existing `findingStageError` / `findingCatalog` builders
  (`src/config/validateCatalog.ts:215`, `:253`) — do not invent a finding shape.
- **On a case-*sensitive* filesystem the check is a no-op**, because an exact mismatch already fails
  to resolve. Detect the filesystem's behaviour once, or simply let the "exists but different
  casing" condition be naturally unsatisfiable. Do not skip the check based on `process.platform`.

**Files likely to touch:** `src/config/validateCatalog.ts`, `docs/cli-reference.md`.

---

## A correction to earlier guidance

An earlier draft of this plan proposed a **single** rich `/api/health` and named **`sf doctor` as
the container healthcheck**. Both halves of that are wrong, and the second is the canonical
anti-pattern in this area. It is written down here so nobody reintroduces it from an older document
or from habit:

1. **`sf doctor` must never be a `HEALTHCHECK`.** Docker runs the healthcheck command on every
   interval, inside the container, inside the same memory cgroup as the Host. `sf doctor` is a fresh
   Node process — tens of megabytes of heap plus a `git` spawn plus a TLS handshake, every interval,
   forever. Under `--memory`, the kernel's OOM killer has no notion that one of those processes is
   the service and the other is the probe; it may take the Host. You would be monitoring a thing by
   periodically trying to kill it.
2. **A single rich health endpoint makes liveness depend on things liveness cannot fix.** If the
   healthcheck reports disk usage, then a filling volume marks the container unhealthy, and
   `restart: unless-stopped` restarts it — which frees no disk, destroys every in-flight run, and
   does it again on the next interval. The same argument applies to an expired credential, an
   unreachable provider, and a stale A2A config. Every one of those is a thing an operator must
   *know*; none of them is a reason to kill the process.

The `HEALTHCHECK` points at `/livez`, which does no I/O. `sf doctor` is a human preflight and a
bug-report attachment. These are not preferences.

---

## Out of scope

- **Named per-caller tokens, `caller_id` on runs, and per-caller quotas.** Slot 9. The per-project
  cap in 7.3 is per *project*, not per caller — do not conflate them, and do not build a token
  registry here.
- **Backup, restore, release provenance, and the egress threat model.** Slot 8. It owns its own
  health field for proxy presence; coordinate on the payload shape but do not write its fields.
- **OpenTelemetry tracing and a collector dependency — explicitly rejected** in the plan
  (`pre-container-work.md:1032`). Do not add a tracing SDK, a collector, or an exporter. At most,
  the plan permits one opt-in Prometheus text endpoint behind the control token, and that is not
  scheduled in this slot either.
- **The Dockerfile, the compose file, and container CI.** After all nine slots. This slot makes the
  `HEALTHCHECK` target and the `ENV` surface exist; it does not write them.
- **`STAGEFLOW_HOME` itself, and the store schema version mechanism.** Slot 1. This slot *reports*
  both.
- **The bind, the allowed-hosts resolver, and the control token.** Slot 5. This slot puts
  `/api/health` behind the token slot 5 built and repoints the autostart probe; it does not change
  the auth mechanism.
- **A queue, `queued`/`cancelled` statuses, and round-robin dequeue.** Slot 3.
- **Curating the stage worker environment.** Slot 6.
- **`requires:` declarations, a toolchain manifest written at image build time, and an MCP
  `preflight` tool.** Slot 9. 8.4 builds the check library those reuse, and `/api/health` reports a
  toolchain manifest if one exists — it does not define the `requires:` schema.
- **Multi-project run stores.** One store, one global home, Host-wide. Only catalog *listing* and
  *validation* become multi-project here.
- **Config hot reload.** Boot-time only, consistent with A2A's existing decision.
- **A headless OAuth device-code relay.** `docker exec -it` is the documented path.

---

## Acceptance criteria

**Catalog (7.1)**

1. With two registered project roots, `GET /api/pipelines` and MCP `list_pipelines` return the same
   set, every entry tagged with `project_root`.
2. The same holds for `/api/tasks` / `list_tasks` and `/api/models` / `list_models` — including
   `list_models`, which is single-project today.
3. `GET /api/pipelines?project_root=<root>` and `list_pipelines { project_root }` narrow to that
   root; an unregistered value returns `unknown_project_root`.
4. A registered root that no longer exists on disk is skipped, the rest of the listing succeeds, and
   the response carries a `root_errors` entry naming it with `catalog_root_unreadable`.
5. A project with no runs yet still sees its own catalog through the boot root.
6. `tests/surface.catalogParity.test.ts` passes with a second project root added to the fixture.

**Path contract (7.2)**

7. MCP `start_run { pipeline: "/Users/someone/x.pipeline.yaml" }` returns
   `absolute_path_not_allowed`, and the message names the inline-pipeline path and the
   catalog-relative rule.
8. The error payload lists the registered `project_root` values.
9. `start_run { pipeline: "hello-world/hello.pipeline.yaml", project_root: <seeded> }` succeeds.
10. `pipeline: "../../etc/x.pipeline.yaml"` returns `path_outside_project_root`.
11. The same enforcement applies to `task_path`, `describe_pipeline`, `validate`, and the REST
    equivalents.
12. `sf run --pipeline /abs/path.pipeline.yaml` from the CLI still works.

**Per-project cap (7.3)**

13. With `STAGEFLOW_MAX_CONCURRENT_RUNS=6` and
    `STAGEFLOW_MAX_CONCURRENT_RUNS_PER_PROJECT=1`, a second run on the same project root fails with
    `busy_capacity` and `scope: "project"`, while a run on a different root starts.
14. With the per-project variable unset, behaviour is byte-identical to today.
15. The per-project cap can never raise a project above the global cap.
16. `/api/health` reports both global and per-project capacity.

**Credentials (8.1)**

17. `STAGEFLOW_PROVIDER_<ID>_API_KEY` set in the environment at boot leaves the provider configured
    with no `sf providers login` call, and `sf providers status` agrees.
18. `..._API_KEY_FILE` pointing at a file containing the key plus a trailing newline does the same.
19. Setting both the plain variable and its `_FILE` sibling is a startup error.
20. An unreadable `_FILE` logs a named error, leaves that provider unconfigured, and the Host still
    starts; `/api/health` reports the failure.
21. `STAGEFLOW_REQUIRE_PROVIDERS` naming an unconfigured provider makes boot fail.
22. No credential value appears in any log line, error message, or health payload.

**Config (8.2)**

23. An unknown key in `$STAGEFLOW_HOME/config.yaml` fails boot with `config_unknown_key`, naming the
    key.
24. An unknown `STAGEFLOW_*` environment variable fails boot the same way;
    `STAGEFLOW_ALLOW_UNKNOWN_CONFIG=1` downgrades it to a warning.
25. `STAGEFLOW_MAX_CONCURRENT_RUNS=banana` fails boot with `config_invalid` instead of silently
    becoming `3`.
26. Precedence is flag > env > file > default, proven by a test that sets all four.
27. `/api/health` echoes the resolved config with every declared-secret field rendered as
    `"set"` / `"unset"`.

**Health (8.3)**

28. `GET /livez` returns `200` with a JSON body, performs no filesystem or database access, and
    responds in under 100 ms with the store deliberately made unopenable.
29. `GET /readyz` returns `200` when the store is openable, `$STAGEFLOW_HOME` is writable,
    migrations are complete, and `git` is present.
30. `GET /readyz` returns `503` with a `checks` object and a `code` when any of those fails.
31. `/readyz` results are cached for a few seconds — two calls in quick succession spawn `git` once.
32. `GET /api/health` requires slot 5's `read` scope: `401` with no bearer, `200` with one.
33. `/api/health` includes version, build SHA, `STAGEFLOW_HOME`, store schema version, git version,
    disk usage by category, capacity (global and per-project), registered catalog roots, provider
    state, and the A2A configuration error when there is one.
34. `/api/health` still carries the fields the console reads today.
35. REST and MCP `get_health` agree on `version`.
36. `sf run` still autostarts a Host with a control token configured — `probeGlobalServiceDetailed`
    now probes `/livez`.

**`sf doctor` (8.4)**

37. `sf doctor` exits `0` on a healthy developer machine and prints every check with its result.
38. `sf doctor --json` emits a stable shape with per-check `status` of `pass` | `warn` | `fail` |
    `skipped`.
39. With `git` removed from `PATH`, `sf doctor` exits non-zero and names `git`.
40. With a catalog `.mcp.json` whose server `command` is not on `PATH`, `sf doctor` exits non-zero
    with `command_not_on_path` naming the command and the server.
41. With `$STAGEFLOW_HOME` read-only, the failure message contains the running uid and a `chown`
    command.
42. `sf doctor` appears in `USAGE` and in `docs/cli-reference.md`, and the docs state that it must
    not be used as a container healthcheck, with the reason.

**Error codes (8.5)**

43. Every error response from `/mcp` and `/api/*` carries a `code` from the documented union, and
    keeps its existing `error` message.
44. `inferRetryStageErrorCode`'s message regexes are gone; retry codes come from the retry path.
45. `busy_capacity`, `busy_checkout`, and `aborted` are unchanged.
46. The code union is documented in `docs/mcp.md`.

**Seeded catalog and `get_started` (13.3)**

47. `npm pack --dry-run` includes `examples/`, and `npm run verify:pack` passes.
48. A Host booted with the seeded root registered and **no** git repository anywhere lists 38
    pipelines and 26 tasks from it. (This is the `isGitProject` case — it must pass without
    `git init` having been run on the seeded directory.)
49. `sf validate` against a fresh container reports zero errors — the `rejected` fixtures are
    excluded.
50. Any write to the seeded root (`POST /api/pipelines` targeting it) is refused with a named code.
51. `get_started` takes no arguments and returns host info, provider state, toolchain, catalog
    roots with counts, and a three-call next-steps list.
52. Running exactly the three calls `get_started` names, against a cold container with only a
    provider API key in its environment, completes a run successfully.

**Config origin (12.6)**

53. A `.mcp.json` present in a run's checkout but not in its catalog project root is not used, and
    the attempt fails with `untrusted_config_origin` rather than starting the server.
54. The run record carries the origin of every resolved MCP server, skill, and verify command.
55. A project listed in `trust_workspace_config` may resolve workspace config, and the recorded
    origin says `workspace`.
56. No YAML key anywhere can grant workspace-config trust.

**A2A config errors (10.11)**

57. A caller token of 20 characters makes `GET /api/a2a/status` return
    `{ state: "configuration_error", error: { code: "a2a_configuration_error", message: <the
    registry's message> } }`.
58. The same message appears once in the boot log and on `/api/health`.
59. A non-HTTPS `public_url` produces its own distinct message.
60. A2A stays disabled and its routes still return `503`.

**Case mismatch (10.11)**

61. On a case-insensitive filesystem, a stage `uses:` path whose casing differs from disk produces a
    validation finding — `warning` normally, `error` under `--strict`.
62. Correct casing produces no finding, on either filesystem.

---

## Testing

Run `npm test`, `npm run ui:test`, and `npm run typecheck` before finishing. All three must pass.

Tests live in `tests/*.test.ts`; fixtures live under `tests/fixtures/`. Prefer extending fixtures
over inlining YAML when behaviour is catalog-driven — `tests/fixtures/manifest-catalog/` is already
the manifest-browse fixture and is what `tests/surface.catalogParity.test.ts` copies into a temp git
repo.

Existing files to extend rather than replace:

| File | What to add |
|---|---|
| `tests/surface.catalogParity.test.ts` | Two project roots; REST and MCP agree; `project_root` filter; `root_errors` for a vanished root |
| `tests/server.http.test.ts` | `/livez`, `/readyz` (200 and 503), `/api/health` shape and its token gate, the `project_root` query parameter |
| `tests/server.createHttpHost.test.ts` | `/livez` and `/readyz` dispatch **before** the auth gate |
| `tests/server.ensureGlobalService.test.ts` | The probe now hits `/livez` and autostart still works with a token configured |
| `tests/mcp.tools.test.ts` | `get_started`; `project_root` on the catalog tools |
| `tests/mcp.catalogInspect.test.ts` | Absolute-path refusal, `..` refusal, catalog-relative success |
| `tests/config.validateCatalog.test.ts` | The case-mismatch finding, both severities |
| `tests/cli.validate.test.ts` | `--strict` promotes the case-mismatch finding to an error |
| `tests/a2a.server.test.ts` | `configuration_error` carries the message for a short token and for a non-HTTPS `public_url` |
| `tests/a2a.registry.test.ts` | Regression: the messages themselves are unchanged |
| `tests/cli.providers.test.ts` | Boot-time env configuration; `_FILE`; both-set error |
| `tests/server.operatorResults.test.ts` | Codes come from the result object, not from message regexes |
| `tests/runManager.submission.test.ts` | Per-project cap: `scope: "project"` on the failure |

New test files worth adding: `tests/config.hostConfig.test.ts` (precedence, unknown keys, invalid
values, redaction), `tests/config.multiProjectCatalog.test.ts` (root set, filter, per-root failure),
`tests/config.catalogRelativePath.test.ts` (the 7.2 refusals), `tests/server.health.test.ts` (the
three surfaces, including `/livez` with the store broken), `tests/cli.doctor.test.ts` (`--json`
shape, exit codes, a missing `PATH` command), `tests/config.configOrigin.test.ts` (12.6's refusal and
the recorded origin), and `tests/mcp.getStarted.test.ts`.

Two tests worth writing carefully because they are the ones that catch a regression nobody would
notice by hand:

- **Table-drive the catalog surface.** One test that walks every catalog-listing route and MCP tool
  against a two-root fixture and asserts identical sets. That is the test that stops the two
  surfaces drifting apart again, which is how the gap 7.1 fixes came to exist.
- **`/livez` with the store deliberately broken.** Point `STAGEFLOW_HOME` at a directory whose
  `state.db` is a directory, or revoke write permission, and assert `/livez` still returns `200`
  quickly. This is the single assertion that encodes the whole 8.3 argument; without it, someone
  will add a `stat` to `/livez` in six months and no test will object.

For 13.3, the honest end-to-end check is not a unit test: `npm pack`, install the tarball into a
clean directory, `STAGEFLOW_HOME=$(mktemp -d) sf mcp` from a directory that is **not** a git
repository, point a coding agent's MCP client at it, and confirm `get_started` names three calls and
that running exactly those three calls completes a run.

---

## Repo conventions

Read [`AGENTS.md`](../../../AGENTS.md) at the repo root first. The parts that bear on this slot:

- **Minimal, focused diffs.** Match the patterns in the file you are editing. Do not restructure
  `createOperatorRoutes` because you are adding two routes to it, and do not reformat
  `catalogTools.ts` while replacing its root-merging helper.
- **Match surrounding patterns rather than importing new ones.** `browseCatalog` already has
  per-context helpers; `validateCatalog` already has finding builders; `operatorResults` already has
  a mapping layer. Extend those seams.
- **No comments unless the logic is non-obvious.** Three places in this slot genuinely earn one: why
  `/livez` does no I/O, why the autostart probe moved off `/api/health`, and why a seeded catalog
  root skips the git-project inference. Most of the rest needs none.
- **JSON output and exit codes are a public contract** — see `docs/ci.md` and `tests/cli.*.test.ts`.
  `sf doctor`'s exit codes and `--json` shape join that contract; so does the 8.5 error-code union.
- **Never commit secrets or `.env` files.** Test tokens and API keys go in test files as obvious
  literals. `*_FILE` tests write to a temp directory.
- **Docs to update in the same change:** `docs/mcp.md` (the path contract, `get_started`, the error
  codes, the seeded catalog, `project_root` filters), `docs/cli-reference.md` (`sf doctor`, the new
  env vars, the per-project cap), `docs/providers.md` (boot-time env credentials and the
  `docker exec -it` OAuth flow), `docs/a2a.md` (the status error field), `docs/ci.md` (the error-code
  and exit-code contracts), `docs/yaml-catalog.md` (the 12.6 trust boundary). Public docs are
  indexed at `docs/README.md`.
- **Keep `examples/` in sync when behaviour changes**, and treat `tests/fixtures/` as canonical YAML.
- **Positioning:** user-facing copy leads with configurable stages and pipelines. `get_started`'s
  `next_steps` text and the seeded-catalog docs are user-facing — do not frame Stageflow as an
  SDLC-only tool there.

---

## Open questions for the human

1. **Where does the seeded `examples/` catalog live in the image, and what is its `project_root`
   string on the wire?** `/opt/stageflow/examples` is the natural answer, but it means a remote
   harness passes a container-absolute path as a `project_root` identifier, which sits awkwardly
   beside 7.2's "no host-absolute paths." An alternative is a symbolic root id (`project_root:
   "examples"`) that the Host maps to a path. **Recommendation: symbolic ids for seeded roots,
   absolute paths for registered ones**, since seeded roots are the ones a remote caller actually
   has to name. Needs a decision before 7.1's response shape is final.
2. **Should `feature-loop` and `ship-feature` be registered in the repo-root `stageflow.yaml`?**
   They are documented in `examples/README.md:35-36` but absent from `stageflow.yaml:3-40`. If it was
   an oversight, fixing it raises the seeded counts from 38/26. If it was deliberate, the README
   should say why.
3. **Does `STAGEFLOW_ALLOW_UNKNOWN_CONFIG` need to exist?** Strict unknown-key rejection on the
   whole `STAGEFLOW_*` namespace is the check that catches typo'd compose variables, but it will bite
   anyone whose CI exports a `STAGEFLOW_*` variable for their own tooling. **Default if nobody
   answers: ship the escape hatch, warn when used.**
4. **Is a per-project cap worth shipping at all, given slot 3's round-robin queue?** The plan
   schedules it here and 11.3 says the queue "subsumes 7.3 more cleanly than a second static cap."
   Shipping both means two mechanisms with overlapping purpose for one release. **Recommendation:
   ship it — it is small, and a queue still wants a ceiling — but flag it for possible removal when
   slot 3 lands.**
5. **How strict should 12.6's default be for `checkout`-bound runs?** A path-checkout run today
   points at a directory the operator chose deliberately, which is arguably already trust. If the
   default refuses workspace config for `checkout` bindings too, we break a local user who keeps
   `.mcp.json` in the repo they are working on and runs `sf run --checkout .` — which is a normal
   thing to do. **Recommendation: refuse by default for `repository` bindings (slot 2's clones),
   permit for `checkout` bindings with the origin recorded as `workspace`.** This needs a human
   decision because it is the one place in the slot where security and current local behaviour
   genuinely conflict.
6. **Does `/readyz` belong open, given it names a failing subsystem?** Its body is booleans and a
   code, no paths and no versions, so exposure is minimal — but "the store is unopenable" is
   information. **Recommendation: keep it open**, because an orchestrator cannot hold a token, and
   keep the body free of paths.
7. **What is the real `engines.node` floor, and is changing it this slot's job?** `package.json:52-54`
   says `>=20`; Pi and `better-sqlite3` need `>=22`, and `install.sh:6` enforces 20. `sf doctor`
   should report the discrepancy, but bumping `engines` is a release-facing change that may belong
   with the Dockerfile work. Assumed out of scope here — confirm.
8. **Should the rich `/api/health` get a `read`-scope or a `drive`-scope requirement?** Slot 5's two
   scopes make `read` the obvious answer, but the payload discloses paths, versions, and capacity.
   **Recommendation: `read`**, since a dashboard is exactly who wants it.
