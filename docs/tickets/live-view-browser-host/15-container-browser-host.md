# 15: Container browser host

**What to build:** A browser host that runs each run's browser in its own container (Chromium, a virtual display and the profile volume only): attach by IP, graceful close over the debugging protocol before removal, stale profile lock cleared at start, label-based sweep of dead runs, and a volume profile handle.

**Blocked by:** 14, 06

**Status:** ready-for-agent

- [ ] A run on the container host logs in through the live view and keeps its login after the container is removed and recreated on the same volume (graceful close first).
- [ ] The attach address uses the container IP; a replaced container is reported as a restarted anchor and the stage env's address is swapped via the existing path.
- [ ] Teardown closes the browser gracefully, waits bounded, then releases through the orchestrator; the Host-start sweep removes containers of dead runs by label.
- [ ] The profile handle no longer requires a folder path for this host; scope remains an input.
- [ ] The image runs read-only, non-root, with capabilities dropped, no privilege escalation, and process and memory limits, with the debugging port reachable only on loopback or a private network.
- [ ] Host contract tests (with the fake orchestrator) pass; an opt-in smoke runs against a real container runtime.
