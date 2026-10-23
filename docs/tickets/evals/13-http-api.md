# 13: HTTP API

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 09, 11, 12

## Why this story exists

The console reads and writes everything through HTTP. This story builds every public route in [api-cli-mcp.md](../../specs/evals-api-cli-mcp.md) on top of the manager, stats, loaders and write path.

## Read first

- [api-cli-mcp.md](../../specs/evals-api-cli-mcp.md) "Conventions", "Evals", "Datasets", "Eval runs" (every route, body and response), and the related sections of [result-schema.md](../../specs/evals-result-schema.md) (list status, compare, estimate) and [dataset-format.md](../../specs/evals-dataset-format.md).
- `src/server/triggerRoutes.ts` and its test `tests/server.triggerRoutes.test.ts`: copy structure, error mapping (`mapStartFailure`), audit writes, `project_root` resolution, JSON body reading and response helpers.
- `src/server/http.ts` around `handleTriggerRoutes` for registration order and the `json` / `readJsonBody` helpers.
- Stories 02–12 outputs.

## Decisions already made (do not revisit)

Routes, bodies, status codes, error codes and field names are those in api-cli-mcp.md; the internal run-case route exists from story 11 and is not part of this story. Mutating routes write audit records the way trigger routes do. Paths in responses are project-relative. List endpoints paginate with `limit` and `cursor`. No route runs an engine except `POST …/runs` and `POST /api/evals/try` (through the manager).

## What to build

1. **`src/server/evalRoutes.ts`:** `handleEvalRoutes(req, res, deps)` implementing:
   - Evals: list (with `status`, `banner`, `footer`, `trend`, target filters, `q`), get, validate, create, update, sample install, try.
   - Datasets: list, get (with `input_check`, `input_fields`, filters, paging), preview, create (cases / sample / runs / append-replace), `PATCH` cases, convert, candidates.
   - Eval runs: start, estimate, get by number, list, get, results list (case rows with repeats folded and filters `status`, `grader`, `q`, `tag`), result detail, review `PUT`, failure types, cancel, delete, compare, export, engine status.
2. **Aggregation helpers** in `src/evals/read/` (pure over store reads): `buildEvalListItems`, `buildRunDetail` (with `stats` from `computeStats` and the previous run for grader deltas), `buildResultRows`, `buildCompare` (store reads + `compareRuns`), `buildExport`. Keep route handlers thin.
3. **Registration:** in `http.ts` next to `handleTriggerRoutes`. Pass the manager, store, cwd, and the engine-status function.
4. **Judge-capable models:** extend the existing model-listing response used by the console's model picker (find it: `ui/src/modelCatalog/` and its server route) with a `judge_capable: boolean` per model computed from story 11's `judgeCapableModels()`. Do not change the model catalog itself.
5. **Types for the console:** `ui/src/api/types.ts` gains the response types listed in api-cli-mcp.md (mirroring the wire names), and `ui/src/api/client.ts` gains one typed function per route, following the existing function style. (Doing this here keeps the UI stories free of API plumbing.)
6. **Tests** (`tests/server.evalRoutes.test.ts`, same harness as trigger route tests; `FakeEngine` and a fake stage runner; temp project): every route happy path and its documented error codes (404, 409 codes, 422 with findings, 503 engine), pagination, the `FILE_CHANGED` flow, tags rejected on a passed result, `only_failed_from` selection, `EVAL_RUN_ACTIVE`, compare mismatch, export content type and filename, delete returns 409 while running.

## Acceptance

- [ ] Every route in api-cli-mcp.md exists with the documented method, path, body and response (a test table enumerates all routes and asserts non-404).
- [ ] The list endpoint returns `status`, `trend` (7 most recent completed runs, oldest first), `last_run_delta_pts`, the regression banner and footer numbers per result-schema "List status" (fixture with 3 evals in different states).
- [ ] `POST /api/evals/validate` returns findings and `derived_yaml` for both a `definition` and a `yaml` body and writes nothing.
- [ ] `GET /api/datasets/:id?eval_id=` marks invalid cases with `input_check` and returns `input_fields` from the stage schema; `filter=invalid|tagged` and `q` work.
- [ ] `POST /api/datasets/preview` returns row statuses and counts for a CSV with a mapping, per dataset-format.md.
- [ ] Starting a run returns 202 with `eval_run_id`; polling `GET …/runs/:n` shows progress and, when finished, `stats`; `GET …/results` folds repeats per case and filters; the review `PUT` stores label, note and tags.
- [ ] A running run cannot be deleted (409); a finished one can, and its eval stage runs are removed.
- [ ] Error bodies never contain secrets, URLs or stack traces (test asserts on a forced engine failure).
- [ ] `ui/src/api/` has the typed client functions and types; `npm run ui:test` and `npm run typecheck` pass for both workspaces.
- [ ] `npm test` passes.

## Out of scope

CLI (14), MCP (15), UI pages (16+), docs (24).

## Open questions

_(agent fills; stop and ask the owner)_
