# 02: Eval file loader and validator

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 01

## Why this story exists

Everything that touches an eval file (the API, the CLI, the form, the engine plan) needs one parser and one set of validation findings. This story builds them against the contract in [eval-file-schema.md](../../specs/evals-file-schema.md) and plugs them into `sf validate`.

## Read first

- [eval-file-schema.md](../../specs/evals-file-schema.md) (all of it) and the epic's A2, A7, P3, P6, P7.
- `src/config/loadTrigger.ts`, `src/config/loadStage.ts`, `src/config/loadOutcome.ts` (`LoadOutcome`, `LoadIssue`, `loadFailure`, `loadSuccess`), `src/config/readYamlObject.ts`, `src/config/yamlParsePosition.ts`: copy their patterns for YAML parsing, issue codes and positions.
- `src/config/validateCatalog.ts` (`ValidationFinding`, `ValidationResult`, `effectiveSeverity`, how trigger and stage files are validated and reported) and `src/cli/validateCommand.ts`, `src/cli/validateOutput.ts`.
- `src/config/loadPipeline.ts`, `src/config/resolvePipelineDag.ts`, `src/config/materializeStageModels.ts`, `src/config/resolveModel.ts`: how a pipeline's stage is loaded and its model resolved.
- `src/envelope/payloadSchema.ts` (`compilePayloadSchema`).
- `src/models/catalog.ts` for model ids (used only for the `eval.judge_unknown_model` warning).
- Tests to imitate: `tests/config.loadTrigger.test.ts`, `tests/config.validateCatalog.test.ts`, `tests/cli.validate.test.ts`.

## Decisions already made (do not revisit)

All field rules, defaults, the target forms, relative-path rule (P6), the finding codes and severities, and the grader hash definition are in eval-file-schema.md. Unknown keys are errors. The loader never resolves anything outside the project root. `command` graders are rejected with a specific message (P3). Agent targets are rejected with `eval.target_kind_unsupported`.

## What to build

1. **`src/evals/types.ts` (partial):** the TypeScript types for the **file** shape (`EvalFile`, `EvalTarget`, `EvalDefaults`, `GraderConfig` union, `FieldCheck`, `RubricExample`, `EvalBudget`) and the resolved shapes `ResolvedGrader` and `PlanCase` copied from [engine-interface.md](../../specs/evals-engine-interface.md). Story 07 adds the engine types to the same file.
2. **`src/config/loadEval.ts`:**
   - `parseEvalOutcome(yamlText, filePath, projectRoot): LoadOutcome<LoadedEval>` pure parse + shape validation (all rules that need no other file).
   - `loadEvalOutcome(absPath, projectRoot)` reads the file, calls the parser, and computes `fileHash` (sha256 of the bytes).
   - `LoadedEval = { path, relPath, id, fileHash, file: EvalFile, graders: ResolvedGrader[] (hashes computed, defaults filled) }`.
   - Grader hash and `canonicalJson` (sorted keys, no whitespace) live in `src/evals/canonical.ts` (shared with stories 03 and 06).
3. **`src/config/resolveEvalTarget.ts`:** resolves a target to `{ stageConfig (materialized), pipelinePath?, stageId?, file?, stageVersionHash, inputSchema?, outputSchema?, modelResolved, modelTier }` using the existing loaders and `materializeStageModels` (pipeline form uses the pipeline's `model` tier; file form uses the manifest tier). Failures become `eval.target_unresolved` findings that name the path and what failed.
4. **`src/config/validateEval.ts`:** `validateEval(loadedEval, ctx)` returning `ValidationFinding[]` with `category: "eval"`: everything in the findings table that needs the target or the dataset file: target resolves; dataset file exists (without parsing it: the dataset story owns parsing; this function receives an optional pre-computed dataset report from story 03 and adds `eval.dataset_invalid`, `eval.cases_skipped`, `eval.no_valid_cases`, `eval.cases_missing_expected`, `eval.large_run`, `eval.too_large_run`); schema grader needs an output schema; judge required and unknown-model warning; judge-same-as-stage; stage gates; stage needs checkout; duplicate eval ids across the project (needs the eval list from story 01). Until story 03 lands, the dataset-dependent findings are skipped and covered by a test marked with the story number that enables them.
5. **`src/config/evalCatalog.ts` (extend story 01's file):** `loadEvalCatalog(manifest)` → every eval loaded, with its findings, for the API list and for `sf validate`.
6. **`sf validate` integration:** `validateCatalog.ts` (and `validateCommand.ts` flags if needed) also validates eval files in the scan roots, reporting findings in the same output shape and text as other files, with `category: "eval"`. `--strict` turns eval warnings into errors the way it does for other categories. The text output's scope line and "checks" line (`VALIDATION_SCOPE_LINE`, `VALIDATION_CHECKS` in `validateOutput.ts`) are updated to mention evals; tests for those strings are updated.
7. **Fixtures:** `tests/fixtures/evals/` with: `valid.eval.yaml` (the example from the schema doc), plus one minimal invalid file per finding code (named after the code, for example `unknown-key.eval.yaml`). A fixture stage file and pipeline for the targets (reuse `tests/fixtures/stages/` and `tests/fixtures/pipelines/` where one fits; add only what is missing).

## Acceptance

- [ ] The schema doc's example file loads with no findings and yields 5 resolved graders with stable 6-char hashes (test pins them).
- [ ] Each finding code in the schema doc's table has a test that produces it (those needing a dataset report are marked for story 03).
- [ ] Unknown keys at the top level, in `target`, `defaults`, a grader and a `checks` item each produce `eval.unknown_key` naming the key.
- [ ] `id` must equal the filename stem; a mismatch gives `eval.id_filename_mismatch`.
- [ ] `target` must have exactly one of the pipeline+stage form or the file form; paths resolve relative to the eval file's directory and may not escape the project root.
- [ ] A `command` grader yields `eval.grader_type_unsupported` with a message that it is not available in release 1.
- [ ] Two eval files with the same id in the project each get `eval.duplicate_id`.
- [ ] The stage version hash for a fixture stage is stable across runs and changes when `system_prompt` changes (test).
- [ ] `sf validate` reports eval findings for a fixture project; `--json` includes them; `--strict` fails on an eval warning. Existing validate tests still pass.
- [ ] `npm test` and `npm run typecheck` pass.

## Out of scope

Reading datasets (story 03). Writing eval files (story 12). Running anything.

## Open questions

_(agent fills; stop and ask the owner)_
