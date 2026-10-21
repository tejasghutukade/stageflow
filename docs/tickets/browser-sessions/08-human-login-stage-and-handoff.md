# 08: Human login stage and handoff

**What to build:** A login stage pattern that opens a visible browser at the login page and stops at a confirm gate. The gate payload includes the site and a handoff kind (`local_window`). An after-phase verify runs the login check again. A failed check sends the run back to the same stage.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] The gate payload includes the site and `handoff: local_window`. The schema also accepts `live_view` with a URL.
- [ ] The window stays open while the operator answers later.
- [ ] A wrong confirm fails the after-phase check and returns to the login stage.
- [ ] A Host with no display fails the stage with a clear message. On Docker the message names the missing live view handoff.
- [ ] When the login is valid, the login stage is skipped and the join to the work stages works.
