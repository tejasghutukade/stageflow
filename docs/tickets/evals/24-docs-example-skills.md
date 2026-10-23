# 24: Docs, example project, skills

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 14, 15 (and 12 for the sample install path)

## Why this story exists

A feature nobody can learn is not shipped. This story writes the user documentation, ships the sample project that the console's "Try the sample eval" installs, teaches the harness skills about `sf eval`, and records the contributor rules in `AGENTS.md`.

## Read first

- The whole [epic](../../specs/evals.md) and the reference specs: documentation must match them, and where a story changed behavior, the code and the final spec win (read the merged code for CLI flags and JSON shapes).
- Existing docs to imitate and extend: `docs/README.md` (index), `docs/yaml-catalog.md`, `docs/cli-reference.md`, `docs/mcp.md`, `docs/ci.md`, `docs/glossary.md`, `docs/environment-variables.md`, `docs/data-directory.md`, `docs/docker.md`, `docs/console-pipelines-catalog.md` (the style of a `console-*.md` page), `docs/operator-console.md`, `docs/browser.md` (how a feature's user docs read), `examples/README.md`, `examples/hello-world/`.
- `skills/` (the router `skills/stageflow/SKILL.md`, `references/`, and how other skills mention `sf` commands) and `docs/skills-suite.md`.
- `AGENTS.md` (the "Browser sessions" and "Connections" sections show how contributor rules are recorded).
- How the Host locates the package's `examples/` directory at runtime (`src/config/seededCatalog.ts`); the sample install (story 12) must use the same helper.

## Decisions already made (do not revisit)

- **Sample project (P14: the sample uses no rubric graders**, so it runs with any provider and needs no judge). Files in `examples/evals/`, flat: `eval-sample.pipeline.yaml`, `critique-sample.eval.yaml`, `critique-sample.dataset.jsonl`, `critique-sample.task.yaml`, `README.md`. When installed into a project by "Try the sample eval", the pipeline, eval and dataset land in the project's `pipelines/`, `evals/`, `datasets/` roots (story 12 rewrites the eval's two path lines).
- Positioning (`AGENTS.md`): lead with configurable stages and evals as a general quality tool; SDLC is one example among others.
- Docs describe **what the product does**, including honest statistics (what "95% CI (by case)" means, why repeats exist, pass^k vs pass@k) and what is **not** done (calibration, command graders, agent evals, CI scheduling).
- Privacy statement (required in the docs): running an eval sends each case's input and stage output to the judge model's provider for rubric graders, and sends case inputs to the stage's model as a normal stage run; nothing is sent to promptfoo's services (telemetry and remote features are blocked); `code` graders run JavaScript on the author's machine with the author's permissions, the same trust level as `verify: command`.

## What to build

