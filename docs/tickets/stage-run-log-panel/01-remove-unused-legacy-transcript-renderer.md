# 01: Remove unused legacy transcript renderer

**What to build:** Delete the legacy `StageActivityLog` transcript renderer, confirmed unused anywhere in the codebase, so the log panel work in this feature doesn't build alongside dead code.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The legacy `StageActivityLog` component file no longer exists in the repository.
- [ ] A repo-wide search confirms zero remaining references to `StageActivityLog`.
- [ ] The `ui/` build and test suite pass with the file removed.
