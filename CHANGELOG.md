# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.26.0] - 2026-09-24

### Added

- Host-global project registry under `$STAGEFLOW_HOME`: durable `ensure` of absolute project roots; `sf run` ensure-then-starts before `start_run`; remotes may only use registered ∪ seeded catalog roots (no invent of unknown absolute `project_root`; Host boot cwd is not a catalog root). See `docs/mcp.md`, `docs/cli-reference.md`, `docs/data-directory.md`.
- Curated stage environment (Slot 6): stages no longer inherit Host ambient env; declare `secrets:`; file-backed git askpass; value redaction; proxy/CA passthrough; shared `$STAGEFLOW_HOME/cache`; MCP connect default 30s; finite stage-process/heap caps; Claude-as-root refusal. See `docs/migration-stage-environment.md`.

### Changed

- Catalog start/write path selection is shared (`resolveCatalogStartInput` / `resolveWritableCatalogRoot`); MCP `run_stage` and A2A string stage paths honor the same catalog containment as `start_run`.
- Operator-terminal run statuses (`cancelled` / `queued`) are preserved inside `deriveStatusFromStages` so recovery and projection cannot overwrite them.
- Host shutdown drains through a required `DrainableHost` adapter (single drain path).
- Stage worker builds / preserves curated env explicitly (forked workers keep launcher-granted secrets; in-process path filters via `buildStageEnvironment`).
- Path-checkout lease (`busy_checkout`) applies only to path-bound runs. Repository-bound runs each get their own worktree and may run in parallel on the same repository; attach/resume no longer re-lease worktree paths.
- `verify` commands run under `bash -c` (not `/bin/sh`).
- Stage MCP `${VAR}` interpolation resolves against the curated stage env only.

### Removed

- Dead `RunStore.listProjectRoots` (superseded by `listRegisteredProjects`) and unused `isMutatingApi` predicate (superseded by `requiredScopeFor`).

## [0.25.0] - 2026-09-21

### Added

- `run_stage`: run a single stage directly, without authoring a pipeline — a catalog stage path or a bare inline stage body, exactly one of `task_path`/`task`/`envelope_ref` for input, optional `blocking`/`timeout_ms` for a single-round-trip result instead of poll, and a per-call `model` override. Internally synthesizes a one-stage pipeline and runs it through the exact same path `start_run` uses, so it gets the same persistence, `verify`/retry, and HITL behavior and is pollable with `wait_run`/`get_envelope` like any other run. Exposed identically as an MCP tool, a new `sf run-stage` CLI command (distinct from the existing internal-only `sf internal run-stage`), and a new A2A operation. See `docs/mcp.md#run_stage`, `docs/cli-reference.md#sf-run-stage`, `docs/a2a.md`.
- `envelope_ref`: chain a `run_stage` call off a previously stored `StageEnvelope` — from another `run_stage` call or from any stage inside a full pipeline run — instead of an inline task. Accepts either one reference or an array of them; multiple references are resolved and namespaced under their `stageId` in the next call's `input` (disambiguated by `runId` on a `stageId` collision), with summaries combined into `goal`.
- A2A's `run_stage` operation deliberately bypasses `a2a.yaml`'s `publications`/`allowed_callers` allowlist — any authenticated caller can run any catalog or inline stage/pipeline through it, the same wildcard-access default the MCP tool and CLI give a local harness. A temporary trade-off for proving out standalone stage execution, not a hardened access-control surface; existing `invoke`/`answer` and their allowlist enforcement are unchanged.

## [0.24.0] - 2026-09-20

### Added

- Inbound A2A: publish explicit pipelines as A2A capabilities that other agents invoke over JSON-RPC. Discovery via Agent Card and per-publication contracts, durable at-most-once run submission, invoke/poll/results, caller-answerable clarification gates, result freezing with opaque artifact downloads, per-caller rate limits and admission caps, and terminal-task/message retention. See `docs/a2a.md`.
- `a2a.yaml` is auto-discovered at the project root (next to `stageflow.yaml`) when `sf ui` starts -- no environment variable required. `STAGEFLOW_A2A_CONFIG` still works as an explicit override for a config living outside the project. `sf a2a validate`/`sf a2a list` follow the same discovery rule, with `--config` now optional on both.
- New `sf a2a add-caller <id>` command: generates a caller's token and writes its `id`/`token_env` name into `a2a.yaml` (scaffolding the file if it doesn't exist yet), printing the token to export -- never writes a secret value to disk.

