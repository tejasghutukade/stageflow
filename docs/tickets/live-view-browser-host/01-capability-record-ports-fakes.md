# 01: Capability record, ports and fakes

**What to build:** Define the extensible browser-host capability record and the port interfaces named in the live view spec (browser host, sandbox orchestrator, live view relay, live view source, profile store), each with an in-tree fake. The local browser host reports capabilities derived from platform and display variables (the Xvfb probe arrives in ticket 09; until then Linux without a display reports no virtual display). No behavior change on any desktop.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The capability record has the fields from spec D2 and D16 (display, live view kind, viewer input, attach style, profile persistence, graceful close, hard allowlist, dialogs, popups, permission policy) with a safe default of unsupported for anything not set.
- [x] Each port interface exists in Stageflow's own types, with no provider types crossing it, and has a fake usable in tests.
- [x] The local browser host and the fake remote host both report capabilities; the browser host contract suite gains capability cases that run against every host.
- [x] Existing browser tests pass unchanged; no runtime behavior changes.
- [x] `npm test`, `npm run ui:test` and `npm run typecheck` pass.
