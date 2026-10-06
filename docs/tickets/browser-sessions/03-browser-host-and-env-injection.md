# 03: Browser host and environment injection

**What to build:** A browser host interface with a local implementation. For a stage with a `browser` field, the stage environment receives the profile path, session name, short socket directory, state directory, headed flag, allowlist, and key reference. The scheduler does not build browser paths. A fake host proves the seam.

**Blocked by:** 00, 01, 02

**Status:** ready-for-agent

- [ ] A whole-pipeline fake-agent test shows the browser settings in the stage environment.
- [ ] The settings enter through explicit run variables, not through the ambient allowlist.
- [ ] The socket directory path stays under the 103-byte limit for a deep Stageflow home.
- [ ] State outside the per-attempt HOME is pinned, so session-only cookies survive between stages.
- [ ] Headless is used when no display exists or when the stage sets it.
- [ ] With a fake remote host, the stage gets a remote address and no local profile path.
