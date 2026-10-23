# A03: Agent service support for eval sessions

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** done (branch worktree-agent-a05270e21b0ea3a92) · **Blocked by:** A01

## Why this story exists

An eval case is a real agent session (G4). To run one safely the service must open a session on an explicit revision (G5), mark it `source: "eval"`, keep it out of every list, count, inbox and retention path the operator sees, apply the eval's limits instead of the agent's (G9), and guarantee no side effect leaves the Host (G8). None of that exists today: `openSession` always opens the current revision and every list query returns every source.

## Read first

- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it). Its items 2, 9, 10, 11 are the design basis; its call-site table is the checklist for this story.
- [Plan](../../specs/evals-agents.md) G4, G5, G8, G9, section 5 ("Agent service"), owner decisions 3 and 5.
- `docs/agent-runtime.md` (limits, sessions), `docs/agent-observability.md`.
- Code: `src/agents/service.ts` (`openSession`, `beginTurn`, `assertWithinLimits`, `definitionAt`, `list`, `listSessions`, `listAllSessions`, `pendingApprovals`, `pendingByAgent`, `resumableTurns`, `recoverInterruptedTurns`, `scheduledAgents`), `src/agents/store.ts` (`AgentSession`, `SessionQuery`, `listSessions`, `listSessionsForRef`, `sessionStats`, `listPendingApprovals`, `insertSession`, plus a delete helper if needed), `src/agents/sessions.ts` (`AgentConversation.send`, `SendTurnInput`, `exportLive`, `score`), `src/agents/chatTurn.ts`, `src/server/agentRoutes.ts`, `src/mcp/agentTools.ts`, `src/agents/errors.ts`. Tests: `tests/agents.*.test.ts` (use the harness in `tests/agents.chat.test.ts`).

## Decisions already made (do not revisit)

- Eval sessions are ordinary rows with `source = "eval"` (a constant `EVAL_SESSION_SOURCE`); no new table (G4). `source` is a free string today, so no migration.
- Hidden **everywhere** by default: lists, per-agent and all-agent stats, pending approvals, Inbox counts, retention (owner decision 3). An explicit opt-in (`includeEval: true`) exists only for internal readers (eval read models, tests).
- The revision is pinned by the eval run at start (G5, owner decision 5): `openSession` gets an optional `revision`, defaulting to current for every existing caller.
- Eval limits replace agent limits for eval sessions and the effective values are reported (G9). Real sessions are untouched.
- No channel send, schedule, web chat, OTLP push or groundedness judge for eval sessions (G8).
- Eval sessions can never be approved by a person: the eval gate policy is A05; this story only guarantees they never appear as pending approvals to operators.

## What to build

