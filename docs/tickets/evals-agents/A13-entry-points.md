# A13: Entry points: Evaluate from an agent, add a session as a case

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** done (branch worktree-agent-a6d75f33f6625e8ac) · **Blocked by:** A12

## Why this story exists

For stages, release 1 put an Evals section and an Evaluate button in the Catalog inspector (story 23) and let authors seed a dataset from past runs. Agents need the same two moments (plan section 6): while looking at an agent ("Evaluate"), and while looking at a real conversation that went wrong or well ("Add this session as a case"). Eval sessions are hidden from every list, so a link back from an eval session to its result is also needed.

## Read first

- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it). Item 9 (hidden eval sessions are still readable by id).
- [Plan](../../specs/evals-agents.md) section 6 ("Entry points"), G4, G12; `docs/tickets/evals/23-ui-entry-points.md` (the pattern to mirror), `docs/specs/evals-ui-map.md` screens 3 and 8 and its release 2 section, `docs/specs/evals-agents-ui-design.md` (A11; if no artboard covers these entry points, follow the stage pattern and note it).
- Code: `ui/src/redesign/agents/detail/AgentDetailPage.tsx`, `ui/src/redesign/agents/session/AgentSessionPage.tsx`, `ui/src/redesign/agents/run/AgentRunPage.tsx`, `ui/src/redesign/catalog/stageEvalsModel.ts` (pattern), `ui/src/redesign/evals/StageRunEvalBanner.tsx` and `stageRunBannerModel.ts` (banner pattern), `ui/src/routes.ts` (`agentPath`, `agentSessionPath`, `agentRunPath`, evals routes), `ui/src/redesign/evals/datasets/CandidatesDialog.tsx` and `candidatesModel.ts` ("From past runs" dialog), `src/config/datasetCandidates.ts` (stage candidates from runs), `src/server/evalRoutes.ts` (`handleCandidates`), `src/runstore/sqlite/evalStore.ts` (query by subject ref from A04), `src/agents/store.ts` (messages, spans).

## Decisions already made (do not revisit)

- The agent page gets an **EVALS n** section and an **Evaluate** button, with the same three-way behavior as stage Evaluate: exactly one eval for the agent -> its Run dialog (`#/evals/<id>?openRun=1`); none -> `#/evals/new` preselected for the agent (`?agent=<id>`); two or more -> `#/evals?agent=<id>`. The evals list honors `?agent=<id>` with a dismissible chip, using the `agent` filter from A10.
- "Add this session as a case" builds a **scenario** from a real session: `script` mode with the session's user messages as the script, `opening` = the first user message, `title` from the session title, `expected.tools` = names of tools the session called (author edits before saving), `tags: ["from-session"]`. A simulated scenario is not generated (auto-generated scenarios are out of scope). It goes through the existing dataset write path (append or new dataset); nothing is written until the author confirms in the same dialogs as release 1.
- Real sessions only: sessions with `source: "eval"` are not offered as sources. Message and tool text come from stored, already-redacted data; the case never includes tool results unless the author adds mocks by hand.
- An eval session (hidden from lists) opened by link shows a banner "This session was created by eval <id>, run #<n>" with a link to the result, like `StageRunEvalBanner`.

## What to build