## [0.23.0] - 2026-09-15

### Added

- Live output streaming for a running stage: assistant text is now captured as it streams, batched every ~300ms, redacted for secret-shaped substrings, and persisted to a small size-capped `stream.log` per stage attempt. New poll-based MCP tool `tail_stage_log` (`{ runId, stageId, attempt?, since_offset? }` → `{ text, next_offset, attempt_complete, truncated?, earliest_offset? }`) lets any watcher (the console, a host integration) follow along with a byte-offset cursor. Always on, no pipeline flag; purely additive — `log.jsonl`, `list_stage_events`, and `resources/subscribe` are unchanged.

## [0.22.0] - 2026-09-15

### Added

- `start_run`'s `pipeline` field now also accepts an inline pipeline definition object (`{ id, stages: [...] }`), not just a filesystem path — validated and executed through the exact same path a file-based pipeline uses, so a host integration can delegate a well-defined, typed task without first writing and saving a YAML file. No new tool, no stage-count limit, no special-cased single-stage mode. A run started this way has no `pipeline_path` and can't be `rerun` — save it to a file if you want that.

### Fixed

- MCP `start_run` now returns a structured `{ error, validation }` body on a pipeline validation failure, matching `POST /api/runs`, instead of an uncaught bare-string error

## [0.21.0] - 2026-09-15

### Added

- `get_health`'s MCP response now includes a `version` field, so a host integration can detect a behavior change that doesn't add or remove a whole tool
- New lightweight `get_waiting_summary` MCP tool — a cheap count/identity list of waiting stages (no prompt bodies, artifacts, or questions) for status-bar badges, scoped by optional `runId` or `path`, spanning every project by default
- MCP inspect parity with the operator console: read-only `list_providers`, `list_models`, `list_project_mcp`, and `probe_project_mcp` (no login, settings-write, or Stage MCP attach)
- `describe_pipeline` includes Clone Chain, feedback-loop, and inbound route `if`/`on` wiring so agents can inspect before `start_run`
- `read_artifact` returns PNG/JPEG/GIF/WebP as MCP image content blocks (text stays JSON; unknown binary still errors)
- Lean `get_run` / `wait_run` (and the run resource) pass through `total_cost_usd` and clone `definition_id` when present on the store
- `decide_feedback_loop` appends a durable `feedback_loop_decided` stage event with optional `reason` before succeeded/failed
- Optional `attempt` on `get_envelope` to read a prior execution's stored envelope (omit = latest)
- `examples/mcp-hitl-tour` walkthrough for MCP-first HITL (`answer_gate`) and feedback-loop decide

### Fixed

- Feedback-loop `wait_for_human` source passes persist as `waiting`, then `succeeded`/`failed` on continue/abandon, so `get_run` no longer leaves the pass `running`

## [0.20.0] - 2026-09-15

### Added

- Stageflow now runs as a single global, auto-starting service instead of one process per project — `sf run`/`sf runs *` talk to it over HTTP, and it starts itself on first use, so opening a second project or git worktree no longer collides on port binding

### Changed

- Run data lives in one shared `~/.stageflow` store instead of per-project `.stageflow/` directories — a run started from any project shows up in `sf runs list` from any other project too
- `maxConcurrent` is a global setting for the whole service, not per-project
- `--operator-cwd`/`--operator-agent-dir` on `sf run` no longer have any effect, since the shared service's operator catalog is fixed once at its own startup; set `STAGEFLOW_OPERATOR_CWD`/`STAGEFLOW_OPERATOR_AGENT_DIR` before the service first starts instead

## [0.19.0] - 2026-09-14

### Added

- Resume a timed-out failed stage on the same attempt from the CLI, MCP, and operator console
- Collapsible feedback-loop banner on the run map; collapsed by default except when waiting for a human decision

### Fixed

- Feedback-loop remints keep Join and scheduling on the active clone cohort and skip superseded instances
- Stringified JSON objects in `emit_stage_envelope` and `ask_operator` arguments are coerced before schema validation
- Operator console hides superseded Clone Chain instances from the spatial map

## [0.18.0] - 2026-09-12

### Added

- Clone Chains: a sealed emitter → clone child → Join path. N is the length of one named-`$ref` Clone Array; `clone_cap` and `clone_mode` sit on the emitter's pipeline entry; each Clone Instance receives that array element only
- Deterministic `if` on forward Route entries, and `type: loop` Route entries as current loop authoring

### Changed

