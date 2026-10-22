# 02: Retry resets correctly through a container

**What to build:** Confidence that the existing checkpoint-and-reset mechanism (the `completion-checkout-before.json` fingerprint manifest and its reset flow) needs no changes when the retried attempt runs in a container instead of a forked worker. A failed attempt's container exits, the worktree is reset to the pre-attempt manifest, and the next attempt runs in a freshly spawned container against that clean state.

**Blocked by:** 01 (Run a single stage attempt inside a container)

**Status:** mostly verified — one item blocked by environment, not by the mechanism

- [x] Forcing a stage attempt to fail requires no code changes to the checkpoint mechanism (`gitCheckoutCapability` / `completionCheckRunner`) — confirmed by reading both files: neither imports or references anything from `stageProcessLauncher.ts`, and the full pre-existing retry test suite (`runtime.stageRetry.test.ts`, `runtime.stageRecovery.test.ts`, etc.) still passes unmodified.
- [x] The retried attempt runs in a newly spawned container, never a reused one — `docker run --rm` is invoked fresh on every `launch()` call regardless of attempt number; proven directly by the new "respects the same concurrency cap as host-process mode" test, where 3 separate container-mode launches each get their own process/container.
- [ ] A live `sf runs retry` against a real failed container-mode run was attempted but blocked: this worktree's `.stageflow` store had an active Stageflow host running (port 3847, likely a VS Code extension session) that refuses CLI-driven store mutations while it's up ("Use the operator console or MCP instead"). Not touched, to avoid disrupting whatever that session was doing. The retry *mechanics* are still covered by the point above and by ticket 05's full pipeline pass, just not a live `runs retry` invocation specifically.
- [ ] A demonstrated run showing attempt 1 fail then attempt 2 succeed needs a real model credential (none available in this environment) to reach an actual success — not exercised end-to-end.
