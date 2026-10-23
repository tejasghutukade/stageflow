# A12: UI build for agent evals

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** built (branch worktree-agent-a01681c8a613462f9) · **Blocked by:** A10, A11

## Why this story exists

Authors work in the console. This story makes the Agent pill live in the new-eval wizard and builds the pieces the plan lists (section 6): agent picker, Conversation card, scenario case editor, upload mapping, Try on one case with a live transcript, and the transcript result view with tool-call chips. It reuses the release 1 screens and models; only the target-specific parts change.

## Read first

- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it).
- `ui/AGENTS.md` (Astryx workflow, chrome exception, UX docs, component map), `docs/specs/evals-ui-map.md` including its "Release 2: agents" section, and `docs/specs/evals-agents-ui-design.md` plus the Wonder artboards from A11 (use `get_design_context` and `take_screenshot`; layout/copy/states from artboards, behavior from specs).
- [Plan](../../specs/evals-agents.md) section 6, G2, G6, G7; A10's typed client in `ui/src/api/types.ts` and `client.ts`.
- Release 1 code to extend (read before editing): `ui/src/redesign/evals/newEval/` (`SetupStep.tsx` where the Agent pill is a disabled "soon" span near line 88, `StagePicker.tsx`, `useWizardData.ts`, `useWizardPreview.ts`, `wizardModel.ts`, `GradersStep.tsx`, `GraderCard.tsx`, `graderForms.ts`, `ReviewStep.tsx`, `wizardCreate.ts`, `stageInput.ts`), `ui/src/redesign/evals/datasets/` (`UploadDialog.tsx`, `uploadModel.ts`, `DatasetTable.tsx`, `datasetModel.ts`), `ui/src/redesign/evals/run/` (`RunDialog.tsx`, `runDialogModel.ts`, `LiveProgress.tsx`), `ui/src/redesign/evals/results/` (`CaseDrawer.tsx`, `drawerModel.ts`, `OverviewTab.tsx`, `overviewModel.ts`, `ConfigTab.tsx`, `configModel.ts`, `CasesTab.tsx`, `casesModel.ts`), `ui/src/redesign/evals/edit/` (`DefinitionCard.tsx`, `editModel.ts`), `EvalRow.tsx`/`evalListModel.ts`, and the agent run page `ui/src/redesign/agents/run/` for the Waterfall link target.

## Decisions already made (do not revisit)

- The UI formats and never computes statistics. Tool policy and approval policy defaults are `read_only` and `record_only` and are written explicitly on create. `real` shows the persistent warning and, in the run dialog, requires the consent checkbox that sends `allow_real_tools: true` (A10).
- Nothing is written before the Review step's Create, as in release 1; try-one uses `POST /api/evals/try` with the draft definition and an inline case.
- No Command grader, no calibration; "Not calibrated" copy stays for rubric graders.
- The run dialog does not offer older agent revisions (owner decision 5); it shows the revision that will be used.
- Pure models (`*Model.ts`) hold all logic and carry the tests; components stay thin (release 1 pattern).

## What to build

