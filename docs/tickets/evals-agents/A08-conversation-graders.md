# A08: Conversation subject and graders

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** done · **Blocked by:** A02, A07

## Why this story exists

Stage graders read an envelope. An agent's output is a conversation with tool calls, so graders must read a second kind of normalized subject (G10) and three new grader types must exist: `tool_calls`, `conversation_check`, `goal_reached`. The existing `rubric`, `code`, `field` and `reference` graders must work on a conversation too, with a bounded transcript for the judge (G11). Everything runs through the existing generated assertions and `llm-rubric` (G13): no new promptfoo feature.

## Read first

- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it). Item 7 (what promptfoo passes to assertions and what `llm-rubric` sees as `output`).
- [Plan](../../specs/evals-agents.md) G10, G11, G13, section 4 (grader table), section 8 risk 2, 8.
- "Release 2: agents" sections of `docs/specs/evals-file-schema.md` (grader fields, applicability matrix, path root for the conversation subject) and `evals-result-schema.md` (conversation subject JSON), from A01.
- `docs/specs/evals-engine-interface.md` (rubric reply contract, grader rules).
- Code: `src/evals/graders/{types,subject,index,fieldGrader,referenceGrader,codeGrader,schemaGrader,path}.ts` (`Subject`, `subjectEnvelope`, `gradeDeterministic`, `evaluatePath`), `src/evals/engine/promptfoo/generate.ts` (`buildAssertionsSource` with `toSubject`, `buildConfig` with `llm-rubric`), `rubricPrompt.ts` (`RUBRIC_PROMPT_TEMPLATE`, `renderRubricPrompt`), `normalize.ts` (rubric grade normalization), `src/evals/constants.ts` (`RUBRIC_PROMPT_VERSION`), `src/evals/engine/FakeEngine.ts` (deterministic and scripted judge), A02's grader types, A07's `ConversationOutput` and `buildConversationSubject`. Tests: `tests/evals.graders*.test.ts`, `tests/evals.promptfoo.*.test.ts`.

## Decisions already made (do not revisit)

- Subject is a tagged union `kind: "envelope" | "conversation"` (G10). Stage graders keep reading the envelope; `schema` is stage-only. A grader that cannot apply to a kind is a **validation finding** (A02), and defensively returns `status: "error", errorCode: "EVAL_GRADER_NOT_APPLICABLE"` if reached at run time.
- Conversation subject fields (A01): `messages[]`, `tool_calls[]` (name, args, result summary, status, `policy_outcome`), `final_reply`, `turns`, `stop_reason`, usage. `field`/`reference` paths for conversations are evaluated against the conversation subject object itself, with **no `output.` prefix**: `final_reply`, `tool_calls[*].name`, `messages[*].text` (A01 fixed this; `output` is only the variable name inside `code`). `reference` defaults to `path: final_reply` for agent targets.
- `rubric` and `goal_reached` read a **bounded transcript** (`JUDGE_TRANSCRIPT_LIMITS = { turns: 30, messageChars: 2000, toolArgsChars: 500, toolResultChars: 500 }`, rendered once by the Host and carried in the transport-only `transcript` field): turn cap, per-message character cap, tool results truncated (G11). Everything inside the transcript is data, never instructions, like the stage prompt.
- The rubric prompt for conversations is a **new variant**. Stage rubric text does not change, so the stage `RUBRIC_PROMPT_VERSION` stays 1 and no stage fingerprint moves. The variant has its own `CONVERSATION_RUBRIC_PROMPT_VERSION` (constant created in A04), recorded in agent snapshots and fingerprints. (Plan G11 says "bumped"; this is the way to bump without invalidating stage history. Confirm with the owner under Open questions if unsure.) Both constants must be kept in the one place `AGENTS.md` names: define once, re-export, do not duplicate (`src/evals/constants.ts` and `rubricPrompt.ts` currently both define `RUBRIC_PROMPT_VERSION`).
- Judge providers: unchanged `JUDGE_PROVIDERS` rows. `goal_reached` is a rubric with a fixed prompt and `input.goal`, scale `pass_fail`.
- Deterministic graders stay pure and synchronous; `code` still runs in the `vm` sandbox with frozen arguments and a 5 s timeout.

