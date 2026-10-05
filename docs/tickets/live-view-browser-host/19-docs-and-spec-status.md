# 19: Docs and spec status

**What to build:** Update the internals document (status table, module map, lifecycle, env contract, new invariants, limitations 1, 8 and 13), the user-facing page, the Docker guide, and the live view spec's status. Record that Steel and Browserless were evaluated and rejected, so the agent-browser stream stays the transport.

**Blocked by:** 08, 15

**Status:** ready-for-agent

- [ ] The internals document lists the new invariants (no timers against agent-browser, ordered input, image-size coordinates, key rules, graceful close before container removal, debugging ports reached by IP and never exposed, no logging of input or frames, gate handoff addresses are stable paths).
- [ ] Limitations 1, 8 and 13 are updated to their new state.
- [ ] The spec's status and the browser-sessions spec's implementation notes reflect what shipped.
- [ ] The provider evaluation summary and the decision to stay on the agent-browser stream are recorded.
