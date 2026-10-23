# A15: End-to-end test and release checklist

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** ready-for-agent · **Blocked by:** all other stories (A00-A14)

## Why this story exists

Each story was tested alone. This story proves agent evals work together with the release 1 shell and, above all, that stage evals did not regress. It runs the real-promptfoo smoke with a fake agent backend, the manual checks only a person with real credentials can run, and prepares (but does not publish) the release notes.

## Read first

- Plan section 7 (A15 row), section 8 (risks), section 9 (out of scope), section 10; `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it).
- All story files' final notes A00-A14 (what each could not do) and `docs/tickets/evals/25-e2e-and-release.md` + `25-final-report.md` (the release 1 pattern and its numbers).
- `tests/evals.e2e.test.ts` (release 1 end to end), `tests/evals.promptfoo.smoke.test.ts` (opt-in real engine, `STAGEFLOW_EVALS_SMOKE=1`), `tests/fixtures/evals/stubJudgeServer.mjs`, A07's `src/evals/runner/FakeAgentBackend.ts`, A06's `FakeSimulatorModel`.
- `CONTRIBUTING.md`, `.github/workflows/ci.yml` and `release.yml`, `package.json` scripts, `docs/docker.md`, `tests/globalSetup.socketLeakGuard.ts`, the test setup that pins an empty `STAGEFLOW_HOME`.

## Decisions already made (do not revisit)

- The automated end-to-end test uses `FakeEngine`, `FakeAgentBackend`, `FakeSimulatorModel` and a temp project. No real model, no network.
- The real promptfoo path is covered by the opt-in smoke test (extended here to an agent plan) and by the manual checklist. The smoke uses a **fake agent backend** (plan A15) and the local stub judge; it proves the generated provider, assertions and `llm-rubric` work on conversation outputs (G13).
- **Do not bump the package version or publish.** Prepare the `CHANGELOG.md` `[Unreleased]` entry only.
- Release 2 success: an author can pick an agent, give it scripted and simulated scenarios, run with repeats, grade conversation and tool calls, and read the same stats and compare views, without any stage eval behavior changing.

## What to build

1. **`tests/evals.agents.e2e.test.ts`** (Host in process with the HTTP routes): install the agent sample (A14) -> validate -> start a run with `FakeEngine` and a scripted `FakeAgentBackend` whose conversations yield a known mix (some pass, one flaky, one forbidden-tool violation, one turn timeout) -> poll to completion -> assert `stats` (pass rate, reliability, `mean_turns`, `mean_tool_calls`, cost including simulator usage) equal hand-computed numbers written in the test -> change the agent file between runs (new revision) and start a second run -> compare (agent revision change appears in the config diff, shared cases, verdict) -> assert the first run kept its revision -> add a failure tag via `review` -> delete a run and assert its eval sessions are gone. A simulated-mode variant with `FakeSimulatorModel`. A CLI variant: `sf eval validate`, `sf eval run --json` with exit codes 0 and 1, and the `--allow-real-tools` refusal.
2. **Safety e2e assertions in the same file:** during a full run with `read_only` the backend's write/shell tool bodies never ran; `agent_approvals` stayed empty; `pendingApprovals`, `GET /api/agents/sessions`, agent stats and Inbox counts equal their pre-run values; no OTLP/channel/schedule/judge side effect fired; `real` without consent returns 422.
3. **Stage regression gate:** run the full release 1 eval test files and `tests/evals.e2e.test.ts` untouched; add a golden test that a stage run's fingerprint, snapshot JSON and `Stats` object equal pre-release-2 literals (captured in A04/A09; re-assert here against a fixture).
4. **Smoke extension (opt-in):** `tests/evals.promptfoo.agent.smoke.test.ts`, gated by `STAGEFLOW_EVALS_SMOKE=1`: install the pinned promptfoo into a temp home, run an agent plan (3 cases, 2 repeats, one `tool_calls`, one `conversation_check`, one `rubric` against the stub judge) with the fake agent backend through the real engine; assert results, grader ids, repeat join and judge cost normalize correctly.
5. **UI pass with browser tools** (if achievable without credentials, as in release 1): run the console against the real manager with the fake backend and fake engine from the tests in a temp `STAGEFLOW_HOME`; walk wizard (Agent pill), scenario editor, try-one with transcript, run, results drawer transcript tab, compare, agent page Evaluate, session "Add as eval case". Screenshots to the scratchpad. If this cannot run outside tests, say so and skip; do not add a production switch.
6. **Manual checklist** (owner, or the agent when credentials exist), ticked in the final note: install the engine; run the agent sample on a real provider; run a simulated scenario with a real `user_model`; confirm a `read_only` run leaves the project untouched (`git status` clean); confirm a stubbed tool shows `stubbed` in the transcript; confirm a would-ask-first tool is denied and nothing appears in Inbox; flip to `real` on a throwaway project and confirm the warning, the consent flag and the real side effect; cancel midway; hit the cost limit with a tiny `--max-cost`; edit the agent and confirm the old result shows the old revision and the stale-config signal; run from the CLI and from MCP (`run_eval` with `wait: true`); confirm eval sessions are absent from agent lists/Inbox and openable by link with the banner.
7. **Release preparation:** `CHANGELOG.md` `[Unreleased]` -> `### Added` entry in the existing style (one bold lead sentence per capability; link `docs/evals.md`), mentioning that agent evals call the agent's model, a simulator and the judge, that tools are read-only by default, and the privacy statement. Do not move it under a version heading.
8. **Docker:** rebuild the image and restart the container (standing owner preference; see `docs/docker.md`), confirm `sf eval engine status` reports installed, the Evals page loads and the agent sample installs.
9. **Final report** (a "Final report" section in this file, release 1 style): acceptance per story not fully met, every open question raised, each place the implementation differs from the specs (update the specs to match the code, or flag for the owner), the plan inconsistencies recorded in the README, and the numbers from the e2e run.

