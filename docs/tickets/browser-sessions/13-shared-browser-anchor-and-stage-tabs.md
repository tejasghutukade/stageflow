# 13: Shared browser per run (anchor) with one tab per stage

**What to build:** Replace per-stage profile launch with an anchor agent-browser session per (run, profile). Stage sessions attach to the anchor by CDP with pin-tab and get their own tab. See "Revision 2" in the spec.

**Blocked by:** None (builds on tickets 03 to 11)

**Status:** ready-for-agent

- [ ] The browser host starts or reuses the anchor for the run and profile (profile env, headed or headless) and reads its CDP address.
- [ ] A stage with a profile gets an env with the CDP address, pin-tab, a unique session name, and no profile variable.
- [ ] Two parallel stages of one run each use their own tab and see the same cookies.
- [ ] Stages without a profile are unchanged.
- [ ] The anchor and stage env are persisted so resume workers use the same values; a dead anchor is restarted and the env refreshed.
- [ ] The fake remote host supplies a CDP address and the stage env is the same shape.
