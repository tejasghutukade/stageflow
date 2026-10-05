# Live view and remote browser hosts: tickets

Parent spec: live view and remote browser hosts (the spec of the same name under the specs folder). Tickets are tracer-bullet slices; each lists what blocks it. Work the frontier: any ticket whose blockers are done.

| # | Title | Blocked by |
|---|---|---|
| 01 | Capability record, ports and fakes | None (can start immediately) |
| 02 | Capability-driven gate handoff | 01 |
| 03 | Live view relay core | 01 |
| 04 | Popup re-targeting | 03 |
| 05 | Console live view API | 02, 03 |
| 06 | Lifecycle integration | 03, 05 |
| 07 | Console viewer in the pending gate | 05 |
| 08 | End-to-end login smoke and user docs | 04, 06, 07 |
| 09 | Virtual display support | 01 |
| 10 | Self-hosted image recipe | 09, 06 |
| 11 | JS dialog spike | None (can start immediately) |
| 12 | Login challenge basics | 07, 09 |
| 13 | Dialog overlay | 11, 07 |
| 14 | Sandbox orchestrator and conformance suite | 01 |
| 15 | Container browser host | 14, 06 |
| 16 | Provider-neutral proof | 15, 05 |
| 17 | Watch-the-agent view | 07, 06 |
| 18 | Owner scope plumbing | 15, 05 |
| 19 | Docs and spec status | 08, 15 |
| 20 | Live view layout in the run page | 07 |
