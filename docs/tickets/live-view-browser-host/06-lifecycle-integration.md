# 06: Lifecycle integration

**What to build:** Wire the relay into the existing runtime lifecycle: close it before the existing stage-end and run-end teardown, close it on cancel and abandon, rebuild it on demand from the persisted browser environment and anchor after a Host restart, and revoke control when the gate is answered.

**Blocked by:** 03, 05

**Status:** done

- [x] Stage teardown closes the relay first, then the stage tab and session in the existing order; run teardown, cancel and abandon close every relay of the run.
- [x] After a simulated Host restart with a pending gate, opening the live view rebuilds the relay from persisted state and shows the current page.
- [x] A relay never outlives its stage; no relay exists for a stage with no viewers.
- [x] Existing teardown, resume and human-login tests pass; new tests cover ordering and rebuild.
- [x] The internals document's lifecycle section is updated for the new steps.