1. **Wizard model (`wizardModel.ts`, tests):** `target` becomes a union (stage or agent); steps and validity rules for agents (agent chosen and enabled; dataset has >= 1 valid scenario; conversation settings valid; >= 1 grader); id derivation `<agent-id>-eval`; draft to `definition` JSON for agent targets exactly per the A01 spec (`conversation`, `defaults.user_model`); defaults written explicitly (`repeats`, `pass_threshold`, `max_cost_usd`, `concurrency`, `conversation.*`).
2. **Setup step:** make the Agent pill live; `AgentPicker.tsx` (from `GET /api/evals/agent-targets`: model, revision, tool risk badges, asks-first list, disabled reasons); `ConversationCard.tsx` with `conversationModel.ts` (mode, max turns, user model via the judge-capable model picker, tools, approvals, `read_only_tools` editor, `real` warning); right column keeps live YAML (validate, debounced 300 ms), Checks, estimate.
3. **Scenario editor:** `datasets/ScenarioEditor.tsx` + `scenarioModel.ts` (persona, goal, opening, facts, script messages with reorder, expected outcome/tools/forbidden tools, tool mocks table with JSON validation); table columns for scenario datasets; `DatasetTable` shows mode and a scenario summary; invalid scenarios flagged from `input_check`.
4. **Upload dialog mapping:** `uploadModel.ts` supports agent field targets (`input.opening`, `input.goal`, `input.persona`, `expected.*`), drag and drop unchanged, and the notice that `script` and `tool_mocks` need JSON/JSONL; preview via `POST /api/datasets/preview` (A10).
5. **Graders step:** add `tool_calls`, `conversation_check`, `goal_reached` forms in `graderForms.ts` + `GraderCard.tsx` (pure helpers with tests; applicability: the Add grader menu hides stage-only `schema` for agents and conversation types for stages); the grader types reference panel lists them.
6. **Try on one case:** reuse the panel; for agents show the live transcript (messages, tool-call chips with outcome), grades, cost; disabled with error findings; the call can take a while, so show progress and a cancel (abort the request).
7. **Run dialog:** show agent, revision, tool and approval policy summary, estimate with simulator/judge lines (and the "Rough estimate from typical conversations" basis), `real` consent checkbox sending `allow_real_tools`, `user_model` override, safer-only tools/approvals selects; live progress handles the `agent_running` phase; start via the A10 client.
8. **Results:** `CaseDrawer` transcript tab (`transcriptModel.ts`: turns, tool-call chips with args/result summary/outcome badges, stop reason, "Open agent run" link to the agent run page by session id); `OverviewTab` tiles for mean turns and mean tool calls (formatted from API values); `ConfigTab` rows for agent revision (with the stale-config chip from `current.agent_revision`), definition hash, tools table with risk/class, policies, simulator model and prompt versions, effective limits; `CasesTab` unchanged except the subject column text; compare page shows the two new deltas and the `agent_diff` card.
9. **List and edit:** `EvalRow` target label for agents; `EditEvalPage`'s `DefinitionCard` switches Target to an agent picker and exposes the Conversation card; stage behavior unchanged.
10. **Docs for the UI:** add the new components to `ui/src/components/COMPONENT-MAP.md` if the repo's UI rules require it, and update `docs/console-evals.md` only in A14.
11. **Tests and visual check:** model tests for every `*Model.ts` above; component tests where release 1 has them; screenshots of the new screens in dark and light compared with the A11 artboards, recorded in the final note.

## Acceptance

- [x] From the wizard an author picks an agent, sets the Conversation card, adds scenarios (manual, script JSON, CSV upload with mapping), adds agent graders, tries one case with a live transcript, and creates the eval; the created file equals the A01 spec's example shape.
- [x] The Agent pill is live; the Stage flow behaves exactly as before (existing wizard tests untouched).
- [x] `real` tools show the warning on the Conversation card and require consent in the run dialog; the default is `read_only` and `record_only`.
- [x] The results drawer shows the transcript with tool-call chips and a working link to the agent run page; overview shows mean turns and tool calls from the API.
- [x] No number is computed in the UI beyond formatting; model tests cover step validity, definition conversion, scenario validation, grader forms, transcript model, conversation card.
- [~] Visual check against the A11 artboards shows the same structure and copy except documented deltas. (partial, see Final note)
- [x] No stage eval behavior changes; existing eval tests untouched.
- [x] `npm test`, `npm run ui:test`, `npm run ui:build`, `npm run typecheck` pass.

## Contract notes from A01 (the six specs' "Release 2: agents" sections win over any older line in this story)

- Copy, fields, defaults and states for every agent screen are in `evals-ui-map.md` Release 2; stop-reason labels are `Resolved`, `Gave up` (abandoned), `Turn limit`, `Script ended`, `Repeated itself`, `Empty message`; tool outcome badges are `Ran`, `Stubbed`, `Mocked`, `Would ask first`, `Denied`.
- Agent default concurrency is 2 and cost limit 1; the wizard writes them explicitly with the whole `conversation` block.

