# 00: Pre-build verification of browser session unknowns

**What to build:** Answer the open technical questions in the spec with small experiments and write the answers into the spec's Further Notes. No product code.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] Confirm the Pi bash tool runs agent-browser with injected environment inside a real stage worker.
- [x] Confirm a headed window opens from a worker started under the console.
- [x] Find where agent-browser keeps state under HOME and an environment variable that pins it outside the per-attempt HOME.
- [x] Confirm a later stage attempt reattaches to the same session after the worker exited to wait for the operator.
- [x] Confirm check, then login (skipped), then work routes correctly with the existing route and skip rules. If not, record the needed change.
- [x] Record how the domain allowlist is configured and whether the tool enforces it.
- [x] Record the effect of the encryption key variable on profile data and state files.
- [x] Record whether `--cdp` attach keeps a login and whether streaming accepts operator input.
- [ ] Decide user story 11 (throw-away profile for stages with no profile).

Results: see "Pre-build verification results (ticket 00)" at the end of `docs/specs/browser-sessions.md`. Last item left open on purpose: technical considerations written, decision pending. Partial: items 1 and 2 verified at tool level; real `sf run` / console path unverified (no provider auth).
