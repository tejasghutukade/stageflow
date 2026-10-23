# A05: Tool policy, approval policy and tool-call recording

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** done (branch worktree-agent-a341274bd9bcfb96a) · **Blocked by:** A03

## Why this story exists

The highest risk in agent evals (plan risk 1) is a case that really runs `bash`, `write` or an MCP tool against the author's project, or that parks on an approval nobody will answer. This story builds the eval-only gate: it classifies every tool, blocks or stubs everything not provably read-only by default (G6), turns ask-first into a recorded "would ask first" with no pending approval (G7), and records every tool call for the conversation subject. It must not be able to weaken the gate for real sessions.

## Read first

- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it). Items 3, 4, 10 give the extension point, the classification table and whether a tool result can be substituted.
- [Plan](../../specs/evals-agents.md) G6, G7, section 5 ("Tool gate"), section 8 risks 1, 7, 8, owner decision 1.
- `docs/agent-runtime.md#the-gate`, `#asking-first`.
- Code: `src/agents/sessions.ts` (`gateOne`, `hooks.gate/toolStarted/toolFinished`), `src/agents/policy.ts` (`isToolGranted`, `requiresAskFirst`, `ALWAYS_ASK_FIRST`, `forbiddenWriteTarget`), `src/agents/runtime/types.ts` (`ToolCall`, `GateDecision`, `BUILTIN_TOOL_GROUP_OF`, `grantIdForPiTool`), `src/agents/runtime/piRuntime.ts` (gate extension near line 149, tool events near line 437), `src/toolkit/meta.ts` (`TOOL_META`, `ToolRisk`, `isOperatorOnlyTool`), `src/agents/service.ts` (`requestApproval`), `src/agents/trace.ts`. A03 output: `src/agents/evalSession.ts`, the session `source`.

## Decisions already made (do not revisit)

- Tool policy `real | read_only | mocked`; default `read_only`. In `read_only`, a call runs only if its tool is provably read-only: builtin `read|grep|find|ls`, Stageflow tools with `risk: "read"`, and MCP tools the eval lists in `conversation.read_only_tools`. Everything else (write, edit, bash, destructive/external Stageflow tools, unlisted MCP tools, browser) is **stubbed**: not executed, answered with the case's mock if one exists (recorded `mocked`), else "`<tool>` was not executed in this evaluation." (recorded `stubbed`), and **recorded as a tool call** (G6). The exact decision table (tool policy x tool class, then approval policy) is in `evals-file-schema.md` Release 2; it is the contract.
- `mocked`: a tool with a `case.input.tool_mocks` entry returns its result (`policy_outcome: "mocked"`); read-class tools without a mock run; every other tool is stubbed. A mock is delivered as an error-flagged tool result carrying the canned text (owner decision 8).
- `real` runs every granted tool; the gate still applies grants and `forbiddenWriteTarget` path denial. It never skips `isToolGranted`.
- Approval policy `deny | auto_approve_read | record_only`; default `record_only`: the ask-first call is recorded `would_ask_first`, treated as **denied** for the model with the reason "Approval for <tool> was not granted in this evaluation. Continue without it.", and **no approval row is created** (G7). `auto_approve_read` lets an ask-first call continue to the tool policy only when it is read-class (otherwise `would_ask_first`). `deny` denies without recording an approval. Nothing ever reaches the Inbox.
- Operator-only Stageflow tools (`isOperatorOnlyTool`) can never run in an eval, in any mode.
- The eval gate applies only when the session source is `eval` and a gate is registered for that session id; a real session cannot reach it.
- Always-blocked set (owner decision 10), outcome `denied`: under `read_only` and `mocked` `stageflow.run_eval`, `stageflow.agent_chat`, `stageflow.fire_trigger`, `stageflow.probe_project_mcp` and every `agent:<id>` call; under `real` only `run_eval`, `agent_chat`, `fire_trigger`. So sub-agents run only under `real`, with child sessions inheriting the policy (A03); their cost is the runner's concern (A07).

## What to build

