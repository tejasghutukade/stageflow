# 00: Pre-build verification of engine and runtime unknowns

**Epic:** [Evals](../../specs/evals.md) · **Status:** done (2026-10-20) · **Blocked by:** none · **Product code:** none

## Why this story exists

Stories 08, 10 and 11 depend on facts about promptfoo and about Stageflow's run manager that nobody has verified yet. Guessing them would put assumptions into the build. This story answers each question with a small experiment and writes the answer into the epic. **No product code is written.** Experiments live in a scratch directory outside the repo (use the session scratchpad); only the recorded results and any saved fixture files enter the repo.

## Read first

- [Epic](../../specs/evals.md), especially A7, P1, P2 and the Architecture section.
- [engine-interface.md](../../specs/evals-engine-interface.md) (every "verify: 00" marker).
- `docs/ideation/evals-agent-chat-research-shelved/phase-minus-1-promptfoo-integration-design.md`, "Verification results (2026-10-11)": what was already verified (telemetry env flags and the fetch guard, `llm-rubric` with an explicit provider, `javascript` assertions). Do not redo those except item 6.
- `src/runtime/runManager.ts` (`startRun`, the admission queue near line 353 and the `BusyCode`/queued result near line 169), `src/mcp/catalogTools.ts` (`run_stage` near line 686).

## Rules for the experiments

- **No real provider keys and no network except to install promptfoo.** For judge and provider tests use a local stub HTTP server that speaks the OpenAI chat-completions format and returns canned JSON; promptfoo can be pointed at it (`apiBaseUrl`). For stage runs use the repo's fake-agent test setup (find how `tests/` fakes the agent for `RunManager` tests) or a stage whose model is a stub.
- Install promptfoo in a **temporary directory**, never in the repo and never globally. Record the exact version tested.
- Record results as facts with the command or code that produced them, not as opinions.

## What to verify (each item ends with a recorded answer)

1. **Version and Node.** Choose the promptfoo version to pin: the newest stable release at least two weeks old. Record it, its license, its `engines.node`, and the minimum Node that actually runs `eval` for it (try Node 20, 22.x lowest available, 24). Record install size and time.
2. **Library vs CLI.** Can a Stageflow-written script run inside the pinned install and call promptfoo's Node API (`evaluate`) with a config object, with hooks or callbacks that fire **as each result and its grades complete**? Or only the CLI with `--output` at the end? Record the API names and signatures found in the installed package, and whether a per-result callback exists. This decides how live progress reaches `io.onResult` (see engine-interface "promptfoo adapter" step 5).
3. **Custom provider callback.** A custom ESM provider (`file://provider.mjs`) that POSTs to a local HTTP server and returns `{ output, metadata }`: confirm it works, that promptfoo's concurrency option is honored, that a provider `{ error }` return is recorded as an error without running assertions, and whether provider processes are shared across tests (global state).
4. **Repeats.** How does promptfoo express N repeats of each test? Does the repeat index reach the provider (`context`), and where does it appear in the results? If it does not reach the provider, record the workaround (a counter keyed by `caseId` in the provider process) and confirm it is correct under concurrency.
5. **Result shape.** Run a small eval (3 tests, 2 repeats, one `javascript` assertion with a `metric` name and one `llm-rubric` against the stub judge) and save the `results.json` (or API result) to `tests/fixtures/evals/promptfoo-results.json` (small, no secrets). Record: where per-test pass/score/reason live; how `metric` identifies each assertion in `componentResults`; token usage and cost fields for the provider and for the judge call; how a provider error appears; how an assertion that throws appears.
6. **Rubric prompt and 1–5 scores.** Confirm a custom `rubricPrompt` (with Nunjucks variables for case input, expected, output) is honored by `llm-rubric`; what JSON the judge must return for promptfoo to parse it (`pass`/`score`/`reason`?); and how to obtain a **1–5 raw value** (does `score` carry it? is it clamped to 0–1?). Record the exact reply format the Stageflow rubric prompt will demand.
7. **Judge provider mapping.** For `anthropic/<model>`, `openai/<model>` and `openrouter/<model>` ids from Stageflow's model catalog (`src/models/catalog.ts`; read how ids and providers are represented), record the promptfoo provider string and the environment variable promptfoo reads for credentials, using the stub endpoint override where possible. List providers Stageflow offers (from `src/agent/providerAuth.ts` / `docs/providers.md`) that have **no** working promptfoo mapping; those will not be judge-capable in release 1.
8. **Telemetry guard.** Re-run the network-spy check with the installed version and the four environment flags plus the `--require` fetch/http guard; record every host contacted with and without the guard.
9. **Cancellation.** Send SIGTERM to the promptfoo process mid-run: does it exit promptly, leave child processes, or write partial results? Record the exact behavior and the safest kill sequence (SIGTERM then SIGKILL after N seconds).
10. **Stage case execution.** Using `RunManager` directly (the way `run_stage` does), run a one-stage inline pipeline with `task.input` and confirm: (a) `task.input` is validated against `io.input.schema` and what the failure looks like; (b) how to wait for completion (the mechanism `run_stage` blocking mode uses; name the function); (c) where the envelope, `latency` (stage started/finished) and usage (cost, tokens in/out per model) are read from after completion, with field names; (d) what a stage that stops for operator input looks like and how to cancel it; (e) what a stage failure (agent error, timeout, verify failure) looks like.
11. **Capacity behavior.** Start more `startRun` calls than `maxConcurrent`: does `startRun` queue them (status `queued`, position) or reject (`busy_capacity`)? How does a queued run start later, and how does the caller learn that? Record the exact result types, and what a runner must do to run 50 cases with concurrency 4 politely.
12. **Run list call sites.** List every place that lists or counts runs for display (Runs page, Inbox, Overview summary, run counts in the sidebar and catalog stats, `sf runs`, MCP `list_runs`, trigger and retention code) so story 04 can apply the `origin` filter everywhere. Give file and function names.
13. **Eval stage runs in storage.** Confirm what an inline `standalone-<stageId>` run writes (rows, workspace directories, disk usage) and how large a typical one is, to size the retention advice.

