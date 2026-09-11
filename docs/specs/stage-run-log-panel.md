---
status: ready-for-agent
---

# Spec: Stage run log panel

## Problem Statement

When an operator is watching a stage run — especially one driven by an agent — the workspace view shows a conversational transcript (system dividers, user prompt, thinking, assistant text, tool calls) as dense prose. There is no compact, step-by-step trace comparable to a CI log (GitHub Actions, for example): a scannable list of what happened, in order, with per-step status and duration, that makes it obvious at a glance where a failing run broke and why. Today, diagnosing a failure means reading through the full conversational transcript to find the one tool call or message that went wrong.

## Solution

Add a second panel beside the existing conversational transcript on the run detail page: a collapsible, GitHub-Actions-style log panel built from the same underlying stage event stream. Every event (tool call, assistant text, thinking, the initial user prompt, HITL ask/answer, lifecycle markers) becomes its own collapsible row with a status icon and duration. Rows are collapsed by default except the step currently in progress and — if the stage failed — the step that failed, which stays expanded. A pinned banner at the bottom surfaces the failure reason when the stage has failed, with a link that jumps to the failing step. Tool-call rows show a human-readable label (e.g. "Read [filename]", "Bash [command]") instead of a raw tool name plus dumped arguments, and bash output stays collapsed by default. The panel works for both currently-running and already-completed stage runs, using only data already captured today — no backend changes or migration required.

## User Stories

1. As an operator watching a stage run, I want to see each tool call and message as a distinct collapsible step, so that I can scan what happened without reading dense prose.
2. As an operator debugging a failed stage, I want the step where the failure occurred to be pre-expanded, so that I see the error without extra clicks.
3. As an operator, I want a pinned banner summarizing the failure reason at the bottom of the log panel, so that I don't have to scroll to find out what broke.
4. As an operator, I want the failure banner to link directly to the failing step, so that I can jump straight to the detail even if it has scrolled out of view.
5. As an operator, I want file-read steps to show only the filename (not the file content), so that logs stay compact and don't leak large blobs into the UI.
6. As an operator, I want bash command steps to show the command by default and let me expand to see captured output, so that I control how much detail I see per step.
7. As an operator watching a stage that's currently running, I want the active step to show a live-updating elapsed timer, so that I have a sense of progress.
8. As an operator, I want completed steps to show how long they took, so that I can spot unusually slow steps.
9. As an operator, I want this log panel available for both currently-running and already-completed stage runs, so that I can review history the same way I watch live runs.
10. As an operator, I want the log panel positioned beside the existing conversational transcript, so that I can cross-reference both views without navigating away.
11. As an operator on a small screen, I want to hide either the conversational side or the log panel, so that the visible side can take full width.
12. As an operator, I want the model's THINKING block and the initial USER prompt each represented as their own collapsible row (collapsed by default), so that I can drill into reasoning or the original task when needed without it cluttering the default view.
13. As an operator, I want assistant text turns represented as collapsible rows too, so that the log reads as one consistent step-by-step trace rather than mixing formats.
14. As an operator, I want HITL ask/answer turns represented as their own rows, consistent with other turn types, so that approval gates are visible in the step trace too.
15. As an operator, I want status icons (pending / running / success / failed) per step, so that I can visually scan for the point of failure.
16. As an operator, I want tool-call labels to read like "Read [filename]" or "Bash [command]" rather than a raw tool name and dumped JSON arguments, so that I understand at a glance what each step did.
17. As an operator, I want unrecognized or future tool types to still show a sensible fallback label instead of breaking, so that the log panel degrades gracefully as new tools are added.
18. As a developer maintaining this codebase, I want the log-step-building logic to be a pure, independently testable function (mirroring the existing transcript-turn builder), so that behavior can be verified without rendering React.
19. As an operator, I want this feature to work on historical runs without any data migration, so that rollout is immediate and low-risk.
20. As a developer, I want the currently unused legacy transcript component removed as part of this change, so that the codebase doesn't carry dead code forward.
21. As an operator, I want lifecycle markers (stage started, agent started) to appear in the log panel as simple divider rows, so that the panel's sequencing matches the conversational transcript's sequencing.
22. As an operator, I want the log panel's row order to be strictly chronological, matching the order events actually occurred, so that the trace reads the same way a CI log does — top to bottom, in execution order.

## Implementation Decisions

