# A07: agentCaseRunner, plan builder, dispatch and wiring

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** ready-for-agent · **Blocked by:** A03, A05, A06 (and A02, A04: this story edits the plan builder and uses the new snapshot builders)

## Why this story exists

An eval result must be a real run of the thing under test. For an agent that is a whole conversation: open a pinned eval session, play the user, send turns, honor limits, budget, timeout and cancel, and return the transcript as the case output. This story is the code that turns one (case, repeat) into an agent conversation (G1), mirroring what `stageCaseRunner` does for stages, and wires it so the manager, the internal run-case route and "Try one case" all work for agent evals.

## Read first

- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it). Items 1, 2, 5, 11, 12.
- [Plan](../../specs/evals-agents.md) G1, G5, G8, G9, section 5 (diagram and "Changed" list), risk 6, 7.
- "Release 2: agents" sections of `docs/specs/evals-engine-interface.md` (runner steps, stop conditions, phases) and `evals-result-schema.md` (conversation subject JSON, status/error mapping), from A01.
- Code to mirror: `src/evals/runner/stageCaseRunner.ts` (`createStageCaseRunner`, `StageCaseRunner` interface, per-eval-run state `spend`/`cancelled`/`abort`, budget refusal, `cancelAll`), `src/server/evalInternalRoutes.ts` (`handleEvalInternalRoutes`, `EvalInternalServices.runner`), `src/evals/engine/promptfoo/generate.ts` (`buildProviderSource`, `META_KEYS`) and `normalize.ts` (`RecordMetadata`), `src/evals/plan.ts` (`buildEvalPlan`), `src/evals/types.ts` (`EvalPlan`, `RunCaseResult`, `CaseOutput`), `src/evals/manager.ts` (where `stageRunId` flows into persistence, `tryOne`), `src/server/bootstrap.ts` (around lines 410-450: runner, manager, `evalServices` construction), `src/agents/hostContext.ts` (`AgentHostContext`: `service`, `chat`, `backend`), `src/agents/chatTurn.ts` (`send`, `stop`, `release`), A03/A05/A06 outputs.

## Decisions already made (do not revisit)

- The promptfoo provider still calls one Host route (`/api/evals/internal/run-case`); the Host runs the loop; promptfoo never sees turns (G1).
- A session per (case, repeat), `source: "eval"`, on the revision pinned at plan time (G5, owner decision 5); eval limits and `capture: "full"` via A03 overrides (G9); gate policy via A05; no side channels (G8).
- Stop conditions, in order of check: cancel; budget (`EVAL_BUDGET_EXCEEDED`, refuse to start a case once spend >= `maxCostUsd`, in-flight cases finish); driver `end` (`script_end`, `resolved`, `abandoned`) and the loop stops `no_progress` / `empty_message`; `conversation.max_turns` (`stop_reason: "max_turns"`, a normal completion, not an error); per-turn timeout `turn_timeout_ms` (stop the turn with `chat.stop`, error per the A01 mapping); case wall clock = `max_turns * turn_timeout_ms + 60 s`.
- Cost of a case = sum of agent turn costs (including sub-agent sessions, A03) + simulator usage (A06). Tokens likewise. Latency = wall clock of the conversation.
- Transcript text and tool results are stored redacted (plan risk 8). `agent_messages.text` is stored **unredacted** (verification sections 3 and 8), so `buildConversationSubject` applies `redactSecrets` to every message, argument and result (ledger or stored) before capping.

## What to build

