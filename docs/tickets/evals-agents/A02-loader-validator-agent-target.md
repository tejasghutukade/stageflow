# A02: Types, loader and validator for `kind: agent`

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** done (branch worktree-agent-ac2e1ccb1b8cfcfdf, commit bb1df2fd) · **Blocked by:** A01

## Why this story exists

An agent eval file must load, validate and report findings exactly like a stage eval file, so the console, CLI, MCP and manager can accept it. Today the loader rejects any target kind but `stage` (`eval.target_kind_unsupported` in `parseTarget`). This story teaches the types, loader, validator and dataset checks about agents, behind `target.kind: agent`, without touching stage behavior.

## Read first

- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it).
- [Plan](../../specs/evals-agents.md) sections 3 (G2, G6, G7, G9, G10, G12), 4, 5 ("Types", "Loader/validator").
- The "Release 2: agents" sections of `docs/specs/evals-file-schema.md` and `evals-dataset-format.md` (A01 output). They are the contract.
- Code: `src/evals/types.ts` (`EvalTarget`, `EvalFile`, `EvalDefaults`, `GraderConfig`, `ResolvedGrader`), `src/config/loadEval.ts` (`parseTarget`, `parseDefaults`, `parseGrader`, `parseEvalOutcome`, `graderHashObject`, `resolveEvalPaths`, `TARGET_KEYS`), `src/config/resolveEvalTarget.ts` (`resolveEvalTarget`, stage-only), `src/config/validateEval.ts` (`validateEval`, `evalFinding`), `src/config/loadDataset.ts` (`parseDatasetCases`), `src/config/datasetStageCheck.ts` (`checkDatasetAgainstStage`), `src/agents/service.ts` (`get`, `list`) and `src/config/loadAgent.ts` (`AgentDefinition`). Tests: `tests/` files matching `evals.loadEval*`, `evals.validate*`, fixtures in `tests/fixtures/evals/`.

## Decisions already made (do not revisit)

- Same file extension and loader: `*.eval.yaml`, `version: 1` (G12). `target: { kind: agent, agent: <id> }`; `revision` is never authored.
- Graders that cannot apply to a target kind produce a **validation finding**, never a run-time error (G10). `schema` is stage-only. The matrix is in the A01 spec.
- A disabled agent is a warning, an archived or missing agent is an error. An agent with parse issues (`AgentSummary.issues`) is an error (plan risk 6).
- Types are unions: `EvalTarget`/`TargetRef` get an agent variant; stage code paths keep narrowing on `kind === "stage"`.
- Judge-capable providers also gate `defaults.user_model` (owner decision 4).

## What to build