1. **The sample files**
   - `eval-sample.pipeline.yaml`: id `eval-sample`, one **inline** stage `critique` (no `model:`, so it uses the project/global default), system prompt: you review a short draft specification and report concrete problems; `io.input.schema` `{ type: object, required: [draft], properties: { draft: { type: string } }, additionalProperties: false }`; `io.output.schema` `{ type: object, required: [verdict, issues], properties: { verdict: { enum: [ok, needs_work] }, issues: { type: array, items: { type: object, required: [severity, text], properties: { severity: { enum: [high, medium, low] }, text: { type: string } } } } } }`. The prompt must say: report `verdict: ok` with an empty `issues` list when the draft has no real problem; do not invent problems.
   - `critique-sample.dataset.jsonl`: these 8 cases, in this order, compact JSON per line with `id`, `title`, `input.draft`, `expected.issues`, `tags`:
     - `c001` "Session token never expires": "Users sign in with email and password. The server returns a session token that stays valid until the user signs out." / `["expir"]` / `["security"]`
     - `c002` "Search without paging": "The search endpoint returns every matching record in one response." / `["paginat"]` / `["api"]`
     - `c003` "Clear export spec": "The export button downloads the current table as a CSV file. The file name is the table name plus the date. Rows keep the on-screen order. An empty table downloads a file with only the header row." / `[]` / `["no-issue"]`
     - `c004` "Retry without backoff": "When a webhook delivery fails, retry immediately until it succeeds." / `["backoff", "limit"]` / `["reliability"]`
     - `c005` "Vague quality goal": "The dashboard should load fast and look modern." / `["measur"]` / `["clarity"]`
     - `c006` "Upload without limits": "Users can upload a profile photo. The photo is shown on their profile page." / `["size", "format"]` / `["validation"]`
     - `c007` "Conflicting shipping rules": "Orders over 100 dollars ship free. All orders pay a flat shipping fee of 5 dollars." / `["conflict"]` / `["consistency"]`
     - `c008` "Clear rename spec": "A user can rename a project from its settings page. Names are 1 to 60 characters. Saving an empty or too long name shows an inline error and keeps the old name." / `[]` / `["no-issue"]`
   - `critique-sample.eval.yaml`: id `critique-sample`, name "Critique sample", description "Sample eval: does the critique stage find the planted problems?", type `capability`, target pipeline `./eval-sample.pipeline.yaml` stage `critique`, dataset `./critique-sample.dataset.jsonl`, defaults `repeats: 2`, `pass_threshold: 0.8`, `max_cost_usd: 1`, `concurrency: 4`, **no judge**; graders: `output-schema` (schema, must_pass), `issues-have-severity` (field: `payload.issues[*].severity` `in [high, medium, low]` so an empty list passes), `finds-expected-issues` (reference, `each_mentioned`, path `payload.issues`, expected `expected.issues`, weight 3), `no-false-alarms` (code, weight 2: `return !testCase.tags.includes("no-issue") || output.payload.issues.length === 0;`).
   - `critique-sample.task.yaml`: a normal task for the pipeline (`goal: Review a draft specification`, `input.draft` = case `c001`'s draft) so `sf run` works on the pipeline too.
   - `README.md`: what the sample shows, how to run it (`sf validate`, `sf eval engine install`, `sf eval run`, the console route), what to expect (some failures are normal), and how to add a rubric grader.
   - Validate everything with the story 02/03 loaders in a test (`tests/examples.evals.test.ts`): the eval loads with no errors, the dataset has 8 valid cases matching the stage input schema, and `installEvalSample` into a temp project produces files whose paths resolve.
   - Add `evals` to `examples/stageflow.yaml` (`pipelines`, `tasks`, `evals`, `datasets` entries) and to the repo root `stageflow.yaml` if story 01 deferred it; add the example row to `examples/README.md`.
2. **User docs**
   - New `docs/evals.md`: concepts, quick start with the sample, writing an eval (every grader type with an example), datasets (formats, ids, mapping on upload, invalid cases are skipped), running (console, CLI, MCP), reading results (every KPI explained; why intervals are by case; repeats; reliability; flaky; compare and what "inconclusive" means; capability vs regression and saturation), the engine (install, Node requirement, offline behavior), cost and limits, privacy and trust statements, troubleshooting (engine missing, Node too old, judge not mapped, stage needs input, budget stop), and what is not built.
   - New `docs/console-evals.md` in the style of other `console-*.md`: each screen, in the order of ui-map.md, without design-file references.
   - Update: `docs/yaml-catalog.md` (eval and dataset file sections with the same tables as the specs, manifest keys and patterns, defaults), `docs/cli-reference.md` (`sf eval …`), `docs/mcp.md` (tools), `docs/ci.md` (eval exit codes and `--json`), `docs/glossary.md` (Eval, Dataset, Case, Repeat, Result, Grader, Rubric, Judge, Eval run, Config snapshot, Fingerprint), `docs/environment-variables.md` (`STAGEFLOW_EVALS_KEEP_WORKDIR`, `STAGEFLOW_EVALS_SMOKE`), `docs/data-directory.md` (`eval-engine/`, `eval-runs/`), `docs/docker.md` (engine baked in), `docs/operator-console.md` and `docs/README.md` (links).
3. **Skills:** teach the router and the run/author skills that evals exist: when to use `sf eval validate`, `sf eval run --json`, how to read `outcome`, that runs cost money, and where the docs are. Follow the structure of the existing skill files and any size or format limits stated in `docs/skills-suite.md`; update tests that snapshot skill content if any exist (`grep -rn "skills/" tests | head`).
4. **`AGENTS.md`:** add an "Evals" section (after "Connections") stating the contributor rules: read `docs/specs/evals.md` before changing evals; `src/evals/stats.ts`, `scoring.ts` and `compare.ts` are the only places numbers are computed; the UI formats and never computes; nothing outside `src/evals/engine/promptfoo/` imports or names promptfoo types; the engine never touches the store; graders read a normalized subject; the target is a tagged reference (`kind`); result tables are target-neutral; no test calls a real model or the network (the smoke test is opt-in); never log the run token; the judge-prompt version must be bumped when its text changes. Also update the repository layout and `src/` map tables in `AGENTS.md` (`src/evals/`) and the docs index line.

## Acceptance

- [ ] `examples/evals/` exists with the files above; `sf validate --strict` on it passes (add the example to the validate test list if other examples are listed there); the loader test passes.
- [ ] A fresh project can run: `sf validate`, `sf eval engine install`, `sf eval run critique-sample` end to end with the owner's provider (manual; recorded in the final note by the owner, not by the agent unless credentials are available).
- [ ] Every new doc page exists and every changed doc builds into the docs site without broken links (run the docs link check if the repo has one: see `.github/workflows/docs.yml`; otherwise check relative links by script and report).
- [ ] The docs state the privacy and trust facts exactly as above, and list what is not built.
- [ ] CLI flags and JSON documents in the docs match the implemented behavior (the agent runs each documented command against a fake Host or reads the tests; no invented flags).
- [ ] Skills mention `sf eval` accurately; skill tests (if any) pass.
- [ ] `AGENTS.md` has the Evals section and updated tables.
- [ ] `npm test`, `npm run ui:test`, `npm run typecheck` pass.

Status of item 1 (sample files): DONE (built early, merged). Remaining for this story: items 2, 3, 4. The docs must mention that "Try the sample eval" needs a default `model` in the project's `stageflow.yaml` (the sample stage has no `model:`); consider a clearer console message than `eval.target_unresolved` (ask the owner).

## Out of scope

Release notes and version bump (story 25). Screenshots of the console (not needed).

## Open questions

_(agent fills; stop and ask the owner)_
