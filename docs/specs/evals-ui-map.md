# Console UI map

Part of the [Evals epic](evals.md). Maps every screen to its Wonder artboard, route, API calls and behavior. Used by stories 16–23.

Wonder file page `01a10d0c-ed8b-7da6-9e8d-e66daac1c0cd`. Artboard ids are given as `(id)`; open them with the Wonder tools (`get_design_context`, `take_screenshot`) rather than guessing. **The artboards show layout, copy, spacing and states; this file and the other specs define behavior and data.** Numbers in artboards are invented.

## Ground rules for all UI stories

- Read `ui/AGENTS.md` first. Follow the Astryx workflow it describes and the "Chrome exception" for shell primitives. Use design tokens, never raw hex or px.
- Build **only the redesign version** (`ui/src/redesign/evals/`). Evals are new, so there is no legacy page and no `useRedesign()` branch. Mount pages from `ui/src/App.tsx` the way `route.name === "triggers"` is mounted, with thin wrappers in `ui/src/pages/` only if the existing pattern needs them (look at `TriggersPage.tsx` and `redesign/triggers/`).
- Put logic in **pure functions beside the components with `vitest` tests** (the existing pattern: `triggerListModel.ts` + `triggerListModel.test.ts`). The list-row model, status labels, the wizard's state machine, YAML preview, input-mapping logic, run-dialog options, compare tables, and number formatting are all pure and tested. Components stay thin.
- Data comes only from the API in [api-cli-mcp.md](evals-api-cli-mcp.md) through `ui/src/api/` (`client.ts` and `types.ts`; follow how triggers are fetched). No component computes statistics; it formats what `stats` contains.
- Number formatting: percentages one decimal (`87.5%`), score two decimals (`0.86`), cost `$0.64` (two decimals; `< $0.01` below a cent), durations `3.9 s` / `3 m 41 s`, token counts `142k` / `2.1k`, points `+2.1 pts`. One shared formatter module `ui/src/redesign/evals/format.ts` with tests.
- Polling: eval run pages poll `GET /api/evals/:id/runs/:runNumber` every 1.5 s while status is `queued` or `running`, then stop. Use the existing polling approach in the run pages.
- Every list and table has an empty state and an error state; the designs show the main empty state only. Use the same pattern as other console pages.
- Keyboard: the Evals list supports `↑ ↓` to move and `Enter` to open (the design's footer hint), like other redesign lists (look at `triggers/TriggersRedesign.tsx`).

## Routes (added to `ui/src/routes.ts` and `routeNav.ts`)

| Route | Screen |
|---|---|
| `#/evals` | Evals list, or the empty state when no evals exist |
| `#/evals/new` (+ `?pipeline=<path>&stage=<id>` or `?file=<path>`) | New eval wizard; the query preselects the target. Wizard step is client state, not in the URL |
| `#/evals/<id>` | If the eval has runs: redirect to its latest run. Otherwise redirect to `#/evals/<id>/edit` |
| `#/evals/<id>/edit` | Edit eval |
| `#/evals/<id>/runs/<n>` (+ `?tab=overview\|cases\|graders\|config`) | Run results (tab default `overview`), or the live progress screen while the run is `queued`/`running` |
| `#/evals/<id>/runs/<n>/case/<caseId>` (+ `?repeat=<i>`) | Run results with the case drawer open |
| `#/evals/<id>/compare?a=<n>&b=<m>` | Compare runs |
| `#/datasets` | Redirects to the first dataset, or shows the Datasets empty state ("No datasets yet. Add one when you create an eval.") |
| `#/datasets/<id>` (+ `?eval=<evalId>`) | Dataset detail |

Nav: **Evals** item in the **Build** group of `ui/src/redesign/shell/navConfig.ts`, after Catalog, icon `LuFlaskConical` (P12). Check `CommandPalette.tsx` and the palette module for nav lists that need the same entry; add "Evals", "New eval" and "Datasets" commands matching how other pages register theirs.

## Screens

### 1. Evals list and empty state: artboards `one` (list), `ict` (empty)

API: `GET /api/evals` (status, banner, footer included), `GET /api/eval-engine` (to show the engine banner).

- Header: title, subtitle "Check a stage before you ship it. Each eval runs a stage against a dataset and grades every result.", buttons **Datasets** (→ `#/datasets`) and **New eval** (→ `#/evals/new`).
- **Regression banner** from `banner` when not null; "Compare runs ↗" → `#/evals/<id>/compare?a=<previous>&b=<last>`.
- Filter tabs: **All n**, **Stages n** (count of stage-target evals; same as All in release 1), **Agents** with a "soon" label and no behavior, **Regressed n** (status `regressed`). Search box filters by eval id, name, stage id and dataset (client-side over the loaded list).
- Table columns: **Eval** (name; description under it), **Target** (a "Stage" chip, `<pipeline id> · <stage id>` or the file stem, path under it), **Dataset** (name; `<type> · <n> cases · <repeats> repeats` or `sample data` for the shipped sample), **Last run** (pass rate, delta in points, bar; "— Not run yet"), **Trend** (7 dots), **Cost / run**, **Status** (dot + word). Row click → `#/evals/<id>`. Chevron on the right.
- Under the table, one line of guidance. If any eval is `saturated`: "<id> passes every case, so it can no longer show improvement. Move it to a regression eval to keep guarding it, and add harder cases to a new capability eval." (the designed copy). Otherwise omit it. Footer from `footer`: "N evals in evals/ · N datasets in datasets/ · $X in the last 7 days".
- Invalid evals (`valid: false`) show a "Needs fixing" status in place of the dot status and open the Edit page.
- **Empty state** (no evals): icon, "Know if a stage got better or worse", the designed paragraph, buttons **Try the sample eval** (`POST /api/evals/sample`, or just open it if `SAMPLE_EXISTS`, then go to its Run dialog) and **Create your own** (→ `#/evals/new`), the "about $0.06" line is shown only if the sample's cost is known (it is not in release 1: omit the cost sentence), and the three step cards (Pick a stage / Add data / Decide what good looks like). Footer "Evals live in evals/ and datasets in datasets/, beside your pipelines." / "No evals yet".
- **Engine banner:** when `GET /api/eval-engine` says not installed or `node_ok` false, show a banner above the table: the reason and the command to run (`sf eval engine install`) with a copy button. "Run eval" actions stay clickable and surface the server's `EVAL_ENGINE_UNAVAILABLE` message.

### 2. New eval wizard: artboards `out` (Setup), `mru` (Graders); **Review step is not designed**

Stepper: **1 Setup → 2 Graders → 3 Review and run**. Nothing is written until the final step (footer note on Setup: "Nothing is written until you create the eval. It will be saved as evals/<id>.eval.yaml."). Client state holds the draft definition, the draft dataset (cases not yet written), and the target. A pure state machine module owns it.

**Setup (`out`)**

- Section 1 **Target**: a "Stage" / "Agent soon" toggle (Agent disabled); a searchable list of stages. The list is the stages of the project's pipelines plus standalone stage files: rows show stage id, model, the pipelines using it, and "N evals" (from `GET /api/evals?target_*`). Source: the existing catalog/pipeline listing endpoints (`/api/pipelines` and stage listing used by the Catalog page; story 17 names the exact ones after reading `ui/src/api/`). Selecting a stage shows its `io.input` fields as chips under the list ("Every case needs these fields"). Preselected when opened with a query.
- Section 2 **Dataset**: four tiles: **Upload a file** (JSONL, JSON or CSV), **Paste or type** (opens the upload dialog with a text area instead of a file picker; format detected: JSONL if every non-blank line starts with `{`, else CSV), **From past runs** (the candidates dialog, `GET /api/datasets/candidates`), **Try sample data** (8 demo cases; disabled with the reason when the sample is incompatible with the selected stage, see [dataset-format.md](evals-dataset-format.md#sample-dataset)). After a dataset exists: a summary card (file name, `n cases`, `all match io.input` or `k skipped`, the path it will be written to, **Replace**) and a preview table of the first 3 cases.
- Section 3 **Run defaults**: Repeats per case, Judge model (picker of judge-capable models; the amber "Same model as the stage…" hint when equal), Pass threshold (percent input, stored as 0–1), Cost limit per run, and the **Capability / Regression** radio cards with the designed explanations.
- Right column: **live YAML preview** (`POST /api/evals/validate` with the draft, debounced 300 ms; shows `derived_yaml`), **Checks** list from `findings` plus fixed checks ("Stage <id> found in <path>", "n of m cases match the stage's io.input", the judge warning, "No graders yet. Add at least one next."), and **"About $0.64 per run"** from the estimate endpoint (if `estimate_usd` is null show "No cost history yet").
- The eval id is derived from the stage id as `<stage-id>-eval` (slugified; `-2`, `-3` if taken) and edited on the Review step.
- Buttons: **Cancel** (→ `#/evals`), **Continue to graders** (enabled when a target, a dataset with ≥ 1 valid case, and valid defaults exist).

**Graders (`mru`)**

- Left: **Graders n** list, **Add grader** menu (types: Schema, Field check, Reference match, Rubric, Custom code; **no Command**: delta 1), a card per grader: drag handle (reorder = file order), type chip (Check for schema/field/reference/code, Rubric for rubric), id (monospace), one-line description, weight (`×2`), "must pass" chip, chevron. Expanded card = that type's form:
  - `schema`: read-only line "Output matches <schema file>"; must-pass toggle.
  - `field`: rows of `path`, `op` (select), `value`; add/remove check; description, weight, must-pass.
  - `reference`: mode select, `path`, `expected` path, `pass_at`, description, weight, must-pass.
  - `rubric` (designed): "What the judge looks for" textarea, Scale (Pass / fail, 1 to 5), Weight, Judge model (default "Eval default"), **Examples n** with "Add example" (PASS/FAIL rows showing output text and reason; edit/remove). **No Judge calibration card** (A10): in its place a muted line "Not calibrated. Rubrics are judged by a model and are not checked against your own labels yet." Badge on the collapsed card: "Not calibrated".
  - `code`: a monospace textarea for the function body with a one-line hint of the signature and return shapes.
- A **Budget** strip at the bottom: latency and cost chips, each editable inline ("Reported as warnings, they do not fail a case").
- Right: **Try on one case**: a case select (the draft dataset's cases), **Run** (calls `POST /api/evals/try` with the draft definition and the inline case; shows "Stage output: n findings" is mockup copy: show `output.summary`, then the grades list with pass/fail or score, and "Case score 75%" with "Just under the 80% threshold" text computed from the threshold, time and cost). While running show a spinner; errors show the error code message. Below it, the **Grader types** reference panel (remove the Command row).
- Footer: "n graders · scored graders add up to a weight of w · a run passes at t% or higher." Buttons **Back**, **Continue to review**.

**Review and run (not designed; build this exactly)**

A single column: (1) **Name** (the eval id, editable, validated against the id pattern and uniqueness) and **Description** inputs; (2) a read-only summary of target, dataset (n cases, k skipped), defaults, and each grader as a one-line row; (3) the **findings** list from validate (errors block, warnings do not); (4) the **file path** it will write and the estimate line; (5) the final YAML in a read-only code block. Buttons: **Back**, **Create eval** (writes the dataset if it is new, then the eval; goes to the Evals list), **Create and run** (same, then opens the Run dialog on the new eval's page). If writing the dataset succeeds and the eval fails, show the error and keep the dataset (say so in the message).

### 3. Datasets: artboards `dog` (detail), `zip` (upload dialog)

API: `GET /api/datasets`, `GET /api/datasets/:id`, `POST /api/datasets/preview`, `POST /api/datasets`, `PATCH /api/datasets/:id/cases`, `POST /api/datasets/:id/convert`, `GET /api/datasets/candidates`.

- Left rail: **DATASETS** list (name, `n cases · used by k eval(s)`; the shipped sample shows a "sample" chip and "ships with Stageflow"); **+ New** (opens the wizard-independent "New dataset" flow: name input then the same Upload dialog; creates an empty-target dataset: with no target the dialog skips the stage mapping and imports rows as `input` = the row fields. State this limit in the dialog: "Pick fields to import").
- Header: name, format chip (`jsonl`), `n cases for the <stage> stage · used by <evals> · <path> · edited <relative time>`. Buttons **Upload cases**, **Add from runs**, **Add case**. For `.json`/`.csv`: the table is read-only and a banner offers **Convert to JSONL** (P5).
- **Invalid banner** when `invalid_total > 0`: "k of n cases do not match the stage's input. <first reason>. They are skipped in runs until fixed." with **Show invalid**.
- Tabs `All n`, `Invalid k`, `Tagged t`; **Table / JSONL** toggle (JSONL view shows the raw file text, read-only); search; paging (25 per page, "Showing 1 to 25 of n").
- Table columns: `#`, one column per `input_fields` entry (cell text truncated to two lines), `expected.*` columns (one per top-level key found in cases' `expected`, max 2 shown then "+n"), **Tags** (chips), **Input check** (green "Valid" or amber reason). Invalid rows are highlighted.
- **Cells are editable inline** for editable datasets; leaving a cell saves one `PATCH` `update` op with the dataset's current `base_hash` (the footer shows "Saving…" then "Saved"; on `FILE_CHANGED` show "The file changed on disk. Reload." with a Reload button and drop the unsaved edit). Footer note: "Changes save to <path> when you leave a cell. Commit the file to keep it in git."
- **Add case**: opens a dialog with fields `id` (prefilled next `cNNN`), `title`, one input per `input_fields` entry (multi-line text; a JSON textarea for non-string properties), `expected` (JSON textarea), `tags`. Not designed; build it plainly. **Delete case**: row action with a confirm.
- **Upload dialog (`zip`)**: file chosen (name, size, "n rows found", **Choose another file**), **MATCH COLUMNS TO THE STAGE'S INPUT** rows (field name, required/optional/reference label, `←`, a select of source columns, a tick when valid; `expected.findings` row has "(split on ;)" via a small split-character control), **PREVIEW** (first 5 rows with Ready / Skipped and reason), radio **Add to the n cases already here / Replace all cases**, summary line "12 cases ready · 2 skipped because plan is empty", **Cancel / Add 12 cases**. The preview is recomputed (debounced) through `POST /api/datasets/preview` on every mapping change. Format is detected from the file extension; a delimiter select appears for CSV.
- **Add from runs**: a dialog listing `GET /api/datasets/candidates` rows with checkboxes, a preview of each input, **Add n cases**.

### 4. Run dialog and live progress: artboards `tub` (dialog), `spa` (live)

Dialog opens from: the list row action "Run", the results header **Run again**, the Edit page **Run**, and the Catalog inspector. API: `GET /api/evals/:id/runs/estimate`, `POST /api/evals/:id/runs`.

- Title "Run <id>", subtitle "Stage <stage> · dataset <dataset> · n graders".
- **Which cases**: segmented **All n** / **Failed last time · k** (disabled when there is no completed run; sends `only_failed_from`) / **Pick cases** (a list with checkboxes and search; sends `case_ids`).
- **Repeats per case** (1–10), **Cost limit** (`max_cost_usd`), **Stage model** (a select with "Stage default · <model>" first, then the catalog; sends `model` only when changed; helper "Try another model without editing the stage"), **Judge model** (select with "Eval default · <model>" first; the amber same-as-stage hint).
- Checkbox **Compare with Run #n when it finishes** (default on when a completed run exists): the UI remembers `a`=that run and, when the new run finishes, navigates to Compare; it sends nothing to the server.
- Estimate box from the estimate endpoint: "About $0.64 and 3 m 40 s" and "72 stage calls and 144 judge calls, based on run #14", right side "stops at $2.00". Missing history texts per [cost estimate](evals-result-schema.md#cost-estimate).
- Footer "Runs on this machine with your connected providers." **Cancel**, **Run eval** (→ start, then `#/evals/<id>/runs/<n>`). Errors from start (`EVAL_INVALID`, `EVAL_RUN_ACTIVE`, `EVAL_ENGINE_UNAVAILABLE`) show inline above the buttons with the server message.
- **Live progress (`spa`)** is the same route as results while the run is `queued` or `running`: title with a "Running" chip, subtitle, **Stop run** (`POST …/cancel`, confirm "Stopping keeps the results so far."). Progress card: "n of N results graded · k in progress", a stacked bar (passed / failed / running / queued), counts, then four tiles: **Passing so far** (passed ÷ executed so far), **Cost so far of $limit limit**, **Elapsed**, **Estimated left** (`elapsed / results_done × remaining`, "—" until 3 results are done). **Results as they arrive** table: Case (`#position`), Input (title or id), Repeats (dots: green passed, red failed, blue running, grey queued), Score (mean of finished repeats), **Now** ("Stage is running repeat 3", "Judge is grading repeat 3", "Done", "Queued", from `live`). Footer "The run stops by itself if it reaches the $limit limit. Stopping keeps the results so far." When the run finishes the page switches to Overview (or to Compare if the checkbox was set). `budget_stopped`, `failed` and `cancelled` runs open the results with a banner stating the reason and that results are partial.

### 5. Results: artboards `but` (Overview), `tee` (case drawer), `tic` (Config); **Cases and Graders tabs are not designed**

API: `GET /api/evals/:id/runs/:n`, `GET …/results`, `GET …/results/:caseId`, `PUT …/review`, `GET /api/evals/:id/failure-types`, `POST /api/evals/try`, `GET /api/eval-runs/:id/export`.

- Header: breadcrumb `Evals / <id> / Run #n`; title; chips `Run #n`, type (`Capability`), result chip (`Passed · 87.5% vs 80% threshold` green, `Below threshold · 78.3% vs 80%` red, or the status for incomplete runs); subtitle `Stage <stage> in <pipeline> · <dataset>, <cases> cases × <repeats> repeats · judge <judge> · finished <relative> in <duration>`. Buttons: **Edit eval** (→ edit), **Compare with #<previous>** (→ Compare; hidden for run 1), **Export** (downloads `export?what=results`), **Run again** (opens the Run dialog). Tabs: **Overview, Cases n, Graders n, Config**.
- **Overview**: KPI strip of six tiles (Pass rate with "x of N results · 95% CI a to b (by case)"; Mean score with "±spread across repeats"; Reliability · pass^k with "x of n cases pass every repeat · pass@k y% · z cases flip" (hidden when repeats = 1); Latency p50 with "p95 …, slowest …"; Cost with per-result and judge parts; Tokens with in/out). **By grader** card: rows (type chip, id, pass-rate bar and %, Mean, Range, "vs #previous" delta from `by_grader[].delta`, "—" / "grader changed" when null); header text "Where the misses come from". **Score per result** histogram with the threshold marker and the flaky-cases note ("n cases gave a different verdict on different repeats. Cases a, b, c … Treat a single run on these as noise."). **Failure types** card ("n failed results", the tags with bars and counts, "Not reviewed yet" row; empty state: "Tag failed results in the case drawer to see them grouped here."); clicking a row opens the Cases tab filtered by that tag. **Failing and flaky cases** card: `failing_cases` first 5, columns Case (`#position`), Input (title), Repeats dots, Score, Failed graders, Time, Cost, chevron; **All n cases →** link to the Cases tab. Footer: "Stage version <hash6> · eval file <path> · stored on this machine"; right "Run #n of N" with previous/next arrows.
- **Cases tab** (build as specified here): filter tabs **All n, Failed k, Flaky k, Errored k, Passed k**, a grader filter select, a tag filter select, search; the same row layout as "Failing and flaky cases" over all cases, paged 25; row click opens the drawer.
- **Graders tab** (build as specified here): one row per grader: type chip, id, description, weight/must-pass, pass rate with bar, mean, range, errors count, delta; expanding a row shows the grader's definition summary (rubric text or checks) and its five lowest-scoring cases linking to the drawer; link "Show all failing cases" → Cases tab filtered by that grader. For rubric graders also list judge model, judge tokens and judge cost.
- **Config tab (`tic`)**: built from `config` and `components` exactly as designed: fingerprint strip; Stage card (stage file or pipeline/stage, version hash with the amber "edited since: now <hash>" chip when the current stage hash differs, model with thinking level if present, output schema file and hash); Dataset card ("unchanged since this run" green or amber "edited since" when the current dataset hash differs; file, content hash, "cases run: n of m · k skipped", input schema); Graders card (id, kind, weight/×, hash6, rubric version `v<ordinal>` from `eval_grader_versions` and the "Not calibrated" chip); Run settings card (judge model with the amber same-as-stage chip, repeats · threshold · limit with spent amount, suite type, software versions); Reproduce card with the `sf eval run <path> --repeats n --judge <model>` command and **Copy command**, **Export JSON** (`export?what=config`), **Re-run with these settings**. **Re-run behavior:** starts a run with overrides equal to the snapshot's `repeats`, `judge`, `model` (only when it was an override), `max_cost_usd` and the same case ids if a subset ran. It **cannot** restore an older stage, dataset or grader version; when the current hashes differ the button shows the amber note "The stage/dataset/graders changed since this run; this will use the current ones." Rename the designed label "Re-run with this config" to **Re-run with these settings**.
- **Case drawer (`tee`)**: opens from a row (`#/evals/<id>/runs/<n>/case/<caseId>`); header `<eval> · Run #n · case i of N` with previous/next case arrows and close; title (case title or id) with a **Flaky** chip when flaky; repeat tabs (**Repeat 1 0.93**, dot colored by pass/fail); **INPUT** (the case input as `key: value` lines, long values scroll); **OUTPUT · STAGE ENVELOPE** with `time · cost · tokens`, the summary and the payload as monospace key paths; **EXPECTED FINDINGS** checklist built from the `reference` grader's `details.items` (green ✓ found, red ✗ "not in output"), shown only when a reference grader exists; **GRADES FOR REPEAT n**: one row per grader (✓/✗, id, `pass`/score/`3 / 5`, and the reason text for failures; error grades show the error code message); **Your review**: Pass / Fail toggle (`label`), "What went wrong?" tag chips from the failure-type vocabulary plus **+ New tag**, **Why (a sentence is enough)** input, **Save review** (`PUT review`); tags are enabled only for results with `passed = 0`; copy line under the toggle: "The judge also said fail for repeat 2. You agree." only when the label agrees with the system result, and "You disagree with the grade." otherwise (no mention of calibration). Footer: **Open stage run** (→ the stage run's page in the console, hidden when the run was purged), **Re-run this case** (`POST /api/evals/try`, shows the new result inline above the grades as a temporary "Re-run" panel, not stored), **Edit case in dataset** (→ `#/datasets/<dataset>?eval=<id>` focused on the case).
- Errored results (`status ≠ completed`) show the error code and message in place of output and grades.

### 6. Compare: artboard `est`

API: `GET /api/eval-compare?a=&b=`, `GET /api/evals/:id/runs` list for the two pickers.

- Header "Compare runs", subtitle "See what changed in the stage and what that did to the results."; **Before** and **After** pickers (`Run #13 · 85.4%`), arrow between.
- **What changed in stage <id>** `<hash a> → <hash b>`: from `stage_diff`: the prompt line diff (red/green lines, max 12 lines then **View full diff** expands), and the line "System prompt edited · model, tools and io.output unchanged" built from `changed_keys` (list which keys changed and "<other keys> unchanged"). Hidden when `stage_diff` is null ("Stage unchanged").
- **Held constant / Changed** strip from `components` (designed copy: "Held constant dataset 9b41c0 · graders rubric v3 · judge … · 3 repeats" and "Changed stage version a → b"). If the datasets or graders differ, the strip says so in amber and the warnings from the result are listed under it.
- KPI strip: **Pass rate** `a → b`, `+2.1 pts · 95% CI −6 to +10 · inconclusive` (verdict words: `improved`, `regressed`, `inconclusive` for `no_clear_difference`, `not enough shared cases`), **Mean score**, **Flaky cases** `5 → 3 · −2 steadier`, **Latency p50**, **Cost per run** (percentage change). No explanatory notes beyond what the data supports (the mockup's "longer prompt" note is not built).
- **By grader**: rows with `a%`, `b%`, a centered delta bar, `+6.2 pts`; "no change"; "changed" for graders whose hash differs.
- **Cases that changed**: tabs **Fixed n**, **Regressed n**, **Unchanged n**; rows: `#position`, title, before dots → after dots, `+0.42` score change, the `graders_changed` ids; row click opens the drawer of run `b` for that case.
- Footer note (computed): "Differences are paired by case. A change counts as real only when its 95% interval excludes zero. With <m> cases only large changes show up; about <cases_needed_5pts> cases are needed to detect 5 points." and the right-hand chips ("Same dataset · same graders · same judge" or what differs).

### 7. Edit eval: artboard `now` ("Page - Edit Eval - Form And YAML")

API: `GET /api/evals/:id`, `POST /api/evals/validate`, `PUT /api/evals/:id`, plus the target and dataset pickers.

- Header: breadcrumb `Evals / <id> / Edit`; title "Edit eval"; description "Everything in evals/<id>.eval.yaml can be changed here. The form and the YAML stay in sync."; right: **N unsaved changes** chip (number of differing leaf values between the loaded definition and the draft; hidden at 0), **Form | YAML** toggle, and for an eval with runs a **Run** button (opens the Run dialog).
- **Form mode:** a **Definition** card (Name, Description, Target stage with **Change**, Dataset with **Change**, Repeats and Pass threshold, Judge model and Cost limit and Suite type; the artboard combines some fields in one input for space; build them as separate labeled inputs) followed by the **Graders** list and Budget strip, identical to the wizard's Graders step. **Change** (target/dataset) opens the same picker as the wizard's Setup step in a dialog (A10: reuse, no new design). The right column replaces "Grader types" with **Changes to the file**: a line diff between the current file text and `derived_yaml` (`POST /api/evals/validate`, debounced 300 ms), `+a −b` count, and notes: an amber "Rubric text changed" line is **not built** (calibration is not built), instead show findings (errors red, warnings amber). Keep the "File edited outside the console? It reloads here and asks before overwriting." note only if the reload-and-ask behavior is built (below).
- **YAML mode** (A10): a monospace text area holding the draft YAML (initially `derived_yaml`); edits are validated through `POST /api/evals/validate` with `yaml`; errors list under the area with line numbers when the finding has them; switching back to Form re-parses the YAML and fails with the findings if it is invalid (stay in YAML mode).
- **Footer:** note "Saving rewrites evals/<id>.eval.yaml. The k past runs keep the version they used." (k from `runs_count`); **Discard changes** (confirm when there are unsaved changes), **Save eval** (`PUT` with `base_hash`; on `FILE_CHANGED` show a dialog "The file changed on disk since you opened it" with **Reload from disk** (discards the draft) and **Keep editing**; Save is disabled while errors exist).
- Leaving the page with unsaved changes asks for confirmation.
- **Run results header has an "Edit eval" button** (artboard `but`) → this page.

### 8. Catalog entry point: artboard `cha`

The Catalog stage inspector (`ui/src/redesign/catalog/`): add the **EVALS n** section (with "+ New eval" → `#/evals/new?pipeline=…&stage=…`): rows (eval id, `n cases · last run <relative>` or "never run", pass rate with a small bar, chevron → `#/evals/<id>`), the guidance line "Run an eval before you save changes to this stage.", and an **Evaluate** button in the footer beside Edit stage (→ the eval's Run dialog if exactly one eval exists, otherwise `#/evals/new` preselected; with ≥ 2 evals open the list filtered to that stage: `#/evals?stage=<id>`). Data: `GET /api/evals?target_pipeline=…&target_stage=…` (or `target_file`). For a stage used by several pipelines, evals are listed for every pipeline entry it appears in, labeled with the pipeline id.

---

# Release 2: agents

Part of the [Evals for agents plan](evals-agents.md). Everything above is release 1 and stays; this section adds the agent screens and states. Used by A11 (Wonder design pass), A12 (build) and A13 (entry points). **A11 artboards (Wonder page `01a10d0c-ed8b-7da6-9e8d-e66daac1c0cd`):** setup `dvd`, real-tools warning `sup`, run dialog consent `two`, scenario editor `sow`, upload mapping `aug`, graders `mai`, try on one case `fri`, case transcript tab `has`, results/config/compare `vcr`, states `lot`; details in [evals-agents-design-handoff.md](evals-agents-design-handoff.md). **Pending A11:** artboard ids are filled in by A11 (`docs/specs/evals-agents-ui-design.md`); until then the layout follows the release 1 artboards and the copy below. Behavior and data come from this section and the other release 2 contracts. Ground rules above apply unchanged (redesign only, pure `*Model.ts` + tests, formatting only, `format.ts`, 1.5 s polling, empty/error states, `ui/AGENTS.md`).

## Routes

No new routes. Query additions: `#/evals/new?agent=<id>` preselects an agent target; `#/evals?agent=<id>` filters the list (dismissible chip, mirrors `?stage=`); `#/evals/<id>?openRun=1` opens the Run dialog (A13). The case drawer route gains `?tab=transcript` on `#/evals/<id>/runs/<n>/case/<caseId>`. Agent pages link back with `#/evals/<id>/runs/<n>/case/<caseId>`; the transcript links to the existing Agent run page by session id (route built with `agentRunPath`).

## 1. Evals list (changes to screen 1)

- The **Agents** filter tab is live (was "soon"): count of agent-target evals; **Stages n** counts stage-target evals; **All** both.
- The Target column shows an **Agent** chip (distinct from the Stage chip) and `<agent name> · r<revision>` with the model under it. Subtitle of the Dataset column for agents: `<type> · <n> scenarios · <repeats> repeats`.
- Empty-state copy for agents is not added; the empty state stays release 1 and the **Create your own** wizard covers agents.

## 2. New eval wizard (changes to screen 2)

**Setup, Target section.** The toggle is **Stage | Agent** (Agent live). Choosing Agent shows `GET /api/evals/agent-targets` as a searchable list. Row: agent name and id, model, `r<revision>` chip, tool risk badges (counts per class: Read, Write, Shell, External, Unknown MCP, Sub-agent), "asks first: billing.refund, bash" line, eval count. Archived rows are disabled with "Archived"; disabled agents are selectable with an amber "Disabled: evals bypass this" chip. Selecting shows a one-line tool summary and the **stubbed tools** hint (below). Preselected from `?agent=`.

**Setup, Dataset section.** Same four tiles. Differences: tile 3 is **From past sessions** (finished sessions of the agent); "Try sample data" is the agent sample (A14) and is disabled with a reason if the selected agent is not compatible. After a dataset exists the summary card says `n scenarios · all valid` or `k skipped`, the preview table shows Mode, Title, Opening or first script message.

**Setup, Conversation card** (new section between Dataset and Run defaults, agent targets only). Fields and defaults:

| Field | Control | Default | Helper |
|---|---|---|---|
| Mode | segmented **Script / Simulated** | Script | "Script plays fixed user messages. Simulated lets a model play the user from a persona and goal." |
| Max turns | number 1-30 | 8 | "User turns per case. Reaching it is not a failure." |
| Turn timeout | number (seconds) 5-600 | 120 | |
| User model (Simulated only) | judge-capable model picker | "Same as judge" | "Plays the user. Costs tokens on every turn." Error if unsupported (`eval.simulator_unsupported`). |
| Tools | radio **Read only / Mocked / Real** | Read only | see copy below |
| Approvals | select **Record only / Deny / Auto-approve reads** | Record only | quiet note below |
| Read-only tools | editor: list of tool ids (`server.tool`, `server.*`) with suggestions from the agent's unknown MCP tools | empty | "Tools not listed as read-only are stubbed." |
| (footer line) | | | "Eval limits replace the agent's own limits for these runs. The agent file is not changed." |

Copy (fixed; A11 designs it):

- **Tools / Read only**: "The agent can read. Anything that writes, runs commands or calls outside services is not executed: the agent is told it was not run, and the call is recorded."
- **Tools / Mocked**: "Only tools with a mock in the scenario return its canned result; reading tools run; everything else is not executed. Mocks reach the agent as error-flagged results, so behavior is approximate."
- **Tools / Real** warning, shown persistently inside the card (not only a color: warning icon, bold lead, and an "I understand" checkbox that sets `allow_real_tools: true` in the definition): "**Real tools can change your project.** Every tool this agent has will run for real on this machine, including write, shell and outside services. Use a throwaway copy of the project, or switch to Read only." The Review step repeats it as an amber finding (`eval.tools_real`); without the checkbox Create is blocked (`eval.real_tools_not_allowed`).
- **Stubbed tools hint** (under the agent picker and in the card when Read only): "n of this agent's tools are not read-only and will be stubbed: write, bash, billing.refund, ..." from `eval.tools_unstubbed_list`.
- **Approvals / Record only** (quiet text under the select): "Calls that would ask first are recorded and denied. Nothing reaches the Inbox."
- Right column: YAML preview as before; **Checks** list adds "Agent <id> found (r4)", "Agent disabled" (amber), "n of m scenarios valid", the simulator/judge warnings; the estimate box adds **Agent turns**, **Simulator** and **Judge** lines (`stage_calls` read as "conversations", `simulator_calls`) and, without history, "Rough estimate from typical conversations" from `estimate_basis: "assumptions"`.
- Eval id derived as `<agent-id>-eval` with `_` -> `-` (slugified, `-2`, `-3` if taken). Defaults written explicitly (repeats 3, pass threshold 0.8, cost limit 1, concurrency 2, `conversation.*`).

**Scenario editor** (replaces the stage Add case form; dialog or drawer, from the dataset table and the wizard preview). Fields: Mode (inherits the eval's mode, per-case switch), Title, Tags; for Simulated: Opening, Persona, Goal, Facts (list, add/remove); for Script: Script messages (ordered list, add, remove, reorder); Expected: Outcome (text), Tools (list), Forbidden tools (list); Tool mocks (table: tool id, `Result` JSON or `Error` text, add/remove). Per-field validation messages from the scenario check; JSON errors inline. Not shown: any field the effective mode ignores (collapsed under "Ignored in this mode"). Table view columns: `#`, Mode, Title, Opening / first message, Expected tools, Tags, Input check.

**Upload dialog (agent).** Mapping rows: Opening, Goal, Persona, Mode, Facts (split control), Expected outcome, Expected tools (split), Forbidden tools (split), Title, Tags. Notice under the rows: "Scripts and tool mocks need a JSON or JSONL file." Preview shows Ready/Skipped with the scenario reason.

**Graders step.** Add-grader menu for agents: Field check, Reference match, Rubric, Custom code, **Tool calls**, **Conversation check**, **Goal reached**; `Schema` is hidden (stage-only); for stage targets the three new types are hidden. Forms:

- `tool_calls`: chip inputs Must call, Must not call, Must ask first, number Max calls, and an Arguments table (tool, path, op, value). Helper: "Leave Must call and Must not call empty to use each scenario's expected tools." Names the agent does not have get an amber `eval.tool_not_granted`.
- `conversation_check`: Max turns, Max questions per agent turn, and Final reply checks (op/value rows).
- `goal_reached`: Judge model (default "Eval default"), Guidance textarea; fixed line "Judged on the whole conversation. Uses each scenario's goal."
- `rubric` card: extra line "The judge reads the conversation, capped in length."
- **Try on one case**: pick a scenario; **Run** (can take a minute; shows a spinner and a Cancel that aborts the request); shows the **transcript** (messages, tool chips with outcome badge), stop reason, the grades, cost and time. Disabled while error findings exist; honors the `real` consent.
- Grader types reference panel: rows for the three new types (no Command).

**Review step.** Adds the Conversation summary, the stubbed-tools note, and (Real) the amber warning with the checkbox state.

## 3. Datasets (changes to screen 3)

Dataset detail for a dataset used by an agent eval uses the scenario columns and the scenario editor above; `Invalid k` means scenarios that fail the check ("skipped in runs until fixed"). A dataset used by both kinds shows the mixed-use banner from [dataset-format](evals-dataset-format.md#attaching-a-dataset-to-an-agent-target). "Add from runs" becomes **Add from sessions** for agent targets (A13).

## 4. Run dialog and live progress (changes to screen 4)

- Subtitle `Agent <name> · r<revision> · dataset <dataset> · n graders`. The run uses the **current revision** shown; there is no revision picker (owner decision 5).
- Fields: Cases, Repeats, Cost limit, **Agent model** (select, "Agent default · <model>" first), **User model** (when any scenario is simulated; "Eval default · <model>"), Judge model.
- A read-only **Conversation** summary line: `Simulated · up to 8 turns · tools read only · approvals recorded`.
- **Real tools consent**: when the effective tools policy is `real`, an amber panel with the real-tools warning and a required checkbox "I understand this run can change files and call outside services." (sends `allow_real_tools: true`); **Run eval** is disabled until checked. Also a safer-override select **Tools for this run** (Eval setting / Read only / Mocked) and **Approvals for this run** (Eval setting / Record only / Deny); options that would be less safe are not offered.
- Estimate box: "About $X and N min" plus "n conversations, m simulator calls and j judge calls, based on run #n" or "Rough estimate from typical conversations", right side "stops at $limit", and a muted line "A conversation that has started always finishes, so the limit can be passed by a little."
- **Live progress**: same card and tiles; the **Now** column says "Agent is talking, repeat 3" / "Judge is grading repeat 3" (phase `agent_running`). A repeat whose result is `stage_failed` shows a red dot with the agent error label ("Agent failed", "Timed out"); `error` with `EVAL_SIMULATOR_ERROR` shows "Simulator error".

## 5. Results (changes to screen 5)

- Header subtitle: `Agent <name> r<revision> · <dataset>, <cases> scenarios × <repeats> repeats · judge <judge> · user <user model> · finished …`. Breadcrumb and buttons unchanged.
- **Overview**: two extra tiles, **Turns** (`mean_turns`, "per conversation") and **Tool calls** (`mean_tool_calls`, "per conversation"); the Cost tile's split reads "Agent / simulator / judge" (agent includes sub-agents). Everything else unchanged. Hidden when the API value is `null`.
- **Cases tab**: the Input column shows the scenario title (or opening / first script message); optional columns **Turns** and **Tools**.
- **Case drawer**, a new **Transcript** tab (default for agent runs) beside the existing content; the drawer's Output section is replaced for agents by the transcript:
  - Header chips: stop reason (`Resolved`, `Gave up`, `Turn limit`, `Script ended`, `Repeated itself`, `Empty message`), `n turns`, `n tool calls`, time, cost.
  - Message list by turn: user bubbles and agent bubbles, long text scrolls, truncated text shows "…[truncated N chars]". Under the agent message of the turn, **tool call chips**: name, outcome badge (**Ran**, **Stubbed**, **Mocked**, **Would ask first**, **Denied**) and status; expanding a chip shows args and the result summary. Badge tooltips: Stubbed "Not executed in this evaluation", Mocked "Canned result from the scenario", Would ask first "The agent needed approval; it was recorded and denied", Denied "Not allowed by the agent's grants or the eval policy".
  - "Open agent run" link (hidden when the session was deleted: "agent session deleted") to the Agent run page / Waterfall.
  - Expected block from `expected.tools` / `forbidden_tools` as a checklist beside the tool chips (green found, red missing/forbidden called), shown only when the scenario has them.
  - Failed results show the partial transcript with the error label and message in place of grades.
  - Footer: **Open agent run** replaces "Open stage run"; **Re-run this case** (try-one), **Edit scenario in dataset** unchanged in behavior.
- **Graders tab**: new types show their definition summary (tools, limits, guidance) and the same lowest-scoring cases.
- **Config tab**: the Stage card becomes an **Agent** card: agent id, revision `r4` with the amber "edited since: now r6" chip when `current.agent_revision` differs, definition hash, model, tools table with risk/class and the policy outcome they get, ask-first list, effective limits ("Eval limits replaced the agent's: 9 turns, 22 minutes"), sub-agent revisions. A **Conversation** card: mode, max turns, turn timeout, tools policy, approvals, read-only tools, user model, simulator prompt version, conversation rubric prompt version. Run settings and Reproduce cards as before (the command includes `--allow-real-tools` when the run used real tools).

## 6. Compare (change to screen 6)

"What changed in stage <id>" becomes "What changed in agent <id>" `r<a> → r<b>` from `agent_diff` (instructions line diff, changed keys: model, tools, limits; "<other keys> unchanged"). The Held constant / Changed strip names tool policy, approvals, mode, max turns and user model when they differ (amber). KPI strip adds **Turns** and **Tool calls** deltas (informational, no verdict). Everything else unchanged.

## 7. Edit eval (change to screen 7)

The Definition card's Target shows the agent with **Change** (opens the agent picker in a dialog); a Conversation card follows it (same as the wizard); the Graders list offers the agent grader types. YAML mode works as before. Stage behavior is unchanged.

## 8. Entry points (A13; extends screen 8)

- Agent detail page: an **EVALS n** section (rows as the Catalog inspector: eval id, `n scenarios · last run <relative>` or "never run", pass rate with a small bar) and an **Evaluate** button: exactly one eval -> its Run dialog; none -> `#/evals/new?agent=<id>`; two or more -> `#/evals?agent=<id>`. Guidance line: "Run an eval before you save changes to this agent." Empty state: "No evals yet. Create one to check this agent before you ship changes." **+ New eval** -> `#/evals/new?agent=<id>`.
- Agent session page: **Add as eval case** action (finished, non-eval sessions only; disabled with a reason while running or empty) opening a dialog: choose a dataset (existing agent dataset or new), preview the generated script scenario, edit, confirm. Nothing is written before confirm.
- Eval sessions are hidden everywhere else. Opening one by link (from a result) shows the banner "This session was created by eval <id>, run #<n>" with a link to the result (`GET /api/eval-runs?subject_ref=`), like `StageRunEvalBanner`.

## States A11 must cover

Default, empty, loading and error for: agent picker (no agents; all archived; agents unavailable), Conversation card (script, simulated, real-warning with and without consent, simulator unsupported), scenario editor (valid, invalid per field, ignored fields), try-one (running, done, failed, cancelled), run dialog (real consent unchecked/checked, estimate unknown), live progress (agent running, simulator error), transcript (long, truncated, stubbed/mocked/would-ask-first/denied chips, failed partial, session deleted), Config tab (stale agent revision). Dark and light.
