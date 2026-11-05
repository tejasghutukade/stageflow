# HITL gates

The exact `answer` object for `answer_gate` and `sf runs answer`. How to present the question is [native-question-ui.md](native-question-ui.md).

Read the gate from `list_waiting` or `sf runs waiting --run <id> --json`. Use `pending_prompt`, not a shortened question string. Copy `pending_prompt.id` into `promptId`. Print `pending_prompt.message` verbatim. Do not answer the gate yourself unless the user gave the answer.

`waiting_kind: feedback_loop_decision` is not this shape. Do not send it to `answer_gate`. Use `decide_feedback_loop` or `sf runs feedback-decide` with `extend`, `continue`, or `abandon`.

## Answer object

Every answer includes `promptId`. `answer_gate` takes `{ runId, stageId, answer }`. The CLI is `sf runs answer --run <id> --stage <id> --answer '<json>' --json`.

| `pending_prompt.kind` | `answer` |
|---|---|
| `free_text` | `{ "promptId", "kind": "free_text", "text" }` |
| `confirm` | `{ "promptId", "kind": "confirm", "decision": "accept" or "reject", "text"? }` |
| `artifact_backed` | `{ "promptId", "kind": "artifact_backed", "decision": "accept" or "reject", "text"? }` |
| `multi_question` | `{ "promptId", "kind": "multi_question", "answers" }` |

`decision` is only `accept` or `reject`. Map a picker Accept / yes / approve to `accept`, and Reject / no / deny to `reject`.

`multi_question.answers` is an object keyed by each sub-question id. Each value is `{ "kind": "free_text", "text" }` or `{ "kind": "confirm", "decision", "text"? }`. Sub-questions are only `free_text` or `confirm`. There is no nested `multi_question` and no `artifact_backed` sub-question. Submit the whole gate once.

`text` on a `confirm` or `artifact_backed` answer is optional notes. On reject of an artifact-backed gate, collect notes in chat after the decision, then submit once.

Success is `{ "ok": true }` even when the run parks on another gate. Go back to watching. On 400, 404, or 409, print the payload and collect a corrected reply. Do not submit a second answer for the same prompt after `{ "ok": true }`.

## What a gate is not

`--skip-gates` / `skip_gates` does not auto-answer. The stage fails at the first wait. Use it only when the user asked for an unattended run.

A stage with `gate_kinds` can still emit without asking unless the pipeline also has a `verify` item of `type: gate`. That is an authoring concern for `stageflow-pipelines`. If a run finishes without ever waiting, say so. Do not invent an answer.
