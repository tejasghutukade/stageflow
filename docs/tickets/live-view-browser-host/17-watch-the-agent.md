# 17: Watch-the-agent view

**What to build:** Operators can open a read-only live view of any running browser stage. Read-only is enforced on the server, the view follows popups, and it does not keep the browser alive after the stage ends.

**Blocked by:** 07, 06

**Status:** ready-for-agent

- [ ] A view ticket for a running browser stage opens a frame stream; input is rejected for view sessions on the server even from a modified client.
- [ ] The view follows popups through re-targeting and ends when the stage ends.
- [ ] Closing the view has no effect on the stage; no relay remains after teardown.
- [ ] Console tests cover the view-only path.
