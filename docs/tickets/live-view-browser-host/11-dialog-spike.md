# 11: JS dialog spike

**What to build:** A short spike establishing what agent-browser does when a JavaScript dialog (alert, confirm, prompt, beforeunload) opens in a session it owns, and whether the relay can answer it through the debugging protocol without conflicting. Output is a findings note and a go/no-go for ticket 13.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Findings state, for each dialog kind, what agent-browser does by default (auto-handle, queue, report), what a CDP client sees, and whether answering through CDP conflicts.
- [x] Findings state whether the viewer should answer dialogs or only show them, and a recommended time-out behavior.
- [x] The fixture dialog page is used; no real sites or credentials are used.
- [x] The findings note is added to the spike folder and the spec's open question 10 is answered in it.

## Notes
Findings: spikes/live-view/dialogs/FINDINGS.md. Verdict GO for ticket 13 with a changed design (viewer answers confirm and prompt only; alert and beforeunload are auto-accepted by agent-browser in milliseconds and stay read-only; relay needs a Page-enabled session from target creation via browser-level auto-attach; Host time-out 60 s then CDP dismiss).