1. **`src/agents/toolRisk.ts`:** `classifyTool(definition, toolId, readOnlyExtra: string[]): { class: "read" | "write" | "shell" | "destructive" | "external" | "mcp_unknown" | "sub_agent" | "browser" | "operator_only"; readOnly: boolean }` driven by `BUILTIN_TOOL_GROUP_OF`, `TOOL_META` (via `stageflowGrantId` prefix `stageflow.`), MCP `<server>.<tool>` id shape and `agent:` prefix. The table is the A00 table. Exported `toolRiskSummary(definition)` for the UI picker (A12).
2. **`src/agents/evalGate.ts`:** `type EvalGatePolicy = { tools; approvals; readOnlyTools; mocks: Record<string, { result?: unknown; error?: string }> }`; `type EvalToolCallRecord = { id; turn; name; args; policyOutcome: "ran" | "stubbed" | "mocked" | "would_ask_first" | "denied"; status: "ok" | "error" | "not_run"; result?: string }`; `createEvalGate({ policy, definition, onCall })` returning `{ decide(call): GateDecision; observeFinished(call, result): void }`. `decide` implements the rules above using `classifyTool`, `requiresAskFirst`, `forbiddenWriteTarget` and the A00-recorded way to return a canned result (tool-result substitution if the runtime supports it, else a block whose reason is the result text, with a unit test documenting what the model sees).
3. **Registry and wiring:** `EvalGateRegistry` (Map sessionId to gate) in `src/agents/evalGate.ts`; `ConversationOptions` (in `src/agents/sessions.ts`) gets optional `evalGates`; in `gateOne`, immediately after the `isToolGranted` check: `if (active.session.source === EVAL_SESSION_SOURCE) { const gate = evalGates?.get(sessionId); if (!gate) return deny("no eval policy"); return gate.decide(call); }` — a missing gate for an eval session denies (fail closed). The existing path below it stays byte-identical for other sources. In `toolFinished`, call `gate.observeFinished`. Pass the registry through `createAgentHostContext` (`src/agents/hostContext.ts`) and `AgentChatController`.
4. **`record_only` span:** when recording a would-ask-first, record the same `approval <tool>` gate span with `stageflow.approval.outcome = "would_ask_first"` so the waterfall shows it (spans honor capture).
5. **Tests** (`tests/agents.evalGate.test.ts`, inline `ConversationBackend` that calls `hooks.gate` for scripted tool calls): read tool runs in `read_only`; write/edit/bash/destructive/external/unlisted MCP are stubbed and recorded and the backend's tool body never executes (spy); listed MCP tool runs; mocks return their result in `mocked`; `real` runs but still denies a non-granted tool and a forbidden write path; operator-only tool denied in all modes; ask-first under each approval policy creates **zero** rows in `agent_approvals` and never sets the session `waiting`; a real (`console`) session with a registered gate for its id is unaffected; an eval session without a gate denies.

## Acceptance

- [x] In `read_only`, no write/shell/destructive/external/unlisted-MCP tool body executes (spy asserts zero calls) and each is recorded with `policy_outcome: "stubbed"`.
- [x] `record_only` leaves `agent_approvals` empty and the session never `waiting`; `pendingApprovals` is empty throughout.
- [x] `tool_mocks` results reach the model in `mocked` mode and are recorded `mocked`.
- [x] `bash` (always ask-first) behaves as ask-first under each approval policy.
- [x] `real` mode still enforces grants and path denial; a warning field is available for the UI (`policy.tools === "real"`).
- [x] Missing gate for an eval session fails closed; non-eval sessions follow the unchanged gate (existing gate tests pass untouched).
- [x] The classification table has a unit test per tool class including `mcp_unknown` and `sub_agent`.
- [x] No stage eval behavior changes; existing eval tests untouched.
- [x] `npm test`, `npm run ui:test`, `npm run typecheck` pass.

## Contract notes from A01 (the six specs' "Release 2: agents" sections win over any older line in this story)

- Order of decision: (1) denied (not granted, forbidden path, operator-only, always-blocked); (2) ask-first tools go through the approval policy (`record_only` -> `would_ask_first`, `deny` -> `denied`, `auto_approve_read` -> continue for read-class, else `would_ask_first`); (3) the tool policy. `policy_outcome` values are exactly `ran | stubbed | mocked | would_ask_first | denied`.
- The ledger is the source of truth for tool calls (blocked calls emit no span in the test harness); ledger `status` is `ok | error | not_run` (`not_run` for `stubbed`, `would_ask_first`, `denied`).
- Mock value shape: `{ result }` or `{ error }`, exactly one; keys are tool grant ids.
- `mocked` fidelity and the stub text are documented in the user docs (A14).

## Out of scope

The conversation loop and user drivers (A06, A07), reading calls into the subject (A07/A08), UI warnings (A12), MCP tool annotation discovery beyond the author-declared list.

## Open questions

_(agent fills; stop and ask the owner)_


## Final note

Files: `src/agents/toolRisk.ts`, `src/agents/evalGate.ts` (new); `src/agents/sessions.ts` (eval branch first in `gateOne`, `observeFinished` in `toolFinished`, child sessions share the parent gate in `delegate`, `evalGates` option); `src/agents/hostContext.ts` (creates and exposes `evalGates`); `tests/agents.evalGate.test.ts` (new), `tests/agents.evalSessions.test.ts` (2 tests adapted).

- Deviation: the eval branch runs BEFORE `isToolGranted` (decide checks grants itself) so a not-granted call is recorded `denied`; non-eval path unchanged.
- Existing A03 tests "capture: full..." and "never lists an eval session's pending approval" ran tools in eval sessions with no gate; fail-closed makes that impossible, so the first registers a read_only gate and the second calls `service.requestApproval` directly. No assertions weakened.
- Gate records are via `onCall` (called at decision, again when a `ran` call finishes) and `gate.records()`; `turn` comes from an optional `turn()` callback the runner (A07) supplies. `gate.warning` set when tools are `real`.
- `real` mode: runtime's own path guard plus `decide`'s `forbiddenWriteTarget` (when `projectRoot` is passed). Sub-agent child sessions reuse the parent's gate object, `decide` takes the child's definition.
- Not-granted/denied/would_ask_first results text is stored in `result`. Mocks (incl. `{result}`) reach the model only as block reason (error-flagged), per A00.
- The "would_ask_first" approval span has status `error`.
