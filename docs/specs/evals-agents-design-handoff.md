# Evals for agents: design handoff (A11 to A12)

Wonder file `01a10d0c-ed89-7a34-ac9e-b8edd0c271ca`, page `01a10d0c-ed8b-7da6-9e8d-e66daac1c0cd`, below the release 1 set (y >= 12400). Tokens are the existing `--sf-*` set; no new tokens or components. Numbers and names in artboards are invented. Owner review required before A12 starts.

## Artboards

| Artboard (all `Page - Evals - Agent - ...`) | id | Position | Covers |
|---|---|---|---|
| Setup Step | `dvd` | 0, 12400 | Duplicate of `out`. Target toggle (Agent active), agent picker (selected, disabled-chip, archived rows), risk badges, "asks first" line, stubbed-tools hint, Dataset summary + scenario preview table (Mode column), Conversation card (all fields, helpers), YAML preview, Checks (found, disabled, simulator warning), estimate with Agent turns / Simulator / Judge lines |
| Conversation Real Tools Warning | `sup` | 0, 14400 | `real` state: header chip, amber panel, consent unchecked + Create blocked finding; checked + Review finding; CLI-equivalent copy |
| Run Dialog Real Tools Consent | `two` | 860, 14400 | Run dialog with Conversation line, consent panel, disabled Run eval, safer overrides, estimate |
| Scenario Editor | `sow` | 1600, 14400 | Mode switch, fields, facts, ignored-in-mode collapse, script list (reorder), expected block, tool mocks, field/JSON errors, disabled Save |
| Upload Dialog Mapping | `aug` | 2420, 14400 | 10 mapping rows, JSON-only notice, Ready/Skipped preview |
| Graders Step Additions | `mai` | 3180, 14400 | Add menu, `tool_calls`, `conversation_check`, `goal_reached`, rubric note, reference rows |
| Try On One Case Live Transcript | `fri` | 0, 16200 | Running chip + Cancel, streaming transcript, chips, stop reason, grades, cost |
| Case Drawer Transcript Tab | `has` | 860, 16200 | Header chips, expected-tools checklist, turn list, expanded chip (args/result), 5 outcome badges, truncation, Open agent run, deleted-session note |
| Results Tiles Config And Compare | `vcr` | 1720, 16200 | Turns/Tool calls tiles, cost split, Cases columns, Config rows, agent diff card (Compare), live-progress Now/failure labels |
| States Loading Empty Error | `lot` | 2720, 16200 | Picker loading/empty/error/no match, sample disabled, dataset empty/invalid/mixed-use, transcript loading/empty/error, stop reasons, Evals list agent row |

## Components to reuse (existing console)

Section card (hairline border, header + body), segmented toggle, radio row, chip (`--sf-raised`), status badges (`ok`/`needs`/`fail`/`running` bg+fg pairs), mono code blocks, estimate box (`--sf-panel`), dialog shell, drawer tabs, table with mono head. Outcome badge colors: Ran=ok, Stubbed=raised/neutral, Mocked=running, Would ask first=needs, Denied=fail. Risk badges: Read=ok, Write=needs, Shell=fail, External=running, Unknown MCP=dashed needs, Sub-agent=neutral.

## Real-tools warning (not color alone)

Warning icon, bold lead "Real tools can change your project.", amber left bar, `REAL TOOLS` header chip on the card, required "I understand" checkbox, blocked-Create finding in the wizard, disabled Run eval with reason in the dialog.

## Copy

All strings from `evals-ui-map.md` Release 2 used as written. New or adapted copy, for owner decision:

1. Real option description in the Tools radio: "Every tool runs for real on this machine. Selecting it shows a warning that must be acknowledged."
2. Blocked finding: "Create is blocked until you tick I understand. (eval.real_tools_not_allowed)".
3. Review finding (`eval.tools_real`): "Real tools are on. Every run of this eval can change files and call outside services."
4. CLI lines: "warning: real tools can change your project..." and "error: this eval uses real tools. Pass --allow-real-tools to confirm. (EVAL_REAL_TOOLS_NOT_ALLOWED)". Flag name and code are proposals for A10/A14.
5. Simulator warning: "User model is the same as the agent model. Choose a different one to avoid a simulator that agrees with itself."
6. Picker empty/error, sample-disabled reason, transcript empty ("No transcript was recorded..."), invalid-scenarios banner, mixed-use banner (placeholder; use dataset-format wording).
7. Agent diff card title "Agent changed between these runs" and its rows (spec lists the card but not its copy).
8. Grader reference-row descriptions and the "agent" menu chip.

## States: covered and not

Covered: default, empty, loading, error for picker and transcript; edge states listed above.
Not designed (state why in A12 if built): light theme (the file's tokens are dark-only; build with the console's existing light tokens, layout is token-driven); Try-on-one-case error state and a mocked-tools Conversation card variant (reuse error banner and Tools card pattern); Review step page and dataset-detail page full artboards (rows described above; reuse `dog` and the Review step layout with the agent rows listed); screenshots for review were taken in-session only.

## Deviations from the A01 UI map / known polish

- Conversation card is Setup section 3 (after Dataset), numbering shifts Run defaults to 4; Run defaults not redrawn.
- Small status dots (`Grade Dot`, `Live Dot`, `Running Dot`) are spans in the artboards and render invisible on the canvas; build as normal dots. Fonts show as Geist/Geist Mono fallback in Wonder.
- Compare artboard `est` not duplicated; the agent diff card is shown standalone in `vcr`, intended above the numbers.
- Stats rule kept: tiles show API values only (`mean_turns`, `mean_tool_calls`, hidden when null).

## API fields needed (from A10 contracts; confirm names)

`agent-targets`: id, name, model, revision, archived, disabled, tool counts per class, asks_first[], eval_count, unknown_mcp_tools[]. Eval: `conversation.{mode,max_turns,turn_timeout,user_model,tools,approvals,read_only_tools}`, `allow_real_tools`. Findings: `eval.tools_real`, `eval.real_tools_not_allowed`, `eval.tools_unstubbed_list`, `eval.tool_not_granted`, `eval.simulator_unsupported`. Estimate: stage_calls, simulator_calls, judge_calls, estimate_basis. Run: mean_turns, mean_tool_calls, cost split, agent revision, definition hash, effective tools/approvals policy, simulator model, prompt versions, effective limits. Case: transcript turns, tool call records (name, args, result summary, outcome, status), stop reason, session id (Open agent run), truncation counts. Compare: agent diff fields.

## Open questions for the owner

Copy items 1-8 above; whether Try-on-one-case needs its own error artboard; whether to add the full Compare/Review artboards before A12 or build from this note.
