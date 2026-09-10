# 02: Stage run log panel skeleton

**What to build:** On the run detail page, add a second panel beside the existing conversational transcript. It renders every stage event (tool call, assistant text, thinking, the initial user prompt, HITL ask/answer, lifecycle marker) as its own collapsible row, in the same chronological order as the conversational transcript, with a status icon reflecting pending/running/success/failed and the event's raw preview text visible on expand. This is backed by a new pure step-building function that turns the existing stage event stream into the ordered row list, independently unit-tested with no DOM rendering, mirroring the test style of the existing transcript-turn builder.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Opening a stage run (running or completed) shows a new panel beside the existing transcript.
- [ ] Every event type (tool call, assistant, thinking, user prompt, ask/answer, lifecycle marker) appears as its own row, in the same chronological order as the conversational transcript.
- [ ] Each row shows a status icon matching pending/running/success/failed.
- [ ] Expanding a row reveals that event's raw preview text (arguments/result/message content).
- [ ] The step-list builder is a pure function with unit tests covering event-to-step mapping, ordering, and status derivation, requiring no DOM rendering.
- [ ] Works identically for historical (completed) runs and currently-running runs, with no backend or schema changes.
