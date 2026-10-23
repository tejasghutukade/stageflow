# 03: Concurrent fan-out attempts each get their own container

**What to build:** Fan-out/clone stages (like a `review~1..4` pattern) run one container per clone, concurrently, up to the existing active-attempt concurrency cap — with no collisions between clones on cache volumes or container identifiers.

**Blocked by:** 01 (Run a single stage attempt inside a container)

**Status:** done — implemented and verified (real fan-out pipeline run not exercised, see last item)

- [x] The existing active-stage-process concurrency cap counts running containers the same way it counts forked processes today: `waitForCapacity()`/`slotsHeld` gate `launch()` before it decides how to spawn, so the cap is agnostic to spawn method. Verified end-to-end with a real cap-of-2/3-launches test using a fake `docker` binary — the third launch waits until one of the first two finishes.
- [x] Cache mounts (`StageContainerOptions.cacheRoot`/`cacheMounts`) are scoped by run id + stage id via `buildCacheMountArgs` — concurrent fan-out clones have distinct stage ids (`review~1`, `review~2`, ...) and therefore always get distinct host cache paths, so they can never clobber each other. Unit-tested directly, including that different stage ids produce different host paths.
- [x] Container names are unique per attempt: `buildContainerName` combines run id + stage id + attempt number with a `randomUUID()`-derived suffix, so concurrent `docker run --name` invocations never collide even across retries of the same attempt.
- [ ] A real fan-out pipeline run (multiple concurrent containers, real credentials) was not exercised — no live model credential was available in this environment, and this worktree's real pipeline shapes need one to reach a fan-out stage. The concurrency and isolation guarantees above are verified at the launcher level (real process/container spawning via a fake docker binary), not against a full live fan-out pipeline.
