# A01: Contracts for agent evals

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** done (2026-10-22; owner confirmation of the open questions below requested) · **Blocked by:** A00 · **Product code:** none

## Why this story exists

Every later story builds against the same field names, error codes, JSON shapes and rules. Release 1 fixed those in six spec files. Release 2 adds a "Release 2: agents" section to each so the stories do not invent contracts independently. Plan section 4 gives the file shapes; this story turns them into exact, testable contracts and fills the gaps the plan leaves.

## Read first

- [Plan](../../specs/evals-agents.md) sections 3 (G1-G13), 4, 5, 6, 10.
- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it).
- The six release 1 specs this story edits: `docs/specs/evals-file-schema.md`, `evals-dataset-format.md`, `evals-result-schema.md`, `evals-engine-interface.md`, `evals-api-cli-mcp.md`, `evals-ui-map.md`. Note their existing "Agent extension" paragraphs (for example result-schema line "Agent extension") and keep them consistent.
- Code that fixes today's shapes: `src/evals/types.ts` (`EvalTarget`, `TargetRef`, `CaseOutput`, `RunCaseResult`, `GraderConfig`), `src/evals/constants.ts` (`EVAL_RESULT_ERROR_CODES`, `EVAL_RESULT_STATUSES`, `EVAL_TARGET_KINDS`), `src/evals/graders/types.ts` (`Subject`), `src/config/loadEval.ts`, `src/runstore/sqlite/migrations/015-evals.ts`.

## Decisions already made (do not revisit)

G1 (Host plays the conversation), G2 (modes `script` and `simulated`), G3 (`defaults.user_model`, `SIMULATOR_PROMPT_VERSION`), G6 (`conversation.tools: real|read_only|mocked`, default `read_only`), G7 (`conversation.approvals: deny|auto_approve_read|record_only`, default `record_only`), G9 (eval limits override agent limits and are shown in the snapshot), G10 (subject union `envelope|conversation`; graders that cannot apply report a validation finding), G11 (bounded transcript for the judge), G12 (`target: { kind: agent, agent: <id> }`; revision recorded, not authored), G13 (no new promptfoo feature). File and dataset shapes are those in plan section 4. Defaults: `concurrency` lower than 4, `max_cost_usd` lower than 2 (the plan says "lower"; pick values in this story and record them in the open questions for owner confirmation).

## What to build

Edit the six spec files, each with a clearly marked "Release 2: agents" section. Do not rewrite release 1 text.