## Acceptance

- [x] `tests/evals.agents.e2e.test.ts` passes and asserts the exact hand-computed numbers; the CLI variant covers exit codes 0 and 1.
- [x] Safety assertions hold: no write/shell tool executed in `read_only`, no approval rows, operator lists and counts unchanged, no side channels.
- [x] Stage regression gate passes: all release 1 eval tests untouched and green; pinned stage fingerprint, snapshot and stats literals unchanged.
- [ ] The opt-in agent smoke passes with the real pinned promptfoo (or the reason it could not run is recorded). NOT MET: not run (see Final report)
- [x] The manual checklist items are each ticked or marked "not run: <reason>".
- [x] `CHANGELOG.md` has the Unreleased entry; version unchanged.
- [ ] The Docker image builds and starts; engine status inside the container is installed (or the reason is recorded). NOT DONE: lead does it
- [x] `npm test`, `npm run ui:test`, `npm run typecheck`, `npm run build` and `npm run ui:build` all pass.
- [x] The final report exists in this file and lists spec differences.

## Contract notes from A01 (the six specs' "Release 2: agents" sections win over any older line in this story)

- Assert stored statuses per the mapping table (`stage_failed` + `EVAL_AGENT_TIMEOUT` for the timeout case, `error` + `EVAL_SIMULATOR_ERROR` for a simulator failure) and the stop reasons `script_end`, `resolved`, `abandoned`, `max_turns`, `no_progress`, `empty_message`.
- `mean_turns` and `mean_tool_calls` are plain means over executed results with a value, so hand-computed numbers must use executed results only.

## Out of scope

Publishing, tagging, version bumps, new features, anything in plan section 9 (voice/channel evals, red-teaming, online evals, auto-generated scenarios, multi-agent targets, human labelling, scheduled runs).

## Open questions

_(agent fills; stop and ask the owner)_

## Final report

Branch `worktree-agent-a51575c191234abaa` (reset to `claude/chat-agent-research-5ab531`, A02-A14; commit 390b5ebf). Not published, version unchanged. Open questions: none blocking; two leftovers need the owner (below).

### Built

