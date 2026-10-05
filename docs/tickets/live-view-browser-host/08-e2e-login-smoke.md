# 08: End-to-end login smoke and user docs

**What to build:** First, make the Host that serves the console report the live view capability to its browser host (the local browser host reports `relay` only when the process that owns the console routes created it with that option; CLI-only runs without a console keep reporting none, so a human login stage there still fails early). Then add an opt-in test that drives the fixture login (username, password, second factor) and the popup flow through the console against a real Chrome, then confirms the gate and the Host-side login check, plus the user-facing browser docs page describing live view and the capability model.

**Blocked by:** 04, 06, 07

**Status:** done

- [x] The server bootstrap passes the live view capability into the browser support used for runs; a Host started with the console reports `relay`, a CLI-only run reports none, and a human login stage on a headless-only host with a relay no longer fails early.
- [x] Wheel scrolling, right click, the modifier bit mask and `char` events are verified against a real Chrome through the live view API (results recorded in the ticket notes).
- [x] With the opt-in switch on and agent-browser on the path, the smoke logs in through the console and the Host check passes; the popup flow completes and the opener receives the token.
- [x] The wrong-confirm path produces a new gate and the live view is still usable.
- [x] The user-facing browser page documents live view, what each kind of Host shows, and the passkey and native-prompt limits.
- [x] The smoke is skipped by default and leaves no sockets or browsers behind.

## Notes (from the implementation)

- Input paths verified against real Chrome through the live view API: mouse wheel, right click (contextmenu fires), shift modifier (`a` with modifiers 8 and text `A` gives "A"), `char` events, Backspace (virtual key code 8), and a 200-character paced paste (complete, in order, no 429).
- The real console UI was driven once with agent-browser: typing through the canvas logged in; instruction line, address line, canvas and help text render. Defect fixed: the address line was blank until the first navigation (agent-browser emits no initial `url` message), so the relay now publishes the current page URL from CDP target discovery.
- Layout follow-up (ticket 20): the stage panel is short by default and the canvas renders small.
