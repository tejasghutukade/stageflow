# 07: Console viewer in the pending gate

**What to build:** The console renders a live view inside the pending login gate when the handoff is `live_view`: a canvas that draws each frame at the decoded image size, maps pointer positions by image size, types through a hidden text area (key events and text-input events), sends everything through one ordered batched queue, and shows connecting, reconnecting, re-target and closed states, plus help text for hidden prompts.

**Blocked by:** 05

**Status:** done

- [x] Clicks land correctly when the frame size differs from the reported metadata size and when the frame size changes after a popup.
- [x] Printable keys, Tab, Enter, Backspace and arrows work (non-printable keys carry a virtual key code; Enter carries a carriage return); paste, composed text and on-screen-keyboard text arrive as character events.
- [x] Input goes through a single ordered queue with at most one request in flight; mouse moves coalesce; a 25-character string with at, dot and plus signs arrives in the right order.
- [x] The viewer shows waiting, reconnect-with-new-ticket, re-target and closed notices, an address line, and the collapsible help text about passkeys, permissions, file pickers and browser sign-in boxes.
- [x] Modifier bit mask, wheel and right click are verified or recorded as known gaps in the ticket notes.
- [x] Logic (coordinate mapping, key event construction, queue, state transitions) is unit-tested in the UI workspace; UI rules in the UI guide are followed.
