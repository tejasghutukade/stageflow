# A00: Pre-build verification of agent runtime unknowns

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** ready-for-agent · **Blocked by:** none · **Product code:** none

## Why this story exists

Stories A03, A05, A06 and A07 rest on facts about the agent runtime that nobody has verified: how to run a conversation without a channel, how to pin a revision, where the tool gate can be wrapped, which tools are safe, and what spans record. Guessing them would put assumptions into the build. This story answers each question with a small experiment or a code reading and writes the answers into one file that every later story reads. **No product code is written.** Experiments live in the session scratchpad; only the results file and saved fixtures enter the repo.

## Read first

- [Plan](../../specs/evals-agents.md): sections 2, 3 (G1-G13), 5, 7 (A00 row), 8.
- `docs/agent-definition.md`, `docs/agent-runtime.md` (the gate, asking first, limits), `docs/agent-observability.md` (capture modes).
- `src/agents/chatTurn.ts` (`AgentChatController.send`), `src/agents/sessions.ts` (`AgentConversation.send`, `runTurn`, `gateOne`, `hooks`), `src/agents/service.ts` (`openSession`, `beginTurn`, `assertWithinLimits`, `requestApproval`, `listSessions`, `listAllSessions`, `list`, `pendingApprovals`), `src/agents/store.ts` (`listSessions`, `sessionStats`, `listPendingApprovals`), `src/agents/runtime/types.ts` (`ConversationBackend`, `TurnHooks`, `GateDecision`, `BUILTIN_TOOL_GROUP_OF`), `src/agents/runtime/piRuntime.ts` (gate extension near line 149), `src/agents/policy.ts`, `src/agents/trace.ts` (`prepareSpan`), `src/toolkit/meta.ts` (`TOOL_META`, `ToolRisk`).
- Release 1 shell: `src/evals/runner/stageCaseRunner.ts`, `src/server/evalInternalRoutes.ts`, `src/evals/engine/promptfoo/generate.ts` (provider and assertions), and the epic's "Pre-build verification results" (`docs/specs/evals.md`) for method.
- Test precedent: `tests/agents.chat.test.ts` (inline `ConversationBackend` fakes).

## Rules for the experiments

- No real provider keys and no network. Models are stubs: an inline `ConversationBackend`, or a local HTTP stub speaking OpenAI chat-completions where a real runtime path is needed.
- Run experiments in a scratch copy or with an injected store; never write to the user's real `$STAGEFLOW_HOME`.
- Record facts with the command or code that produced them (file and line), not opinions.

## What to verify (each item ends with a recorded answer)

