# 14: Run-scoped profile lease

**What to build:** The profile lock becomes a lease held by a run, not a stage. Stages of the holder run join it. Other runs queue until the holder run is terminal.

**Blocked by:** 13

**Status:** done

- [x] Parallel stages of one run that use one profile start at once.
- [x] A second run waits until the first run is success, failed, cancelled, or abandoned, and shows the holder run id.
- [x] The lease stays held while the run waits at a gate.
- [x] Stale leases of dead runs are reclaimed at Host start and while waiting.
- [x] The lease contract suite runs against the local and in-memory implementations with run owners.