- Pipeline wiring is `route` / `entry` only. Listed Route targets always run (no agent `fork_choice` pick list)

### Removed

- `clonable`, envelope `clone_forks`, and skip / once / fanout as current cloning
- `needs`, `fork`, and `feedback_loop` as current pipeline-stage fields

## [0.17.0] - 2026-09-10

### Added

- GitHub-Actions-style log panel on the run detail page, alongside the existing conversational transcript: every tool call, message, and lifecycle event renders as a collapsible step with a status indicator, human-readable label (e.g. `Read app.ts`, `Bash npm test`), duration, and a one-line preview of its result
- The step responsible for a stage failure auto-expands, with a pinned banner linking straight to it
- Either side of the transcript/logs split can be hidden independently; logs are shown by default
- `npm run dev:watch` — a live-reload local dev loop for the backend (paired with the existing `npm run ui:dev` for the frontend), so UI/backend changes no longer require a manual build + restart cycle

## [0.16.0] - 2026-09-10

### Added

- Per-stage and per-run LLM cost/token tracking, sourced from the Claude Agent SDK's and pi-ai's own per-turn accounting — no separate pricing table
- `stage_executions.cost_usd` / `usage_json`, summed across attempts into `StageSnapshot.cost_usd` and across stages into `RunSummary.total_cost_usd`
- `sf run` prints a `Cost:` line in human output and `total_cost_usd` in `--json`
- Cost badges in the UI on the runs list, run detail header, and each stage

### Fixed

- `claudeAdapter`: the interrupt-on-tool-result path could break out of the turn before the SDK's cost-bearing `result` message arrived, silently losing usage data on every successful Claude-backed stage

## [0.15.0] - 2026-09-10

### Added

- Target catalog dialect: `io`, `verify`, and `on_verify_fail` on pipelines and stages
- Dual-read of legacy `payload_schema`, `pre_emit_checks`, `completion`, and `recovery` onto the same IR
- `sf migrate-yaml` to rewrite a catalog onto the target spelling
- Optional task `input` checked against entry `io.input`
- Pipeline-root `schemas:` for `$ref`, with sequential `io` subset checks at load
- `sf run --json` optional `findings` (including `pipeline.model_applies` and `task.entry_input_unmet`)

### Changed

- Public docs and author skills teach `io` / `verify` / `on_verify_fail`; first-party examples convert to the target dialect

## [0.14.0] - 2026-09-09

### Added

- Optional `model` defaults on `stageflow.yaml` and `*.pipeline.yaml`; stages may omit `model` when a higher tier fills it
- Resolution at pipeline load: `stage.model ?? pipeline.model ?? stageflow.yaml model`, failing with `stage.missing_model` when unset (no silent hardcoded model)
- `LoadedStageConfig` / `materializeStageModels` so loaded stages carry a required effective model
- Operator console New Stage: inherit default model; blank custom “Other” is rejected
- Fixtures under `tests/fixtures/model-hierarchy/` and docs for model defaults vs `agent` backend selection

### Changed

- Invalid present `stageflow.yaml` fails pipeline load with catalog/manifest errors instead of being skipped as “no global model”
- Create stage/pipeline APIs reject empty/whitespace `model` instead of coercing to inherit

## [0.13.0] - 2026-09-09

### Added

- Stage `mcp:` allowlists from project `.mcp.json`, resolved and interpolated before the agent session opens
- Isolated Pi/Claude MCP attach so a stage only receives the servers it names; host MCP files stay out of the session
- Operator console Settings: list project MCP servers and Check connect without opening a stage
- `STAGEFLOW_STAGE_ARTIFACTS_DIR` stamped into MCP args and stage `system_prompt` so MCP tools can write into the attempt artifacts directory
- Image run artifacts (PNG/JPEG/GIF/WebP) served with the matching content type and rendered in the Files pane
- Walkthroughs: `examples/stage-mcp/`, `examples/playwright-mcp/`, and `examples/context7-mcp/`

### Fixed

- Settings Check uses eager MCP lifecycle so a cached Pi MCP metadata file is not treated as a live connect

## [0.12.1] - 2026-09-08

### Changed

- Harness `stageflow-author` documents run-derived anti-patterns as Always-do contracts (emit, artifacts, checkout writers, review remediation, completion wiring)
- `stage-prompt-template` and `catalog-mapping` harden prompts and DAG shape for those contracts; `stageflow-session-capture` catalog authoring matches the same emit/artifact/summary rules

