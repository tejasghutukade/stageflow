# 04: Popup re-targeting

**What to build:** The relay follows popups and new tabs: it opens its own CDP connection to the browser address the Host already holds, watches target creation and destruction, and when a popup opens or the streamed tab closes it switches the stage session's tab, restarts the stream on the same port, reconnects, clears the frame cache and tells subscribers.

**Blocked by:** 03

**Status:** done

- [x] A new page target with an opener causes a re-target to it; the streamed target closing causes a re-target back to its opener (or the latest remaining page).
- [x] A re-target maps the target to the session's tab id with a read-only tab listing, makes it active, restarts the stream on the same port, and tells subscribers (tab and address).
- [x] The frame cache is cleared on re-target and late joiners get the new tab's frame.
- [x] No agent-browser command runs while idle; commands run only on a detected change.
- [x] The relay contract suite covers popup open, popup close, no popup, and a re-target during an in-flight input batch, using a fake CDP target emitter.
- [x] An opt-in real-Chrome check opens the fixture popup and confirms the opener receives the message after authorization.