1. **Types (`src/evals/types.ts`):** `EvalPlan` becomes a union keyed by `target.kind` or gains `agent?` fields (follow the A01 spec): `agentRevision`, `agentDefinitionHash`, `conversation` (resolved), `userModel`, `scenarioMode` per case. `CaseOutput` becomes `EnvelopeOutput | ConversationOutput` (`kind: "conversation"`, shape from A01). `RunCaseResult.ok` gains `subjectRef: string` (session id; stage results set it equal to `stageRunId`); the failure variant gains optional `subjectRef`, `output` (partial conversation) and the codes `EVAL_AGENT_FAILED`, `EVAL_AGENT_TIMEOUT`, `EVAL_SIMULATOR_ERROR`. Add the `agent_running` phase. Add `RunCaseFailureCode` members per the A01 mapping. Stage code compiles by narrowing.
2. **`src/evals/plan.ts`:** `buildEvalPlan` branches on `loaded.file.target.kind`; agent branch uses A02's `resolveAgentTarget`, reads the agent's **current revision once**, fills the plan and builds the snapshot/components with A04's builders (effective limits recorded). The stage branch is untouched. Reject with `EVAL_INVALID` when the agent has parse issues.
3. **`src/evals/runner/conversationSubject.ts`:** `buildConversationSubject({ detail: AgentSessionDetail, calls: EvalToolCallRecord[], stopReason, usage })` → `ConversationOutput`: messages from `detail.messages` (with turn numbers), tool calls merged from A05 records and `tool` spans (name, args, result summary, status, `policy_outcome`), `final_reply` = last assistant message, `turns` = user turn count, per-field truncation constants (`EVAL_CONVERSATION_LIMITS` in `constants.ts`).
4. **`src/evals/runner/agentCaseRunner.ts`:** `createAgentCaseRunner(deps)` returning the same interface as `StageCaseRunner` (`runCase(plan, req)`, `cancelAll(evalRunId)`, `spend`, `addSpend`). Steps per case: load case from plan; create driver (A06); open session with overrides; register gate (A05) and per-session recorder; loop (driver.next, `chat.send({ projectRoot, agentId, sessionId, text, source: "eval" })`, accumulate usage, check stops); on exit read `service.getSession`, build the subject, `chat.release`, unregister the gate, return `RunCaseResult` with `subjectRef = sessionId`. Failure mapping is the table in `evals-result-schema.md` Release 2 (`agent.*` errors -> `stage_failed`/`EVAL_AGENT_FAILED`, timeouts -> `EVAL_AGENT_TIMEOUT`, simulator -> `error`/`EVAL_SIMULATOR_ERROR`); a failed case returns its partial subject. Always release and unregister in `finally`. `cancelAll` calls `chat.stop` for active sessions, waits until terminal.
5. **`src/evals/runner/caseRunner.ts`:** `createEvalCaseRunner({ stage, agent })` implementing the same interface, dispatching on `plan.target.kind`; `spend`/`addSpend`/`cancelAll` fan out. `createStageCaseRunner` is unchanged.
6. **Wiring:** `src/server/bootstrap.ts` builds the agent runner from the agent host context and passes the dispatcher as `stageRunner` to `EvalRunManager` and `evalServices.runner` (rename nothing). In `src/evals/manager.ts` persist `subjectRef` from the result next to `stageRunId`, and `turns` and `toolCallCount` (columns from A04) taken from the conversation output; on boot recovery, sweep eval sessions of recovered runs with `AgentService.deleteEvalSessions`. `tryOne` accepts agent definitions and persists nothing but keeps its session for the response, then deletes it.
7. **Provider metadata:** in `generate.ts` add `subjectRef` to the metadata keys the generated provider forwards and in `normalize.ts` `RecordMetadata`; `output` may be the conversation object. Keep stage output paths identical.
8. **`src/evals/runner/FakeAgentBackend.ts`:** a scriptable `ConversationBackend` (replies, tool calls through `hooks.gate/toolStarted/toolFinished`, usage, delays, failures) used here and by A15.
9. **Tests** (`tests/evals.agentCaseRunner.test.ts`): script case happy path (messages, tool calls recorded, usage summed, session `source: "eval"` and hidden); simulated case with `FakeSimulatorModel`; `max_turns` stop is `completed`; turn timeout; backend failure; budget refusal without opening a session; `cancelAll` mid-turn; revision pinned when the agent changes mid-run; sub-agent cost summed; `read_only` tool stub recorded; cleanup (`release` called, gate unregistered) on every path; dispatcher routes by kind; internal route test with an agent plan and `FakeEngine`.

