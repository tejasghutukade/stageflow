# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/tejasghutukade/stageflow/compare/v0.13.0...HEAD
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