- **New pure builder function**, colocated the same way `buildTranscriptTurns()` is colocated with `TranscriptTurns.tsx`/`TranscriptTurns.test.ts`. It takes the existing `StageLogEvent[]` (plus current run/stage status) and returns an ordered list of step structures — one per tool call, assistant turn, thinking turn, the initial user prompt, HITL ask/answer turn, and lifecycle marker (stage started / agent started). Each step structure carries: a stable id, a kind, a display label, a status (pending / running / success / failed), start/finish timestamps, a derived duration (or none, while still running), an expandable detail payload (the existing `argsPreview` / `resultPreview` / `text`), and a default-expanded flag.
- **Tool-call label derivation**: parse the existing `argsPreview` string (already `JSON.stringify`'d structured tool input) per known tool name — `Read`/`Write`/`Edit` → `file_path`, `Bash` → `command`, and so on for other known tools — to produce labels like "Read [filename]" / "Bash [command]". Unrecognized tool names, or a parse failure, fall back to just the raw tool name. No server-side change is needed: the structured input is already present in the stored preview string for every event, past and future.
- **Duration derivation**: pair each tool call's start/end events by their existing `at` timestamps (reusing or extending the existing pairing logic already used for the conversational transcript). For the step currently in progress, duration is computed live as `now − startedAt` and re-evaluated on each existing poll tick — no new interval or polling mechanism is introduced.
- **Default expand/collapse state**: all steps start collapsed except (a) the step currently in progress, which auto-expands while active and collapses again once it finishes successfully, and (b) the step that failed, which stays expanded once the stage/run reaches a failed state.
- **Failure banner**: rendered only when the stage/run has failed, pinned to the bottom of the log panel. Its text is sourced from the existing failure reason already captured on the terminal event / run summary. It includes a control that scrolls to and (re-)highlights the failing step's row.
- **Layout**: the run detail page's workspace pane becomes a two-column split — the existing conversational transcript on the left, the new log panel on the right — each independently scrollable. The existing single "hide workspace" toggle becomes a per-side visibility control, so either side can be hidden to let the other take full width.
- **No backend, API, or schema changes.** The panel is built entirely from data the run detail view already fetches; it works identically for historical and live runs, with no migration or backfill.
- **Cleanup**: the existing unused legacy transcript renderer is removed as part of this change (confirmed zero imports anywhere in the codebase).
- **Scope**: this panel is added to the run detail page only. No other surface in the app renders stage transcripts today.

## Testing Decisions

- A good test here asserts on the *shape of the builder function's output* given a fixed input event array — never on rendered markup or DOM structure. This matches the existing prior art (`TranscriptTurns.test.ts`): plain fixtures in, `toEqual`/`toMatchObject` assertions on the returned structure out, using `vitest` directly with no `@testing-library/react` (not a dependency of the `ui/` package).
- The new builder function is the primary and essentially only unit-tested surface for this feature. Cases to cover: label derivation for known tools (Read, Bash) and an unrecognized tool (fallback path); duration pairing for a completed step and for a step still in progress; default-expanded logic for the running step, the failed step, and everything else (collapsed); ordering (strictly chronological); and failure-banner content/target derivation (present only on a failed run, pointing at the correct step id).
- The React layer (the new panel component, and the layout change to the run detail page) stays thin and declarative and is not independently unit tested at this seam — matching how the existing `TranscriptTurns.tsx` component itself has no direct test, only its pure builder does.
- No new test infrastructure is required; `vitest` is already configured for `ui/`.

## Out of Scope

- Search box, line numbers, and a settings affordance (full GitHub Actions fidelity) — deferred to a future iteration; v1 is status icon, label, duration, expand/collapse, and the failure banner only.
- Any backend, API, or schema changes, and any migration or backfill of older runs.
- Any functional migration of the removed legacy transcript component — it is unused, so removal is deletion only.
- Live streaming via websocket/SSE — the panel continues to rely on the existing polling mechanism already used by the run detail page.
- Non-agent-driven stage types, if any exist outside the current agent-stage flow (not covered by this investigation).

## Further Notes

- This design keeps the panel building itself strictly from the structured `StageLogEvent` fields the API already returns (tool name, preview strings, timestamps, failure reason), rather than re-parsing conversational transcript text — consistent with this codebase's existing "explicit envelopes over transcript scraping" principle documented in `docs/architecture.md`.
- `docs/adr/` is a recognized convention path in this repository but is gitignored/local-only, and none exist in this worktree; this spec is the canonical written record of the decisions above.
- This project has no issue tracker at present, so this spec lives in `docs/specs/` (tracked in git, outside the public Jekyll doc site) rather than being filed as an issue.
