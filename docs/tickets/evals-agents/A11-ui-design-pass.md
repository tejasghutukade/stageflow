# A11: UI design pass in Wonder

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** ready-for-agent · **Blocked by:** A01 · **Product code:** none

## Why this story exists

Release 1's console was built from Wonder artboards (`docs/specs/evals-ui-map.md`). Plan section 6 says release 2 needs a design pass for four things that have no precedent in the console: the Conversation card, the scenario editor, the transcript result view, and the tool-policy warning. The plan states designs are a story, not assumed. This story produces them, so A12 builds from artboards and a written delta list instead of inventing layout. **No product code is written.**

## Read first

- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it). Item 4 (tool classes and risk), item 5 (what a tool call record contains).
- [Plan](../../specs/evals-agents.md) section 6, G2, G6, G7, section 8 risks 1, 8.
- `docs/specs/evals-ui-map.md` including the "Release 2: agents" section (A01): screens, states and copy to design. Wonder file page `01a10d0c-ed8b-7da6-9e8d-e66daac1c0cd` holds the release 1 artboards; reuse their tokens, type, spacing and components: `out` (Setup), `mru` (Graders), `dog` (dataset detail), `zip` (upload dialog), `tub` (run dialog), `spa` (live progress), `but` (results overview), `tee` (case drawer), `est` (compare).
- `ui/AGENTS.md` (Astryx rules, chrome exception, UX docs, component map) and `ui/src/components/COMPONENT-MAP.md`. Wonder tooling: load the `wonder:wonder-design` skill, call `get_design_context` first with the page id above, and `get_skills` for the new-design job.
- Existing agent screens for visual language: `ui/src/redesign/agents/run/AgentRunPage.tsx`, `traceViews.tsx`, `SpanPanel.tsx` (Waterfall, span chips), `ui/src/redesign/agents/session/AgentSessionPage.tsx` (message list).

## Decisions already made (do not revisit)

- Same console tokens and Astryx rules as release 1; no new design system. Designs follow the "deltas" practice: artboards show layout, copy and states; specs define behavior and data. Numbers in artboards are invented.
- Agent pill in the wizard Setup step becomes live (it is "soon" today). Target step shows an agent picker (name, model, revision, tool summary with risk badges).
- Conversation card fields: mode (script/simulated), max turns, user model, tools policy (`read_only` default, `mocked`, `real` loud), approval policy (`record_only` default).
- `real` tools shows a persistent warning in the Conversation card and on the run dialog (consent checkbox, matching A10's `allow_real_tools`). `record_only` approvals show a quiet explanation ("calls that would ask first are recorded and denied; nothing reaches the Inbox").
- Scenario editor replaces the stage input form; script and tool mocks are JSON/JSONL only (CSV upload cannot map them).
- Transcript view: turns, tool call chips with args/result/policy outcome (`ran`, `stubbed`, `mocked`, `would_ask_first`, `denied`), links to the existing agent run page (Waterfall) by session id. Results overview adds mean turns and mean tool calls tiles. Everything else (compare, flaky, failure tags) unchanged.
- Stats display rule: the UI formats numbers the API returns; designs must not imply client-side computation.

## What to build

Produce Wonder artboards (on the same page, below the release 1 set, named `agents / <screen>`), each with default, empty, loading, error and relevant edge states, in dark and light:

1. **Setup step, Agent target:** target pill row with Agent active, agent picker list (search, model, revision chip, tool risk badges per class, "asks first: …" line, disabled/archived rows with reason), Conversation card (all five fields, helper text, limits note "Eval limits replace the agent's own limits"), right column Checks and estimate including simulator and judge cost lines.
2. **Dataset step, scenarios:** summary card and table with mode column; **scenario editor** (drawer or dialog): mode switch, opening, persona, goal, facts list, script messages list (add/reorder), expected block (outcome, tools, forbidden tools), tool mocks table (tool id, result JSON, error), validation errors per field; upload dialog variant with agent field mapping and the "script and tool mocks need JSON" notice.
3. **Graders step additions:** forms for `tool_calls`, `conversation_check`, `goal_reached`; rubric card note that the judge reads the bounded transcript; grader types reference panel rows for the new types.
4. **Tool-policy warning:** the `real` state in the Conversation card, the run-dialog consent state, and the CLI-equivalent copy (for A10/A14 wording). Also the unlisted-MCP-tool hint: "Tools not listed as read-only are stubbed" with the `read_only_tools` editor.
5. **Try on one case, live transcript:** streaming transcript with tool chips, grades beneath, cost line.
6. **Results:** case drawer **transcript tab** (turn list, tool call detail, stub/mock/would-ask-first badges, stop reason, "Open agent run" link), overview tiles for mean turns and tool calls, Config tab rows for agent revision, definition hash, tool and approval policy, simulator model and prompt versions, effective limits.
7. **Deliverable note:** `docs/specs/evals-agents-ui-design.md` listing each artboard id, route, API fields it needs (from A10), deviations from the A01 UI map, and open copy questions. Update the "Release 2: agents" section of `evals-ui-map.md` with artboard ids. Take screenshots into the scratchpad for review only.

## Acceptance

- [ ] Artboards exist for items 1-6 with the listed states, in both themes, using existing tokens and components.
- [ ] Every state in the A01 UI map's agent section is covered, or the note says why not.
- [ ] The `real` warning is unmistakable (not just a color) and appears on the Conversation card and the run dialog.
- [ ] `docs/specs/evals-agents-ui-design.md` maps artboards to routes, components to reuse, and API fields; unresolved copy is listed as questions for the owner.
- [ ] Owner review requested before A12 starts (state it in the final note).
- [ ] No file under `src/`, `ui/` or `tests/` changed.

## Contract notes from A01

- `evals-ui-map.md` Release 2 fixes the screens, fields, defaults, the exact copy for the `real` warning, the `record_only` note and the stubbed-tools hint, the stop-reason labels and the tool outcome badges (`Ran`, `Stubbed`, `Mocked`, `Would ask first`, `Denied`). Design those strings as written; list any copy you change as a question for the owner. Add the **agent diff** card to the Compare artboard and the Conversation card to the Config tab.

## Out of scope

Any code, new tokens or components in the repo, designs for entry points on the agent page (A13 may need a small addition; list it in the note), marketing visuals.

## Open questions

_(agent fills; stop and ask the owner)_
