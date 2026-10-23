# 17: New eval wizard (Setup, Graders, Review) and Try on one case

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 16

## Why this story exists

This is how an author creates an eval: pick a stage, add data, write graders (including rubrics), see what a case would score, and create the files. The Review step is not in the designs and is specified in ui-map.md.

## Read first

- [ui-map.md](../../specs/evals-ui-map.md): "Ground rules", screen 2 (all three steps; the Review step is specified there in full), screen 3's Upload dialog and candidates dialog (the Setup step reuses them; **build the shared dialogs in this story only if story 18 has not**, and tell the owner which story owns them: the rule is whichever story runs first builds them in `ui/src/redesign/evals/datasets/` and the other imports them).
- [eval-file-schema.md](../../specs/evals-file-schema.md) (every grader's fields and rules; the form must offer exactly these and nothing else), [dataset-format.md](../../specs/evals-dataset-format.md).
- Wonder artboards `out` (Setup) and `mru` (Graders). Note the deltas in the epic's "Design source and deltas" (no Command grader, no calibration card, "Not calibrated" copy).
- `ui/src/redesign/triggers/NewTriggerModal.tsx`, `newTriggerModel.ts` + test, `triggerYamlPreview.ts` (state-machine, draft model and live YAML preview patterns); the existing stage and pipeline listing in `ui/src/api/` and the Catalog page (`ui/src/redesign/catalog/`) for the stage picker data; `ui/src/modelCatalog/` for the model picker (use `judge_capable` from story 13 for the judge picker).

## Decisions already made (do not revisit)

Everything in ui-map.md screen 2: step structure, nothing written until the final step, eval id derived as `<stage-id>-eval` and edited on Review, dataset held client-side until Create (dataset written first, then the eval; if the second write fails the dataset stays and the message says so), the four dataset tiles and their behavior, sample tile enabled only when compatible, the grader forms per type, drag-to-reorder (= file order), the budget strip, Try on one case via `POST /api/evals/try` with the **draft definition and an inline case**, and the footer texts. Default values written explicitly on create: `defaults.repeats`, `defaults.pass_threshold`, `defaults.max_cost_usd`. **No judge calibration, no Command grader.**

## What to build

1. **`ui/src/redesign/evals/newEval/wizardModel.ts`** (+ tests): the pure state machine and draft model: steps, validity per step, draft `definition` (the eval file shape), draft dataset (cases, source), id derivation and uniqueness, adding/removing/reordering graders, per-type default grader factories (ids like `grader-1` until renamed; unique), conversion of the draft to the `definition` JSON the API takes, and the "Continue" enable rules (target chosen; dataset has ≥ 1 valid case; defaults valid; Graders step needs ≥ 1 grader).
2. **`graderForms.ts`** (+ tests): pure helpers for each grader type's form values ↔ grader config (field checks rows, rubric examples, scale/pass_at coupling: `pass_at` shown only for `1_to_5`; weight/must-pass rules).
3. **Setup step components:** target picker (stages list with search, model, pipelines, eval counts; `io.input` chips), dataset tiles + summary card + preview table, run defaults, the right column (live YAML via `POST /api/evals/validate` debounced 300 ms, Checks list from findings plus the fixed checks, estimate line from the estimate endpoint, "No cost history yet" when null).
4. **Graders step components:** list + Add grader menu + expandable cards per type + budget strip + **Try on one case** panel + grader types reference panel (without Command) + footer.
5. **Review step components:** name/description inputs, read-only summary, findings, file path and estimate, final YAML, buttons **Back / Create eval / Create and run**.
6. **Wiring:** replace the `evalNew` placeholder route; preselect the target from the query; Create writes via `POST /api/datasets` (when the dataset is new) then `POST /api/evals`; on success **Create eval** goes to `#/evals`; **Create and run** navigates to `#/evals/<id>?openRun=1`, which opens the Run dialog from story 19 (story 19 defines the flag; until story 19 lands this button is disabled with the tooltip "Available after the run dialog ships").
7. **Dialogs reused from story 18:** upload/paste and "From past runs" (see "Read first" for ownership).

## Acceptance

- [ ] From `#/evals/new?pipeline=…&stage=…` the target is preselected and the `io.input` chips match the stage schema.
- [ ] Uploading a CSV (through the dialog) mapped to the stage input yields a dataset summary "n cases · k skipped" and a 3-row preview; nothing is written to disk before Create (assert no write calls in tests of the model and that the components only call the API at the documented points).
- [ ] The YAML preview updates as defaults change and equals the API's `derived_yaml`; findings appear as checks (error red, warning amber); the judge-same-as-stage hint appears when the judge equals the stage model.
- [ ] Each grader type can be added, edited, reordered and removed; the produced definition matches [eval-file-schema.md](../../specs/evals-file-schema.md) exactly (model tests compare to the schema doc's example).
- [ ] Rubric cards show "Not calibrated" and no calibration card; no Command option anywhere.
- [ ] Try on one case runs through `POST /api/evals/try` with the draft and an inline case and displays grades and the case score (against the threshold) or the error message; it is disabled while the draft has error findings.
- [ ] Review step: the id is validated (pattern and uniqueness via the validate endpoint), Create writes dataset then eval, a failure of the second write keeps the dataset and shows the message.
- [ ] **Create and run** is wired per item 6.
- [ ] The wizard's pure model has tests for step validity, id derivation (`review` → `review-eval`, `review-eval-2` when taken), reordering, and definition conversion; `npm run ui:test`, `npm run ui:build`, `npm run typecheck` pass.
- [ ] Visual check against artboards `out` and `mru` (screenshots) shows the same structure and copy except the documented deltas.

## Out of scope

Run dialog and results (19, 20); the dataset detail page (18); the Edit page (22). Server changes.

## Open questions

_(agent fills; stop and ask the owner)_
