# 23: Entry points: Catalog stage "Evaluate" and cross-links

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 16, 20

## Why this story exists

The most natural moment to run an eval is while looking at a stage. The Catalog stage inspector gets an Evals section and an Evaluate button, and a few cross-links tie the pages together.

## Read first

- [ui-map.md](../../specs/evals-ui-map.md) screen 8.
- Wonder artboard `cha` (Catalog - Stage Evals Entry).
- `ui/src/redesign/catalog/` (the stage inspector component and its tests), `ui/src/pages/CatalogPage.tsx`, `ui/src/api/` (story 13 client: `GET /api/evals` with `target_*` filters).

## Decisions already made (do not revisit)

The inspector's **EVALS n** section (header with "+ New eval"; rows: id, "n cases · last run <relative>" or "never run", pass rate with a small bar, chevron), the guidance line "Run an eval before you save changes to this stage.", the **Evaluate** footer button beside Edit stage with this behavior: exactly one eval → open its Run dialog (`#/evals/<id>?openRun=1`); none → `#/evals/new` preselected for the stage; two or more → `#/evals?stage=<id>`. For a stage used by several pipelines, evals are listed for each pipeline entry, labeled with the pipeline id. "+ New eval" → `#/evals/new?pipeline=…&stage=…`. The Evals list honors `?stage=<id>` by passing `target_stage` to the list API and showing a dismissible "Showing evals for stage <id>" chip.

## What to build

1. **Model** `ui/src/redesign/catalog/stageEvalsModel.ts` (+ test): from the stage's pipeline usages and the eval list response: sections per pipeline, row text, the Evaluate button's destination rules, the guidance line.
2. **Inspector changes** in the existing component: the Evals section and the button, loading/empty/error states (no evals: "No evals yet. Create one to check this stage before you ship changes." with the "+ New eval" action).
3. **List filter chip** for `?stage=` in story 16's list page and its model.
4. **Cross-links:** run detail page for an **eval stage run** shows a banner "This run was started by eval <id>, run #<n>" linking to the eval result (needs the stage run → eval result lookup: `GET /api/eval-runs?stage_run_id=<id>`; add this filter to the list endpoint with a route test; run detail pages for normal runs are unchanged). The Runs page does not list eval stage runs (story 04), so this banner appears only when opening such a run by link, for example from "Open stage run".
5. Keep all existing Catalog inspector tests passing; add tests for the new model.

## Acceptance

- [ ] The inspector shows the Evals section for a stage with two evals (visual check against `cha`), and the correct empty state for none.
- [ ] **Evaluate** routes per the three cases (model tests for each).
- [ ] `#/evals?stage=<id>` filters the list and shows the chip; dismissing it clears the filter.
- [ ] Opening an eval stage run shows the banner with a working link; a normal run shows no banner.
- [ ] `GET /api/eval-runs?stage_run_id=` is covered by a route test.
- [ ] `npm run ui:test`, `npm run ui:build`, `npm run typecheck`, `npm test` pass.

## Out of scope

Pipeline-level entry points, agent pages.

## Open questions

_(agent fills; stop and ask the owner)_
