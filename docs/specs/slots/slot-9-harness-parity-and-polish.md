---
status: implementation-brief
slot: 9
---

# Slot 9 — Parity closed, and the things that make it better than local

## For the agent picking this up

**Stageflow** is a Node/TypeScript runtime for configurable multi-stage AI agent workflows. Users
author pipelines in YAML (`*.pipeline.yaml`, `*.task.yaml`, an optional repo-root `stageflow.yaml`
manifest); each stage runs in a fresh agent session and hands off to the next through typed
envelopes and artifacts. The CLI is `sf` (`src/cli.ts`).

Five facts about the architecture matter for this slot:

1. **There is one HTTP Host.** `sf ui` and `sf mcp` both call `createHttpHost`
   (`src/server/createHttpHost.ts`), which serves the operator REST API (`/api/*`), the MCP
   endpoint (`/mcp`), and — when configured — A2A, all on port `3847`. Everything this slot exposes
   remotely goes through those routes. `sf mcp` serves the **full** REST API, not just health
   (`src/server/mcpHost.ts:41-49`).
2. **MCP tools are registered from `src/mcp/tools.ts:13-19`**, which wires four modules and
   registers `wait_run` itself: `catalogTools.ts` (ten tools — `list_pipelines`, `list_tasks`,
   `list_models`, `list_runs`, `get_health`, `start_run`, `get_run`, `read_artifact`, `validate`,
   `describe_pipeline`), `controlTools.ts` (fourteen run-control tools), `providerTools.ts`
   (`list_providers` only), `projectMcpTools.ts` (two).
3. **Stages are forked Node child processes** hosting a "Pi" coding agent with `bash`, read, write,
   and edit tools. A stage can run arbitrary shell. That is why several of the capabilities below
   are deliberately *not* exposed over the API.
4. **All durable state is one SQLite file** in WAL mode under the global home. The run record is
   rows plus a per-run workspace directory tree (`src/runstore/workspaceLayout.ts`).
5. **`--json` output and exit codes are a public contract** (`docs/ci.md`, `tests/cli.*.test.ts`).

Stageflow is being containerized. The work is split into nine shipping slots; see
[`../pre-container-work.md`](../pre-container-work.md) for the full plan and build order. **This is
slot 9, the last one.** Slots 1–8 make the Host survivable, reachable, safe, and recoverable in a
container. Slot 9 is where the stated bar gets met: *a remote harness driving a container gets
everything a local install gives, and in a few places more.*

One child spec is already locked and you should treat its decisions as settled:
[`../run-scoped-skills.md`](../run-scoped-skills.md). Do not redesign it; item 3 below implements
it.

You do not need to read the plan doc. Everything you need is below, and every claim about current
behaviour was re-verified in this worktree with a `file:line` citation.

---

## Mission

Ship seven things:

1. **`start_run` parameter parity** — MCP gets `checkout` override, `skipGates`, and CI metadata,
   which REST and the CLI already have, plus slot 2's repository binding.
2. **Inline pipelines that can be rerun** — persist the inline pipeline with the run, so the
   mount-free path we recommend to every remote harness is not a one-shot.
3. **Run-scoped skills** — `start_run.skills` as name → file bytes, materialised beside the Run,
   resolved by stage `skill: <name>`, with recorded origin, plus a `list_skills` MCP tool.
4. **A decision, in writing, for every remaining CLI-only capability** — `sf export-run`,
   `sf graph`, `sf migrate-yaml`, `sf skills install`, `sf a2a *`, provider login. Each either gets
   an API or is documented as `docker exec`-only. An undocumented gap is worse than a documented
   one.
5. **Declared toolchain requirements and a preflight** — `requires:` at pipeline and stage level, a
   toolchain manifest, `sf doctor --pipeline <path>`, and an MCP `preflight` tool that returns
   `missing_tool` / `tool_version_mismatch` *before* a run starts.
6. **A run manifest** — what actually ran: image digest, build SHA, repository/ref/resolved_sha,
   pipeline and task **bytes**, skill digests, the **resolved** model per stage, toolchain versions,
   and the resolved stage MCP server set with secrets redacted. Written at start, finalised at
   terminal, exposed on `get_run`, and used as the payload of `sf export-run`.
7. **Per-caller attribution and quotas**, and **post-mortem debugging** — named tokens, `caller_id`
   on the run record, a per-caller concurrency quota, audit lines; plus `sf debug-run <id>` and
   longer worktree retention for failed runs.

Items 5 and 6 are the only genuinely new standalone capabilities in the whole nine-slot plan.
Everything else in this slot is closing a gap that already exists.

---

## Why this matters

- **The bar was stated as parity, and parity is currently false in a way that bites on day two.**
  A harness can start a run over MCP with an inline pipeline — and then cannot rerun it, cannot
  pin a checkout, cannot skip gates for unattended CI, and cannot attach CI provenance. REST and
  the CLI can do all four (`src/server/http.ts:352-423`). The container's primary interface is the
  weakest one.
- **The mount-free path is the one we recommend and the one that dead-ends.** Slot 7 documents
  "inline pipeline + inline task" as the path for remote harnesses. `rerun` hard-requires
  `meta.pipeline_path` (`src/runtime/runManager.ts:689-695`), which an inline run never has. So the
  recommended path is the un-retryable one.
- **Skills are the difference between a generic agent and yours.** Today a skill has to already be
  on the container's disk (`src/runtime/stageAttemptBootstrap.ts:86-103` fails the stage with
  `Skill "<name>" is not installed`), and the only way to put one there is `docker exec … sf skills
  install`. A harness that ships its own `SKILL.md` with the call needs no exec step at all.
- **A declared toolchain is the clearest case where a container beats a laptop.** Locally
  `requires: [{ tool: pnpm, version: ">=9" }]` is bureaucracy — you install pnpm and move on. In an
  image the toolchain is a fixed, inspectable fact, so the declaration can actually be *checked*,
  and a harness learns "this image has no pnpm" in one call instead of eighteen minutes into a run.
- **"What actually ran" is unanswerable today.** The run record carries a DAG snapshot
  (`src/runstore/pipelineDagSnapshot.ts`) — which is genuinely good — but not the pipeline bytes,
  not the resolved model, not the resolved MCP server set, not a build identity. Two hosts running
  the same YAML can resolve differently, because `.mcp.json` entries interpolate from the
  environment (`src/config/resolveStageMcpServers.ts`). A bug report that cannot say what ran is a
  bug report you cannot act on.
- **One shared control token forecloses team use.** Slot 5 ships a single
  `STAGEFLOW_CONTROL_TOKEN`. Every run then looks identical in `list_runs`, quotas are impossible,
  and rotating locks out everyone at once. A2A already solved this one layer over
  (`src/a2a/store.ts:9-40`, `src/a2a/registry.ts:114-119`) and none of it reaches the run record.

---

## Dependencies

This slot assumes slots 1–8 have shipped. It is last for a reason: nearly every item here reads
something an earlier slot records.

| | |
|---|---|
| **Assumes shipped: slot 1** | `$STAGEFLOW_HOME` as the resolved, validated durable root, and the flattened layout. Run-scoped skills materialise under `$STAGEFLOW_HOME/runs/<runId>/skills/`; the debug bundle and the manifest both name paths relative to it. Slot 1 also owns the store schema version and the migrations ledger — **every new column in this slot is a forward migration in that ledger, not another `PRAGMA table_info` probe.** |
| **Assumes shipped: slot 2** | The repository binding (`repository` + `ref` + `resolved_sha` recorded on the Run), the `src/git/` module and its error taxonomy, the worktree path and branch, the `STAGEFLOW_*` path contract, and the three read-only checkout tools `list_checkout_changes`, `get_run_diff`, `read_checkout_file`. Item 1 surfaces the binding on MCP `start_run`; item 6 records the triple in the manifest; item 7's `sf debug-run` calls `get_run_diff`. |
| **Assumes shipped: slot 3** | Two-stage retention (SLIM / PURGE) with **per-status overrides**, `sf runs gc`, `delete_run`, `cancel_run`, and the `queued` / `cancelled` statuses. Item 7's post-mortem work is a *defaults change* on slot 3's override mechanism, not a new retention system. The per-caller quota sits on top of slot 3's/11.3's queue rather than adding a third rejection path. |
| **Assumes shipped: slot 4** | The JSON-lines logger to stdout. Audit lines are records on that logger, not a second log file. |
| **Assumes shipped: slot 5** | `STAGEFLOW_CONTROL_TOKEN` / `_FILE`, the `read` / `drive` scopes, the allowed-hosts resolver, and the refuse-to-start rule. **Item 7 generalises slot 5's single token into named tokens; it does not replace the scope model.** Every route and tool this slot adds sits behind slot 5's check with a scope chosen deliberately. |
| **Assumes shipped: slot 6** | The curated stage environment and `secrets:` declarations. The manifest's redaction of resolved MCP server configuration reuses slot 6's redaction helper — **do not write a second redactor.** |
| **Assumes shipped: slot 7** | The stable **error taxonomy** on MCP and REST (`{ code, message }`), the `/livez` / `/readyz` / `/api/health` split, the **toolchain manifest** reported on `/api/health`, `sf doctor`, the unified multi-project catalog resolution, and the catalog-relative path contract. Item 5 adds `--pipeline` to slot 7's `sf doctor` and an MCP `preflight` tool that diffs against slot 7's manifest. `missing_tool` and `tool_version_mismatch` are new codes **in slot 7's taxonomy**. |
| **Assumes shipped: slot 8** | The export envelope's `pipeline_source` field, `sf export --all`, the build SHA (`BUILD_SHA` in `src/package-meta.ts`), and `docs/docker.md`. **Slot 8 defined `pipeline_source: "inline" \| "path"` and emits `pipeline: null` with an `"unavailable_until_slot_9"` note for inline runs — item 2 fills that body and the format does not change.** Slot 8 may already have lifted `assertRunComplete` for `sf export --all`; check before editing it for `sf export-run` (item 6). |
| **Blocks** | Nothing. This is the last slot before the Dockerfile. |