## Out of scope

Entry points from the agent pages and "Add this session as a case" (A13), docs (A14), server changes (A10), run dialog offering older revisions.

## Open questions

_(agent fills; stop and ask the owner)_

## Final note

Branch `worktree-agent-a01681c8a613462f9` (on `claude/chat-agent-research-5ab531`, A02-A10). UI only; no server change.

New files (all under `ui/src/redesign/evals/`): `agentRun.ts`; `newEval/{conversationModel,agentPickerModel,useAgentTargets,AgentPicker,ConversationCard,ChipInput,AgentGraderForms}`; `datasets/{scenarioModel,ScenarioEditor,ScenarioTable,SessionCandidatesDialog}`; `results/{transcriptModel,TranscriptView}`. Edited: wizard (`wizardModel`, `SetupStep`, `NewEvalWizard`, `GradersStep`, `GraderCard`, `graderForms`, `ReviewStep`, `wizardCreate`), `uploadModel`/`UploadDialog`/`DatasetsPage`/`datasetModel`/`candidatesModel`, run dialog + live progress models, results (`CaseDrawer`, `configModel`, `ConfigTab`, `overviewModel`, `headerModel`, `casesModel`, tables), compare, list (`evalListModel`, `EvalRow`, `EvalsRedesign`), edit page, `routes.ts`/`App.tsx` (`?agent=` on `/evals` and `/evals/new`, `?tab=transcript` on the case route), `evalsClient.tryEvalCase(input, signal)`. 12 new `*.test.ts` files; existing tests untouched (1874 UI tests pass, typecheck and `ui:build` pass).

Decisions and deltas:
- `WizardTarget.kind` gained `"agent"` and the draft has `targetKind` and `conversation`; stage paths unchanged. `evalTabs(items, agentsLive)` takes a flag so the release 1 "Agents soon" assertion stays; the console passes true.
- Cost split: stats have only `cost_stage` (agent + simulator) and `cost_judge`, so the Cost tile reads "agent and simulator $x · judge $y" (no separate simulator figure; UI may not compute one).
- Live progress: result rows carry only the stored status, so a timeout shows as "Agent failed" and any `error` as "Error" (simulator error not distinguishable).
- Open agent run links to `agentRunPath(agent, session, firstTurnSeq)` from `agentsApi.session`; a failed lookup shows "agent session deleted".
- Upload: the server checks a new dataset's scenarios as simulated, so the dialog re-checks rows against the wizard's conversation mode (`recheckForMode`) and offers a "Scripted conversations" switch only when no mode is known. Upload confirm carries `candidates` (all parsed rows).
- Re-run this case and Results "Re-run with these settings" are blocked or routed to the Run dialog for real-tools evals (no silent real execution).
- "Add from runs" is hidden for agent datasets (Add from sessions on the dataset page is A13); the wizard tile "From past sessions" is built. "Try sample data" is disabled for agents until A14.
- Compare card title follows the UI map ("What changed in agent <id>"), not handoff copy item 7.
- Visual check: ran against a mock API in the Browser pane (dark theme only: the console's `--sf-*` tokens have no light set, so light was not checked). Compared the case drawer to artboard `has`: same structure; deltas are tabs (artboard Transcript/Grades/Scenario, built Transcript/Grades and review with the scenario as Input above), badge explanations as tooltips instead of inline text, expected-tools rows worded "must be called / not called" instead of Found/Missing, and no "Stopped: ..." footer line. Other artboards (`dvd`, `sup`, `two`, `sow`, `aug`, `mai`, `fri`, `vcr`, `lot`) were built from the UI map and handoff text, not pixel-compared.
- Not built: entry points and "Add as eval case" (A13), docs (A14), COMPONENT-MAP (no eval entries exist there).
