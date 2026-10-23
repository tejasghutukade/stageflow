# 20: Results: Overview, Cases, Graders, Config tabs and the case drawer

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 19

## Why this story exists

Results are what the author came for: pass rate with honest error bars, which graders miss, which cases fail or flip, why, and what exactly was run. This story builds the four tabs and the case drawer, including the author's review (label, note, failure-type tags).

## Read first

- [ui-map.md](../../specs/evals-ui-map.md) screen 5 (header, Overview, Cases tab, Graders tab, Config tab, case drawer, errored results).
- [result-schema.md](../../specs/evals-result-schema.md): "Statistics" (what each number means; the UI formats, never recomputes), "Config snapshot", "List status" only for naming; [api-cli-mcp.md](../../specs/evals-api-cli-mcp.md): `EvalRunDetail`, results routes, `review`, `failure-types`, `export`, `try`.
- Wonder artboards `but` (Overview), `tee` (Case drawer), `tic` (Config). The Cases and Graders tabs have **no artboard**: build them exactly as ui-map.md specifies.
- The epic's design deltas (no calibration card, "Not calibrated", rename "Re-run with this config" to **Re-run with these settings**, no domain-specific seeded failure types).
- `ui/src/redesign/runs/` and `ui/src/redesign/shell/Inspector.tsx` for the drawer pattern, `ui/src/redesign/overlay/`.

## Decisions already made (do not revisit)

All of screen 5. In particular: the six KPI tiles and their sub-lines (reliability tile hidden when repeats = 1), By-grader card with "vs #previous" from `by_grader[].delta` ("—" or "grader changed" when null), score histogram with the threshold marker, the flaky note, the Failure types card (empty-state text; clicking a row filters the Cases tab by that tag), Failing and flaky cases (first 5 with "All n cases →"), footer with prev/next run arrows, header chips and buttons (Edit eval, Compare with #previous hidden for run 1, Export = `export?what=results`, Run again = story 19's dialog), the Config tab cards and its **Re-run with these settings** behavior (overrides only; amber note when stage/dataset/graders changed since), the drawer sections (input, output envelope with `time · cost · tokens`, expected findings checklist only when a `reference` grader exists, grades with reasons, **Your review**: Pass/Fail, tags enabled only for results with `passed = 0`, why note, **Save review**; the agree/disagree line; no calibration wording), drawer footer actions (**Open stage run**, **Re-run this case** via `POST /api/evals/try` shown as a temporary panel, **Edit case in dataset**). Errored results show the error code and message in place of output and grades. Incomplete runs (`failed`/`cancelled`/`budget_stopped`) show a banner with the reason and "Results are partial."

## What to build

1. **Pure models** in `ui/src/redesign/evals/results/` (+ tests each): `overviewModel.ts` (KPI tile texts, header chip, by-grader rows, histogram bars, flaky note, failure-type rows, failing-cases rows), `casesModel.ts` (tabs/counts, filters, paging, row view), `gradersModel.ts` (rows, expansion detail, lowest-scoring cases), `configModel.ts` (card rows, "edited since" chips by comparing snapshot hashes with the **current** stage and dataset hashes the API returns on `EvalRunDetail.current` (**add `current: { stage_version_hash, dataset_hash, grader_hashes }` to `EvalRunDetail` in story 13's API if absent; coordinate by adding it in this story's server part**), reproduce command text, re-run overrides builder), `drawerModel.ts` (repeat tabs, expected-findings rows from `details.items`, grade rows, review state machine and the save request, agree/disagree line).
2. **Components:** the run results page shell (header, tabs, banners), each tab, the drawer, the temporary re-run panel, tag chip input with the vocabulary from `failure-types`.
3. **Routing:** replace the `evalRun` and `evalCase` placeholders; `?tab=` selection; drawer deep link (`/case/<caseId>?repeat=<i>`), previous/next case arrows, closing returns to the tab.
4. **Server addition (small):** `current` on `EvalRunDetail` as above, with a test in the route tests.
5. **Export** and **Copy command** actions.

## Acceptance

- [ ] Overview matches `but` structurally for a fixture run (visual check), with every number coming from `stats`/`config` fields (model tests assert the texts for a fixture: "63 of 72 results · 95% CI 77 to 97 (by case)" style strings derive from fields).
- [ ] Reliability tile hidden for repeats = 1; CI line omitted when `pass_rate_ci` is null.
- [ ] The Cases tab filters (All/Failed/Flaky/Errored/Passed, grader, tag, search) and pages 25 rows; row click opens the drawer and updates the URL.
- [ ] The Graders tab lists graders with stats and expands to the definition and the five lowest-scoring cases linking to the drawer; rubric graders show judge, tokens and cost.
- [ ] Config tab shows the snapshot; changing the stage or dataset after the run (fixture with differing `current` hashes) shows the amber "edited since" chips and the note on the re-run button; **Re-run with these settings** starts a run with only the snapshot's overrides.
- [ ] The drawer shows expected findings from `details.items`, grades with reasons, errored results correctly, saves a review (label, note, tags) through the API, disables tags on passed results, and shows the agree/disagree line.
- [ ] **Re-run this case** shows a temporary result without storing it; **Open stage run** links to the stage run (hidden when purged); **Edit case in dataset** deep-links the dataset page.
- [ ] Incomplete runs show the partial-results banner.
- [ ] Model tests cover each model file's branches; `npm run ui:test`, `npm run ui:build`, `npm run typecheck`, `npm test` pass.

## Out of scope

Compare (21), the Edit page (22), calibration.

## Open questions

_(agent fills; stop and ask the owner)_
