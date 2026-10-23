# 22: Edit eval page (form, YAML view, diff)

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 17

## Why this story exists

Everything the YAML can set must be editable in the console (A9). This page edits an existing eval with the same form as the wizard's Graders step plus a Definition card, a YAML view, and a live diff of what saving will write.

## Read first

- [ui-map.md](../../specs/evals-ui-map.md) screen 7; the epic's A9, A10 and the design deltas.
- [eval-file-schema.md](../../specs/evals-file-schema.md) ("Writing the file"), [api-cli-mcp.md](../../specs/evals-api-cli-mcp.md) `GET/PUT /api/evals/:id`, `POST /api/evals/validate`.
- Wonder artboard `now` ("Page - Edit Eval - Form And YAML").
- Story 17's modules: grader forms, Graders step components, target/dataset pickers, YAML preview. **Reuse them; do not copy them.** If a story 17 component is not reusable as is, refactor it in this story and keep story 17's tests green.

## Decisions already made (do not revisit)

All of screen 7: header (unsaved-changes chip = number of differing leaf values between the loaded definition and the draft; Form | YAML toggle; **Run** button when the eval has runs), Definition card with separate labeled inputs (the artboard combines some for space), the target and dataset **Change** buttons reusing the wizard pickers in a dialog (no new design), the Graders list and Budget strip identical to the wizard, the right column **Changes to the file** (line diff between current file text and `derived_yaml`, `+a −b` count, findings under it; **no** calibration-warning line), YAML mode as a monospace text area validated through the validate endpoint with errors listed under it and refusal to switch back to Form while invalid, the footer note with the past-run count, **Discard changes** (confirm when dirty), **Save eval** (`PUT` with `base_hash`, disabled while errors exist), the `FILE_CHANGED` dialog (**Reload from disk** / **Keep editing**), and the leave-page confirmation. The "File edited outside the console? …" note is shown because the reload-and-ask behavior is built here: when the page gains focus, re-fetch `GET /api/evals/:id` and, if `file_hash` differs from the loaded one and the draft is clean, reload silently; if the draft is dirty, show an amber banner "The file changed on disk" with the same two actions.

## What to build

1. **`ui/src/redesign/evals/edit/editModel.ts`** (+ tests): pure model: loading state from `EvalDetail`, draft vs loaded diff and the unsaved count (leaf-value diff over the definition JSON), mode switching rules (Form ↔ YAML with validation gate), save request building and conflict state machine, discard rules, dirty-on-focus handling.
2. **`lineDiffView.ts`** (+ tests) if the story 05 line diff helper is server-only: a small client function to diff two strings by lines for the panel. (Use the same algorithm; the UI may not import server code, so duplicate the ~40-line LCS diff with its tests rather than adding a dependency.)
3. **Components:** Edit page, Definition card, YAML view, diff panel, conflict dialog, dirty banner, change-target/dataset dialogs.
4. **Routing:** replace the `evalEdit` placeholder; `#/evals/<id>` redirect rule (latest run if any, otherwise Edit) if story 16 left it as a placeholder; "No runs yet" banner with a **Run** button on Edit when `runs_count = 0`.
5. **Entry points:** the **Edit eval** button on the results header (story 20 already links here), and the list's "Needs fixing" rows.

## Acceptance

- [ ] Opening an eval shows the loaded definition in Form mode; changing a default, editing a rubric and reordering graders updates the unsaved count and the diff panel (equal to `derived_yaml` vs the file text).
- [ ] Save sends `PUT` with `base_hash` and shows the saved state; the loaded hash updates from the response; unsaved count returns to 0.
- [ ] A `FILE_CHANGED` response shows the dialog; **Reload from disk** replaces the draft; **Keep editing** keeps it and Save stays blocked until reload.
- [ ] YAML mode: edits validate; errors list with line numbers when present; Form is refused while invalid; valid YAML switches back and the form shows the parsed values.
- [ ] Change target / Change dataset open the wizard pickers in a dialog and update the draft; the dataset change re-validates (cases skipped warning appears in findings).
- [ ] Errors block Save; warnings do not.
- [ ] Leaving with unsaved changes asks for confirmation; Discard asks only when dirty.
- [ ] Focus re-fetch: clean draft + changed file reloads silently; dirty draft + changed file shows the amber banner.
- [ ] Model tests: leaf diff counting (rubric text, reorder counts as changed, add/remove), mode gate, conflict machine, focus handling; `npm run ui:test`, `npm run ui:build`, `npm run typecheck` pass.
- [ ] Visual check against artboard `now` except documented deltas.

## Out of scope

Calibration UI, an inline-validating code editor (A10), deleting evals.

## Open questions

_(agent fills; stop and ask the owner)_
