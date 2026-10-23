# Evals for agents (release 2): story index

**Epic:** [Evals for agents (release 2)](../../specs/evals-agents.md) (approved 2026-10-22; sections 3, 7 and 10 are the source of truth) · builds on [Evals release 1](../../specs/evals.md) and its contracts (`docs/specs/evals-{file-schema,dataset-format,result-schema,engine-interface,api-cli-mcp,ui-map}.md`).

Release 1 stories live in [../evals/](../evals/). These stories extend that shell to a second target kind (`agent`) without changing any stage eval behavior.

## Stories

| # | Story | Blocked by | Can run in parallel with |
|---|---|---|---|
| [A00](A00-pre-build-verification.md) | Pre-build verification (no product code); writes `docs/specs/evals-agents-verification.md` | none | none |
| [A01](A01-contracts.md) | Contracts: release 2 sections in the six specs | A00 | none |
| [A02](A02-loader-validator-agent-target.md) | Types, loader, validator for `kind: agent` | A01 | A03, A04, A06, A11 |
| [A03](A03-agent-service-eval-sessions.md) | Agent service: eval sessions (pin, hide, limits, no side effects) | A01 | A02, A04, A06, A11 |
| [A04](A04-migration-store-snapshot.md) | Migration 016, store, snapshot and fingerprint for agents | A01 | A02, A03, A06, A11 |
| [A05](A05-tool-and-approval-policy.md) | Tool policy, approval policy, tool-call recording | A03 | A06, A11 |
| [A06](A06-user-drivers.md) | `ScriptDriver`, `SimulatedUser`, simulator prompt | A01 | A02-A05, A11 |
| [A07](A07-agent-case-runner.md) | `agentCaseRunner`, plan builder branch, dispatch, wiring | A03, A05, A06 (plus A02, A04: see note) | A11 |
| [A08](A08-conversation-graders.md) | Conversation subject and graders | A02, A07 | A09, A11 |
| [A09](A09-stats-read-models.md) | Stats and read models (turns, tool calls, transcript) | A04, A07 | A08, A11 |
| [A10](A10-api-cli-mcp.md) | API, CLI, MCP accept agent targets | A08, A09 | A11, A14 |
| [A11](A11-ui-design-pass.md) | Wonder design pass | A01 | A02-A09 |
| [A12](A12-ui-build.md) | UI build | A10, A11 | A14 |
| [A13](A13-entry-points.md) | Entry points from agent pages | A12 | A14 |
| [A14](A14-sample-docs-skills.md) | Sample agent eval, docs, skills, AGENTS.md | A10 | A12, A13 |
| [A15](A15-e2e-and-release.md) | E2E, release, final report | all | none |

Note on A07: the plan table lists A03, A05, A06. A07 also edits the plan builder (`src/evals/plan.ts`) and reads the new snapshot builders, so it also needs **A02 and A04** merged. Treat them as blockers.

## Dependency graph

```
A00 ─▶ A01 ─┬─▶ A02 ───────────────────────┐
            ├─▶ A03 ─▶ A05 ─┐              │
            ├─▶ A04 ────────┼─▶ A07 ─┬─▶ A08 ─┐
            ├─▶ A06 ────────┘        │        ├─▶ A10 ─┬─▶ A12 ─▶ A13 ─┐
            └─▶ A11 (design) ────────┴─▶ A09 ─┘        │               ├─▶ A15
                                                       └─▶ A14 ────────┘
(A07 also needs A02 and A04; A12 also needs A11; A15 needs everything)
```

Critical path: A00, A01, A03, A05, A07, A08, A10, A12, A15. Parallel waves after A01: {A02, A03, A04, A06, A11}; after A07: {A08, A09}; after A10: {A12, A14}.

## How to work on these stories (rules for implementing agents)

Adapted from the release 1 epic's "How to work on this epic".