1. **Conversation without a channel.** Can `AgentChatController.send` (or `AgentConversation.send`) drive several turns on one session id from inside the Host with no channel, no web chat and no console? What does the caller need (`projectRoot`, `agentId`, `sessionId`, `source`)? Is `AgentSessionDetail` enough to read the reply, or must spans be read? Name the exact calls to open a session, send turn N, read messages, and release the runtime session (`chat.release`).
2. **Revision pin and definition override.** `openSession` always calls `currentRevision`. Show the minimal change to accept `revision` (and an in-memory definition override for model and limits). Where does `beginTurn` take the definition (`definitionAt(session.revision)`), and where would an override have to be stored so `beginTurn`, `assertWithinLimits`, `runTurn` and `requestApproval` all see it? Is a revision of a disabled or archived agent loadable? What happens to a running eval session if the agent file is edited mid-run?
3. **Wrapping the gate for `source: eval`.** `gateOne` in `sessions.ts` runs grants, `requiresAskFirst`, then `service.requestApproval`. Record exactly where an eval policy hook can sit, how it learns the session source (`active.session.source`), and confirm a real session cannot reach it. Can a gate decision only allow or block (`GateDecision`), or can a tool result be substituted? Check Pi's extension API in `piRuntime.ts` and the installed Pi package for a tool-result override. If not, record the fallback (block with a reason string that carries the canned result) and what the model sees.
4. **Read-only classification.** For every tool kind, record whether it is provably read-only: builtin groups (`BUILTIN_TOOL_GROUP_OF`: read/write/shell), Stageflow tools (`TOOL_META` risk `read|write|destructive|external`, operator-only groups), MCP tools (`<server>.<tool>`, unknown), sub-agents (`agent:<id>`), browser. List the stageflow tools whose risk is `read` today, and whether MCP tool annotations (`readOnlyHint`) are visible to the runtime. Output a proposed classification table for A05.
5. **Span content and capture.** At `capture: metadata`, are tool arguments and results stored? (`prepareSpan` drops `inputText`/`outputText` unless `full`.) Can an eval session force `full` for its own sessions without editing the agent file (through item 2's override)? Is redaction applied before storage? Can tool calls and results also be captured in memory from `TurnHooks.toolStarted/toolFinished` instead of spans? Recommend one source for the conversation subject and say why.
6. **Simulated user probe.** With a stub model, run a draft simulator prompt (persona, goal, facts, stop marker) against a canned agent for 3 scenarios. Record: does the stub-driven loop stop on the marker and on `max_turns`; what a bad reply looks like (leaks facts early, breaks character, never ends); how the stop marker is parsed. This is a prompt-shape probe, not a quality evaluation.
7. **promptfoo needs nothing new.** With the stub provider returning a conversation-shaped `output` object, confirm the existing generated provider, `javascript` assertions (the `code` grader path) and `llm-rubric` run unchanged (G13). Record any size limit on `output` and on `metadata`, and how a non-string/object `output` is passed to assertions.
8. **Cost of a 6-turn conversation.** Estimate tokens and cost for a 6-turn case: agent turns, simulator calls, one judge reading a bounded transcript. Use the model catalog prices (`src/models/catalog.ts`) and stub token counts; give a formula and a worked example. Feeds A04/A07 estimates.
9. **Hiding eval sessions: call sites.** List every place that lists, counts or reads agent sessions or approvals for display, with file and function, so A03 can exclude `source = 'eval'` everywhere. Starting points (verify and complete): `src/agents/store.ts` `listSessions`, `sessionStats`, `listPendingApprovals`, `listSessionsForRef`; `src/agents/service.ts` `list` (via `pendingByAgent` and `sessionStats`), `listSessions`, `listAllSessions`, `pendingApprovals`, `pendingApprovalFor`, `resumableTurns`, `recoverInterruptedTurns`, `latestUndelivered`; `src/server/agentRoutes.ts` (`/api/agents/sessions`, `/api/agents/approvals`, `/api/agents/:id/sessions`); `src/mcp/agentTools.ts` (session list and get tools); `src/server/overview*` and the Inbox and Overview UIs (`ui/src/redesign/inbox`, `ui/src/redesign/overview`, `ui/src/redesign/agents`) for approval and session counts; `src/toolkit/meta.ts` (Stageflow tools that list sessions). Also state whether any retention or cleanup of agent sessions exists today (search for `DELETE FROM agent_`); if none, say so, and say what deleting an eval run must do about its sessions.
10. **Approvals bypass.** `requestApproval` throws when the tool is not ask-first and otherwise inserts a pending approval and sets the session `waiting`. Record how `record_only` can be implemented for `source: 'eval'` without ever inserting a pending approval or touching `approvalBroker`: which function short-circuits (`gateOne` before `requestApproval`), what must be recorded (tool, arguments, `would_ask_first`), what the model is told, and which spans appear (`approval <tool>` gate span with `stageflow.approval.outcome`). Confirm `bash` (always ask-first) behaves the same and that `decideApproval`/the Inbox can never see an eval approval.
11. **Sub-agents and side channels.** For `agent:<id>` delegation, what `source` do child sessions get (`"agent"` in `delegate`) and how must they be tagged so they are hidden and costed under the eval session? Confirm no channel delivery, schedule, web-chat registration or OTLP push (`exportLive`) is triggered by a session opened directly through the service, and that the groundedness `judge` call is skipped when `evals.groundedness` is off or the backend has no `judge`.
12. **Turn lifecycle for evals.** How does a runner cancel a running turn (`chat.stop`), time one out (the runtime has `agent.model_timeout`; is there a per-turn wall clock?), and learn cost and tokens per turn (`AgentTurn.costUsd/inputTokens`)? What does a turn that fails (`agent.limit_reached`, `agent.guardrail_blocked`, `agent.backend_failed`) look like in `AgentSessionDetail`?

## Deliverables

- **`docs/specs/evals-agents-verification.md`**: one numbered answer per item above (1-12), each with evidence and a final line "Impact on stories: ...". Include the proposed tool classification table (item 4), the call-site table (item 9) and the recommended extension points (items 2, 3, 10) as small code sketches (not committed code). End with "Contradictions": anything that conflicts with plan G1-G13 or owner decisions, stated plainly.
- If a result contradicts a G decision or an owner decision, **stop and report to the owner**; do not work around it.
- Any fixture worth keeping (for example a stub OpenAI server for the A15 smoke) saved under `tests/fixtures/evals/` with no secrets.

## Acceptance

- [ ] Items 1-12 each have a recorded answer in `docs/specs/evals-agents-verification.md` with evidence (file and line, or the command).
- [ ] The tool classification table covers builtin, Stageflow, MCP, sub-agent and browser tools.
- [ ] The call-site table names file and function for every list, count, inbox and retention path, and says "none exists" where that is the case.
- [ ] The `record_only` approval design and the revision-pin/override design are written as concrete sketches.
- [ ] The 6-turn cost formula and example are recorded.
- [ ] Contradictions with the plan are listed (or "none").
- [ ] No file under `src/` or `ui/` changed; `git status` shows only docs and fixtures.

## Out of scope

Any product code. Choosing the simulator model. Judge or simulator quality evaluation. Changes to the plan (report them; the owner edits it).

## Open questions

_(agent fills; stop and ask the owner)_
