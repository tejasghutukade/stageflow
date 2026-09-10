# 05: Default expand/collapse behavior

**What to build:** Rows default to collapsed, except the step currently in progress (which auto-expands while active and collapses again once it finishes successfully) and, if the stage has failed, the step that failed (which stays expanded).

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] On a freshly loaded run, all rows are collapsed except the currently-running step, which is expanded.
- [ ] When the running step completes successfully, it collapses again automatically.
- [ ] When a stage fails, the specific step responsible for the failure is expanded and stays expanded.
- [ ] All other steps around a failed or running step remain collapsed by default.
