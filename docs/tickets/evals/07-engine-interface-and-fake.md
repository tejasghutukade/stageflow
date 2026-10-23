# 07: EvalEngine interface, grader implementations and FakeEngine

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 05, 06

## Why this story exists

The manager (story 09) and every test need an engine they can drive without promptfoo, a network or a model. This story defines the interface once, implements the grader rules once (used by both the fake engine and the real engine's assertions), and ships a scriptable fake.

## Read first

- [engine-interface.md](../../specs/evals-engine-interface.md) ("Types", "Rules", "FakeEngine").
- [eval-file-schema.md](../../specs/evals-file-schema.md): the `schema`, `field`, `reference`, `rubric`, `code` rules (every operator, the path syntax, the reference modes, the code contract).
- [result-schema.md](../../specs/evals-result-schema.md): "Scoring" (the engine does **not** compute weighted score or `passed`; story 05's `scoreResult` does).
- `src/envelope/payloadSchema.ts` (`payloadInstanceMismatch`), `src/evals/types.ts` (stories 02/04).

## Decisions already made (do not revisit)

The interface, the normalized shapes and the division of labor (engines emit raw grades; the manager scores) are in engine-interface.md. Agent extension rule 4: graders read a **normalized subject**, so grader functions take a `Subject` (`{ status, summary, payload, artifacts }` for stages), never an envelope type. `code` graders run with the Node `vm` module, timeout 5 s, no access to `require`, `process` or the network, and receive deep-frozen copies of their arguments.

## What to build

1. **Engine types** in `src/evals/types.ts` per engine-interface.md (`EvalPlan` and `PlanCase` already exist from story 06): `CaseOutput`, `RunCaseRequest`, `RunCaseResult`, `NormalizedGrade`, `NormalizedResult`, `EngineIo` (including `onPhase`), `EvalEngine`.
2. **`src/evals/graders/`** (pure, one file each, one exported `gradeX(grader, subject, case, context)` returning `NormalizedGrade`-compatible data):
   - `path.ts`: the envelope-path evaluator (dots, `[n]`, `[*]`) returning the matched nodes and whether the path resolved; unit-tested on every example in the schema doc.
   - `schemaGrader.ts` (uses the plan's `outputSchema` through `payloadInstanceMismatch`), `fieldGrader.ts` (all ops; reason text per schema doc; `details.checks`), `referenceGrader.ts` (both modes; `details.items`; the missing-expected case returns `status: "error", errorCode: "EVAL_CASE_MISSING_EXPECTED"`), `codeGrader.ts` (vm sandbox; error codes `EVAL_GRADER_CODE_ERROR`; accepts boolean, number, or `{pass, score, reason}`).
   - `index.ts`: `gradeDeterministic(grader, subject, case, ctx)` dispatching on type for the four non-rubric types.
3. **`src/evals/engine/FakeEngine.ts`:** per engine-interface.md: runs `plan.cases × repeats` with `plan.concurrency` workers; calls `io.onPhase("stage_running")`, `io.runCase`, `io.onPhase("grading")`, grades with `gradeDeterministic` and a scripted judge for rubric graders (`script.judge(grader, case, output) → { verdict } | { score }` plus `reason`, default pass / score 5), reports `io.reportJudgeCost(script.judgeCostUsd ?? 0)` per judge call, emits `io.onResult`, then `io.onPhase("done")`. Honors `signal` (stops taking new work, finishes in-flight, resolves). If a `runCase` result is `ok: false`, emits the result with no grades. Options: `order` (`"sequential" | "shuffled"` with a seed), `delayMs` per phase (for cancel tests), `failEngineAfter` (throws `EVAL_ENGINE_ERROR` after N results, for failure tests).
4. **`src/evals/engine/index.ts`:** `EvalEngine` registry `getEngine(name)` returning FakeEngine for `"fake"` (the promptfoo engine registers itself in story 11).

## Acceptance

- [ ] Every operator in the field-check table has a passing and a failing test; `[*]` semantics (all must satisfy; no match fails) are tested; `length_*` on arrays and strings.
- [ ] `reference each_mentioned` tests: case-insensitive, whitespace-collapsed, 1 of 2 → 0.5, empty expected → 1, non-string actual serialized; `equals` deep equality; missing expected → error grade.
- [ ] `schemaGrader` passes valid payloads and fails envelope `failure` status and invalid payloads with the validator message.
- [ ] `codeGrader` tests: boolean, number, object returns; thrown error; infinite loop hits the 5 s timeout (test with an injectable shorter timeout); `process`, `require` and `fetch` are undefined inside; arguments are frozen.
- [ ] FakeEngine with a 3-case, 2-repeat plan emits exactly 6 results with the expected grades, calls phases in order per result, honors concurrency (max in-flight never exceeds `plan.concurrency`), and stops on abort with no new work started.
- [ ] A scripted judge returning `{score: 4}` yields a grade with `rawValue: 4`, `score: 0.75`.
- [ ] No test uses the network or a real model.
- [ ] `npm test` and `npm run typecheck` pass.

## Out of scope

The promptfoo adapter (story 11), persistence and statuses (story 09).

## Open questions

_(agent fills; stop and ask the owner)_