1. **`src/agents/evalSession.ts` (new):** `EVAL_SESSION_SOURCE = "eval"`, `type EvalSessionOverrides = { revision?: number; definition?: Partial<{ model; limits; observability: { capture }; evals: { groundedness } }>; limits?: { max_turns; session_minutes; cost_usd }; capture?: "full" | "metadata" }`, and `isEvalSession(session)`.
2. **`service.openSession`:** new optional `eval: EvalSessionOverrides`; allowed only when `input.source === "eval"` (else `AgentError("agent.invalid")`). Loads `revision` via `definitionAt` (errors: `agent.revision_not_found`; archived agents refused), stores the overrides in a service-owned map keyed by session id (memory only; eval sessions do not survive a Host restart, and boot recovery marks them failed), and returns the session with `revision` set.
3. **Effective definition:** one private method `effectiveDefinition(session)` used by `beginTurn`, `assertWithinLimits`, `requestApproval` and `definitionAt` callers inside the service: pinned revision definition merged with the session's overrides. `beginTurn` returns the effective definition in `ActiveTurn`, so `AgentConversation.runTurn` (capture mode, groundedness flag, limits) sees it. Check the eval `max_turns` and `session_minutes` overrides in `assertWithinLimits`.
4. **Hide eval sessions:** add `source <> 'eval'` (a `hideEval` clause) to `AgentStore.listSessions`, `sessionStats` (both queries), `listPendingApprovals`, `listSessionsForRef`; thread an `includeEval?: boolean` through `SessionQuery` and the store signatures (default false). Cover every call site in the A00 table: `AgentService.list`/`pendingByAgent`/`listSessions`/`listAllSessions`/`pendingApprovals`/`pendingApprovalFor`, the routes in `src/server/agentRoutes.ts`, the MCP tools in `src/mcp/agentTools.ts`, and `resumableTurns`/`scheduledAgents` (must ignore eval). A direct `getSession(projectRoot, sessionId)` by id still works (the eval transcript view needs it).
5. **No side effects:** in `AgentConversation.runTurn`, `exportLive` returns early and `score` is skipped when `active.session.source === "eval"` (the eval grader replaces groundedness). Confirm by test that `OtlpSink` and `backend.judge` are never called for an eval session. Sub-agent sessions created by `delegate` while the parent is an eval session get `source: "eval"`, `sourceRef = <parent session id>` (the root eval session has `sourceRef = <eval run id>`) and the parent's overrides; add the child session id to the `agent:<id>` span attributes (`stageflow.sub_agent.session_id`) and `gen_ai.tool.call.id` to tool span attributes; add `AgentStore.listChildSessions(sessionId)` (recursive over `source_ref`). A07 sums descendant cost under the root.
6. **Cleanup:** `AgentService.deleteEvalSessions(projectRoot, sessionIds)` and `AgentStore.deleteSessions(ids)` (messages, turns, spans, approvals cascade; follow the existing FK/transaction style) used by A04/A10 when an eval run is deleted. Refuses non-eval sessions. Also `closeEvalSession(sessionId) that releases the runtime session through `AgentChatController.release`.
7. **Boot:** `recoverInterruptedTurns` keeps working for eval sessions (they become failed turns); eval sessions left `open` after a crash are swept by `deleteEvalSessions` when their eval run is recovered failed (A07 calls it).
8. **Tests** (`tests/agents.evalSessions.test.ts`): pinned revision opens that revision after the agent file changes; override of model/limits/capture reaches the backend input; eval session absent from `listSessions`, `listAllSessions`, stats, `list` counts, `pendingApprovals`, MCP list; present with `includeEval`; `delegate` child inherits `source: "eval"`; no OTLP/judge calls; non-eval `openSession` with `eval` overrides is rejected; `deleteEvalSessions` refuses real sessions.

## Acceptance

- [x] `openSession(..., { source: "eval", eval: { revision: n } })` opens revision n even when current is n+3; omitted `eval` behaves exactly as before.
- [x] Eval limits (`max_turns`, `session_minutes`, `cost_usd`) are enforced for eval sessions and the agent's own limits are not; real sessions unaffected.
- [x] No operator-facing list, count, stat, pending approval or Inbox source returns an eval session (test per call site in the A00 table).
- [x] `capture: "full"` override stores tool arguments and results for an eval session without editing the agent file.
- [x] No OTLP push, no groundedness judge, no delivery for eval sessions (spies).
- [x] Deleting eval sessions removes their messages, turns, spans, approvals; real sessions are refused.
- [x] No stage eval behavior changes; existing eval tests untouched; existing agent tests pass untouched.
- [x] `npm test`, `npm run typecheck` pass (`npm run ui:test` not run: no UI change).

## Contract notes from A01 (the six specs' "Release 2: agents" sections win over any older line in this story)

- Effective override values for eval sessions (from the contract): `max_turns = conversation.max_turns + 1`, `session_minutes = ceil(max_turns * turn_timeout_ms / 60000) + 5`, `cost_usd = null`, `always_on = false`, `capture = full`, `otlp = false`, `evals.groundedness = false`, plus the eval's model override; they are applied inside `beginTurn` before `assertWithinLimits` (a wrapper outside cannot do it, verification section 6).
- `deleteEvalSessions(projectRoot, ids)` deletes the given roots **and their descendants** (via `listChildSessions`). The age-based orphan sweep on boot (eval sessions older than 7 days referenced by no `eval_results.subject_ref`) is called from the eval manager recovery in A07.
- Eval sessions bypass `enabled` (owner decision 7) in both `openSession` and `beginTurn`; archived agents are still refused.

## Out of scope

Tool and approval policy (A05), the case runner (A07), the migration for eval results (A04), UI.

## Open questions

_(agent fills; stop and ask the owner)_

## Final note

Files: `src/agents/evalSession.ts` (new: `EVAL_SESSION_SOURCE`, `EvalSessionOverrides`, `isEvalSession`, `applyEvalOverrides`), `service.ts` (`openSession` eval option, `effectiveDefinition`, `evalOverridesOf`, `listChildSessions`, `deleteEvalSessions`, `forgetEvalSession`, `pendingApprovals({includeEval})`), `store.ts` (`HIDE_EVAL` clause, `includeEval` on `SessionQuery`/`sessionStats`/`listPendingApprovals`/`listSessionsForRef`, `listChildSessions`, `deleteSessions`), `sessions.ts` (eval skips OTLP push and groundedness; `delegate` marks eval children; `SendTurnInput.sourceRef/eval`), `chatTurn.ts` (`closeEvalSession`), `runtime/types.ts` + `piRuntime.ts` (`delegate` gets optional `callId`), `tests/agents.evalSessions.test.ts` (17 tests).
Decisions taken inside the story: eval sessions always get forced defaults (always_on false, otlp false, groundedness false, capture default full); eval limits given as `limits` set `cost_usd` null unless supplied; `gen_ai.tool.call.id` and `stageflow.sub_agent.session_id` span attributes are added for eval sessions only, so real traces are byte-identical; `closeEvalSession(projectRoot, sessionId)` lives on `AgentChatController`. Routes and MCP tools needed no edit (the store filter covers them; `includeEval` is not reachable from request params).
Not done: the age-based orphan sweep (called from A07 recovery per contract note; only `deleteEvalSessions` exists). Full suite: only `tests/runChangeBus.test.ts` fails (`store_schema_too_new`: shared `$STAGEFLOW_HOME` store migrated past this binary by another worktree), plus the socket-leak guard from a concurrent worktree; neither touches agents.
