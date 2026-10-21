# 12: Opt-in real Chrome smoke test

**What to build:** An opt-in test that runs agent-browser against a local fixture login server. The server sets one persistent cookie and one session-only cookie.

**Blocked by:** 09

**Status:** ready-for-agent

- [ ] The test is skipped unless an environment flag is set.
- [ ] The test proves both cookies survive close and reopen with the pinned state directory.
- [ ] The test proves the daemon is closed by Host teardown.