---

## The parity gap, as a table

Read this before the task list. It is the whole slot in one screen. "CLI" means reachable via
`docker exec … sf <cmd>`; "MCP" and "REST" mean reachable by a remote harness holding a token.

| Capability | MCP | REST | CLI | What slot 9 does |
|---|---|---|---|---|
| Start a run from a **path** pipeline | yes | yes | yes | unchanged |
| Start a run from an **inline** pipeline | yes (`src/mcp/catalogTools.ts:66-70`) | **no** — `pipeline` must be a string (`src/server/http.ts:362-369`) | no | leave REST as-is; the console has a filesystem. Document the asymmetry |
| `checkout` override on start | **no** | yes (`http.ts:377-382`) | yes | **add to MCP** (item 1) |
| `skipGates` on start | **no** | yes (`http.ts:384-387`) | yes | **add to MCP** (item 1) |
| CI metadata (`gitSha`, `ciPrUrl`, `ciJobUrl`) | **no** | yes (`http.ts:388-393`) | yes | **add to MCP** (item 1) |
| Repository binding on start | slot 2 | slot 2 | slot 2 | **surface on MCP alongside the above** (item 1) |
| Rerun a **path** run | yes | yes (`http.ts:425-434`) | yes | unchanged |
| Rerun an **inline** run | **no** — 400 | **no** — 400 | **no** | **persist the pipeline; rerun replays it** (item 2) |
| Ship a skill with the call | **no** | no | `sf skills install` | **`start_run.skills`** (item 3) |
| See which skill a stage loaded | **no** | `GET /api/skills` (`http.ts:735-737`, no origin per run) | `sf skills list` | **`list_skills` MCP tool reporting origin** (item 3) |
| Know a tool is missing before starting | no | no | no | **`preflight` + `sf doctor --pipeline`** (item 5) |
| Know what actually ran | partial — DAG snapshot only | partial | `sf export-run` | **run manifest on `get_run`** (item 6) |
| Export one run | **no** | **no** | `sf export-run` | **`GET /api/runs/<id>/export`, and lift the terminal-status gate** (item 6) |
| Attribute a run to a caller | no — `RunMeta` has no caller field (`src/runstore/port.ts:56-71`) | no | no | **`caller_id` + `list_runs` filter + quota** (item 7) |
| Post-mortem after GC | no | no | no | **longer FAILED retention + `sf debug-run`** (item 7) |
| `sf graph` | no | no | yes | **documented `docker exec`-only** — `describe_pipeline` covers the harness case (item 4) |
| `sf migrate-yaml` | no | no | yes | **documented `docker exec`-only** — it rewrites files in a checkout (item 4) |
| `sf a2a validate/list/add-caller` | no | `GET /api/a2a/status` only | yes | **documented `docker exec`-only**, config is boot-read by design (item 4) |
| Provider login (API key) | no | yes | yes | **boot-time env/file config is slot 7's; document it as the container path** (item 4) |
| Provider login (OAuth) | no | browser-driven | terminal-driven | **documented `docker exec`-only** (item 4) |

---

## Verified current state

Every line below was read in this worktree.

### `start_run`, exactly

The MCP schema is four lines long and that is the whole gap:

```64:76:src/mcp/catalogTools.ts
const startRunSchema = z
  .object({
    pipeline: z
      .union([z.string(), inlinePipelineSchema])
      .describe(
        "Filesystem path to a pipeline YAML file, or an inline pipeline definition object ({ id, stages: [...] }) authored directly in this call",
      ),
    task_path: z.string().optional(),
    task: taskFileSchema.optional(),
  })
  .refine((data) => Boolean(data.task_path) !== Boolean(data.task), {
    message: "Exactly one of task_path or task is required",
  });
```

The handler then calls `manager.startRun({ pipeline, task: taskInput })`
(`src/mcp/catalogTools.ts:199`) — three fields, nothing else.

`RunManager.startRun` already accepts everything that is missing
(`src/runtime/runManager.ts:613-621`): `checkoutOverride`, `skipGates`, `gitSha`, `ciPrUrl`,
`ciJobUrl`, and it forwards them to `reserveAndStartPipeline` (`:662-677`, defined at `:1611-1684`).
**So item 1 is a schema and a pass-through, not a runtime change.** REST proves it: `POST /api/runs`
validates and forwards exactly those five (`src/server/http.ts:352-423`).

| Fact | Evidence |
|---|---|
| MCP `start_run` accepts only `pipeline`, `task_path`, `task` | `src/mcp/catalogTools.ts:64-76`, handler `:189-214` |
| REST `POST /api/runs` accepts `checkoutOverride`, `skipGates`, `gitSha`, `ciPrUrl`, `ciJobUrl` | `src/server/http.ts:353-406` |
| REST requires `pipeline` to be a **string** — no inline pipeline over REST | `src/server/http.ts:362-369` |
| `RunManager.startRun` already takes all five | `src/runtime/runManager.ts:613-621`, `:662-677` |
| Start failures are `{ ok: false, reason, status, code? }` with `busy_capacity` / `busy_checkout` | `src/runtime/runManager.ts:1686-1708` |

### `rerun` and what the store keeps

```688:696:src/runtime/runManager.ts
      const meta = await this.options.store.readRunMeta(runId);
      if (!meta.pipeline_path) {
        return {
          ok: false,
          reason: `Run ${runId} is missing pipeline_path; re-run requires stored catalog locators.`,
          status: 400,
        };
      }
      pipeline = normalizeCatalogPath(meta.pipeline_path);
```

The asymmetry is the point: the **task** survives as bytes (`store.readTaskYaml(runId)`,
`src/runtime/runManager.ts:703`; `task_yaml TEXT NOT NULL` in the runs table), while the
**pipeline** survives only as a path plus a structural DAG snapshot.

| Fact | Evidence |
|---|---|
| `pipelinePath` is `undefined` for an inline pipeline, by construction | `src/runtime/pipelineRunner.ts:147-150` |
| `createRun` persists `taskYaml`, `pipelineDag`, `pipelinePath`, `taskPath`, `projectRoot` — never the pipeline body | `src/runtime/pipelineRunner.ts:158-171`, `CreateRunInput` at `src/runstore/port.ts:375-388` |
| Runs table columns | `src/runstore/sqlite/schema.ts:2-18` — no pipeline body column |
| The DAG snapshot carries `stage_ids`, `nodes`, `roots`, `childrenOf`, `gate_kinds`, `clone_input_schema` — **no prompts, no models, no verify blocks** | `src/runstore/pipelineDagSnapshot.ts` |
| `rerun` takes no options at all — no `pinned`, no overrides | `src/runtime/runManager.ts:680`, REST at `src/server/http.ts:425-434` |

**The snapshot is not enough to replay from.** It is a shape, not a definition. Item 2 stores bytes.

### Skills