## Acceptance

- [x] A scripted 3-turn case returns `ok: true`, `subjectRef`, a conversation `output` with 6 messages and recorded tool calls, `costUsd`/`tokensIn`/`tokensOut` equal to the fake backend's reported usage plus simulator usage.
- [x] Every stop condition yields its documented `stop_reason` (`script_end`, `resolved`, `abandoned`, `max_turns`, `no_progress`, `empty_message`) or failure code; budget refusal opens no session (assert session count).
- [x] `cancelAll` stops in-flight turns and sessions end terminal before it resolves.
- [x] The run uses the plan's pinned revision even if the agent is saved during the run.
- [x] Eval sessions never appear in operator lists and no approval row is created (reuses A03/A05 asserts).
- [x] `tryOne` with an agent eval returns transcript, grades-ready output and cost, persists no `eval_*` rows.
- [x] Stage plans and runs behave exactly as before (dispatcher passes through; existing runner/manager/route tests untouched).
- [x] No test calls a real model or the network.
- [x] `npm test`, `npm run ui:test`, `npm run typecheck` pass.

## Contract notes from A01 (the six specs' "Release 2: agents" sections win over any older line in this story)

- The cost cap is checked before a case starts only, never inside a running conversation (overshoot bounded by `concurrency` conversations); the run dialog copy says so.
- Session `sourceRef` is the eval run id for the root; descendants use the parent session id. On boot recovery the manager also deletes eval sessions older than 7 days that no `eval_results.subject_ref` references (`AgentService.deleteEvalSessions`).
- The run-case output carries the transport-only `transcript` string (bounded rendered transcript for the judge); the manager drops it before storing. `subjectRef` is a new provider metadata key; `normalize.ts` accepts `subjectRef` or `stageRunId` as the join echo.
- `cost_usd` of a result = root + descendant turns + simulator usage; `tokens_*` exclude the simulator (they are in `usage` of the subject).
- Under the default `read_only` policy sub-agent calls are blocked, so descendant sessions only occur with `tools: real`.
- Agent host absent (no SQLite) -> `ok:false EVAL_ENGINE_ERROR`; the plan builder reports `eval.agents_unavailable` before the run starts.

## Out of scope

Graders and conversation rubric (A08), stats and read models (A09), API/CLI/MCP/UI (A10+), real-promptfoo smoke (A15).

## Open questions

_(agent fills; stop and ask the owner)_

## Final note

Branch `worktree-agent-a8dc835c5ce64ecf2` (commit 5eb0264d). Files: `src/evals/runner/{agentCaseRunner,caseRunner,conversationSubject,FakeAgentBackend}.ts`, `src/evals/{types,plan,manager}.ts`, engine `generate/normalize/PromptfooEngine/FakeEngine`, `src/server/bootstrap.ts`, `src/agents/{store,service}.ts` (+`listEvalRootSessions`, `sweepEvalSessions`), judge `systemPrompt` in `runtime/types.ts`+`piRuntime.ts`+`simulatorModel.ts`; tests `evals.agentCaseRunner`, `evals.agentPlan`.
- ConversationOutput TS fields are snake_case (stored JSON shape). `RunCaseResult.ok.subjectRef` optional (stage runner untouched; manager falls back to stageRunId). `EvalPlan` gained optional `agent/conversation/userModel` rather than a union.
- Not done: `transcript` (renderTranscript is A08); internal-route HTTP test with an agent plan; other `buildEvalPlan` callers (evalRoutes, read/api) do not pass `agents` yet (A10). Generated provider/hooks text differs only for agent plans. One A06 test assertion adapted for judge `systemPrompt`. `ui:test` not run.
- Full `npm test`: only flaky unrelated failures (cli.init, server.shutdown, one agents.chat timeout under load), differing between runs.