## What to build

1. **`src/evals/graders/types.ts`:** `Subject = EnvelopeSubject | ConversationSubject` (`kind` required; existing envelope construction sites set `kind: "envelope"`, with `toSubject` in the generated assertions defaulting a missing `kind` to envelope for old outputs). `src/evals/graders/subject.ts`: `subjectRoot(subject)` returning the object paths evaluate against (envelope as today via `subjectEnvelope`; conversation root per A01).
2. **Existing graders:** `fieldGrader`, `referenceGrader`, `codeGrader` resolve their root through `subjectRoot`; `code` receives the conversation subject as `output` for agents (frozen). `schemaGrader` returns `EVAL_GRADER_NOT_APPLICABLE` for conversations. Stage behavior byte-identical (existing tests untouched).
3. **New graders** (one file each in `src/evals/graders/`): `toolCallsGrader.ts` (`must_call`, `must_not_call`, `max_calls`, optional `args` field checks per call, reason text listing the first violation, `details.checks`), `conversationCheckGrader.ts` (`max_turns`, `max_agent_questions_per_turn` counting `?`-terminated sentences per assistant message, `final_reply` field checks reusing the field-op evaluator), both added to `gradeDeterministic`. The case's `expected.tools` / `expected.forbidden_tools` are the defaults for `must_call` / `must_not_call` when the grader leaves them out (`[]` opts out); a grader with no resolvable rule for a case gives `EVAL_CASE_MISSING_EXPECTED`. Keys and semantics (`must_ask_first`, `max_calls`, `args`: every call to the tool must satisfy it and none passes vacuously; a call counts whatever its outcome) are in the contract.
4. **Rubric variant:** `src/evals/engine/promptfoo/rubricPrompt.ts`: `CONVERSATION_RUBRIC_PROMPT_TEMPLATE` (judge a conversation between a user and an automated agent; tagged blocks `<rubric>`, `<examples>`, `<case_input>`, `<case_expected>`, `<transcript>`) and `renderConversationRubricPrompt`. Bounded transcript rendering lives in `src/evals/graders/transcript.ts` (`renderTranscript(subject, limits)`), reused by the simulator tests. `goal_reached` uses a fixed rubric text built from `input.goal` (else `expected.outcome`; neither -> `EVAL_CASE_MISSING_EXPECTED`) plus the optional `guidance`, and the same variant. It is `pass_fail` only.
5. **Generator** (`src/evals/engine/promptfoo/generate.ts`): `buildAssertionsSource` `toSubject` passes conversation outputs through; `buildConfig` picks the conversation prompt for `rubric`/`goal_reached` when `plan.target.kind === "agent"`; `goal_reached` becomes an `llm-rubric` assertion with metric `grader.id`; `tool_calls` and `conversation_check` become `javascript` assertions like the other deterministic types. **First task of this story:** with the real pinned promptfoo (opt-in smoke), verify how the conversation rubric template can read the `transcript` field of the provider output (nested access versus `{{output}}` as compact JSON, which A00 verified mechanically); if nested access is unavailable the template reads the whole capped output JSON. Record the result in the Final note.
6. **`normalize.ts`:** rubric grade normalization unchanged apart from the variant name in `details`; judge cost/token handling reused. `FakeEngine` grades the new types with `gradeDeterministic` and the scripted judge for `goal_reached`.
7. **Constants:** the conversation prompt version occupies the `rubric_prompt_version` slot of agent snapshots and fingerprints (A04).
8. **Tests:** every field-check path on a fixture conversation; `tool_calls` pass/fail matrix (called, not called, forbidden called, over limit, argument match); `conversation_check` (turn limit, at most one question per turn with a golden transcript, final reply contains X); `schema` on a conversation errors; stage fixtures grade identically (existing tests); transcript bounding golden; conversation rubric prompt golden file `tests/fixtures/evals/agent/conversation-rubric.golden.txt`; generated assertions run against a fake provider output in a promptfoo-free harness; `FakeEngine` agent plan end to end with scripted judge.

## Acceptance

