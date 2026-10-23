# A09: Stats and read models for agent runs

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** done (branch worktree-agent-a7fda5288c3f9d99f, commit cf60e8b3) · **Blocked by:** A04, A07

## Why this story exists

Agent eval runs must show the same numbers as stage runs (pass rate with intervals, reliability, flaky cases, cost, latency, compare) plus two agent ones: mean turns and mean tool calls (plan section 5). The console and API read only what the read models return, and the UI never computes a statistic (epic rule), so every new number is computed here, in the three files allowed to compute numbers, and exposed through the existing read helpers.

## Read first

- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it). Item 8 (cost formula) feeds the estimate.
- [Plan](../../specs/evals-agents.md) section 5 ("Stats"), section 6 ("Results"), risk 4.
- `docs/specs/evals-result-schema.md` (scoring, `summary_json`, compare, estimate) and its "Release 2: agents" section (A01): names of `mean_turns`, `mean_tool_calls`, result `subject`.
- Code: `src/evals/stats.ts` (`computeStats`, `buildCaseStats`, `Stats`), `src/evals/statsTypes.ts` (`ResultRecord`), `src/evals/statsAdapter.ts` (`toResultRecord`), `src/evals/compare.ts` (`compareRuns`, delta fields near line 279), `src/evals/scoring.ts`, `src/evals/estimate.ts` (`estimateRun`, `EstimateRunInput`), `src/evals/read/runs.ts` (`WireResultDetail`, `resultToWire`, `buildRunDetail`, `runHeadline`), `src/evals/read/results.ts` (`ResultRow`, `buildResultRows`), `src/evals/read/api.ts` (`buildResultDetail`, `buildResultsPage`, `buildEvalDetail`), `src/evals/read/list.ts` (`EvalListItem`), `src/evals/read/compare.ts`, `src/evals/manager.ts` (`summary_json` built at finish), A04's `turns`/`tool_call_count` columns and `subjectRef`. Tests: `tests/evals.stats*.test.ts`, `tests/evals.compare*.test.ts`, `tests/evals.read*.test.ts`.

## Decisions already made (do not revisit)

- **Numbers are computed in `stats.ts`, `scoring.ts`, `compare.ts` only.** The UI and the read helpers format and pass through. Any new formula needs a hand-computed test.
- New aggregates are plain means over **executed** results of the run: `mean_turns` = mean of `turns`, `mean_tool_calls` = mean of `tool_call_count`, both `null` when no executed result has the value (always `null` for stage runs). No new interval or significance math in release 2.
- The columns are the ones A04 added; this story adds no migration. Stage `Stats` objects keep exactly their current keys and values: the new keys are present only for agent runs (omit them for stages so existing deep-equal tests and fixtures stay valid).
- The result's stored `output_json` is the conversation subject (A07). The read model returns the **redacted stored subject**, never re-reads sessions, so a deleted session does not break a result.
- Transcript detail links to the existing agent run page through ids only (`subject_ref` = session id, `agent_id`); the console builds the route (A12).

## What to build

1. **`src/evals/statsTypes.ts` and `statsAdapter.ts`:** `ResultRecord` gains optional `turns: number | null`, `toolCalls: number | null`; `toResultRecord` fills them from the row (stage rows give `null`/omit).
2. **`src/evals/stats.ts`:** `Stats` gains optional `mean_turns` and `mean_tool_calls`; `computeStats` fills them using the existing `mean` helper over executed results with non-null values; omitted when the run has no such data. Export nothing else.
3. **`src/evals/compare.ts`:** add `mean_turns` and `mean_tool_calls` `NumberDelta`s to the compare output only when both runs are agent runs (shape per A01), and `agent_diff` (`changed_keys`, `instructions` line diff, `{ a, b }` revisions; computed from `config.target.definition`) in place of `stage_diff` for agent pairs (`stage_diff` stays `null`); the "inconclusive"/significance rules are unchanged. Compare mismatch (`EVAL_COMPARE_MISMATCH`) between an agent run and a stage run of different targets is already the rule; add a test that a stage run vs an agent run mismatches.
4. **`src/evals/manager.ts`:** `summary_json` (headline numbers at finish) includes `mean_turns`, `mean_tool_calls` for agent runs.
5. **Read models:**
   - `read/runs.ts`: `WireResultDetail` gains `subject_ref: string | null`, `turns: number | null`, `tool_call_count: number | null`; for agent results `output` is the conversation subject and a typed helper `conversationView(output)` returns `{ messages, tool_calls, final_reply, stop_reason }` safely (unknown shapes give `null`). `RunHeadline`/`EvalRunDetail.stats` carry the new aggregates; `RunCurrent` gains `agent_revision`, `agent_definition_hash` for agent runs (what is "current" for the stale-config banner) alongside the stage hashes; for agent runs the snapshot's `target.tools[].class` and `limits_override` are passed through for the Config tab.
   - `read/results.ts`: `ResultRow` gains `turns`, `tool_calls` per case-row (mean over repeats via the same fold used for latency; compute in `stats.ts` if it is a formula, else pass through).
   - `read/api.ts`: `buildResultDetail` includes `agent_id` and `session_id` for agent runs; list and detail target blocks carry `kind: "agent"` with `agent` id and `revision`; target filters on the list endpoint (`target_kind`) honored.
   - `read/list.ts` (`EvalListItem`): target label/subtitle for agents (agent name and model from the snapshot, not the live agent).
