# 04: Step duration + live elapsed timer

**What to build:** Show how long each completed step took, derived from its paired start/end timestamps, and show a live-updating elapsed counter on whichever step is currently in progress.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Each completed step row displays a duration computed from its start and end timestamps.
- [ ] The currently in-progress step shows a spinner plus an elapsed-time counter that increases over time as the page polls.
- [ ] No new polling loop or interval is introduced; the timer updates on the existing poll cycle already driving the run detail page.
- [ ] A step that never received an end event (e.g. the run terminated abnormally) degrades gracefully rather than showing a broken or negative duration.