- `tests/evals.agents.e2e.test.ts` (4 tests): (1) installs the agent sample through `POST /api/evals/sample`, validates, runs with `FakeEngine` + a scripted `FakeAgentBackend`, edits the agent (new revision), runs again, compares, reviews, deletes; (2) simulated variant with `FakeSimulatorModel`; (3) CLI `sf eval validate` + `sf eval run --json` exit 1 and exit 0; (4) real tools without consent: HTTP 422 `EVAL_REAL_TOOLS_NOT_CONFIRMED`, CLI exit 1 naming `--allow-real-tools`, no run row, no backend call.
- `tests/evals.stageRegression.test.ts` + `tests/helpers/stageRegressionInputs.ts` + `tests/fixtures/evals/stage-regression.golden.json`: Stats, components, fingerprint and snapshot JSON for fixed stage inputs. The golden file was produced by running the inputs through the release 1 code (`git archive 71dd147c`, before A02) and through the current code; the outputs were byte-identical. Stage Stats has no `mean_turns`/`mean_tool_calls` keys.
- `tests/evals.promptfoo.agent.smoke.test.ts` (opt-in `STAGEFLOW_EVALS_SMOKE=1`): written, NOT RUN (below).
- `CHANGELOG.md` `[Unreleased]` `### Added`: five bullets (agent evals, conversation graders, read-only default, three-model privacy statement, CLI/MCP).
- No existing test file was edited; only new files plus CHANGELOG.

### Hand-computed numbers (e2e test 1; sample: 6 scenarios x 2 repeats = 12 results)

Script keyed on the user's last message. s001 repeat A states "3", repeat B does not (flaky; `mentions-the-fact` weight 3 of 7 fails, 4/7 < 0.8); s002, s003 (2 turns), s006 (reads README) always pass; s004 tries `write` and `bash` (blocked; `no-forbidden-tools` must_pass fails, both repeats); s005 hangs (5 s turn timeout -> `stage_failed` + `EVAL_AGENT_TIMEOUT`, both repeats).
- Run 1: executed 12, passed 7, pass_rate 7/12, reliability 3/6 = 0.5, pass_any 4/6, flaky `["s001"]`, failing cases order s005, s004, s001. Counts all 6, passed 3, failed 3, flaky 1. mean_turns 14/12 (12 from completed + 1 per timeout), mean_tool_calls 6/12 = 0.5 (s004 2+2, s006 1+1). cost_stage 0.14 = 14 backend calls x 0.01 (a timed-out turn still reports usage), cost_judge 0. By grader: no-forbidden-tools 8/10, mentions-the-fact 9/10, others 10/10 (timeouts have no grades).
- Run 2 after changing the agent's instructions: s001 stable, passed 8/12, reliability 4/6, flaky `[]`. Compare: shared_cases 6, `agent_diff.changed_keys = ["instructions"]`, `agent_diff.revision {a: r1, b: r2}`, `stage_diff` null, s001 improved, verdict `no_clear_difference`. Run 1 kept `config.target.revision` r1; `current.agent_revision` is r2 (stale signal).
- Review tag on s004/0: `by_tag {"Forbidden tool": 1}`, untagged 4. Delete run 1: its 12 eval sessions are gone (`agent.session_not_found`), run 2's 12 remain.
- Simulated: 2 cases x 1 repeat; each = opening + the simulator's closing message ("resolved") = 2 agent turns (2 x 0.01) + 1 simulator call (0.001): cost 0.042, mean_turns 2, stop_reason `resolved`, simulator calls 2, backend calls 4.
- CLI: `--case s001 --case s004` = 1/4 = 0.25, exit 1 `below_threshold`; `--case s002 --case s006` = 4/4, exit 0, mean_turns 1, mean_tool_calls 0.5.

### Safety assertions (same run)