## [0.12.0] - 2026-09-07

### Added

- `payload_schema` / `clone_input_schema` string constraints: `pattern` (JS RegExp, unicode), `minLength`, and `maxLength`
- `nullable: true` on nested schema nodes (compiles to a union with `null`; root object cannot be nullable)

### Changed

- Keywords `pattern`, `minLength`, `maxLength`, and `nullable` that were previously ignored are now enforced at compile/runtime

## [0.11.0] - 2026-09-07

### Added

- Generic multi-parent fan-in: a stage may `needs` two or more catalog parents; the join receives `priorEnvelopesByStage` keyed in YAML declaration order
- Structured `needs` items `{ id, on }` so a join can accept `succeeded`, `failed`, or `skipped` per parent without failing the run
- `examples/generic-fan-in/` walkthrough for the diamond join and the accepted-failure variant

## [0.10.0] - 2026-09-07

### Added

- Claude Agent SDK backend as an alternative to Pi for stage execution, selected via `agent: claude` in `stageflow.yml` at global, pipeline, or gated stage scope
- HITL parity for the Claude backend: non-blocking `ask_operator` handling with session-marker-based resume, matching Pi's wait/answer lifecycle
- Parameterized `AgentPort` contract tests covering both backends

## [0.9.0] - 2026-09-02

### Added

- `sf --version` / `sf -V` print the package version without opening a catalog or run store
- `sf runs` host-down operator verbs: `list`, `show`, `waiting`, `wait`, `answer`, `retry`, `abandon`, `rerun`

### Changed

- Harness `stageflow-run` answers HITL on a down host with `sf runs waiting` / `answer` / `wait` instead of starting a disposable `sf mcp --mcp-stateless` bridge
- Harness `stageflow-run` presents mappable HITL gates on the host native question UI when one exists, and still submits through `answer_gate`. A representable `multi_question` is one picker call, not sequential cards.
- Public docs catch up to the 0.8 console (spatial map, gated workspace, stage deep links), full-catalog task validation, MCP via `sf mcp`, and YAML wiring vs body / clone-join contracts

### Fixed

- GitHub Release notes include every CHANGELOG version since the last published GitHub Release, not only the latest package.json bump
- Manual **Repair GitHub Release notes** workflow rewrites published GitHub Release notes from CHANGELOG when a version gap was missed

## [0.8.0] - 2026-09-01

### Added

- Spatial map-first run detail page: zoomable stage graph, gated workspace (logs / files / envelopes / HITL), and stage deep links (`#/runs/:id/stages/:stageId`)

### Changed

- Runs and Pipelines list rows stack identity above a full-width mini track so catalog paths stay readable
- Created runs show `not started` (still gray status) and a `Start run` primary action until history exists

### Fixed

- Run-page polish: workspace header wrap, single envelope/artifact chrome, camera refit when the workspace opens, readable node Retry/Abandon icons, focus rings, clone-aware aside labels, and quieter failure/turn transcript dividers

## [0.7.0] - 2026-09-01

### Changed

- **BREAKING:** Parallel clone join requires every clone to succeed. A clone failure skips the join and its descendants; sibling clones still run. Sequential fail-fast is unchanged.

### Fixed

- Cursor provider resolution prefers `pi-cursor-sdk` `dist/index.js` (0.3+) over `src/index.ts`, so parallel Cursor stages load the isolated per-session store.

## [0.6.0] - 2026-08-31

### Added

- Rich MCP operator surface: `validate`, `describe_pipeline`, `list_waiting`, `retry_stage`, `abandon_stage`, `rerun`, plus catalog/control parity with the console
- `wait_run` long-poll for agent observation (`until=any|waiting|terminal`) with progress notifications
- Session-backed MCP by default, `stageflow://runs/{runId}` resources, and `sf mcp` standalone host
- Shared `createHttpHost` for `sf ui` and `sf mcp` (`/mcp`, `requestTimeout=0`, Origin checks)

### Changed

- **BREAKING (MCP):** sessions are the default transport mode (`--mcp-stateless` / `STAGEFLOW_MCP_STATELESS=1` for opt-out)
- **BREAKING (MCP):** `list_pipelines` / `list_tasks` return `{path,id}` objects instead of path strings (greenfield; no prior MCP clients)

## [0.5.0] - 2026-08-28

### Added

