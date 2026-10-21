# 15: Teardown per stage and per run

**What to build:** At stage end, close the stage's tab and its session. At run end, cancel, or abandon, close the anchor gracefully and release the lease. The sweep covers anchors and stage sessions.

**Blocked by:** 13, 14

**Status:** done

- [x] After a stage ends, its tab is closed and Chrome and the other stages stay up.
- [x] After the run ends, fails, or is cancelled, Chrome is gone and the lease is free.
- [x] A run waiting at a gate keeps the anchor and lease.
- [x] The Host-start sweep closes anchors and stage sessions of dead runs and leaves live runs alone.
- [x] Session-only cookies survive from one stage to the next in a run.
