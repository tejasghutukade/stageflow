# Native question UI

Present a waiting HITL gate on the coding-agent host's structured question tool when that tool can represent the gate. Otherwise collect the reply in this chat. Submit with `answer_gate` either way. This file is presentation only — it does not change MCP tools, `detect-host.mjs`, or the operator console.

Read `pending_prompt` from `list_waiting` (not only `waiting_questions` strings).

## Detect a picker

Inspect **this harness's current tool list**. A picker is a tool that collects a structured choice (question text plus labeled options), not a free-form chat reply.

Do not run `detect-host.mjs` for this. That script is Stageflow host up/down (MCP vs CLI). It does not detect a question UI.

| If this name is in the tool list | Use it |
|---|---|
| `AskQuestion` | Cursor question cards |
| `AskUserQuestion` | Claude Code questions |
| `ask_user` | Pi questions |

If none of those (or another options-based question tool already in the list) is present, collect in chat. Do not invent a tool name or call shape. Codex and OpenCode stay in chat until an options-based question tool appears in the list.

Pass the pending message as the question text and the mapped labels as that tool's options. One question per call. If the picker returns a custom or Other value, map that text the same as a chat reply.

**Done when** you know picker or chat for this gate.

## Representable vs chat

| Gate | Picker | Chat |
|---|---|---|
| `confirm` | Accept and Reject | Host has no picker |
| `artifact_backed` | Accept and Reject (decision only) | Host has no picker |
| `free_text` with a harvested closed set | Those names as options | Open-ended, or harvest is ambiguous |
| `free_text` with no closed set | — | Always |
| `multi_question` | Sequential pickers when **every** sub-question is representable; then one `answer_gate` | Any sub-question is open or unmappable — the **whole** gate in chat |

Map picker Accept / yes / approve → `accept`. Reject / no / deny → `reject`. Submit the selected option label as `free_text.text` unless the kind is `confirm` or `artifact_backed`.

When in doubt, chat.

**Done when** the path (picker or chat) is chosen from this table.

## Harvest

Harvest only from `pending_prompt.message` (or a `multi_question` item `message`) when it names a **hard closed set**:

- `reply with exactly one of:`
- `choose one of:`
- `exactly one of`

Split the names after that directive (commas, `or`, newlines). Those literal names are the picker options.

Do **not** harvest loose example lists (`you might try`, `e.g.`, `for example` without `exactly one of`). A listed example set that is not a hard closed directive stays in chat.

Submit the selected label as-is. If the prompt also lists aliases for the same choice (for example `minimal` and `prototype~1`), keep every listed name on the card; do not rewrite the label at submit — the stage maps synonyms.

**Done when** the option list is the prompt's literal closed set, or the gate stayed in chat.

## Artifact-backed

1. Print the pending message and artifact paths (from `list_waiting`) in this chat. Do not put artifact bodies on the card. Do not call `read_artifact` unless the human asked to open a file.
2. Open the picker with Accept and Reject.
3. Accept → submit immediately (`decision: "accept"`).
4. Reject → one chat follow-up for optional notes, then submit `decision: "reject"` and `text` when they typed notes.

**Done when** the operator has seen the paths in chat and the decision is on the picker (or chat if there is no picker).

## Errors

On `answer_gate` `isError` (400 / 404 / 409), print the payload. Collect a corrected reply on the picker if the gate is still representable; otherwise chat. Then `answer_gate` again.

**Done when** `{ "ok": true }` or the error payload has been printed and a corrected reply is in hand.