1. **`evals-file-schema.md`:** `target.kind: agent` with `agent` (agent id, pattern `AGENT_ID_PATTERN` = `^[a-z][a-z0-9_]{0,63}$` from `src/agents/agentId.ts`); the `conversation:` block (`mode`, `max_turns`, `turn_timeout_ms`, `tools`, `approvals`, `read_only_tools` list for author-declared safe MCP tools per plan risk 1, `mocks` default tool results if A00 recommends); `defaults.user_model`; field defaults, ranges and finding codes for each invalid value (use the `eval.*` finding style of `src/config/validateEval.ts`, for example `eval.agent_not_found`, `eval.agent_archived`, `eval.agent_disabled` (warning), `eval.conversation_invalid`, `eval.grader_not_applicable`, `eval.simulator_unsupported`). Grader table: `tool_calls` (fields: `must_call`, `must_not_call`, `max_calls`, `args` checks), `conversation_check` (`max_turns`, `max_agent_questions_per_turn`, `final_reply` field checks, reusing the `field` op table), `goal_reached` (judge, `scale: pass_fail`), and which existing types apply to which subject kind (matrix of grader type x target kind; `schema` is stage-only; `reference`/`field` paths for the conversation subject).
2. **`evals-dataset-format.md`:** the agent case: `input.{persona,goal,opening,facts,script,tool_mocks}`, `expected.{outcome,tools,forbidden_tools}`, per-mode required fields, per-case `mode` override, id/size limits, which fields CSV may map (`opening`, `goal`, `persona`, `expected.*`; `script` and `tool_mocks` JSON/JSONL only), dataset findings for each invalid shape, and how a dataset is attached to an agent target (no stage `io.input` schema; validate against the case shape instead).
3. **`evals-result-schema.md`:** the conversation subject JSON stored in `eval_results.output_json`: `{ kind:"conversation", status, summary, messages:[{role,text,turn}], tool_calls:[{id,turn,name,args,result_summary,status,policy_outcome}], final_reply, turns, stop_reason, usage }` with truncation and redaction rules; `policy_outcome` values (`ran`, `stubbed`, `mocked`, `would_ask_first`, `denied`); `subject_ref` column (A04) and the mapping from agent outcomes to existing result statuses and error codes. Existing CHECKs in migration 015 allow only `completed|stage_failed|needs_input|error|skipped_budget|cancelled`; decide and record the mapping (recommended: keep DB values, add wire aliases) and new result error codes (for example `EVAL_AGENT_FAILED`, `EVAL_AGENT_TIMEOUT`, `EVAL_SIMULATOR_ERROR`) — flag as an open question if the owner should choose. Add agent summary fields: `mean_turns`, `mean_tool_calls`.
4. **`evals-engine-interface.md`:** `PlanCase` for agents, `EvalPlan.target` union, `CaseOutput` union, `RunCaseResult.ok` carrying `subjectRef` (session id) beside `stageRunId`, phase names for agents (`agent_running` or reuse `stage_running`: pick and record), the `agentCaseRunner` steps (plan section 5 diagram as numbered steps, including stop conditions: goal marker, `max_turns`, per-turn timeout, case timeout, budget, cancel), the simulator prompt contract and `SIMULATOR_PROMPT_VERSION`, and the conversation rubric variant and `RUBRIC_PROMPT_VERSION` bump rule.
5. **`evals-api-cli-mcp.md`:** every request/response field that gains an agent variant (`target`, `conversation`, estimate, run detail `stats.mean_turns`, result detail `subject`), error codes, CLI behavior (existing commands only; note there is no `sf eval new`), MCP tool outputs, and `GET /api/evals` target filters.
6. **`evals-ui-map.md`:** the agent additions listed in plan section 6 as screens and states (picker, Conversation card, scenario editor, transcript view, warnings), with the copy for the `real` tools warning and the `record_only` approval note. Mark the Wonder-dependent parts "pending A11".

## Acceptance

- [x] Each of the six files has a "Release 2: agents" section; release 1 text is unchanged except cross-links.
- [x] Every new field has type, required/optional, default, range and finding code; every new JSON shape has a complete example.
- [x] The grader x target-kind applicability matrix exists and each "not applicable" cell names its finding code.
- [x] The status/error-code mapping for agent outcomes is written and consistent with migration 015 CHECKs.
- [x] Examples in the specs are valid against plan section 4's YAML and JSON (copy and check by eye; A02 will turn them into fixtures).
- [x] Defaults chosen for `concurrency`, `max_cost_usd`, `max_turns`, `turn_timeout_ms` are listed under Open questions for owner confirmation.
- [x] Docs only: no change under `src/`, `ui/`, `tests/`.

## Out of scope

Any code. `docs/yaml-catalog.md` and user docs (A14). Final UI visuals (A11). Re-deciding G1-G13.

## Open questions

Decided here as recommended defaults; the owner may overturn any of them (stories already follow them):

