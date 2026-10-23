# 12: Eval and dataset write path

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 02, 03

## Why this story exists

The console edits files (A3, A9). Saving must rewrite `evals/<id>.eval.yaml` and `datasets/<name>.dataset.jsonl` safely: atomically, without losing the author's comments, refusing to overwrite changes made outside the console, and inside writable catalog roots only.

## Read first

- [eval-file-schema.md](../../specs/evals-file-schema.md) "Writing the file", [dataset-format.md](../../specs/evals-dataset-format.md) "Editing in the console", "Atomic writes", "Upload mapping", "Sample dataset", "From past runs".
- `src/config/createTrigger.ts`, `src/config/updateTrigger.ts`, `src/config/createStage.ts`, `src/config/createPipeline.ts`, `src/config/draftPackage.ts`: the existing create/update patterns (how they choose a root, write, report conflicts, preserve text).
- `src/config/catalogRelativePath.ts` (`resolveWritableCatalogRoot`, `resolveCatalogRelativePath`, `CatalogPathError`), `src/config/ensureCatalogScanRoot.ts` (making sure a new file's directory is in a scan root).
- The `yaml` package's `Document` API (already a dependency) for comment-preserving edits.
- Stories 02 and 03 loaders; `src/runstore/` run reads for past-run candidates: `src/runstore/port.ts` (`readRun`, `RunDetail`), `runs.task_yaml` and `taskPath` for the recorded task input.

## Decisions already made (do not revisit)

- Writes are atomic (temp file in the same directory + `rename`) and check `base_hash` against the file's current content hash first (`FILE_CHANGED` with the current hash).
- Eval edits preserve comments and unrelated formatting using the `yaml` Document API; key order and flow/block styles follow "Writing the file". A full rewrite is allowed only when a Document edit cannot represent the change, and tests must show comments survive the common edits (change a default, edit a rubric, add a grader, reorder graders, remove a grader).
- New files go into a **writable** catalog root: the project's first configured `evals` / `datasets` root (or the P13 default `evals/` / `datasets/`, created if missing and added to the scan roots by `ensureCatalogScanRoot` only when the manifest names explicit roots that do not include it).
- Console edits to datasets are `.dataset.jsonl` only (P5). `.json`/`.csv` → `convert`.
- Ids assigned to cases without one: `c001`, `c002`, … continuing after the highest numeric `cNNN` in use.
- Past-run candidates (**conservative rule, decided here**): standalone stage runs of the target stage and pipeline runs whose **entry** stage is the target stage; the input is the run's recorded `task.input`; eval runs (`origin = 'eval'`) are excluded. If the investigation shows that inputs of non-entry stages are recorded and easily readable, **stop and ask** before extending the rule.
- The shipped sample is installed from the package's `examples/evals/` directory, located with the same helper `src/config/seededCatalog.ts` uses to find `examples/` (story 24 creates the files; until then this story's tests use a fixture copy under `tests/fixtures/evals/sample/` and an injectable source directory). Installing copies files only when absent and never overwrites.

## What to build

1. **`src/config/writeEval.ts`:** `createEvalFile({ projectRoot, definition, directory? })`, `updateEvalFile({ projectRoot, id, definition? | yaml?, baseHash })`, `renderEvalYaml(definition)` (used for `derived_yaml`: the canonical text for a definition, ignoring existing comments), `previewEvalUpdate(currentText, definition)` (returns the Document-edited text the update would write, used for the live diff). `definition` is validated by story 02's parser before writing (errors block with the findings); `yaml` input is parsed and validated the same way.
2. **`src/config/writeDataset.ts`:** `createDatasetFile({ projectRoot, name, cases, directory? })`, `applyCaseOps({ projectRoot, id, baseHash, ops })` (all-or-nothing: validate every op against the current cases first; ops per api-cli-mcp.md `PATCH`), `appendOrReplaceCases(...)` for uploads, `convertDatasetToJsonl({ projectRoot, id, baseHash })`. Writes JSONL with one compact JSON object per line, stable key order (`id, title, input, expected, tags, goal, metadata`), trailing newline.
3. **`src/config/atomicWrite.ts`:** `writeFileAtomic(path, text)`, `contentHash(bytes)`, and `assertBaseHash(path, baseHash)` raising `FileChangedError { currentHash }`.
4. **`src/config/datasetCandidates.ts`:** `listDatasetCandidates({ store, target, limit })` per the rule above, each `{ runId, finishedAt, preview }` with the 160-char preview of the compact JSON input; and `casesFromRuns({ store, runIds, target })` building cases (`title: "Run <first 8 chars>"`, `metadata.source_run`).
5. **`src/config/installEvalSample.ts`:** `installEvalSample({ projectRoot })` copying the sample files (three files, names fixed in story 24: `eval-sample.pipeline.yaml`, `critique-sample.eval.yaml`, `critique-sample.dataset.jsonl`, written to the project's pipelines, evals and datasets roots respectively; the `critique-sample.task.yaml` and README stay in `examples/` and are not installed) into the writable roots with the eval file's relative paths rewritten if the directories differ; returns `{ evalId }` or throws `SAMPLE_EXISTS`.
6. Unit tests for everything above using temp project directories.

## Acceptance

- [ ] Creating an eval writes exactly the canonical YAML for the definition (golden file test with the schema doc's example), refuses an existing id (`EVAL_EXISTS`), and refuses an invalid definition with findings.
- [ ] Updating with a stale `base_hash` fails with `FILE_CHANGED` and the file is untouched; with the right hash it writes atomically (test simulates a crash between temp write and rename: the original remains intact).
- [ ] Comment preservation: a fixture eval with comments on defaults, a grader, and a top-level comment keeps every comment after each of: change `defaults.repeats`; edit a rubric's text; add a grader; reorder two graders; remove a grader; change `target.stage`.
- [ ] `previewEvalUpdate` output equals what `updateEvalFile` writes for the same input.
- [ ] A YAML-text update (`yaml:`) is parsed and validated; invalid YAML or findings with errors write nothing.
- [ ] `applyCaseOps` applies add/update/delete/set_tags together or not at all (a bad op in a batch leaves the file unchanged), rejects duplicate ids, assigns ids on add when absent, and refuses `.json`/`.csv` (`DATASET_READ_ONLY`).
- [ ] Append continues ids after the highest `cNNN`; replace discards existing cases; `convert` writes the sibling `.jsonl`, keeps the original, keeps the same content hash, and refuses when the target exists.
- [ ] Candidates: standalone stage runs and entry-stage pipeline runs for the target appear; eval runs and runs of other stages do not; previews are truncated to 160 chars.
- [ ] `installEvalSample` copies once and returns the eval id; the second call throws `SAMPLE_EXISTS` and changes nothing.
- [ ] Files are only ever written inside the project root (a path-escape attempt through `directory` or `name` is rejected with the existing `CatalogPathError`).
- [ ] `npm test` and `npm run typecheck` pass.

## Out of scope

HTTP routes (story 13), UI, the sample files themselves (story 24).

## Open questions

_(agent fills; stop and ask the owner)_