| Fact | Evidence |
|---|---|
| Stage `skill: <name>` resolves through Pi's loader, keyed on `{ cwd, agentDir }` | `resolveStageSkillForRun`, `src/runtime/stageAttemptBootstrap.ts:86-103` → `resolveSkillByName`, `src/config/listSkills.ts:68-85` |
| The failure is a flat string with no origin information | `src/runtime/stageAttemptBootstrap.ts:92`, `:98` — `Skill "<name>" is not installed` |
| `{ cwd, agentDir }` comes from the Host's `operatorCatalog`, set once at boot | `src/server/bootstrap.ts:95` — `operatorCatalog: { cwd, agentDir }`; type at `src/runtime/stageAttemptBootstrap.ts:49-52` |
| `SkillListing` **already** carries `scope` (`user` / `project` / `temporary`) and `source` from Pi's `sourceInfo` | `src/config/listSkills.ts:10-18`, `:41-51` |
| Skills are listed over REST only | `GET /api/skills` → `listSkills({ cwd, agentDir })`, `src/server/http.ts:735-737` |
| **No MCP skills tool exists** | the four `registerTool` files contain none; `docs/mcp.md` has no skills entry |
| `sf skills install` writes into `<projectRoot>/.pi/skills/<name>/` | `skillsDirForRoot`, `src/cli/skillsCommand.ts:117-119` |
| Documented resolution is the operator checkout's `.pi/skills` plus the Pi agent skills dir | `docs/yaml-catalog.md:712-713` |

**Correction to the plan doc.** `run-scoped-skills.md` lists "`list_skills` origin field on MCP"
under *Not locked*, while `pre-container-work.md` 9.3 puts it in scope. **This brief includes it**,
because item 6's manifest has to record the chosen origin anyway, and a field the manifest records
but no tool reports is a strange place to stop. The locked spec's substance is untouched.

### The run record, attribution, and A2A's reusable half

```56:71:src/runstore/port.ts
export type RunMeta = {
  run_id: string;
  pipeline_id: string;
  created_at: string;
  status?: RunStatus;
  task_id?: string;
  updated_at?: string;
  checkout_root?: string;
  git_sha?: string;
  ci_pr_url?: string;
  ci_job_url?: string;
  pipeline_dag?: RunPipelineDagSnapshot;
  pipeline_path?: string;
  task_path?: string;
  project_root?: string;
};
```

**No caller field. Confirmed.** And `ListRunsFilter` is `status` / `since` / `pipeline` only
(`src/runstore/port.ts:390-396`).

A2A already has the shape, one layer over:

| Fact | Evidence |
|---|---|
| `caller_id` is a column on `a2a_contexts`, `a2a_tasks` (indexed), and `a2a_messages` | `src/a2a/store.ts:9-40` |
| Bearer tokens are stored **hashed** and compared with `timingSafeEqual`, returning the caller id | `src/a2a/registry.ts:114-119` |
| Tokens are validated at load: non-empty, no whitespace, ≥ 32 chars, per-caller env var | `src/a2a/registry.ts:152-154` |
| Callers are declared in `a2a.yaml` with unique ids | `src/a2a/registry.ts:150-151` |

That is the mechanism item 7 reuses. **Copy it; do not reinvent it.**

### Model resolution — what "resolved" means for item 6

There are **two** resolutions, and the manifest should record both:

1. **Catalog resolution, at pipeline load.** `resolveModelOutcome` applies stage > pipeline >
   manifest-global precedence with no silent fallback (`src/config/resolveModel.ts:18-45`), driven
   by `materializeStageModels` (`src/config/materializeStageModels.ts:10-49`), which produces
   `LoadedStageConfig[]` with a concrete `model` string per stage. **This value exists in memory at
   run start and is never persisted** — the DAG snapshot does not carry it.
