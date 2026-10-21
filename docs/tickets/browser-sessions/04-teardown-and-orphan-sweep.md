# 04: Teardown and orphan sweep

**What to build:** The Host closes the browser session on stage success, failure, cancel, timeout, and run end. The session stays open while a stage waits for the operator. On Host start, the Host closes sessions whose run is gone.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] Teardown does not depend on the stage worker process staying alive.
- [ ] A cancelled run leaves no browser process.
- [ ] A timed out stage leaves no browser process.
- [ ] A stage that waits at a gate keeps its browser open.
- [ ] On Host start, sessions of dead runs are closed. Sessions of live runs are left alone.