1. Read `docs/specs/evals-agents.md`, then `docs/specs/evals-agents-verification.md` (A00 results; from A01 on), then the reference specs your story names, then the story. Do not skip "Read first".
2. **Do not decide anything the plan already decides.** G1-G13 (plan section 3) and the owner decisions (section 10) are final. Release 1 decisions A and P in `docs/specs/evals.md` still stand.
3. **If your story needs a decision that is not written down, stop.** Add it under the story's "Open questions" and ask the owner. Do not pick a default and keep going.
4. Do only what "What to build" says. "Out of scope" lists things that look related and are not yours.
5. The verification results are authoritative. If a fact contradicts a story, the verification wins; note the contradiction under "Open questions". If it contradicts a plan decision (G or owner decision), stop and ask.
6. **Stage evals must not change.** No stage eval behavior changes; existing eval tests stay untouched (add new tests, never edit old assertions to pass). Run the release 1 eval tests before and after.
7. Follow `AGENTS.md`: match surrounding code, no comments unless the logic is not obvious, minimal diffs, and run `npm test`, `npm run ui:test` and `npm run typecheck` before finishing. Update docs when behavior changes. UI work also follows `ui/AGENTS.md`.
8. Evals rules from `AGENTS.md` still apply: numbers only in `stats.ts`, `scoring.ts`, `compare.ts`; nothing outside `src/evals/engine/promptfoo/` names promptfoo types; the engine never touches the store; snapshots are written once; bump `RUBRIC_PROMPT_VERSION` when judge text changes; run token never logged; no test calls a real model or the network; all eval/dataset writes go through the write path.
9. Use release 1 glossary words (eval, target, dataset, case, repeat, result, grader, grade, rubric, judge, eval run). New words for release 2: **scenario** (an agent case's input), **driver** (script or simulated user), **simulator** (the model that plays the user), **conversation subject**, **tool policy**, **approval policy**.
10. Tests use `FakeEngine`, a `FakeAgentBackend` (from A07) or an inline `ConversationBackend` (see `tests/agents.chat.test.ts`), and stub models. Never a real provider.
11. The planning docs (`docs/specs/evals*.md`, `docs/tickets/`) are untracked and local. A fresh worktree will not have them. Read them from the main checkout path given in your task, and do not commit them unless the task says so.
12. The working tree may hold uncommitted edits to `src/evals/manager.ts` and `src/server/bootstrap.ts` made by another session. Rebase onto what is committed; never revert files you did not touch.
13. When you finish: tick the acceptance boxes, set the story's status line, add a "Final note" listing files changed and anything you could not do.

## Plan notes found while writing the stories

- The plan's A10 mentioned `sf eval new --agent`. `sf eval` has no `new` subcommand; dropped by owner decision 12 (resolved in A01).
- `plan.ts` (`buildEvalPlan`) agent branch has no owner in the plan table; it is assigned to A07.
- Plan G11 says to bump `RUBRIC_PROMPT_VERSION` for the conversation rubric, but that constant is in every stage fingerprint, so bumping it would break stage run comparability. A04/A08 add a separate `CONVERSATION_RUBRIC_PROMPT_VERSION` instead (owner decision 11; it occupies the `rubric_prompt_version` slot of agent snapshots and fingerprints). The constant is also defined twice today (`src/evals/constants.ts`, `src/evals/engine/promptfoo/rubricPrompt.ts`).
- Agent session retention does not exist today (no `DELETE FROM agent_sessions`); A00 verifies, A03/A04 add cleanup of eval sessions when an eval run is deleted.
- Result statuses and error codes are stage-named (`stage_failed`, `needs_input`, `EVAL_STAGE_*`), constrained by migration 015 CHECKs. A01 decided the mapping: stored statuses are kept, agent failures use `stage_failed`/`error` with new `EVAL_AGENT_*` and `EVAL_SIMULATOR_ERROR` codes (see `evals-result-schema.md` Release 2).
- The `groundedness` grader in plan section 4 has no story; it stays out of scope.