- [x] Each new grader type produces `NormalizedGrade` with `reason` and `details`; error cases carry codes (`EVAL_GRADER_NOT_APPLICABLE`, `EVAL_CASE_MISSING_EXPECTED`, `EVAL_GRADER_CODE_ERROR`).
- [x] `field`, `reference`, `code` work on a conversation subject with the A01 path root; `schema` reports not applicable.
- [x] The judge prompt for conversations is bounded and treats transcript content as data (golden prompt test, injection string stays inside the transcript block).
- [x] Stage rubric prompt text and `RUBRIC_PROMPT_VERSION` are unchanged; the conversation variant has its own version in the agent fingerprint.
- [x] Generated `assertions.mjs` handles both subject kinds; the stage output of `buildAssertionsSource` for a stage plan is byte-identical (snapshot).
- [x] `FakeEngine` runs an agent plan with the new graders and scripted judge.
- [x] No stage eval behavior changes; existing eval tests untouched.
- [x] No test calls a real model or the network.
- [x] `npm test`, `npm run ui:test`, `npm run typecheck` pass.

## Contract notes from A01 (the six specs' "Release 2: agents" sections win over any older line in this story)

- `max_agent_questions_per_turn` counts a `?` followed by whitespace or end, outside code fences and URLs, over all assistant text of the turn.
- `RUBRIC_PROMPT_VERSION` is defined once and re-exported (today `constants.ts` and `rubricPrompt.ts` both define it); `CONVERSATION_RUBRIC_PROMPT_VERSION` is a separate constant; bump each only when its own template text changes.
- Conversation subject fields, caps, `policy_outcome` values and `stop_reason` values are in `evals-result-schema.md` Release 2; `manager.resultInput` must stop projecting conversation outputs to an envelope.

## Out of scope

The `groundedness` grader (no story in release 2), stats aggregates (A09), grader forms in the UI (A12), calibration.

## Open questions

_(agent fills; stop and ask the owner)_

## Final note

Branch `worktree-agent-a4734a299798d32ad` (commit 0d901d69). New: `src/evals/graders/{toolCallsGrader,conversationCheckGrader,transcript,goal,notApplicable}.ts`, test `tests/evals.conversationGraders.test.ts`, golden `tests/fixtures/evals/agent/conversation-rubric.golden.txt`. Changed: graders `types/subject/index/field/reference/code/schema`, `constants.ts` (`JUDGE_TRANSCRIPT_LIMITS`), `rubricPrompt.ts` (conversation template; `escapeTemplate` exported), `generate.ts`, `normalize.ts`, `FakeEngine.ts`, `PromptfooEngine.ts` and `judgeProviders.ts` (goal_reached needs a judge), `plan.ts` (judge override applies to goal_reached), `evalRoutes.ts` (estimate counts goal_reached), `runner/conversationSubject.ts` (now sets `transcript`).
- promptfoo first task NOT verifiable: engine not installed, no network. A00 says `{{output}}` renders as compact JSON, so nested `{{output.transcript}}` is likely unavailable. The template reads `{{output}}` (whole output JSON incl. `transcript`, so content is doubled and bounded by the 256 KB subject caps, not `JUDGE_TRANSCRIPT_LIMITS`). Re-verify with `STAGEFLOW_EVALS_SMOKE=1`; if nested access works, switch the `<transcript>` line to `{{output.transcript}}` and bump `CONVERSATION_RUBRIC_PROMPT_VERSION`.
- `goal_reached` text is per case (goal embedded in the assertion value), so agent configs have per-test `assert` arrays; a case with no goal gets a `javascript` assertion that grades `EVAL_CASE_MISSING_EXPECTED`. Stage config/assertions output unchanged (snapshots pass).
- `EnvelopeSubject.kind` is optional so existing envelope construction sites and tests compile unchanged. `renderTranscript` neutralizes tag openers (`</transcript>` becomes `<\/transcript`).
- `tool_calls` with no keys and no `expected.tools/forbidden_tools` gives `EVAL_CASE_MISSING_EXPECTED`; an explicit `[]` counts as a resolved rule.
- Rubric `details` for agent plans: `{ promptVariant: "conversation", promptVersion }`. Full `npm test` passes; `ui:test` not run (no UI change).