## Deliverables

- Fill the epic's "Pre-build verification results" section with one numbered answer per item above. Where an answer contradicts a decision (A or P) or a spec, say so plainly and **stop**: the owner decides.
- Save `tests/fixtures/evals/promptfoo-results.json` (item 5) and, if useful, the stub judge server as `tests/fixtures/evals/stubJudgeServer.mjs` (a small file reused by story 11's opt-in smoke test).
- Update [engine-interface.md](../../specs/evals-engine-interface.md): replace each "(verify: 00)" with the verified fact, and fix any sentence the facts contradict. List what you changed in the story's final note.

## Acceptance

- [x] Items 1–13 each have a recorded answer in the epic, with the evidence (command or code).
- [x] The pinned promptfoo version, its minimum Node, and the install size/time are recorded.
- [x] The decision between "library inside the pinned install" and "CLI plus callbacks" for live results is recorded with the reason.
- [x] `tests/fixtures/evals/promptfoo-results.json` exists and contains no secrets.
- [x] The list of judge-capable providers is recorded.
- [x] All "(verify: 00)" markers in engine-interface.md are resolved.
- [x] Any contradiction with a decision or spec is reported to the owner.

## Out of scope

Any change under `src/` or `ui/`. Choosing between engines (A7 is decided). Cost or quality evaluation of judges.

## Open questions

None blocking. For the owner to confirm: pin promptfoo 0.124.0; CLI plus `afterEach` hook for live results; judges limited to anthropic, openai, openrouter; the install is 1.2 GB.

## Final note

Results: [epic, Pre-build verification results](../../specs/evals.md#pre-build-verification-results). Files added: `tests/fixtures/evals/promptfoo-results.json`, `tests/fixtures/evals/stubJudgeServer.mjs`. Changed in `docs/specs/evals-engine-interface.md`: all "(verify: 00)" markers resolved; spawn command and flags; live results via the `extensions` `afterEach` hook (provider-callback fallback dropped); exit code 100 semantics; cancel behavior; repeat index handling; never-throwing assertions; no `apiKey` in the generated config; judge mapping table; rubric reply contract; normalization rules (`failureReason`, `graderError`, judge cost computed by Stageflow); install notes (Node >= 22.22.0, size). Not verified: Node 20/22 runs (not installed), real Pi adapter timeout and usage numbers, providers other than the three judges.
