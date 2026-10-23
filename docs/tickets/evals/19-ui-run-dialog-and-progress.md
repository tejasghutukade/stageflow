# 19: Run dialog and live progress

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 16

## Why this story exists

Starting a run and watching it is the center of the feature. This story builds the Run dialog and the live progress screen, and routes a finished run to results or compare.

## Read first

- [ui-map.md](../../specs/evals-ui-map.md) screen 4 (all of it) and the "Routes" table (`#/evals/<id>/runs/<n>` is both the live screen and the results screen).
- [result-schema.md](../../specs/evals-result-schema.md): "Cost estimate", statuses; [api-cli-mcp.md](../../specs/evals-api-cli-mcp.md): `POST /api/evals/:id/runs`, `GET …/runs/estimate`, `GET …/runs/:n`, `cancel`, `live`.
- Wonder artboards `tub` (Run dialog) and `spa` (Live progress).
- `ui/src/redesign/startRun/` (the existing Start Run dialog: copy its dialog, form and error patterns), `ui/src/redesign/overlay/`, and how run pages poll (`ui/src/runs/`, `ui/src/runLifecycle/`).
- The API client from story 13.

## Decisions already made (do not revisit)

All of screen 4: cases segmented control (All / Failed last time / Pick cases), repeats, cost limit, stage model, judge model with the same-as-stage hint, the "Compare with Run #n when it finishes" checkbox (client-side only), the estimate box and its missing-history texts, footer copy, inline error display for `EVAL_INVALID` / `EVAL_RUN_ACTIVE` / `EVAL_ENGINE_UNAVAILABLE`, the live screen's tiles, results table with phases from `live`, **Stop run** with confirm, and what happens on finish (Overview, or Compare when the checkbox was set; incomplete runs open results with a reason banner). Estimated left = `elapsed / results_done × remaining`, shown as "—" until 3 results are done. Polling every 1.5 s while `queued`/`running`.

## What to build

1. **`ui/src/redesign/evals/run/runDialogModel.ts`** (+ tests): pure model: option state, mapping to the start request (`case_ids` / `only_failed_from` / none, `model` only when changed, `judge` only when changed, `repeats`, `max_cost_usd`), validation (repeats 1–10, cost > 0), the "Failed last time · k" availability/count from the last completed run, the same-as-stage hint rule, estimate request building and display texts.
2. **`liveProgressModel.ts`** (+ tests): pure model from `EvalRunDetail` + results rows + `live`: counts (passed/failed/running/queued), the stacked bar segments, "Passing so far", "Cost so far of $limit limit", elapsed, estimated left, table rows with phase text and repeat dot states, ordering, and the finish routing decision (Overview vs Compare vs incomplete-banner).
3. **Components:** Run dialog (including **Pick cases** list with search), Live progress page, stop confirm, banner for `budget_stopped`/`failed`/`cancelled`.
4. **Opening the dialog:** a route-state mechanism so other screens can open it: `#/evals/<id>?openRun=1` opens the dialog on the eval's page (the page redirects to the latest run or edit view and keeps the flag), and the dialog can also be opened from the list row action "Run" and the results header "Run again" (those screens call a shared `openRunDialog(evalId)`). Use the existing overlay/route-state pattern (look at how Start Run is opened) rather than inventing a new one.
5. **Run page routing:** `#/evals/<id>/runs/<n>` renders the live screen while the run is `queued`/`running` and the results screen (story 20; a placeholder until then) otherwise; the transition happens without a full reload.
6. Update story 17's "Create and run" to use the mechanism (remove its disabled state) if story 17 has landed.

## Acceptance

- [ ] The dialog opens from the list row action and shows estimate, counts and texts matching the artboard structure (visual check against `tub`), with missing-history variants tested at model level.
- [ ] Changing repeats, cases or the stage model refreshes the estimate (debounced) and only changed overrides are sent.
- [ ] "Failed last time" is disabled with no completed run, otherwise sends `only_failed_from` of the latest completed run.
- [ ] Start navigates to `#/evals/<id>/runs/<n>`; start errors appear inline with the server message.
- [ ] The live page shows counts, bar, tiles and the "Now" phase column from `live`, updates by polling, shows Stop run (confirm → cancel), and switches to results on finish; with the compare checkbox it navigates to Compare instead.
- [ ] A `budget_stopped` run shows the banner "Reached the $X cost limit. Results are partial."; `failed` shows the status reason.
- [ ] Model tests: request building, estimated-left rule (< 3 results → "—"), counts consistency (the four counts sum to total), finish routing.
- [ ] `npm run ui:test`, `npm run ui:build`, `npm run typecheck` pass.

## Out of scope

The results screen (20), compare (21).

## Open questions

_(agent fills; stop and ask the owner)_