2. **Provider resolution, at stage start.** Pi's `resolveCliModel({ cliModel: input.stage.model,
   modelRuntime })` maps that catalog id onto a concrete provider model plus an optional thinking
   level (`src/agent/piAdapter.ts:1254-1266`, and again on the resume path at `:1329-1343`). Also
   not persisted.

The only model information that survives today is *post hoc*: `StageUsage.models` is keyed by the
model string the provider reported on assistant messages (`src/types/usage.ts:11-14`, populated at
`src/agent/piAdapter.ts:417-421`). That tells you what answered, after the fact, and nothing at all
for a stage that failed before its first turn.

### `sf export-run`

```108:113:src/cli/exportRunCommand.ts
function assertRunComplete(status: RunStatus, runId: string): void {
  if (status === "succeeded" || status === "failed") {
    return;
  }
  throw new Error(`run is not complete: ${runId} (status: ${status})`);
}
```

Called at `:162`, before `projectRun(detail)` at `:163`. `--out` is confined to the cwd with
`..`-rejection (`resolveSafeOutPath`, `:93-106`). There is no REST or MCP equivalent.

### Confirmed absent

| Thing | Search |
|---|---|
| Any `requires` key in the schema | `rg -n "requires" src/config/` returns only English prose inside validation messages (`yamlDialect.ts:232`, `cloneChain.ts:444`, `parseCompletionContract.ts:55`, …). **No `requires` field exists anywhere in the config layer.** |
| Any toolchain manifest, tool-version check, or `preflight` | no matches in `src/` — slot 7 lands the manifest, this slot consumes it |
| Any run manifest | no matches |
| `caller_id` outside `src/a2a/` | no matches |
| `sf debug-run`, `sf doctor --pipeline` | no matches (`sf doctor` itself is slot 7's) |
| Provider login over MCP | `src/mcp/providerTools.ts` registers exactly one tool, `list_providers` |
| An MCP skills tool of any kind | no matches |

### Where the plan document needs correcting

- **9.2 offers a choice** ("either persist the inline pipeline … or add opt-in `save_as`"). **It is
  decided: persist.** `save_as` writes into a catalog the harness cannot see, needs a writable
  catalog root under `read_only: true`, and creates a naming collision surface — and it does not
  make the run record self-contained, which slot 8's export needs. See item 2.
- **9.4 lists `sf export-run` as an open "decide whether it gets an API"**, while 12.8 says that
  framing is wrong for a container product. 12.8 wins, and item 6 gives `export-run` an API because
  the run manifest is its payload anyway.
- **`run-scoped-skills.md` files the `list_skills` origin field under "not locked."** This brief
  pulls it into scope; see the skills section above for why.
- **13.5 says A2A's caller tokens are "one layer over."** Precisely: A2A tokens authenticate `/a2a`,
  not `/mcp` or `/api/*`. Item 7 reuses A2A's *mechanism* (hashed tokens, constant-time compare,
  the ≥32-char rule) for slot 5's control tokens. **Do not route MCP through the A2A registry** —
  the caller namespaces stay separate, and both write the same `caller_id` field on the run.

---

## The work

### 1. `start_run` parameter parity *(9.1)*

**Today.** MCP `start_run` accepts three fields (`src/mcp/catalogTools.ts:64-76`). REST accepts
five more (`src/server/http.ts:353-406`). `RunManager.startRun` already takes all of them
(`src/runtime/runManager.ts:613-621`).

**Target.** One schema, shared shape across MCP and REST:

| Field | Type | Note |
|---|---|---|
| `checkout` | string | The MCP-facing name for REST's `checkoutOverride`. Subject to slot 7's path contract: catalog-relative or an error explaining the contract, never a bare `ENOENT` |
| `skip_gates` | boolean | Unattended-fail for CI |
| `git_sha`, `ci_pr_url`, `ci_job_url` | string | CI provenance, straight through to the existing columns |
| `repository`, `ref` | string | Slot 2's binding. XOR with `checkout`, with slot 2's named validation error |
| `skills` | map | Item 3 |
| `caller_id` | — | **Never a parameter.** Derived from the token (item 7) |

**Design decisions already made:**

- **MCP tool parameters are `snake_case`; the `RunManager` option names stay as they are.** The
  existing MCP schema already uses `task_path` while the manager uses `taskPath`; map at the
  boundary rather than renaming a runtime option and churning REST.
- **`checkout`, not `checkoutOverride`, on MCP.** There is nothing to "override" from a harness's
  point of view — it is just where the run works. REST keeps `checkoutOverride` for compatibility;
  document them as the same thing.
- **The XOR is enforced once**, in slot 2's binding resolution, not separately per surface. MCP,
  REST, and the CLI must produce the *same* named error code for `repository` + `checkout`.
- **Do not add inline-pipeline support to REST.** The console runs beside a filesystem and has no
  need; the asymmetry is documented in the parity table rather than closed. Adding it means
  duplicating `inlinePipelineSchema` validation in the hand-rolled body parser for no user.
- **Extend the tool description with the new parameters.** MCP tool descriptions are the only
  documentation a harness reads at runtime; `src/mcp/catalogTools.ts:186` is the model.

**Files likely to touch.** `src/mcp/catalogTools.ts` (schema `:64-76`, handler `:189-214`),
`src/server/http.ts` (accept `repository` / `ref` / `skills` on `POST /api/runs`),
`src/runtime/runManager.ts` (only if a new option is not already threaded), `docs/mcp.md`,
`docs/cli-reference.md`.

---

### 2. Inline pipelines must be rerunnable *(9.2)*

**Today.** `rerun` returns 400 for any run whose `pipeline_path` is null
(`src/runtime/runManager.ts:689-695`), which is every inline run by construction
(`src/runtime/pipelineRunner.ts:147-150`).

**Target — decided: persist the inline pipeline with the run.**

Add to the runs table, as a slot-1 forward migration:

| Column | Contents |
|---|---|
| `pipeline_source` | `"inline"` \| `"path"` — the same discriminator slot 8 already put in the export envelope |
| `pipeline_body` | the inline definition serialised as canonical JSON (it arrives as an object over MCP, not as YAML), or `NULL` for a path run |

Then:

- `CreateRunInput` gains `pipelineSource` and `pipelineBody`
  (`src/runstore/port.ts:375-388`); `RunMeta` gains the same two (`:56-71`); the store adds
  `readPipelineBody(runId)` beside the existing `readTaskYaml(runId)` (`:409`), which is the exact
  precedent.
- `preparePipeline` sets them where it currently computes `pipelinePath`
  (`src/runtime/pipelineRunner.ts:147-171`).
- `rerun` (`src/runtime/runManager.ts:680-718`) branches on `pipeline_source`: `"path"` keeps
  today's behaviour verbatim; `"inline"` loads the body and passes the object straight into
  `reserveAndStartPipeline`, which already accepts `string | InlinePipelineDefinition`
  (`:1613`). The 400 stays only for a run with neither — an old row from before this migration.

**Design decisions already made:**

- **Persist rather than `save_as`.** `save_as` would write a file into a catalog root that is
  read-only in the supported container profile, invent a naming and collision policy, and still
  leave the run record pointing outward. Persisting makes the record self-contained, which is what
  slot 8's whole-instance export and item 6's manifest both need. One change, three payoffs.
- **Store the definition as JSON, not re-serialised YAML.** It arrives as a validated object
  (`inlinePipelineSchema`); round-tripping it through YAML introduces a formatting decision and a
  lossy path for no benefit. The manifest (item 6) records a digest over these canonical bytes.
- **Rerun replays the pipeline as it was submitted, always.** There is no "rerun against the
  current version of that inline pipeline" — there is no such thing. For repository-bound runs,
  slot 2's `ref`-vs-`pinned` rerun semantics are unchanged and orthogonal.
- **Cap the stored body**, with a named error at start (`inline_pipeline_too_large`), and pick the
  limit in the same place as item 3's skills payload cap so there is one number to document.
- **This is the field slot 8 reserved.** Slot 8 emits `pipeline_source` with
  `pipeline: null` and an `"unavailable_until_slot_9"` note. Fill the body; **do not change the
  envelope shape.** If slot 8's note text is load-bearing in a test, update the test in this slot.

**Files likely to touch.** `src/runstore/sqlite/schema.ts`, slot 1's migration ledger,
`src/runstore/sqlite/SqliteRunStore.ts`, `src/runstore/port.ts`, `src/runtime/pipelineRunner.ts`,
`src/runtime/runManager.ts`, `src/cli/exportRunCommand.ts` / slot 8's export path, `docs/mcp.md`.

---

### 3. Run-scoped skills *(9.3, per the locked spec)*

**Today.** A stage's `skill: <name>` resolves only against what is already on the container's disk
(`src/runtime/stageAttemptBootstrap.ts:86-103`), and the only way to put something there is
`sf skills install` writing to `<projectRoot>/.pi/skills/` (`src/cli/skillsCommand.ts:117-119`) —
i.e. `docker exec`.

**Target.** Implement [`../run-scoped-skills.md`](../run-scoped-skills.md) exactly. Restated as
requirements, since that document is the contract:

1. `start_run.skills` is a map of skill name → `{ relativePath: bytes }`. At least `SKILL.md` per
   name. Extra relative paths are allowed (scripts the skill needs). **Absolute paths and any `..`
   segment are rejected**, with a named error.
2. **The harness sends bytes.** No URL, no fetch, no clone during `start_run`.
   `sf skills install --from-path|--from-zip` remains the operator/image path and is untouched.
3. The Host materialises them at `$STAGEFLOW_HOME/runs/<runId>/skills/<name>/`. **Never inside the
   worktree** — writing there dirties the PR the run is about to raise. Never into a global drawer.
4. `skill:` on the stage is the only link. A name used by the pipeline that is in neither the run
   payload nor on disk fails **before the agent session starts**, exactly as today.
5. One map per run, shared: two stages with `skill: archify` see one materialised copy.
6. **Precedence: run payload > checkout `.pi/skills` > host/image skills.** Same name, run wins.
   **The chosen origin is recorded on the run** and feeds item 6's manifest.
7. Lifetime is the Run. Slot 3's delete and GC remove the directory with the rest of the run
   workspace. Reuse means sending the map again.
8. No generated GitHub skill from `GITHUB_TOKEN`. A stage that needs `gh` instructions gets a
   `SKILL.md` from the harness.

Plus, in scope here: **a `list_skills` MCP tool** reporting each skill's name, description, and
origin — `run` \| `checkout` \| `host` — with an optional `runId` so a harness can ask "what would
*this* run see." `SkillListing` already carries `scope` and `source` (`src/config/listSkills.ts:10-18`),
so the host/checkout half is a projection of what exists; add the `run` tier.

**Design decisions already made:**

- **Precedence is implemented by ordering the loader's search paths, not by copying files around.**
  `resolveSkillByName` takes `{ cwd, agentDir }` (`src/config/listSkills.ts:68-71`) and the run
  scope is a third root. Thread a run-scoped skills directory into `OperatorCatalog`
  (`src/runtime/stageAttemptBootstrap.ts:49-52`) — or a per-run successor to it — rather than
  mutating the Host-wide catalog, which is shared by every concurrent run.
- **Materialise once at run start, not per stage.** Stages fork; doing it per attempt is a race and
  a duplicate.
- **Validate the whole map before creating the Run.** Slot 2 established the rule: a failed link
  fails the start, with no half-built Run and no orphaned directory. Bad paths, an empty map entry,
  a missing `SKILL.md`, and the size cap are all start-time errors with named codes.
- **Cap total payload size and per-file size**, same numbers as item 2's inline pipeline cap. A
  `start_run` body is not a file upload channel.
- **Record origin even when it is `host`.** "The image's skill was used because the harness did not
  send one" is exactly the fact a confused user needs.
- **Do not add a durable `put_skill` or a Host skill drawer.** Explicitly deferred by the locked
  spec.

**Files likely to touch.** `src/mcp/catalogTools.ts` (schema + a new `list_skills` tool),
`src/config/listSkills.ts` (a run-scoped root and an origin field),
`src/runtime/stageAttemptBootstrap.ts` (`resolveStageSkillForRun`, `OperatorCatalog`),
`src/runtime/pipelineRunner.ts` (materialise at start), `src/runstore/` (record origins),
new `src/runtime/runSkills.ts` for the write-and-validate step, `docs/mcp.md`,
`docs/yaml-catalog.md` (the Skill binding section, `:699-719`, gains the precedence table).

---

### 4. Close the remaining CLI-only gaps by deciding each one *(9.4)*

**Today.** Six capabilities are CLI-only and none of them is documented as such. In a container
"CLI-only" means `docker exec`, which a remote harness cannot do.

**The point of this item is the decision and the sentence in the docs, not the code.** Ship the
table below into `docs/mcp.md` (as "what is not available over MCP, and why") and
`docs/docker.md` (as "what needs `docker exec`").

| Capability | Decision | Reason |
|---|---|---|
| **`sf export-run`** | **Gets an API** — `GET /api/runs/<id>/export` (`read` scope) and an MCP `export_run` tool. Terminal-status gate lifted. | The export *is* the portability promise, and the run manifest (item 6) is its payload. Behind `docker exec` it is not a promise a remote harness can keep. Implemented in item 6. |
| **`sf graph`** | **`docker exec`-only.** | `describe_pipeline` already gives a harness the DAG over MCP (`src/mcp/catalogTools.ts:341-364`), and `get_run`'s DAG snapshot gives the per-run shape. `sf graph` renders that for a human terminal. Adding a second rendering surface over MCP duplicates data the harness already has in a form it cannot use. |
| **`sf migrate-yaml`** | **`docker exec`-only.** | It rewrites YAML **files in place** in a checkout, and shells `git status --porcelain` to refuse on a dirty tree. Over an API it would be the Host mutating a caller's repository from a request — the exact "repository content is untrusted input" line slot 8's threat model draws. An author runs this on their laptop before committing. |
| **`sf skills install`** | **`docker exec`-only, and no longer the primary path.** | Item 3 makes the durable install unnecessary for the harness case. `sf skills install` stays the operator/image path: baking skills into a derived image, or installing into a mounted `/workspace`. This is what the locked spec decided; state it rather than leaving it looking like a gap. |
| **`sf a2a validate` / `list` / `add-caller`** | **`docker exec`-only**, with `GET /api/a2a/status` (slot 7, including the configuration error) as the read surface. | A2A publications are read once at boot **by design** — hot reload is on the reject list. A mutating API for a config that only takes effect on restart is a trap. `add-caller` writes a token env reference into `a2a.yaml`, which is deployment configuration, not a runtime call. |
| **Provider login — API key** | **Already solved elsewhere; document it as the container path.** Slot 7 lands boot-time provider configuration from env and `*_FILE`. | The image should self-configure with no exec step at all. This is a documentation deliverable in slot 9 only because 9.4 asked for a decision per capability. |
| **Provider login — OAuth** | **`docker exec`-only**, documented with the exact command. | The flow is terminal-driven (`src/cli/terminalAuthInteraction.ts`) or browser-driven. Neither has a headless shape we can ship responsibly, and a "paste this code" API is a credential-handling surface for a once-per-deployment action. |

**Design decisions already made:**

- **Write the negative decisions down in the same table as the positive ones.** A harness author
  reading `docs/mcp.md` must be able to see "there is no `graph` tool, here is why, here is what to
  use instead" without filing an issue.
- **Every `docker exec`-only row gets its literal command in `docs/docker.md`** — e.g.
  `docker exec -it stageflow sf providers login anthropic --type oauth`. A decision without the
  command is half a decision.
- **Do not add `sf graph` or `sf migrate-yaml` "just for symmetry."** Each new tool is MCP context
  budget spent on every call the harness makes.

**Files likely to touch.** `docs/mcp.md`, `docs/docker.md`, `docs/cli-reference.md`. Code only for
`export_run`, which item 6 owns.

---

### 5. Declared toolchain requirements and a preflight *(13.2)*

**Today.** Nothing. There is **no `requires` key anywhere in `src/config/`** — the only matches for
that word are English inside validation messages. A pipeline that needs `pnpm` discovers its
absence when a `verify` command exits 127, eighteen minutes into a run, with a message that reads
like the tests broke.

**Target.** Four pieces.

**a) The `requires:` block**, at pipeline root and on a stage body:

```yaml
# checkout-verify.pipeline.yaml
id: checkout-verify
model: anthropic/claude-sonnet-4
requires:
  - tool: node
    version: ">=22.19"
  - tool: pnpm
    version: ">=9"
  - tool: git
stages:
  - id: implement
    uses: stages/implement.stage.yaml
  - id: verify-build
    uses: stages/verify-build.stage.yaml
    requires:
      - tool: pnpm
        version: ">=9.5"
      - tool: docker          # present in no Stageflow image; this is how a user learns that
```

Shape: a list of `{ tool: string, version?: string }`. `tool` is a binary name resolved against
`PATH`. `version` is a semver range; **omit it to mean "must exist."** Stage-level requirements are
additive to pipeline-level ones; where both name the same tool, the **intersection** must hold and
the stricter range is what gets checked and recorded.

**b) The toolchain manifest.** Slot 7 already writes and reports one on `/api/health`. Slot 9
consumes it and adds the image-build-time generation step: a JSON file at a fixed path under the
image (not under `$STAGEFLOW_HOME` — it describes the image, not the data), listing each known tool
with its resolved absolute path and `--version` output, generated by a build script so the values
are a fact rather than a promise. At runtime, a tool absent from the manifest is resolved live
against `PATH` and cached, so a derived image (`FROM stageflow:x.y.z` + `apt-get install`) works
without regenerating anything.

**c) The preflight surfaces:**

- `sf doctor --pipeline <path>` — slot 7 owns `sf doctor`; this adds a flag that loads the pipeline,
  collects `requires:` across pipeline and stages, diffs against the manifest, and exits non-zero
  on any unmet requirement.
- An MCP **`preflight`** tool accepting the same `pipeline` union as `start_run` (path **or** inline
  definition) and optionally `skills`, returning `{ ok, checks: [{ tool, required, found, status }] }`
  where `status` is `ok` \| `missing_tool` \| `tool_version_mismatch` \| `unknown_version`.
- **`start_run` runs the same check** and fails before creating a Run, with the same codes.

**d) Resolved versions recorded on the run**, into item 6's manifest.

**Design decisions already made:**

- **Declare and check. Never build.** Stageflow does not install tools, does not build a derived
  image from `requires:`, and does not warn-and-continue. Document the derived-image pattern in
  `docs/docker.md` and let `requires:` be the thing that tells a user they need one. On the reject
  list; see below.
- **An unmet `requires:` fails the start; it does not warn.** The entire value is learning before
  the run, and a warning in a JSON-lines log is not learning.
- **`unknown_version` is a distinct status from `tool_version_mismatch`.** A tool whose
  `--version` output we cannot parse is present but unverifiable. Treat it as a **pass with a
  recorded note** by default and give `sf doctor` a `--strict` mode that fails — the alternative is
  that one oddly-formatted `--version` blocks every run in an image.
- **Version comparison uses the semver range syntax the repo already depends on**, not a
  hand-rolled comparator, and it is documented as semver so nobody writes `>= 9` expecting apt
  semantics.
- **`requires:` is validated at load like every other key** — an unknown sub-key is an error, with
  a named code (`pipeline.invalid_requires` / `stage.invalid_requires`) following the existing
  shape in `src/config/yamlDialect.ts`. Add it to `sf validate` and to `docs/yaml-catalog.md`'s key
  tables (`:69-73` wiring/body lists) in the same change — a body key not in those tables is
  rejected by the loader.
- **Preflight is advisory to the caller and mandatory in `start_run`.** A harness that skips
  `preflight` still cannot start a run that would fail on a missing tool.
- **The check resolves against the *stage's* `PATH`**, i.e. slot 6's curated environment, not the
  Host's. Checking a `PATH` the stage will not have is theatre.

**Files likely to touch.** `src/config/yamlDialect.ts` and `src/config/loadPipeline.ts` /
`loadStage.ts` (parse and validate `requires`), new `src/preflight/toolchain.ts` (slot 6 already
established `src/preflight/` as the home for these functions), slot 7's `sf doctor` and health
payload, `src/mcp/catalogTools.ts` (the `preflight` tool), `src/runtime/pipelineRunner.ts` (the
start-time gate), `scripts/` (the build-time manifest generator), `docs/yaml-catalog.md`,
`docs/mcp.md`, `docs/docker.md`.

---

### 6. A run manifest: what actually ran *(13.4)*

**Today.** The run record has a DAG snapshot (`src/runstore/pipelineDagSnapshot.ts`) and CI
metadata. It does not have the pipeline body, the resolved model, the skill identities, the
toolchain, the resolved MCP servers, or any build identity. `sf export-run` projects what exists
(`src/cli/exportRunCommand.ts:158-174`) and refuses non-terminal runs (`:108-113`).

**Target.** One `run_manifest` blob, written at run start and finalised at terminal, exposed on
`get_run` and `GET /api/runs/<id>`, and used as the payload of `sf export-run` and its new API.

Sketch — treat the field names as the proposal and the *content* as the requirement:

```json
{
  "manifest_version": 1,
  "run_id": "run_01J…",
  "created_at": "2026-03-04T10:15:00Z",
  "finalised_at": "2026-03-04T10:41:22Z",
  "host": {
    "stageflow_version": "0.24.0",
    "build_sha": "a1b2c3d…",
    "image_digest": "sha256:…",
    "schema_version": 7
  },
  "caller": { "caller_id": "ci-github", "surface": "mcp" },
  "binding": {
    "kind": "repository",
    "repository": "owner/repo",
    "ref": "main",
    "resolved_sha": "9f8e7d6…",
    "branch": "stageflow/run-01J…",
    "worktree_path": "$STAGEFLOW_HOME/worktrees/run_01J…"
  },
  "pipeline": {
    "source": "inline",
    "path": null,
    "bytes_sha256": "…",
    "body": { "id": "checkout-verify", "stages": [] }
  },
  "task": { "source": "inline", "path": null, "bytes_sha256": "…", "body": "id: …\ngoal: …\n" },
  "skills": [
    { "name": "archify", "origin": "run", "digest": "sha256:…", "files": ["SKILL.md", "scripts/render.ts"] },
    { "name": "house-style", "origin": "host", "digest": "sha256:…", "files": ["SKILL.md"] }
  ],
  "stages": [
    {
      "stage_id": "implement",
      "model": {
        "authored": "anthropic/claude-sonnet-4",
        "authored_tier": "pipeline",
        "resolved": "claude-sonnet-4-20250514",
        "thinking_level": "medium"
      },
      "mcp_servers": [
        { "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
          "env": { "GITHUB_TOKEN": "<redacted>" }, "origin": "catalog" }
      ]
    }
  ],
  "toolchain": [
    { "tool": "node", "required": ">=22.19", "resolved": "22.19.0", "path": "/usr/local/bin/node" },
    { "tool": "pnpm", "required": ">=9",     "resolved": "9.12.1",  "path": "/usr/local/bin/pnpm" }
  ]
}
```

**Design decisions already made:**

- **Bytes, not paths.** A path is a claim about a filesystem the reader does not have. Store the
  pipeline body (item 2 already persists it) and the task YAML (already persisted), plus a
  `sha256` over each so two manifests can be compared without diffing bodies.
- **Record the model twice: authored and resolved.** The authored value plus its tier (`stage` /
  `pipeline` / `global`) explains *why*; the resolved provider model explains *what*. Both are
  computed today and neither is kept — see the model section of Verified current state for the two
  call sites. Write `authored` at start; write `resolved` when the stage session is created.
- **Secrets are redacted structurally, with slot 6's redactor.** Resolved `.mcp.json` entries are
  interpolated from the environment (`src/config/resolveStageMcpServers.ts`), so the resolved set
  is exactly where a token lands. Redact by **key shape and by matching known secret values**, and
  redact on the way *in* to the manifest, never on the way out — a manifest that has to be
  sanitised at every read surface will eventually be read by a surface that forgets.
- **Written at start, appended during, finalised at terminal.** A manifest that only exists for
  finished runs is useless for the hung run, which is the case people care about. Per-stage entries
  fill in as stages start.
- **Store it as one JSON blob column on the run**, not a normalised table. It is write-once-ish,
  read-whole, and versioned by `manifest_version`; normalising it buys nothing and costs a
  migration every time a field is added.
- **Lift `export-run`'s terminal-status requirement** (`src/cli/exportRunCommand.ts:108-113`).
  A hung run is exactly the run you want to export. **Coordinate with slot 8**, which lifts the
  same check for `sf export --all`; if slot 8 already removed `assertRunComplete`, do not
  reintroduce it.
- **`sf export-run` gets an API**: `GET /api/runs/<id>/export` (`read` scope) and MCP `export_run`.
  The payload is the manifest plus the existing `projectRun` projection
  (`src/projection/projectRun.ts`) — **reuse that projection, do not write a second one.**
- **Record what ran; do not build a replay engine.** On the reject list; see below.

**Files likely to touch.** New `src/runstore/runManifest.ts` (the type and the builder),
`src/runstore/port.ts`, `src/runstore/sqlite/schema.ts` + slot 1's migration ledger,
`src/runtime/pipelineRunner.ts` (write at start), `src/runtime/stageAttemptBootstrap.ts` and
`src/agent/piAdapter.ts` (the resolved model and the resolved MCP set, at the two `resolveCliModel`
call sites `:1254-1266` and `:1329-1343`), `src/mcp/projectRun.ts` and
`src/projection/projectRun.ts`, `src/cli/exportRunCommand.ts`, `src/server/http.ts`,
`src/mcp/controlTools.ts`, `docs/mcp.md`, `docs/cli-reference.md`.

---

### 7. Per-caller attribution and quotas *(13.5)*, and post-mortem debugging *(13.6)*

These ship together because the debug bundle wants to say who started the run.

#### 7a. Attribution and quotas

**Today.** Slot 5 ships one shared `STAGEFLOW_CONTROL_TOKEN`. `RunMeta` has no caller field
(`src/runstore/port.ts:56-71`), and `ListRunsFilter` has no caller filter (`:390-396`).

**Target — four small things, in this order:**

1. **Named tokens.** Alongside slot 5's single token, accept a set of named control tokens:
   `STAGEFLOW_CONTROL_TOKEN_<NAME>` / `_FILE`, each mapping to a `caller_id` derived from `<NAME>`
   lowercased, each carrying slot 5's `read` or `drive` scope. Validate and compare **using A2A's
   mechanism verbatim**: store the SHA-256 of the token, compare with `timingSafeEqual`
   (`src/a2a/registry.ts:114-119`), and enforce the ≥32-char / no-whitespace rule at load
   (`:152-154`). The plain `STAGEFLOW_CONTROL_TOKEN` keeps working and resolves to
   `caller_id: "default"`.
2. **`caller_id` on the run record.** A nullable column, on `RunMeta`, set from the authenticated
   caller at start — **never from a request parameter.** A2A-originated runs write the A2A caller id
   into the same field; record the surface (`mcp` / `rest` / `cli` / `a2a`) alongside it so
   `ci-github` over MCP and `ci-github` over A2A are distinguishable.
3. **A `list_runs` filter.** `caller_id` on `ListRunsFilter` and on the MCP `list_runs` schema
   (`src/mcp/catalogTools.ts:148-153`) and `GET /api/runs`.
4. **A per-caller concurrency quota**, configurable, checked *after* the global cap
   (`src/runtime/runManager.ts:1715-1717`) and slot 7's per-project cap. Over quota, the run
   **queues** on slot 3/11.3's queue rather than being rejected; `busy_capacity` stays the
   bounded-queue error. A distinct queue reason so a harness can tell "I am at my quota" from "the
   host is full."
5. **Append-only audit lines** for every mutating call — `start_run`, `rerun`, `cancel_run`,
   `delete_run`, `answer_gate`, `retry_stage`, `resume_stage`, `abandon_stage`, restore, backup —
   as records on slot 4's JSON-lines logger with `caller_id`, surface, tool or route, target run,
   and outcome. **Not a new file and not a new table.**

**Design decisions already made:**

- **Attribution and quotas only. No accounts, no RBAC, no SSO.** On the reject list. A named token
  is a label on a credential, not an identity system: there is no user record, no group, no
  per-resource permission. Scopes stay exactly slot 5's two.
- **Reuse A2A's mechanism; keep the namespaces separate.** Do not authenticate `/mcp` through the
  A2A registry. Both paths write the same `caller_id` field, and `surface` disambiguates.
- **Tokens are never logged, never echoed on health, and never in the manifest.** Only the
  `caller_id` travels.
- **Rotation is per caller**, which is the entire point: revoking `ci-github` must not lock out the
  console.
- **Backfill `caller_id` as NULL and treat NULL as "unattributed."** Do not invent a retroactive
  caller for existing rows.

#### 7b. Post-mortem debugging

**Today.** Live feedback is already good — `tail_stage_log` handles byte offsets and truncation
(`src/mcp/controlTools.ts:164-214`), `get_stage_verification` returns captured stdout and stderr.
The gap is *after* the run: locally the disk is still there; remotely slot 3's SLIM reclaims the
worktree on a schedule.

**Target — three things:**

1. **Change the default, not the mechanism.** Slot 3 ships per-status retention overrides. Set the
   shipped default so `failed` (and `cancelled`) runs keep their worktree and stage logs
   **materially longer** than `succeeded` ones — the plan's suggested SLIM default is 3 days; a
   failed run should be on the order of the PURGE window instead. This is a defaults change plus a
   paragraph in `docs/docker.md`, and it is the highest-value part of this item.
2. **`sf debug-run <id> [--out <file>]`**, producing **one attachable bundle**: item 6's run
   manifest, the run record and stage events, verification evidence (captured stdout/stderr per
   check), slot 2's `get_run_diff` output for the run's binding, the tail of each stage's stream
   log up to a byte cap, and the resolved host configuration in redacted form. One file, a bug
   report attaches it, and slot 6's redaction runs over the whole thing before it is written.
3. **Document `docker exec` into the worktree as the supported escape hatch** — the literal
   command, including how to find the worktree path (`get_run` reports it, slot 2). Leaving it
   undiscoverable is what makes users think the container is a black box.

**Design decisions already made:**

- **`sf debug-run` gets an API too** — it is the same argument as `export-run`: the person who needs
  the bundle is the remote one. `GET /api/runs/<id>/debug-bundle`, `read` scope.
- **The bundle is a superset of the export, not a different format.** Manifest first, then the
  `projectRun` projection, then evidence. A reader who can parse an export can parse the first half
  of a bundle.
- **Cap it.** Stream logs and diffs are unbounded; every section gets a byte cap with an explicit
  truncation marker, the same shape slot 8 uses for log lines.
- **Do not add a "keep this run forever" pin.** Retention overrides plus `sf debug-run` cover it,
  and a pin is a disk leak with a nice name.

**Files likely to touch.** `src/runstore/port.ts` and the sqlite store (`caller_id`, the filter),
slot 1's migration ledger, slot 5's token resolver, `src/runtime/runManager.ts` (quota check next
to `tryReserve`, `:1710-1730`), `src/mcp/catalogTools.ts` (`list_runs` filter),
`src/server/http.ts`, slot 4's logger (audit records), slot 3's retention defaults, new
`src/cli/debugRunCommand.ts` + `src/cli.ts` (command list `:129-144`, dispatch near `:371`),
`docs/docker.md`, `docs/cli-reference.md`, `docs/mcp.md`.

---

## Explicitly rejected

Restated from 13.7 with the reason attached, so none of it gets relitigated mid-slot.

| Rejected | Reason |
|---|---|
| **A replay engine** | Item 6 records what ran, which is the value. Byte-identical replay additionally requires pinning model non-determinism, network responses, and third-party MCP behaviour — none of which the image controls. Recording is honest; replay would be a promise we cannot keep. |
| **Per-stage CPU and memory limits inside Stageflow** | The operator's job, via `docker run --cpus --memory`. Enforcing them inside Stageflow means cgroup manipulation or nested containers, which needs privileges the docs tell users never to grant. Stageflow owns **time, disk, and tokens**; the operator owns CPU and memory. |
| **Per-stage container sandboxing or docker-in-docker** | Same privilege problem, larger. The Docker socket is never mounted — that is a host root escape, and it is stated in slot 8's threat model. |
| **User accounts, RBAC, or SSO** | Item 7a gets most of the value — attribution, quotas, per-caller rotation — for a fraction of the surface. An identity system is a product, not a slot. |
| **Stageflow building derived images from `requires:`** | Declare and check; document the `FROM stageflow:x.y.z` + `apt-get install` pattern and let `requires:` be what tells a user they need one. Becoming a build tool means owning base image selection, layer caching, and a registry story. |
| **A web terminal or an `exec` tool over MCP** | A remote shell behind one bearer token, on an endpoint that is already one mistake away from unauthenticated RCE. `docker exec` is the right tool and it is already in the operator's hands. |
| **Mounting the user's dotfiles or ssh-agent** | Reproducibility is what the container buys. Importing ambient laptop state trades it away and reintroduces exactly the "works on my machine" class slot 6 spent its budget eliminating. |
| **A2A hot reload** | Publications are read once at boot deliberately. A config surface that mutates under a running server turns "which revision answered this call" into a guess — and A2A already fingerprints publication revisions for precisely that reason. Item 4 files the A2A CLI as `docker exec`-only on the back of this. |
| **OpenTelemetry tracing and a collector dependency** | A second daemon and a vendor decision imposed on every self-hoster. The at-most concession, out of scope for this slot, is one opt-in Prometheus text endpoint behind the control token with a deliberately small metric set and labels bounded to project and stage id — **never run id**. |
| **gVisor, microVMs, or userns-remap** | Infrastructure choices that belong to the operator's platform, not to the application. |

---

## Acceptance criteria

**`start_run` parity (item 1)**

1. MCP `start_run` accepts `checkout`, `skip_gates`, `git_sha`, `ci_pr_url`, `ci_job_url`, and
   slot 2's `repository` / `ref`, and each reaches the run record with the same effect as the
   equivalent REST field.
2. `repository` together with `checkout` is rejected on MCP, REST, and the CLI with the **same**
   named error code.
3. An absolute host path in `checkout` from a remote caller is rejected with slot 7's
   path-contract error, not `ENOENT`.
4. The MCP tool description lists every accepted parameter.

**Inline rerun (item 2)**

5. A run started from an inline pipeline over MCP can be `rerun`, producing a second run that
   executes the same stages, and the 400 at `src/runtime/runManager.ts:689-695` is no longer
   reachable for it.
6. `rerun` of a path-based run behaves exactly as before, including `project_root` handling.
7. A run row written before this slot, with neither a path nor a body, still fails `rerun` with a
   clear error naming the reason.
8. `sf export-run` on an inline run emits `pipeline_source: "inline"` with a populated body, in
   slot 8's envelope shape, unchanged.
9. An inline pipeline over the size cap fails the start with `inline_pipeline_too_large` and
   creates no Run.

**Run-scoped skills (item 3)**

10. `start_run.skills` materialises under `$STAGEFLOW_HOME/runs/<runId>/skills/<name>/` and
    **nowhere else**; after a run with a repository binding, `git status` in the worktree is clean.
11. A stage `skill: <name>` present only in the run payload resolves; one present in neither the
    payload nor on disk fails **before** the agent session starts.
12. Precedence holds: the same name in the run payload, the checkout's `.pi/skills`, and the host
    skills resolves to the run payload, and the run records origin `run`.
13. Two stages naming the same skill share one materialised directory.
14. A skill entry with an absolute path, a `..` segment, or no `SKILL.md` is rejected at start with
    a named error and no Run is created.
15. `list_skills` over MCP reports name, description, and origin, and with a `runId` reports what
    that run resolved.
16. Slot 3's `delete_run` and GC remove the run's skills directory.

**Documented gaps (item 4)**

17. `docs/mcp.md` contains the capability table with a decision and a reason for `sf graph`,
    `sf migrate-yaml`, `sf skills install`, `sf a2a *`, and both provider-login flows.
18. `docs/docker.md` contains the literal `docker exec` command for each one.

**Toolchain and preflight (item 5)**

19. `requires:` parses at pipeline root and on a stage body; an unknown sub-key fails load with a
    named code; `sf validate` reports it; `docs/yaml-catalog.md` lists the key.
20. `sf doctor --pipeline <path>` exits non-zero and names the tool when a requirement is unmet,
    and exits zero when all are met.
21. MCP `preflight` returns `missing_tool` for an absent tool and `tool_version_mismatch` for a
    present-but-old one, for both a path pipeline and an inline one, **without creating a Run**.
22. `start_run` on a pipeline with an unmet requirement fails before creating a Run, with the same
    code `preflight` returned.
23. A tool whose `--version` cannot be parsed yields `unknown_version`, passes by default, and fails
    under `sf doctor --strict`.
24. Stage-level and pipeline-level requirements for the same tool resolve to the stricter range,
    and that is the range recorded on the run.
25. Resolved tool versions appear in the run manifest.

**Run manifest (item 6)**

26. `get_run` exposes a `run_manifest` for a run that is still `running`, populated with everything
    known at that point.
27. The manifest carries: build SHA and image digest, the repository/ref/resolved_sha triple (or
    the checkout/unbound equivalent), pipeline and task **bytes** with digests, skill names with
    content digests and origins, the **resolved** model per stage, toolchain versions, and the
    resolved MCP server set.
28. A secret interpolated into a `.mcp.json` entry appears in the manifest as redacted, both on
    `get_run` and in the export — and the stored blob itself contains no secret value.
29. `sf export-run` succeeds against a `running` run, and the payload contains the manifest.
30. `GET /api/runs/<id>/export` and MCP `export_run` refuse without a token and otherwise produce
    the same payload as the CLI for the same run.

**Attribution, quotas, and post-mortem (item 7)**

31. Two named tokens produce two `caller_id` values on the runs they start; the unnamed
    `STAGEFLOW_CONTROL_TOKEN` produces `default`; an invalid token is rejected in constant time.
32. `list_runs` filters by `caller_id` over MCP and REST.
33. A caller at its quota queues rather than failing, with a distinct reason from `busy_capacity`,
    while another caller under quota starts immediately.
34. Every mutating call emits one audit record with `caller_id`, surface, target, and outcome; no
    audit record contains a token.
35. A failed run's worktree survives past the SLIM window that reclaims a succeeded run's, by
    default and without configuration.
36. `sf debug-run <id>` produces one file containing the manifest, stage events, verification
    evidence, and a diff, with every section capped and truncation marked; the API equivalent
    returns the same bundle.
37. `docs/docker.md` documents `docker exec` into a run's worktree, including how to obtain the
    path.

---

## Testing

### Automated — repo convention

Tests live in `tests/*.test.ts` (Vitest), one file per surface, named after the thing under test.
Fixtures live in `tests/fixtures/pipelines/`, `stages/`, and `tasks/`, and **the repo convention is
to extend fixtures rather than inline YAML when behaviour is catalog-driven** (`AGENTS.md`).
`tests/cli.exportRun.test.ts` is the closest existing model for the CLI additions.

| File | Covers |
|---|---|
| `tests/mcp.startRun.test.ts` | the new parameters reaching `RunManager`, the `repository`/`checkout` XOR error, the absolute-path rejection |
| `tests/runManager.rerunInline.test.ts` | inline persistence, inline rerun, path rerun unchanged, the legacy-row error, the size cap |
| `tests/runSkills.test.ts` | materialisation path, traversal and absolute-path rejection, missing `SKILL.md`, shared copy across stages, cleanup on GC |
| `tests/config.skillPrecedence.test.ts` | run > checkout > host, and the recorded origin |
| `tests/mcp.listSkills.test.ts` | the tool's shape, origin reporting, the `runId` variant |
| `tests/config.requires.test.ts` | parsing at both levels, unknown sub-keys, `sf validate` findings, range intersection |
| `tests/preflight.toolchain.test.ts` | `missing_tool`, `tool_version_mismatch`, `unknown_version`, against an **injected** manifest — do not depend on what happens to be installed on the test machine |
| `tests/mcp.preflight.test.ts` | the tool for path and inline pipelines; no Run created |
| `tests/runstore.runManifest.test.ts` | written at start, finalised at terminal, resolved model recorded, redaction of interpolated MCP env |
| `tests/cli.exportRun.test.ts` (extend) | non-terminal export, manifest in the payload |
| `tests/server.callerTokens.test.ts` | named-token resolution, constant-time rejection, `caller_id` on the run, the `list_runs` filter |
| `tests/runManager.callerQuota.test.ts` | quota queuing, the distinct reason, isolation between callers |
| `tests/cli.debugRun.test.ts` | bundle contents, caps and truncation markers, redaction |

**New fixtures.** A pipeline fixture with a `requires:` block at both levels, and a task fixture
pairing with it. Keep `examples/` in sync if a behaviour users can see changes (`AGENTS.md`).

Run `npm test`, `npm run ui:test`, and `npm run typecheck` before finishing.

### Manual — what the automated tests cannot reach

1. **The parity claim, end to end.** From a real harness against a running container: `preflight`,
   `start_run` with an inline pipeline, inline task, `skills`, `repository`/`ref`, and `skip_gates`
   — then `tail_stage_log`, `answer_gate`, `get_run` for the manifest, `rerun`, and `export_run`.
   No `docker exec` at any point. If any step needs one, the slot is not done.
2. **The skill does not dirty the PR.** Run a repository-bound pipeline with a run-scoped skill and
   confirm the branch contains only the stage's intended changes.
3. **A derived image.** `FROM stageflow:x.y.z` plus `apt-get install` of a tool named in
   `requires:`; confirm `preflight` flips from `missing_tool` to `ok` with no manifest
   regeneration.
4. **Two callers.** Two named tokens, a quota of one each, four concurrent starts; confirm the
   queue behaviour, the `list_runs` filter, and the audit lines in `docker logs`.
5. **Post-mortem after GC.** Let a failed run pass the succeeded-run SLIM window, then run
   `sf debug-run` and confirm the diff and worktree evidence are still there.
6. **Redaction, adversarially.** A stage `.mcp.json` entry interpolating a real token; grep the
   stored manifest blob, the `get_run` response, the export, and the debug bundle for the value.

---

## Repo conventions

- **Read `AGENTS.md` first.** Minimal focused diffs; match the patterns in the area you touch; **no
  comments unless the logic is non-obvious**; never commit secrets.
- **`--json` output and exit codes are a public contract** (`docs/ci.md`, `tests/cli.*.test.ts`).
  New commands choose exit codes deliberately and coordinate with slot 4's exit-code table.
- **CLI command shape.** Register in the command list at `src/cli.ts:129-144` and dispatch near
  `:371`, implementation in `src/cli/<name>Command.ts` with a hand-rolled arg loop and a `*_USAGE`
  constant — `src/cli/exportRunCommand.ts:9-71` is the model. Inject IO through an `Io`-style
  object with a `defaultIo` so tests can capture output.
- **MCP tool shape.** `server.registerTool(name, { description, inputSchema }, handler)` with
  `textResult(payload, isError?)` from `src/mcp/toolResults.ts`. Descriptions are the harness's only
  runtime documentation — write them for a stranger's agent, and keep them short, because every one
  of them is in every request's context.
- **YAML vs IR.** Author new catalog contracts in target YAML names and map them in
  `compileTargetContract` (`src/config/yamlDialect.ts`); runtime types and snapshots keep the IR
  names. `requires:` is a new target-YAML key and must appear in `docs/yaml-catalog.md`'s key
  tables, or the loader rejects it.
- **Path containment.** Reuse the existing shape — `..`-rejection plus `realpath` containment —
  from `src/mcp/readArtifact.ts:72-93` and `src/cli/exportRunCommand.ts:93-106`. The skills
  materialiser and the debug bundle both need it; do not write a third one.
- **Store access.** Go through the `RunStore` port (`src/runstore/port.ts`). New columns are
  forward migrations in slot 1's ledger, **never** another `PRAGMA table_info` probe.
- **Env var naming.** `STAGEFLOW_*`, with `*_FILE` variants for anything secret-bearing.
- **Positioning.** User-facing copy leads with configurable stages and pipelines; SDLC is one
  example among others.
- **Do not commit.** Leave the work staged for review.

---

## Open questions for the human

1. **Named-token configuration shape.** This brief proposes
   `STAGEFLOW_CONTROL_TOKEN_<NAME>` env vars, because it needs no file and works in compose,
   swarm, and Kubernetes. The alternative is a `callers:` block in slot 7's host config file, which
   matches `a2a.yaml` and supports per-caller quotas declaratively — at the cost of a second config
   surface for secrets. Env vars, file, or both?
2. **Where the per-caller quota is configured.** If named tokens stay env-only, the quota needs
   somewhere to live: `STAGEFLOW_CALLER_QUOTA_<NAME>`, a single global default, or the config file.
   Related to question 1 and probably decided with it.
3. **The failed-run retention default, in days.** Item 7b says "materially longer" and suggests the
   PURGE window. A concrete pair — succeeded SLIM at 3 days, failed SLIM at 30 — is a real disk
   commitment on a small VPS. Confirm the numbers, or make failed-run SLIM a documented
   first-run prompt rather than a silent default.
4. **Does `requires:` belong on the task as well as the pipeline and stage?** A task is where a
   caller says what they want done, and "this task needs `terraform`" is arguably task-shaped. This
   brief kept it to pipeline and stage because that is what 13.2 specified and because the pipeline
   is what owns execution. Confirm, or widen it now rather than later.
5. **Should `preflight` also check declared `secrets:` and stage `mcp` servers?** It already has to
   resolve the stage MCP set for the manifest, and "the `github` server's `${GITHUB_TOKEN}` is
   unresolved" is the same class of before-you-start failure as a missing binary. Cheap to add,
   and it widens the tool's contract. In or out?
6. **Inline pipeline body retention.** The body is stored with the run and follows the run's
   retention. For a harness that sends a large inline pipeline on every CI run, that is real
   storage. Keep the body through PURGE, or drop the body at SLIM and keep only the digest —
   accepting that rerun stops working on a slimmed run?
7. **`caller_id` for CLI-originated runs.** A `docker exec … sf run` has no token. This brief
   records surface `cli` with a null caller. Should the CLI adopt a configurable identity so an
   operator's manual runs are attributable too, or is "unattributed, surface `cli`" the honest
   answer?
8. **Manifest versioning policy.** `manifest_version: 1` is in the sketch, but nothing says what
   happens at `2`. Do old manifests get migrated, or does a reader branch on the version? Decide
   before the first manifest is written, because both answers are cheap now and one is expensive
   later.
