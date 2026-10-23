# 25: End-to-end test and release checklist

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** all other stories

## Why this story exists

Each story was tested alone. This story proves the whole feature works together, runs the manual checks only a person with real credentials can run, and prepares (but does not publish) the release notes.

## Read first

- The epic's "Release 1 scope", "Testing decisions" and "Risks to watch".
- All story files' final notes (what each one reported it could not do).
- `CONTRIBUTING.md`, `.github/workflows/ci.yml` and `release.yml`, `package.json` scripts, `docs/docker.md`.
- `tests/globalSetup.socketLeakGuard.ts` and the test setup that pins an empty `STAGEFLOW_HOME`.

## Decisions already made (do not revisit)

- The automated end-to-end test uses `FakeEngine`, a fake stage runner/agent, and a temp project. It calls no real model and no network.
- The real promptfoo path is covered by the opt-in smoke test (story 11) and by the manual checklist below.
- **Do not bump the package version or publish.** Prepare the `CHANGELOG.md` `[Unreleased]` entry only; the owner decides the release.
- Release 1 success criterion (A6): a nice UI, basic eval setup, the dummy dataset runs, standard stats visible. The checklist below proves it.

## What to build

1. **`tests/evals.e2e.test.ts`** (Host in-process with the HTTP routes, as route tests do): install the sample (`POST /api/evals/sample`) → validate → start a run with a scripted fake engine whose outcomes produce a known mix (some pass, one flaky, one stage failure) → poll to completion → assert `stats` values equal hand-computed numbers (write them in the test) → start a second run with a changed stage prompt (edit the sample pipeline file between runs) → compare (assert `stage_diff` shows the prompt change, shared cases, verdict) → add a failure tag via `review` → edit the eval through `PUT` (comment preserved, `FILE_CHANGED` conflict path) → delete a run. Also a CLI-level variant: `sf eval validate`, `sf eval run --json` (exit codes) against the same Host fake.
2. **UI pass with the browser tools (no credentials needed, if achievable):** run the console (`npm run ui:dev` against `sf ui`) with the real manager but the **fake promptfoo binary** from story 11's tests installed at the engine location in a temp `STAGEFLOW_HOME`, and a stub stage model through the repo's fake-agent facilities if they can run outside tests. Do not add a production switch or a test-only launcher to the product. If the stub stage model cannot run outside tests, say so and skip this item; the manual checklist (item 3) then needs real credentials.
3. **Manual checklist** (the owner, or the agent when credentials are available), recorded as ticked items in this file's final note: install the engine; run the sample eval on a real provider; see live progress; open results and each tab; open a case drawer and save a review with a tag; run again and open Compare; edit a rubric-free grader weight in the Edit page and save; check the YAML file on disk kept comments; run from the CLI and from MCP (`run_eval` with `wait: true`); cancel a run midway; hit the cost limit with a tiny `--max-cost` and see the partial-results banner; confirm eval stage runs do not appear in Runs or Inbox and do appear when opened by link.
4. **Release preparation:** write the `CHANGELOG.md` `[Unreleased]` → `### Added` entry in the style of previous entries (one bold lead sentence per capability; link `docs/evals.md`), mention the Node and engine-install requirement and that evals send inputs and outputs to the judge's provider. Do not move it under a version heading.
5. **Docker:** rebuild the image and restart the container (the owner's standing preference; see `docs/docker.md` and the memory note about rebuilding after finished changes), confirm `sf eval engine status` inside the container reports the engine installed, and confirm the console's Evals page loads.
6. **Final report:** list any story whose acceptance was not fully met, every open question that was raised, and every place the implementation differs from the specs (and update the specs to match the code, or flag the difference for the owner).

## Acceptance

- [ ] `tests/evals.e2e.test.ts` passes and asserts the exact numbers described above.
- [ ] The CLI variant covers exit codes `0` (passed) and `1` (below threshold).
- [ ] The manual checklist items are each ticked, or marked "not run: <reason>".
- [ ] `CHANGELOG.md` has the Unreleased entry; the version is unchanged.
- [ ] The Docker image builds and starts; engine status inside the container is installed (or the reason is recorded).
- [ ] `npm test`, `npm run ui:test`, `npm run typecheck`, `npm run build` and `npm run ui:build` all pass.
- [ ] The final report exists in this file and lists spec differences.

## Out of scope

Publishing, tagging, bumping versions, new features, anything in the epic's Deferred list.

## Open questions

_(agent fills; stop and ask the owner)_
