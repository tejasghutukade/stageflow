# 18: Datasets: detail page and upload dialog

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 16

## Why this story exists

Datasets are managed in the console: browse and edit cases, see which fail the stage's input, upload more, add from past runs. The upload dialog is also used by the New eval wizard.

## Read first

- [ui-map.md](../../specs/evals-ui-map.md) screen 3 (all of it).
- [dataset-format.md](../../specs/evals-dataset-format.md) (formats, upload mapping, editing rules, atomic writes), [api-cli-mcp.md](../../specs/evals-api-cli-mcp.md) "Datasets".
- Wonder artboards `dog` (Dataset detail) and `zip` (Upload dialog).
- `ui/src/redesign/shell/DataTable.tsx`, `Inspector.tsx`, `PageHeader.tsx` and an existing redesign table page (`ui/src/redesign/tasks/TasksRedesign.tsx`) for table and header patterns; `ui/src/redesign/overlay/` for dialog patterns; `ui/src/redesign/triggers/NewTriggerModal.tsx` for a modal.
- The Dataset API client from story 13.

## Decisions already made (do not revisit)

Everything in ui-map.md screen 3: left rail, header actions, the invalid banner (invalid cases are skipped at run start), tabs and the Table/JSONL toggle, columns from `input_fields`, inline cell editing with autosave on blur through `PATCH` with `base_hash` and the `FILE_CHANGED` handling, read-only `.json`/`.csv` with **Convert to JSONL**, the Add case dialog fields, delete with confirm, the upload dialog's stage-aware mapping and preview with Ready/Skipped, the append/replace radio, and **Add from runs**. Paging is 25 per page. Cells for non-string input fields edit as JSON text and are validated before saving.

## What to build

1. **`ui/src/redesign/evals/datasets/datasetModel.ts`** (+ tests): pure view model: tab counts, filtering, paging, columns (including the max-2 `expected.*` rule and "+n"), row check labels, cell edit parsing (string vs JSON by schema type) and the `PATCH` op builder, save-state machine (idle/saving/saved/conflict).
2. **`uploadModel.ts`** (+ tests): pure model for the upload dialog: auto-matching columns to stage input fields by name (case-insensitive, `_`/`-`/space equivalence), mapping rows, the `split` control, building the `preview` request, summarizing counts ("12 cases ready · 2 skipped because plan is empty"), and the append/replace request builder.
3. **Components:** the Datasets page (rail, header, banners, table, JSONL view, paging, footer), cell editor, Add case dialog, delete confirm, Convert banner, **Upload dialog** (file input + paste mode, CSV delimiter select, mapping, preview, radio, buttons), **Candidates dialog** ("Add from runs"), **New dataset** flow from the rail's "+ New" (name + upload dialog without stage mapping: "Pick fields to import").
4. **Routes:** replace the `datasets` and `datasetDetail` placeholders from story 16; `?eval=` selects which eval's stage the checks use.
5. Export the upload and candidates dialogs for story 17 (`ui/src/redesign/evals/datasets/index.ts`).

## Acceptance

- [ ] `#/datasets/<id>` renders a fixture dataset with the invalid banner, tabs and counts, columns from the stage input, and a valid/invalid "Input check" column (visual check against `dog`).
- [ ] Editing a cell and leaving it sends one `PATCH` `update` op with the current `base_hash`; the footer shows Saving then Saved; a `FILE_CHANGED` response shows the reload message and drops the edit.
- [ ] A `.csv` dataset is read-only with the Convert banner; **Convert** calls the convert endpoint and navigates to the new dataset.
- [ ] Add case creates a case with the next `cNNN` id; Delete asks for confirmation then sends a `delete` op.
- [ ] The upload dialog auto-matches same-named columns, shows live preview statuses from the preview endpoint, shows the summary line, honors append vs replace, and adds only ready rows (visual check against `zip`).
- [ ] The candidates dialog lists past runs and adds the selected cases.
- [ ] Model tests: column auto-match (including `diff_text` not matching `diff`: left unmatched), type-aware cell parsing, op building, counts text, paging boundaries, tab filters.
- [ ] `npm run ui:test`, `npm run ui:build`, `npm run typecheck` pass.

## Out of scope

The wizard (17), results (20). Server changes.

## Open questions

_(agent fills; stop and ask the owner)_
