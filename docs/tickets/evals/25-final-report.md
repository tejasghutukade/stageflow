# 25: Final report

Branch: worktree-agent-a43dfdc69becf1223 (base: Merge wizard wiring and diff-spacing fix).

## Acceptance

- [x] `tests/evals.e2e.test.ts` passes with hand-computed numbers (sample installed from `examples/evals/`, 8 cases x 2 repeats = 16 results; run 1: 12 passed, pass_rate 0.75, flaky c002 and c003, c004 stage failure; run 2 after a prompt edit: 14 passed, 0.875, no flaky; compare: 8 shared cases, `stage_diff.changed_keys = ["system_prompt"]`, verdict `no_clear_difference`; review tag, PUT keeps comment, `FILE_CHANGED` 409, delete run).
- [x] CLI variant: `sf eval validate` exit 0; `sf eval run --json` exit 1 (`below_threshold`, 0.75 vs 0.8) and exit 0 (`passed`, `--case` selection).
- [x] Full root suite: 482 files passed, 9 skipped; 5388 tests passed, 27 skipped, 2 todo. Zero failures, nothing to attribute to pre-existing/environmental.
- [x] `npm run ui:test` 1669 passed; `npm run typecheck`, `npm run build`, `npm run ui:build` pass.
- [x] CHANGELOG `[Unreleased]` entry added; version stays 0.38.0.
- [x] Docker image built and started (details below).
- [x] Smoke test with the real pinned promptfoo 0.124.0 passes (see below).
- Item 2 (UI pass with browser tools): not run: needs a stub stage model outside tests plus a fake promptfoo binary; no product switch allowed, and the repo has no launcher for it.
- Item 3 manual checklist: not run: needs real provider credentials (engine install: done in a temp home; sample on real provider, live progress, tabs, drawer review, Compare in browser, Edit page weight, MCP `run_eval wait:true`, cancel midway, tiny `--max-cost` banner, Runs/Inbox exclusion: all not run).

## Smoke (real engine)

`sf eval engine install` into a temp `STAGEFLOW_HOME` succeeded (610 packages, ~15 s, Node 26.5). `STAGEFLOW_EVALS_SMOKE=1 npx vitest run tests/evals.promptfoo.smoke.test.ts` passed. A temporary variant with `repeats: 3` (6 results, unique case:repeat keys, then deleted) also passed. So the previously unverified assumptions hold: grader ids (from javascript-assertion metadata in componentResults) reach the normalized grades, the repeat index joins correctly, results shape parses. Not covered: real stage runner, real judge.
Note: npm warned that esbuild's postinstall is not covered by `allowScripts`; it did not affect the run.

## Docker

Compose project `stageflow-evals-e2e` (override file in scratchpad: image tag `stageflow:evals-e2e`, port 127.0.0.1:3861) so the shared `ghcr.io/tejasghutukade/stageflow:local` tag used by another running project and port 3847 stay untouched. Built from this checkout; container healthy; `/livez` ok, console `/` 200, `/api/evals` answers, `sf eval engine status` inside: installed 0.124.0, node 22.23.3, node_ok. New volume (so the baked-in engine is visible). Left running. Remove with `docker compose -p stageflow-evals-e2e down -v` (use the same -f files) if unwanted.

## Defects found and fixed

- `tests/fixtures/evals/sample/eval-sample.pipeline.yaml` (used by route tests as sample source) lacked `type: string` next to the two `enum` schemas, so the real loader rejected it (`payload_schema.properties.verdict: type is required`). Route tests never loaded it. Fixed. The shipped `examples/evals/` copy was already correct.

## Spec differences / notes

- The route-test sample fixture is a 2-case, 2-grader reduction of `examples/evals/` (8 cases, 4 graders); the e2e test uses the real example.
- The sample needs a project default `model` in `stageflow.yaml` (documented in docs/evals.md; the e2e manifest sets one). Fresh Docker workspace has none, so installing the sample there and validating yields `eval.target_unresolved` until a model is set.
- `POST /api/evals/validate` requires `definition` or `yaml` (path alone returns 400).
- Install rewrites the sample YAML through the YAML document (flow list spacing `[ ok, needs_work ]`); comments survive.

## Open questions

- Should the Docker workspace sample install prompt or default a model so a first-time user does not hit `eval.target_unresolved`?
- Run the manual checklist with real credentials (owner).
