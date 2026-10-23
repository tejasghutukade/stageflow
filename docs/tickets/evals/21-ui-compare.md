# 21: Compare runs

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 19

## Why this story exists

"Did my change make the stage better?" is answered here: what changed in the stage, what stayed constant, and a paired comparison with an interval that says whether the difference is real.

## Read first

- [ui-map.md](../../specs/evals-ui-map.md) screen 6.
- [result-schema.md](../../specs/evals-result-schema.md) "Compare" (verdict rules, warnings, stage diff, detectable change) and [api-cli-mcp.md](../../specs/evals-api-cli-mcp.md) `GET /api/eval-compare`.
- Wonder artboard `est` (Compare runs) including the "Held constant / Changed" strip.
- Story 20's models and drawer (the Compare case rows open the drawer of run `b`).

## Decisions already made (do not revisit)

All of screen 6: the Before/After pickers (runs of the same eval, "Run #13 · 85.4%"), the stage-change panel from `stage_diff` (12 lines then **View full diff**; "Stage unchanged" when null), the Held-constant/Changed strip from `components` with amber warnings for dataset/graders/engine differences, the KPI strip with verdict words (`improved`, `regressed`, `inconclusive` for `no_clear_difference`, "not enough shared cases" for `insufficient_data`), By grader rows with delta bars and "changed" for differing grader hashes, Cases that changed tabs (Fixed / Regressed / Unchanged) with before→after dots, score change and `graders_changed`, and the computed footer note including `cases_needed_5pts`. No explanatory notes that the data does not support (the mockup's "longer prompt" is not built).

## What to build

1. **`ui/src/redesign/evals/compare/compareModel.ts`** (+ tests): pure model: picker options, KPI tiles (`a → b`, delta text in points or percent, CI text "95% CI −6 to +10", verdict word and tone), strip text and warnings, by-grader rows and bar geometry (centered bar proportional to delta, clamped), case lists per tab with before/after dot arrays, stage-diff panel lines (collapse/expand), footer note text.
2. **Components** and the route `#/evals/<id>/compare?a=<n>&b=<m>`; default `b` = the latest run and `a` = the previous completed run when the query is absent; changing a picker updates the URL.
3. Navigation: from the list banner, the results header button, and the run dialog's "Compare with Run #n when it finishes" (story 19 already routes there).
4. Error states: `EVAL_COMPARE_MISMATCH` (cannot happen from the UI's own pickers but handle it), runs deleted, fewer than two runs (an empty state "Run the eval at least twice to compare").

## Acceptance

- [ ] For a fixture compare payload the page matches `est` structurally (visual check) and every text derives from payload fields.
- [ ] Verdict words and tones: `improved` green, `regressed` red, `no_clear_difference` neutral "inconclusive", `insufficient_data` neutral "not enough shared cases".
- [ ] Different datasets or graders show the amber warning and the right components in the Changed list; identical config shows "Same dataset · same graders · same judge".
- [ ] "View full diff" expands the prompt diff; a null `stage_diff` shows "Stage unchanged".
- [ ] Cases that changed lists the Fixed/Regressed/Unchanged counts from the payload and clicking a row opens the case drawer of run `b`.
- [ ] The footer note reports `m` and `cases_needed_5pts` from the payload, and omits the clause when null.
- [ ] Model tests cover tiles, strip, by-grader geometry (including 0 and large deltas), case tabs and footer text; `npm run ui:test`, `npm run ui:build`, `npm run typecheck` pass.

## Out of scope

Computing any statistic client-side. Comparing across evals.

## Open questions

_(agent fills; stop and ask the owner)_