- Clonable successors: pipeline `clonable` / `clone_cap` and envelope `clone_forks` (`skip` | `once` | `fanout`) so a completing stage can clone one successor N times, then join
- Parallel clone join receives every clone envelope (including failures); sequential clones fail-fast
- Fan-out instance ids (`{catalogId}~{n}`) in the run store, CLI `--stage`, console, and MCP
- Operator console clone tracks and HITL on a selected clone instance
- `examples/clonable-fanout/` walkthrough (skip / once / parallel / sequential / mix)

## [0.4.0] - 2026-08-27

### Added

- CI headless run access: `sf run --json --include stages`, `sf envelope get` (`envelope` / `handoff` formats), `sf export-run`, `sf artifact read`
- `sf skills list` / `sf skills install` (`--from-path`, `--from-zip`) for provisioning Pi skills in CI
- Pipeline stage entry `skill:` binding (resolved at stage start; missing skill fails the stage)
- `.github/actions/sf-run` composite for run + optional handoff extraction + export
- `examples/archify-on-pr/` — PR diagram automation dogfood (conditional fork, Archify skill, GHA deliver)
- `scripts/prepare-ci-context.sh` and `scripts/deliver-diagrams.sh` for deterministic CI context and Archify deliver
- Fork-skipped stages persist as `skipped` in the run store and appear correctly in CLI/MCP projections

### Fixed

- Architecture deliver no longer pins evidence to the ephemeral `pull_request` merge commit (`GITHUB_SHA`); uses PR head SHA via `ci-context.json`

## [0.3.0] - 2026-08-26

### Added

- Conditional stage routing: pipeline `fork` field (`select: one | subset`, optional `allow_none`) and envelope `fork_choice`; unchosen branches and descendants are `skipped`
- Repo-root `stageflow.yaml` manifest and `sf init` scaffold
- Git-root `.stageflow` run store; global auth under `~/.stageflow` by default

### Changed

- **BREAKING:** Pipeline-owned catalog replaces legacy `pipelines/` + `stages/` + cwd layout. Stages are object entries with `uses:` or inline bodies; filenames use `*.pipeline.yaml` / `*.task.yaml`.
- **BREAKING:** `--pipeline` requires a filesystem path (no bare pipeline id).
- **BREAKING:** MCP `start_run` requires a pipeline path.
- **BREAKING:** MCP `list_pipelines` and `list_tasks` return manifest filesystem paths, not bare ids.
- Migrated repo fixtures, examples, docs, and CI workflows to pipeline-owned paths.

See `docs/yaml-catalog.md` and `docs/quickstart.md` for the pipeline-owned authoring model.

## [0.2.0] - 2026-08-25

### Added

- Headless CI guest contract: `sf run --json` with exit codes `0` / `1` / `2`
- `--skip-gates` flag to fail HITL stages instead of parking
- Optional CI identity stamped on run creation
- Unified guest module for run start and completion reporting
- GitHub Release pipeline dogfooding via Stageflow stages

### Changed

- HITL park reports `waiting` outcome (exit `2`) instead of success
- Busy start remapped to exit `1`

### Fixed

- `sf` bin resolves main correctly when installed as a symlink

## [0.1.0] - 2026-08-24

### Added

- Initial public release: YAML catalog (pipelines, stages, tasks)
- Pi-native stage worker with fresh session per stage
- Typed envelope handoffs and stage artifacts
- Operator console (`sf ui`) with HITL gate replies
- MCP Streamable HTTP endpoint at `/mcp`
- SQLite run store under `.stageflow/`
- `sf validate`, `sf providers`, parallel pipeline DAG support

[Unreleased]: https://github.com/tejasghutukade/stageflow/compare/v0.19.0...HEAD
[0.19.0]: https://github.com/tejasghutukade/stageflow/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/tejasghutukade/stageflow/compare/v0.17.0...v0.18.0
[0.15.0]: https://github.com/tejasghutukade/stageflow/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/tejasghutukade/stageflow/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/tejasghutukade/stageflow/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/tejasghutukade/stageflow/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/tejasghutukade/stageflow/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/tejasghutukade/stageflow/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/tejasghutukade/stageflow/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/tejasghutukade/stageflow/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/tejasghutukade/stageflow/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/tejasghutukade/stageflow/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/tejasghutukade/stageflow/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/tejasghutukade/stageflow/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/tejasghutukade/stageflow/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tejasghutukade/stageflow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tejasghutukade/stageflow/compare/a30b7b4...v0.2.0
[0.1.0]: https://github.com/tejasghutukade/stageflow/commit/a30b7b4
