# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING:** Pipeline-owned catalog replaces legacy `pipelines/` + `stages/` + cwd layout. Stages are object entries with `uses:` or inline bodies; filenames use `*.pipeline.yaml` / `*.task.yaml`.
- **BREAKING:** `--pipeline` requires a filesystem path (no bare pipeline id).
- **BREAKING:** MCP `start_run` requires a pipeline path.
- Added: repo-root `stageflow.yaml` manifest, `sf init`, git-root `.stageflow` store, global auth under `~/.stageflow` by default.
- Migrated repo fixtures, examples, docs, and CI workflows to pipeline-owned paths.

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

[Unreleased]: https://github.com/tejasghutukade/stageflow/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tejasghutukade/stageflow/compare/a30b7b4...v0.2.0
[0.1.0]: https://github.com/tejasghutukade/stageflow/commit/a30b7b4