6. **`src/evals/estimate.ts`:** `estimateRun` accepts an optional agent block `{ turnsPerCase, simulatorCallsPerCase, judgeTranscriptTokens }`; with a previous run it keeps using actual per-result cost (conversation results already include simulator cost); without one it applies the fixed assumptions in `evals-result-schema.md` Release 2 ("Cost estimate (agents)", constant `AGENT_ESTIMATE_ASSUMPTIONS`) and says so (`based_on_run_number: null`, `estimate_basis: "assumptions"`). The route (A10) fills the block from the eval's `conversation` settings and the catalog prices. Stage estimates must be identical.
7. **Tests (hand-computed):** `mean_turns` of results [2, 4, null, 6] with one errored = 4 (only executed, non-null); stage run stats equal the existing golden; compare deltas with two agent runs; `conversationView` on valid, truncated and foreign shapes; result detail for an agent result; estimate with and without a previous run; stage-vs-agent compare mismatch.

## Acceptance

- [x] `computeStats` over an agent fixture returns `mean_turns` and `mean_tool_calls` equal to hand-computed values; over a stage fixture the object is deep-equal to the current golden (no new keys).
- [x] `compareRuns` includes the two new deltas for agent pairs only.
- [x] Result detail returns the stored conversation subject, `subject_ref`, `turns`, `tool_call_count`, and `agent_id`/`session_id`; a result whose session was deleted still renders.
- [x] Run detail `current` block flags a changed agent revision/definition hash after the agent is edited (stale-config signal).
- [x] The estimate includes simulator and judge-transcript cost when there is no previous run, and equals the actual per-result mean when there is one; stage estimates unchanged.
- [x] No formulas outside `stats.ts`, `scoring.ts`, `compare.ts` (and `estimate.ts` which already holds the estimate math).
- [x] No stage eval behavior changes; existing eval tests untouched.
- [x] `npm test`, `npm run ui:test`, `npm run typecheck` pass.

## Contract notes from A01 (the six specs' "Release 2: agents" sections win over any older line in this story)

- Stats additions are exactly `mean_turns` and `mean_tool_calls` (plain means over executed results with a value); `ResultRow` gains `turns` and `tool_calls` (mean per case).
- Wire statuses are unchanged (no aliases): `stage_failed` + `EVAL_AGENT_FAILED`/`EVAL_AGENT_TIMEOUT` and `error` + `EVAL_SIMULATOR_ERROR` are stored values; `EVAL_EXECUTED_RESULT_STATUSES` is unchanged.
- `cost_stage` is the target cost for agent runs (agent + sub-agents + simulator); judge cost stays separate.

## Out of scope

Routes, CLI, MCP shape changes (A10), screens (A12), tool-call count budgets, per-turn cost breakdown, groundedness aggregates.

## Open questions

_(agent fills; stop and ask the owner)_

## Final note

Files: `src/evals/{statsTypes,statsAdapter,stats,compare,estimate,manager}.ts`, new `src/evals/agentDiff.ts`, `src/evals/read/{runs,results,list,api,compare}.ts`, `src/server/evalRoutes.ts` (type fixes, `target_kind`/`agent` list filters, null `subject_ref`/`turns`/`tool_call_count` on try). Tests: `tests/evals/agentStats.test.ts`, `tests/evals.agentRead.test.ts`.

Decisions/notes:
- `computeStats` takes optional `targetKind`; agent runs always carry `mean_turns`/`mean_tool_calls` (null when no data); stage runs omit them unless a record has turns/tool calls.
- `CompareRunInput` gained optional `targetKind`, `agentId`, `agentRevision`, `agentDefinition`; kind mismatch or different agent ids throw `CompareMismatchError`. `agent_diff.instructions_diff` is the line diff key; revisions in `agent_diff.revision {a,b}`.
- `buildRunDetail`/`currentHashes` take an optional `agents: AgentCatalogPort`; without it `agent_revision`/`agent_definition_hash` are null. A10 must pass the agent service from routes and MCP. Same optional `agents` on `loadAggregatedEvalList`/`loadEvalListItems`/`buildEvalListItems` (live agent fallback for list label when no run exists).
- `resultToWire(r, review, agentId?)`: `agent: { id, session_id } | null` only when agentId is passed (agent runs). `WireResultDetail` now always has `subject_ref`, `turns`, `tool_call_count`.
- `estimateRun` `agent` block extended with optional `agentPrice`/`simulatorPrice`/`judgePrice` (`{ inputPerMillion, outputPerMillion }`) because the assumptions need prices; A10 fills them from the catalog and passes `rubricGraderCount` counting `rubric` plus `goal_reached`. Assumption read: agent calls per turn = 1 + 2 tool calls. `AGENT_ESTIMATE_ASSUMPTIONS` is exported from `estimate.ts`. Response adds `simulator_calls`, `estimate_basis` only when the block is present; route not yet wired (A10).
- Not done: route wiring of estimate block, `?subject_ref=` run filter, `conversationView` is exported but no route uses it yet (A10).
