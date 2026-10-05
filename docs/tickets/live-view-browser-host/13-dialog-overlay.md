# 13: Dialog overlay

**What to build:** Confirm and prompt dialogs appear in the viewer as an overlay with accept, dismiss and (for prompts) text entry; control sessions answer, view-only sessions see that a dialog is open. Alert and beforeunload are auto-accepted by agent-browser within milliseconds, so they are shown read-only at most. The relay keeps a Page-enabled debugging session on every page target from creation (browser-level auto-attach with the new-popup pause), emits `dialog` and `dialog_closed` messages, and replays an open dialog to late viewers. An unanswered dialog is dismissed by the Host after a configured time-out (default 60 s) and the gate shows a failure notice. Dialog text is plain text and untrusted. Design follows the dialog spike findings (spikes folder, dialogs); the stage environment is NOT changed to turn off agent-browser's auto-handling.

**Blocked by:** 11, 07

**Status:** done

- [x] The relay uses browser-level auto-attach so popups are attached before their scripts run; it emits `dialog` (kind, message, default prompt, target) and `dialog_closed` (result), replays an open dialog to late subscribers, and treats a "no dialog is showing" reply as already closed; one answer per dialog.
- [x] A prompt answered without text sends the default prompt explicitly (an accept with no text would return an empty string).
- [x] Alert and beforeunload are reported read-only (they close before anyone can answer) and the viewer never offers answer controls for them.
- [x] View-only sessions cannot answer; dialog text is never passed to the agent or logs.
- [x] An unanswered dialog is dismissed through the debugging protocol after the configured limit (default 60 s, well before the agent-side ~150 s wedge) and the gate shows a failure notice.
- [x] A relay that starts while a dialog is already open cannot answer it (spike finding); the limitation is handled explicitly (documented, with the Host time-out as the fallback) and covered by a test.
- [x] The fixture dialog page works end to end in the opt-in smoke.
- [x] Relay contract tests and UI unit tests cover each case.

## Notes (from the implementation and verification)

- The viewer overlay is covered by unit tests, typecheck and a successful UI build; it was not exercised in a real browser. Do this in the layout follow-up (ticket 20) or a manual pass.
- The relay only exists while a viewer is attached, so dialogs raised with nobody watching are not tracked (agent-browser handles those as before). A relay that starts while a dialog is already open cannot answer it (documented as limitation 17).
- The Host time-out dismisses the dialog and the viewer shows a notice; it does not fail the stage.
