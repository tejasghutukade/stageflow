# 01: Catalog roots for evals and datasets

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** none

## Why this story exists

Evals and datasets are catalog files like pipelines, tasks and triggers (A2). They need manifest roots, filename patterns and scanning, with the same exclude behavior. Nothing else in the epic can find files until this exists.

## Read first

- [Epic](../../specs/evals.md): A2, P13.
- `src/config/loadStageflowManifest.ts` (how `triggers` and `patterns` are parsed), `src/types/stageflowManifest.ts`, `src/config/scanCatalogPaths.ts` (`CatalogPathKind`, `scanCatalogPaths`, `isExcluded`).
- Every place that treats trigger roots specially. Find them with `grep -rn "triggers" src/config src/server/http.ts src/cli/hostClient.ts` and `grep -rn "patterns\.trigger\|catalog\.triggers" src`. Mirror each one for evals and datasets where it is about *scanning or describing the manifest*; do not copy trigger-specific behavior (firing, adapters).
- Tests: `tests/config.loadStageflowManifest.test.ts`, `tests/config.scanCatalogPaths.test.ts`, `tests/packaging.manifest.test.ts`.

## Decisions already made (do not revisit)

- Manifest keys: `catalog.evals: string[]`, `catalog.datasets: string[]`, optional, repo-relative paths, validated exactly like `catalog.triggers`.
- Patterns: `catalog.patterns.eval` (string, default `*.eval.yaml`) and `catalog.patterns.dataset` (string **or** array of strings, default `["*.dataset.jsonl", "*.dataset.json", "*.dataset.csv"]`).
- **Defaults (P13):** when `catalog.evals` / `catalog.datasets` are absent, scan `evals/` and `datasets/` under the project root if the directory exists. Present keys replace the default. `exclude` applies to both.
- Pattern matching keeps the existing glob-to-regex behavior (`*` only). A dataset pattern array matches if any entry matches.

## What to build

1. Extend the manifest types and parser: new optional keys, new patterns, same error codes (`catalog.manifest_invalid`) and messages style as `triggers`. `LoadedManifest.patterns` gains `eval: string` and `dataset: string[]`.
2. Extend `CatalogPathKind` with `"eval"` and `"dataset"`, and `scanCatalogPaths` to return sorted absolute paths for them (defaults from P13 applied here, so every caller gets them).
3. Add `src/config/evalCatalog.ts` exporting `listEvalFiles(manifest)` and `listDatasetFiles(manifest)` returning `{ absPath, relPath }[]` (a thin layer over `scanCatalogPaths`; later stories add loading on top). `relPath` is relative to the project root with forward slashes.
4. Wherever the existing code lists the manifest's roots for display, validation, ensure-scan-root, multi-project catalogs, or the host catalog (found by the greps above), include evals and datasets the same way triggers are included. If a place is trigger-specific and you are unsure, leave it and list it under Open questions.
5. Add the roots to the repo's root `stageflow.yaml` (`evals: [examples/evals]`, `datasets: [examples/evals]`) and to `examples/stageflow.yaml` the same way `triggers` appear there, **only if** story 24 has created `examples/evals/` (if not yet, skip this step and note it for story 24).

## Acceptance

- [ ] A manifest with `catalog.evals`/`catalog.datasets` parses; invalid shapes produce `catalog.manifest_invalid` with a message naming the field.
- [ ] `catalog.patterns.dataset` accepts a string and an array; an array entry that is not a non-empty string is rejected.
- [ ] A manifest without the keys scans `evals/` and `datasets/` when they exist, and returns nothing (no error) when they do not.
- [ ] `exclude` removes matching eval and dataset files.
- [ ] `scanCatalogPaths` returns `.dataset.jsonl`, `.dataset.json` and `.dataset.csv` files and not other files; results are sorted.
- [ ] Existing manifest and scan tests still pass unchanged; new tests cover each bullet above.
- [ ] `npm test` and `npm run typecheck` pass.

## Out of scope

Reading file contents (stories 02, 03). UI. Any behavior for files outside the scan roots.

## Open questions

_(agent fills; stop and ask the owner)_