1. **`src/evals/types.ts`:** add `EvalTarget` agent variant `{ kind: "agent"; agent: string }`; `TargetRef` agent variant `{ kind: "agent"; agentId: string }`; `EvalConversation` (`mode`, `max_turns`, `turn_timeout_ms`, `tools`, `approvals`, `read_only_tools`); `EvalFile.conversation?`; `EvalDefaults.user_model?`; grader configs and resolved graders for `tool_calls`, `conversation_check`, `goal_reached` (fields exactly as the A01 spec); `PlanCase` input stays `Record<string, unknown>`. Add `EVAL_AGENT_TARGET` helpers as needed. Do not change `CaseOutput` or `RunCaseResult` here (A07/A08).
2. **`src/config/loadEval.ts`:** `parseTarget` accepts `kind: agent` (keys `kind`, `agent`; reject stage keys on an agent target with `eval.target_invalid`); keep the stage branch and its messages byte-identical. Add `parseConversation` with defaults and range checks (finding `eval.conversation_invalid`), `parseDefaults` accepts `user_model` only for agent targets (`eval.conversation_not_applicable` on stage targets; `conversation` and `task` get `eval.conversation_not_applicable` / `eval.task_not_applicable` on the wrong kind), agent defaults are `concurrency 2` and `max_cost_usd 1`, and `parseGrader` parses the three new types with weight/`must_pass` rules shared with the others. Extend `graderHashObject` so new types hash their configs (stage graders' hashes must not change; add a test pinning an existing grader hash).
3. **`src/config/resolveAgentTarget.ts` (new):** `resolveAgentTarget(file, projectRoot, agentService)` → `LoadOutcome<ResolvedAgentTarget>` with `{ agentId, revision, definitionHash, definition, modelResolved, tools (granted ids with risk), askFirst, issues }`. Uses `AgentService.get`; maps `agent.not_found`/archived/disabled to findings (`eval.agent_not_found`, `eval.agent_archived`, `eval.agent_disabled`, and `eval.agent_invalid` for parse issues). Hash = `sha256Hex(canonicalJson(definition))` of the revision's parsed definition after the eval's `defaults.model` override, using `src/evals/canonical.ts`.
4. **`src/config/validateEval.ts`:** `ValidateEvalContext` gains an optional `agents` dependency; `validateEval` branches on `file.target.kind`: stage path unchanged; agent path runs `resolveAgentTarget`, checks grader x kind applicability (`eval.grader_not_applicable`, error), `tool_calls`/`read_only_tools`/`tool_mocks` names against granted tools (warning `eval.tool_not_granted`), `defaults.user_model` provider support (`eval.simulator_unsupported`, `eval.simulator_unknown_model`, `eval.user_model_missing`) and `eval.simulator_same_as_agent` (warning), `conversation.tools: real` (`eval.real_tools_not_allowed` error without `allow_real_tools: true`, `eval.tools_real` warning with it), `eval.tools_unstubbed_list`, `eval.tools_mocked_no_mocks`, `eval.cases_missing_goal`, and case shape per mode.
5. **Dataset checks for agents:** a sibling of `checkDatasetAgainstStage` (`datasetAgentCheck.ts`) validating each case's `input` per mode (script needs non-empty `script` strings; simulated needs `opening`, `persona`, `goal`; `tool_mocks` keys must be strings with `result` or `error`), producing the same finding structure (reused code `dataset.input_mismatch`, plus `dataset.scenario_unknown_field`, `dataset.expected_invalid`) and the "invalid cases are skipped" behavior (`eval.cases_skipped`, `eval.no_valid_cases`). `loadDatasetFile`/`parseDatasetCases` stay unchanged.
6. **Fixtures and tests:** `tests/fixtures/evals/agent/` with `support.agent.yaml`-style fixture (or the project's agent fixture mechanism; look at `tests/agents.*`), `support-basics.eval.yaml` (the plan's example), a dataset with one script and one simulated case, and invalid variants. Tests: valid file loads; each invalid field gives its code; stage fixtures load identically (snapshot of existing results unchanged); applicability matrix; disabled/archived/missing agent findings; hash stability.

## Acceptance

- [x] An agent eval file from plan section 4 loads with no errors and yields the typed `EvalFile` with `conversation`, `defaults.user_model`, and new graders.
- [x] Every invalid value in the A01 spec yields its documented finding code and path (table-driven test).
- [x] `schema` grader on an agent target gives `eval.grader_not_applicable`; conversation graders on a stage target give the same.
- [x] `parseTarget` for stage targets is unchanged: all existing eval loader and validator tests pass untouched; a test pins an existing grader hash.
- [x] A missing/archived agent is an error, a disabled agent a warning, a parse-issue agent an error.
- [x] Dataset cases are checked per mode; invalid cases are listed and skipped like stage cases.
- [x] No stage eval behavior changes; existing eval tests untouched (one fixture edited, see note).
- [x] `npm test` (one unrelated env failure, see note), `npm run typecheck` pass. `npm run ui:test` not run: no ui files touched.

## Contract notes from A01 (the six specs' "Release 2: agents" sections win over any older line in this story)

- Finding codes, severities, defaults (`mode` script, `max_turns` 8, `turn_timeout_ms` 120000, `tools` read_only, `approvals` record_only, `read_only_tools` [], `allow_real_tools` false) and ranges are exactly the tables in `evals-file-schema.md` Release 2; every one needs a table-driven test.
- `reference` default `path` is `final_reply` for agent targets (`payload` for stage); the write path (A10) elides a default only when it equals the target's default.
- New grader keys: `tool_calls` (`must_call`, `must_not_call`, `must_ask_first`, `max_calls`, `args`), `conversation_check` (`max_turns`, `max_agent_questions_per_turn`, `final_reply`), `goal_reached` (`judge`, `guidance`; `scale` rejected). `schema` is `eval.grader_not_applicable` on agents; the three new types are `eval.grader_not_applicable` on stages; `eval.grader_type_unsupported` lists all eight valid types.
- Case shape rules (script 1-40 messages, simulated needs `opening`/`persona`/`goal`, `tool_mocks` value is exactly one of `result`/`error`, per-case `input.mode`) are in `evals-dataset-format.md` Release 2.
- Offline `sf eval validate` has no agent service: parse `agents/<id>.agent.yaml` only and skip revision-dependent findings.

## Out of scope

Plan building and snapshots (A04, A07), running, graders' execution (A08), write path/UI for agent evals (A10, A12), docs (A14).

## Open questions

_(none blocking)_

## Final note

Branch `worktree-agent-ac2e1ccb1b8cfcfdf` (commit bb1df2fd), based on `claude/chat-agent-research-5ab531` (71dd147c), because main has no `src/evals`.

Files: `src/evals/types.ts`, `src/config/loadEval.ts`, `src/config/validateEval.ts`, new `src/config/resolveAgentTarget.ts`, new `src/config/datasetAgentCheck.ts`; type-narrowing only in `resolveEvalTarget.ts`, `evals/plan.ts`, `evals/read/list.ts`, `evals/runner/stageCaseRunner.ts`, `server/evalRoutes.ts`, `evals/graders/index.ts` (+`isDeterministicGrader`), `evals/engine/FakeEngine.ts` (non-envelope graders grade `EVAL_GRADER_NOT_APPLICABLE` until A08). Tests: `tests/config.{loadEvalAgent,validateEvalAgent,datasetAgentCheck}.test.ts`, fixtures `tests/fixtures/evals/agent/project/`.

Deviations / notes:
- `tests/fixtures/evals/target-kind-unsupported.eval.yaml` used `kind: agent`, which is now valid; changed to `kind: team` so the unchanged test still asserts `eval.target_kind_unsupported`.
- `agent` key on a stage target is now `eval.target_invalid` (was `eval.unknown_key`), per A01 spec. `revision` on a stage target stays `eval.unknown_key`.
- `EvalFile.conversation` keeps authored keys; defaults via `resolveConversation()` (in `loadEval.ts`), plus `EVAL_AGENT_DEFAULT_CONCURRENCY/MAX_COST_USD` constants. `plan.ts` does not apply them yet (A07).
- Archived agent detected as "`get` ok but absent from `list`" (AgentSummary has no archived flag); no service change.
- Bare `tool_calls` grader (no keys) is accepted (uses case `expected.tools`), per spec; `eval.cases_missing_expected` warns.
- `validateEval` gets `ctx.agents` (AgentCatalogPort); callers (manager, API, CLI) are not wired yet (A10); without it, offline resolution parses `agents/<id>.agent.yaml`.
- `tests/runChangeBus.test.ts` fails in this env (real ~/.stageflow store schema 16 > binary 15); unrelated.
- Not done: `docs/yaml-catalog.md` (A14), write path (A10).