1. **Defaults.** Agent evals: `concurrency` 2, `max_cost_usd` 1 (the plan's YAML example shows 3 as an authored value), `repeats` 3, `conversation.mode` script, `max_turns` 8 (range 1-30), `turn_timeout_ms` 120000 (5000-600000), `tools` read_only, `approvals` record_only. Case wall clock = `max_turns * turn_timeout_ms + 60 s`. Confirm or change.
2. **No wire status aliases.** Stored result statuses stay (`stage_failed` now means "target failed"); agent failures are `stage_failed` + `EVAL_AGENT_FAILED`/`EVAL_AGENT_TIMEOUT`, simulator failures `error` + `EVAL_SIMULATOR_ERROR`; the console labels from `error_code`. Prefer aliases such as `agent_failed`? (costs a wire mapping layer in A09/A10).
3. **Two-part consent for `real` tools:** `conversation.allow_real_tools: true` in the file AND a per-run flag (`--allow-real-tools`, `allow_real_tools`, dialog checkbox). Owner decision 11 names both; confirm both are required (A10 had this as its pre-flagged question).
4. **Cost cap is not enforced inside a running conversation** (checked before each case starts; overshoot up to `concurrency` conversations). Alternative: stop mid-conversation, which yields partial, ungradeable results.
5. **`mocked` semantics:** reads without a mock still run; mocks apply to unsafe tools in `read_only` too (outcome `mocked`). Confirm that `mocked` is not "everything mocked".
6. **Simulator end protocol:** the A00 marker protocol (`[[END:resolved]]`/`[[END:abandoned]]` + `max_turns` + `no_progress` + `empty_message`) replaces A06's JSON `status` contract (verification is authoritative and its "Recommended plan changes" were adopted).
7. **Definition hash** is `sha256(canonicalJson(parsed definition))` (A02), not `sha256(revision.yaml)` as the verification sketched: stable against whitespace edits, comparable with the stage hash.
8. **Small additions to the plan's lists** (low risk, flag if unwanted): CSV/upload mapping also accepts `input.mode` and `input.facts` (split); `tool_calls` gains `must_ask_first` (plan G7 mentions `tool_asked_first`); `goal_reached` gains optional `guidance`; `conversation.allow_real_tools`; agent `agent_diff` in Compare; `GET /api/evals/agent-targets` lists archived agents greyed.
9. **Estimate without history** uses fixed assumptions (`AGENT_ESTIMATE_ASSUMPTIONS`: T = min(max_turns, 6), 2 tool calls per turn, token sizes in the result-schema section), shown as "Rough estimate". The numbers are guesses; confirm.
10. **Transcript for the judge** travels as a transport-only `transcript` field in the provider output; whether the promptfoo template can read the nested field is verified first in A08 (fallback: the whole capped output JSON). No owner decision needed unless the fallback hurts judge quality.
11. **Simulator usage** may be estimated (chars/4) when the `judge()`-based adapter reports no usage (`usage.estimated`); accurate simulator cost needs a Pi change outside this release.

## Final note

Files changed (docs only): `docs/specs/evals-file-schema.md`, `evals-dataset-format.md`, `evals-result-schema.md`, `evals-engine-interface.md`, `evals-api-cli-mcp.md`, `evals-ui-map.md` (each gained a "Release 2: agents" section; release 1 text changed only to replace the "later, do not add yet" wording in file-schema and engine-interface, the result-schema "Agent extension" paragraph, and one `eval.target_kind_unsupported` row). Downstream: `A02`-`A15` and `README.md` of this folder got a "Contract notes from A01" block and line fixes where a line was inaccurate (A05: always-blocked set and outcomes; A06: marker protocol instead of JSON status; A07: stop reasons, redaction of raw messages, partial output on failure; A04: migration columns and prompt-version slot; A08: path root without `output.`, transcript transport; A09: `agent_diff`; A10: try response, safer-only overrides, resolved questions; A13: `source: "sessions"` body).

Settled: file keys, defaults, ranges and 23 new finding codes; grader x target matrix with `eval.grader_not_applicable`; tool/approval decision table, `allow_real_tools`; scenario case shape and CSV limits; conversation subject JSON, caps, `policy_outcome`, `stop_reason`; status/error mapping (no CHECK change); migration 016 (`subject_ref`, `turns`, `tool_call_count`); agent snapshot, fingerprint and components; stats (`mean_turns`, `mean_tool_calls`); engine types (`AgentPlan`, `subjectRef`, `agent_running`), `agentCaseRunner` steps; simulator protocol and `SIMULATOR_PROMPT_VERSION`/`CONVERSATION_RUBRIC_PROMPT_VERSION` rules; API/CLI/MCP shapes; UI map additions with copy (A11 artboard ids pending).

Not done: nothing under `src/`, `ui/`, `tests/` changed; examples in the specs were checked by eye only (A02 turns them into fixtures); `docs/yaml-catalog.md` and user docs are A14.
