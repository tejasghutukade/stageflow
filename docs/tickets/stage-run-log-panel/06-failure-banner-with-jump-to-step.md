# 06: Failure banner with jump-to-step

**What to build:** On a failed stage run, show a small banner pinned to the bottom of the log panel summarizing the failure reason, with a control that scrolls to and highlights the failing step's row.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] The banner appears only when the stage/run has failed; it is absent on successful or in-progress runs.
- [ ] The banner's text matches the failure reason already captured for that run/stage.
- [ ] Clicking the banner's jump control scrolls the failing step's row into view and visibly highlights it, even if that row was scrolled out of view or the panel was showing something else.
- [ ] The row the banner links to is the same row that's auto-expanded per ticket 05.
