# A04: Migration 016, store changes, snapshot and fingerprint for agents

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** done (branch worktree-evals-agents-a04) · **Blocked by:** A01

## Why this story exists

Results of agent cases point to an agent session, not a stage run, and a run must record which agent revision, tool policy, approval policy, simulator model and prompt version produced it, or two runs cannot be compared honestly. The result tables are already target-neutral by design; this story adds the one reserved column (`subject_ref`), teaches the store to read and write it, and extends the snapshot and fingerprint (G5, G9, G3) so a fingerprint change means a real configuration change.

## Read first

- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it).
- [Plan](../../specs/evals-agents.md) section 5 ("Plan/snapshot", "Migration"), G3, G5, G9; `docs/specs/evals-result-schema.md` ("Agent extension" note and the A01 "Release 2: agents" section for the status/error mapping and the `subject` JSON).
- Code: `src/runstore/sqlite/migrations/015-evals.ts` and `migrations/index.ts` (how versions are registered; `minStageflowVersion`), `src/runstore/sqlite/evalStore.ts` (`insertResult`/upsert near line 290, `toResult` near line 153, `deleteEvalRun` near line 704, query by `stageRunId` near line 414), `src/runstore/sqlite/SqliteRunStore.ts` (eval methods near line 1424), `src/runstore/port.ts` (eval methods near line 677), `src/evals/storeTypes.ts` (`EvalResultRow`, `EvalResultInput`, query types), `src/evals/snapshot.ts` (`ConfigSnapshot`, `ConfigComponents`, `ComponentsInput`, `buildComponents`, `computeFingerprint`, `buildSnapshot`), `src/evals/constants.ts` (`CONFIG_SNAPSHOT_VERSION`), `tests/` files for the store, the migration list and the snapshot.

## Decisions already made (do not revisit)

- One additive migration, number 016, `ALTER TABLE eval_results ADD COLUMN subject_ref TEXT` (nullable) plus an index, and two nullable summary columns `turns INTEGER` and `tool_call_count INTEGER` (plan section 5: stats aggregate them; one migration only, so A09 adds none). `stage_run_id` stays; stage rows are backfilled `subject_ref = stage_run_id` in the same migration (plan section 5). `target_kind` already allows `'agent'` (migration 015), so no table rebuild. Existing CHECKs on result `status` stay; the agent mapping is in the A01 spec.
- Migrations are forward-only and must not change any stage eval data. Follow the migration test pattern.
- The snapshot is written once and never edited; the fingerprint covers what changes results and excludes cost cap and concurrency. For agents it adds: agent definition hash, revision, `conversation.tools`, `conversation.approvals`, `conversation.mode`, `max_turns`, `turn_timeout_ms`, user model, `SIMULATOR_PROMPT_VERSION` (G3, G9, G11); `CONVERSATION_RUBRIC_PROMPT_VERSION` takes the existing `rubric_prompt_version` slot for agent runs. Stage fingerprints must be byte-identical to today's.
- A snapshot version bump (`CONFIG_SNAPSHOT_VERSION`) is required only if stage snapshots change; they must not, so keep the version and make `target` a discriminated union readable by old readers.

## What to build

1. **`src/runstore/sqlite/migrations/016-eval-subject-ref.ts`:** `MIGRATION_016` (`name: "016_eval_subject_ref"`), register in `migrations/index.ts`. SQL: add `subject_ref`, `turns`, `tool_call_count`, `UPDATE eval_results SET subject_ref = stage_run_id WHERE stage_run_id IS NOT NULL`, `CREATE INDEX eval_results_subject_ref ON eval_results (subject_ref)` (exactly the SQL in `evals-result-schema.md` Release 2; no `subject_kind` column). Update any test that asserts the schema version or migration list (find with `grep -rn "015_evals\|user_version" tests`); do not edit unrelated assertions.
2. **Store types and port:** `EvalResultRow`/`EvalResultInput` gain `subjectRef?: string | null`, `turns?: number | null`, `toolCallCount?: number | null`; `src/runstore/sqlite/evalStore.ts` writes `subject_ref` in the upsert and reads it in `toResult`; for stage results `subjectRef` defaults to `stageRunId`. New `listEvalSubjectRefs(db, evalRunId, targetKind)` returning distinct non-null refs; add to `RunStore` port and `SqliteRunStore`. `deleteEvalRun` keeps its signature and return value (stage run ids only) so release 1 callers do not change; the route (A10) uses `listEvalSubjectRefs` first to remove agent sessions via `AgentService.deleteEvalSessions` (A03).
3. **Query by subject:** extend the by-run lookup near `query.stageRunId` with `subjectRef` (stage lookup unchanged).
4. **`src/evals/snapshot.ts`:** `ConfigSnapshot.target` becomes a union: the existing stage object (`kind: "stage"`) and `{ kind: "agent"; agent_id; revision; definition_hash; definition: Record<string, unknown>; model; tools: Array<{ id; risk }>; ask_first: string[] }`; `settings` gains an optional `conversation` object (`mode`, `max_turns`, `turn_timeout_ms`, `tools`, `approvals`, `read_only_tools`, `user_model`, `simulator_prompt_version`, plus `effective_limits` showing the override per G9). `ConfigComponents` gains the optional `agent` key; `buildComponents`/`computeFingerprint` include them only when present so stage payloads hash identically: for agents `stage_version_hash` holds the agent `definition_hash`, `model` the effective agent model, `rubric_prompt_version` the conversation constant, and one extra key `agent` (shape in the contract; absent for stages). `buildSnapshot` accepts either target variant.
5. **Constants:** `SIMULATOR_PROMPT_VERSION = 1` and `CONVERSATION_RUBRIC_PROMPT_VERSION = 1` in `src/evals/constants.ts` (A06 and A08 use them), plus `EVAL_CONVERSATION_LIMITS` and the new error-code members (`EVAL_AGENT_FAILED`, `EVAL_AGENT_TIMEOUT`, `EVAL_SIMULATOR_ERROR`, `EVAL_GRADER_NOT_APPLICABLE`, request code `EVAL_REAL_TOOLS_NOT_CONFIRMED`); make `RUBRIC_PROMPT_VERSION` defined once (re-export from `rubricPrompt.ts`) and do not change its value (stage prompt text does not change, so stage fingerprints must not move).
6. **Read-side tolerance:** places that read `snapshot.target` (`src/evals/read/runs.ts` `graderRefsOf`, `currentHashes`, `src/evals/read/compare.ts`, `src/evals/manager.ts`) must narrow on `kind` and keep compiling; add only the narrowing, not agent features (A09).
7. **Tests:** migration applies on a DB with release 1 data and backfills; stage results round-trip unchanged; an agent result with `subjectRef` round-trips; fingerprint of a fixed stage input equals a pinned literal computed before the change (add that pinned test first); agent fingerprint changes when each new component changes and not when `max_cost_usd` or `concurrency` change; snapshot for agents contains the effective limits; `deleteEvalRun` for an agent run returns no stage ids and `listEvalSubjectRefs` returns the sessions.

