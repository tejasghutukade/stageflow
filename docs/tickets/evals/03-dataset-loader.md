# 03: Dataset loader, validator and hashing

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 01

## Why this story exists

Datasets are plain files in three formats. One loader must turn any of them into the same list of cases, validate them, hash them, and check them against a stage. The API, CLI, wizard, dataset page and engine plan all use it.

## Read first

- [dataset-format.md](../../specs/evals-dataset-format.md) (all of it) and the epic's A3, P5, P11.
- `src/config/loadOutcome.ts`, `src/config/yamlParsePosition.ts` (finding/position conventions), `src/config/validateCatalog.ts` (`ValidationFinding`).
- `src/envelope/payloadSchema.ts` (`payloadInstanceMismatch`, `compilePayloadSchema`), and how `src/runtime/taskInput.ts` (`checkTaskEntryInput`) validates `task.input` against a stage input schema.
- Story 02's `src/evals/canonical.ts` (`canonicalJson`); if story 02 is not merged yet, create the file as story 02 describes it and tell the owner.
- Whether the repo already depends on a CSV parser (`package.json`). If not, **do not add a dependency**: write a small RFC 4180 parser in `src/config/csv.ts` with tests (quoted fields, escaped quotes, embedded newlines, `\r\n`, BOM, custom delimiter).

## Decisions already made (do not revisit)

Case shape, id rules, tags rules, file formats, CSV header convention, ids required in stored files, the hash definition, limits, validation codes and severities, `.jsonl`-only editing, and the upload-mapping contract are all in dataset-format.md. `dataset.input_mismatch` is a **warning** and such cases are skipped at run start.

## What to build

1. **`src/config/loadDataset.ts`:** `parseDatasetText(text, format, options)` and `loadDatasetFile(absPath)` returning `{ path, relPath, format, cases: DatasetCase[], findings, contentHash, fileBytes }`. Format from the extension. Parse errors name the 1-based line (JSONL) or row (CSV). Unknown formats are an error.
2. **`src/config/datasetHash.ts`:** `datasetContentHash(cases)` per the spec (canonical JSON per case, joined with `\n`, sha256). A test proves that reformatting a JSONL file, reordering keys, and converting the same cases to JSON and CSV forms give the same hash, and that reordering cases changes it.
3. **`checkDatasetAgainstStage(cases, inputSchema)`** in `src/config/datasetStageCheck.ts` returning, per case, `{ caseId, valid, message? }` using `payloadInstanceMismatch`. A stage with no `io.input.schema` makes every case valid.
4. **Upload mapping:** `applyUploadMapping(rows, mapping, inputSchema, existingIds)` in `src/config/datasetImport.ts` implementing [Upload mapping](../../specs/evals-dataset-format.md#upload-mapping-console-upload-dialog): produces `{ index, case, status: "ready" | "skipped", reason? }[]`, assigns `cNNN` ids continuing after the highest numeric suffix in `existingIds`, parses number/integer/boolean fields by schema type, honors `split`, and marks a row skipped when its input fails the schema (reason = the validator's message trimmed to 160 chars).
5. **Past-run candidates** are **not** built here (story 12 owns them).
6. **Sample cases:** none here (story 24).
7. **Fixtures:** `tests/fixtures/datasets/` with a valid JSONL, JSON (both shapes) and CSV (header convention, quoted fields, `:json` column, `tags` split) of the same 6 cases, plus a small invalid file per finding code.
8. Enable the dataset-dependent findings in story 02's `validateEval` (the tests marked for this story) if story 02 is merged; if not, leave a note for story 02.

## Acceptance

- [ ] The same 6 cases load identically from the JSONL, JSON array, `{cases}` and CSV fixtures and produce the same content hash.
- [ ] Each validation code in dataset-format.md has a test that produces it.
- [ ] A JSONL file with a bad line reports the line number; a CSV with an unknown header reports `dataset.csv_unknown_column` with the header name; a file without ids reports `dataset.case_missing_id` for hand-authored datasets.
- [ ] Limits (cases, per-case size, file size) are enforced with the documented codes; tests use small synthetic limits by passing options (limits are constants overridable in tests).
- [ ] `checkDatasetAgainstStage` marks exactly the failing cases with a human message; with no schema everything is valid.
- [ ] `applyUploadMapping` has tests for: required field empty → skipped with reason; type parsing; `split`; id continuation (`c007` exists → next is `c008`); a column not mapped is ignored; null mapping skips the field.
- [ ] The CSV parser has its own tests (quotes, newlines, BOM, delimiter).
- [ ] `npm test` and `npm run typecheck` pass.

## Out of scope

Writing dataset files (story 12). The UI. Sample data. "From past runs".

## Open questions

_(agent fills; stop and ask the owner)_