`backend.executed` is exactly `["read","read"]` (write/bash bodies never ran); `listApprovals` empty for all 12 eval sessions; `pendingApprovals(includeEval)` equals the pre-run value; operator `listAllSessions` count and stats equal pre-run; simulator never called in script mode; real without consent 422. NOT asserted directly: OTLP push, channel send, schedule and judge side effects (no spy points; only A03's own tests and the docs cover them).

### Gate results (final run on this branch)

`npm test`: 504 files passed, 10 skipped; 5712 tests passed, 29 skipped, 2 todo; 0 failures. `npm run ui:test`: 194 files, 1895 tests passed. `npm run typecheck`, `npm run build`, `npm run ui:build`: pass. No flaky failures this run.

### Not met / not done

- **Smoke (item 4): not run.** Pinned promptfoo 0.124.0 cannot be installed offline: `npm install promptfoo@0.124.0 --offline` fails `ENOTCACHED` (openai-7.43.0.tgz not in the npm cache) and there is no network. The test file type-checks but is unverified. Owner: `sf eval engine install`, then `STAGEFLOW_EVALS_SMOKE=1 npx vitest run tests/evals.promptfoo.agent.smoke.test.ts`. It has a test "sends the transcript to the judge once" that fails if the A08 leftover below is real.
- **Docker (item 8):** skipped (the lead does it).
- **UI pass (item 5):** skipped; needs the fake backend/engine wired into a running console, no launcher exists and no production switch may be added.
- **Manual checklist (item 6):**
  - [ ] install the engine: not run: no network
  - [ ] agent sample on a real provider: not run: needs real credentials
  - [ ] simulated scenario with a real `user_model`: not run: needs real credentials
  - [ ] `read_only` leaves the project untouched: fakes cover it (write/shell bodies never ran); real `git status` check not run: needs real credentials
  - [ ] stubbed tool shows `stubbed`: unit-tested in A05/A07; real check not run: needs real credentials
  - [ ] would-ask-first denied, Inbox empty: fakes cover it (no approval rows); real check not run: needs real credentials
  - [ ] `real` on a throwaway project: consent refusal covered (HTTP 422, CLI exit 1), warning text covered in `tests/cli.evalAgent.test.ts`; real side effect not run: needs real credentials
  - [ ] cancel midway: not run: needs real credentials (unit-tested in A07)
  - [ ] tiny `--max-cost`: not run: needs real credentials
  - [x] agent edit: old result shows old revision and the stale signal: covered by e2e test 1
  - [ ] CLI and MCP `run_eval wait:true`: CLI covered here, MCP by `tests/mcp.evalTools.agent.test.ts`; real provider not run: needs real credentials
  - [x] eval sessions absent from agent lists and Inbox counts: covered by e2e test 1. Openable by link with the banner: not run: needs a browser

### Leftovers

- **A08 conversation rubric reads `{{output}}`: OPEN, not fixed.** Checking nested `{{output.transcript}}` needs the real engine (smoke could not run), so the template and `CONVERSATION_RUBRIC_PROMPT_VERSION` are unchanged. The transcript is in the judge prompt twice and bounded by the 256 KB subject caps, not `JUDGE_TRANSCRIPT_LIMITS`. When the smoke can run: if its "once" test shows nested access renders, switch the `<transcript>` line to `{{output.transcript}}` and bump the version (the golden `conversation-rubric.golden.txt` changes with it).
- **A14 `sf validate --strict` at repo root: recorded, resolver unchanged.** It passes only because the root `stageflow.yaml` excludes `examples/evals/support-sample.eval.yaml`; the sample agent lives in a project's `agents/`, so the offline resolver cannot see `support_sample` beside the eval. The installed copy validates clean (`tests/examples.agentEvals.test.ts`).

### Observations / spec differences

- A timed-out turn counts as one turn in `mean_turns` and its usage counts in `cost_stage`; `stage_failed` results are executed (pass 0).
- A simulated chat ends with the simulator's closing message sent to the agent as one more turn, so a one-question chat is 2 turns.
- Results-list `failed` includes flaky cases (pass_fraction below 1).
- A result failed by a `must_pass` grader (s004) still shows `score` 1 (weighted score of the other graders); status and score are separate. Confirm that is intended.
- No docs changes were needed.