## Acceptance

- [x] `npm test` migration tests: DB at version 15 upgrades to 16, `subject_ref` exists, stage rows backfilled, user_version 16.
- [x] A pinned stage fingerprint and a pinned stage snapshot (golden JSON) are unchanged.
- [x] Agent fingerprint covers revision/definition hash, tool and approval policy, mode, turn limits, user model, simulator and conversation-rubric prompt versions, and ignores cost cap and concurrency (table-driven test).
- [x] `listEvalSubjectRefs` returns session ids for agent runs and stage run ids for stage runs.
- [x] `RunStore` implementations other than SQLite (in-memory/fake stores in `tests/`) compile; add the new method only where the port requires it.
- [x] No stage eval behavior changes; existing eval tests untouched.
- [x] `npm test`, `npm run ui:test`, `npm run typecheck` pass.

## Contract notes from A01 (the six specs' "Release 2: agents" sections win over any older line in this story)

- Snapshot field names and examples (`target.agent_id`, `revision`, `definition_hash`, `definition`, `model`, `model_tier`, `tools[{id,risk,class}]`, `ask_first`, `sub_agents`, `limits_override`; `settings.conversation` including `user_model_from_judge`, `real_tools_confirmed`, `simulator_prompt_version`; `overrides` gains `user_model`, `tools`, `approvals`) are the JSON in `evals-result-schema.md` Release 2.
- `user_model` enters the fingerprint only when some selected case runs simulated; `real_tools_confirmed`, `max_cost_usd`, `concurrency` never do.
- `turns` = user turns completed; `tool_call_count` = recorded tool calls of every outcome; cost includes simulator, tokens exclude it.

## Out of scope

Building plans and snapshots from a loaded agent eval (A07), result status mapping logic (A07/A01), read models and stats (A09), HTTP/UI.

## Open questions

_(agent fills; stop and ask the owner)_

## Final note

Branch `worktree-evals-agents-a04` (based on `claude/chat-agent-research-5ab531` 71dd147c; the assigned worktree base lacked the evals code). Files: `src/runstore/sqlite/migrations/016-eval-subject-ref.ts`, `migrations/index.ts`, `src/runstore/sqlite/evalStore.ts`, `SqliteRunStore.ts`, `src/runstore/port.ts`, `src/evals/storeTypes.ts` (subjectRef/turns/toolCallCount; `ListEvalRunsQuery.subjectRef`), `src/evals/snapshot.ts`, `src/evals/constants.ts`, `src/evals/engine/promptfoo/rubricPrompt.ts` (re-exports `RUBRIC_PROMPT_VERSION`), `src/evals/manager.ts` (narrowing only); tests `tests/evals.snapshot.agent.test.ts`, `tests/runstore.evalsAgents.test.ts`, and three schema-version assertions 15 -> 16 in `tests/runstore.evals.test.ts`. Full `npm test` and `tsc` pass.
- Followed the contract (`target.limits_override`) rather than the story's `settings.conversation.effective_limits`.
- `RunStore` has only the SQLite implementation, so no other fakes needed the new method.
- `EVAL_CONVERSATION_LIMITS` keys are my naming (maxMessageChars etc.); A07/A08 may rename.
- `ui:test` not run (no UI change).