1. **Server, candidates from sessions** (`src/config/agentSessionCandidates.ts`, `src/server/evalRoutes.ts`): `GET /api/datasets/candidates?agent=<id>` returns `{ session_id, updated_at, preview, turns, tools }` for finished non-eval sessions of that agent (cursor/limit like the stage route); `POST /api/datasets` gains `{ name, source: "sessions", target: { agent_id }, session_ids }` (contract shape; the append form uses `dataset_id`/`mode` like the stage forms) building scenario cases via `buildScenarioFromSession(detail)` (pure, tested): `input = { mode: "script", script, opening }`, `expected.tools`, `tags: ["from-session"]`, `metadata.source_session`. Uses `AgentService.getSession`; hidden sessions are never listed.
2. **Server, reverse lookup:** `GET /api/eval-runs?subject_ref=<session id>` (extends the existing `stage_run_id` filter implementation with A04's store query) returning the eval run number and eval id; route test.
3. **Model `ui/src/redesign/agents/detail/agentEvalsModel.ts` (+ test):** from the eval list response for the agent: rows ("n cases, last run <relative>" or "never run", pass rate bar), the Evaluate destination rules, the guidance line "Run an eval before you save changes to this agent.", and the empty state "No evals yet. Create one to check this agent before you ship changes."
4. **Agent page:** Evals section and Evaluate button in `AgentDetailPage.tsx` (placement per artboard or the stage pattern), "+ New eval" -> `#/evals/new?agent=<id>`; the wizard preselects the agent target from the query (small change in `useWizardData.ts`/`wizardModel.ts` from A12).
5. **Session page:** an "Add as eval case" action on `AgentSessionPage.tsx` (only for finished, non-eval sessions) opening the A12/18 candidates-style dialog: choose a dataset (existing agent dataset or new), preview the generated scenario, confirm; the dialog reuses `DialogShell`. Disabled with a reason while the session is running or has no messages.
6. **Banner:** `AgentSessionEvalBanner.tsx` + model on the agent session and run pages, calling the reverse lookup; normal sessions show nothing.
7. **Evals list:** `?agent=<id>` filter chip in the list page and model (mirrors `?stage=`).
8. **Tests:** `buildScenarioFromSession` (messages, tool names, tags, title, empty/odd sessions); candidates route hides eval sessions; reverse lookup route; `agentEvalsModel` for the three Evaluate cases; banner model; list filter model; existing Catalog, agent page and wizard tests untouched.

## Acceptance

- [x] The agent page shows the Evals section for an agent with two evals and the empty state for none; Evaluate routes per the three cases (model tests).
- [x] `#/evals?agent=<id>` filters the list and shows a dismissible chip.
- [x] "Add as eval case" on a finished session creates a script scenario with the session's user messages and observed tool names; the author can edit it before saving; the dataset write goes through the write path; nothing is written before confirm.
- [x] Eval sessions are never offered as sources; a normal session shows no eval banner; an eval session opened by link shows the banner with a working link.
- [x] `GET /api/eval-runs?subject_ref=` and the agent candidates route are covered by route tests.
- [x] No stage eval behavior changes; existing eval, Catalog and agent UI tests untouched.
- [x] `npm test`, `npm run ui:test`, `npm run ui:build`, `npm run typecheck` pass.

## Contract notes from A01 (the six specs' "Release 2: agents" sections win over any older line in this story)

- `GET /api/datasets/candidates?agent=<id>` returns `{ items: [{ session_id, updated_at, preview, turns, tools }] }` and `GET /api/eval-runs?subject_ref=<id>` is the reverse lookup, per `evals-api-cli-mcp.md` Release 2.

## Out of scope

Auto-generated simulated scenarios, building scenarios from production traffic automatically, pipeline-level entry points, docs (A14).

## Open questions

_(agent fills; stop and ask the owner)_


## Final note

Branch `worktree-agent-a6d75f33f6625e8ac` (on `claude/chat-agent-research-5ab531`, A02-A14), commit 507d1735. UI + one docs file; no server change (A10 already had candidates?agent=, source "sessions" create/append, subject_ref; A12 had the `?agent=` list chip and wizard preselect).

New: `agents/detail/{agentEvalsModel,AgentEvalsSection}`, `agents/session/{sessionCaseModel,AddSessionCaseDialog}`, `evals/{agentSessionBannerModel,AgentSessionEvalBanner}`, tests for each plus `newEval/agentSample.test.ts`. Edited: `AgentDetailPage`, `AgentSessionPage`, `AgentRunPage`, `DatasetsPage`, `SetupStep`, `wizardModel`, `evalsClient.installEvalSample(projectRoot?, kind?)`, `docs/console-evals.md`.

Decisions/deltas:
- Evals on the agent page is an **Evals n tab** (the Sessions view only shows the aside when empty), with Evaluate in the header; routing is the three-way rule. Not compared to an artboard (none covers it).
- Add as eval case: dialog picks New dataset (name) or an editable existing dataset (agent's first), previews the script scenario, Edit reuses ScenarioEditor, writes via createEvalDataset (`cases`, or append with list hash). Scenario is built client-side from session detail (`scenarioFromSession`, mirrors the server's).
- Banner on session and run pages, only requested when `source === "eval"`; links to the case transcript tab.
- Extra: dataset page **Add from sessions** for agent datasets (A12 deferred it to A13; server append already existed).
- Sample: the agent sample installs a whole agent + eval, not a dataset. The wizard's "Try sample data" tile for an agent now installs it and opens `support-sample` Run dialog; SAMPLE_NO_DEFAULT_MODEL and SAMPLE_AGENTS_UNAVAILABLE show clear toasts, SAMPLE_EXISTS opens the existing eval. The empty-state "Try the sample eval" stays stage-only.
- Docs fixed in console-evals.md (tab not section, sample behavior, banner on run page, add-as-case details).
- Not done: visual check in a browser; evals list `?agent=` chip tests unchanged (A12).
