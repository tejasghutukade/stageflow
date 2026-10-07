---
status: ready-for-agent
---

# Spec: Live view and remote browser hosts for browser stages

Builds on [Browser sessions for stages](browser-sessions.md) (implemented in 0.29.0). Read [Browser sessions internals](../browser-internals.md) first; this spec uses its vocabulary (Host, anchor, profile, lease, stage session, gate, human login stage) and its invariants.

This spec is the output of four spikes (live view stream, popup re-targeting, headed Chromium under Xvfb, container per run). Every claim marked **(spike)** was observed in a spike run, not assumed. Claims marked **(docs)** come from vendor documentation and were not tested. Section "Further Notes" holds the evidence, the protocol cheat sheet, the gotchas, and a question-and-answer list.

## Problem Statement

A pipeline stage that needs a logged-in website (the running example is searching LinkedIn) cannot start until a person logs in. Today that person must be sitting at the machine that runs the Stageflow Host:

1. Stageflow opens a real, visible Chrome window on the Host machine.
2. The operator types the username, password, and the two-factor code in that window.
3. The operator confirms in the console; the Host re-checks the login; later stages reuse the saved profile and may run without a window.

This breaks in three situations the operator cares about:

- **Stageflow as a service.** On a hosted or containerized Host there is no screen. A human login stage fails before the agent starts with "a visible browser is needed, but this Host has no screen. A live view handoff is not available yet." The operator cannot log in at all.
- **Operator and Host on different machines.** Even on a self-hosted Linux server or a Docker Host, the operator is in a browser on a laptop and cannot reach the Host's display.
- **Intrusive and opaque local browser.** On a laptop, a real Chrome window pops up over the operator's work, they cannot see what a later stage's browser is doing without finding that window, and they have to keep it alone while the stage runs.

Related weaknesses of the current design that a virtual display fixes at the same time:

- A headless fallback on Linux with no display changes the user agent (it says `HeadlessChrome`) compared with the headed login, which sites can notice. The silent fallback is limitation 8 in the internals document.
- The CDP port of the shared browser is unauthenticated and local, so a hosted Host cannot safely run browsers next to other tenants' work (invariant 13).
- `allow_domains` is only a soft prompt for stages with a profile (limitation 1).

## Solution

The operator logs in through the Stageflow console, in their normal browser, to a browser that runs wherever the Host decides. The browser can be a headed Chromium inside a virtual display on the Host or inside a per-run container. The console shows that browser as a live picture inside the gate that asks for the login, and forwards mouse, keyboard, paste, and touch input to it.

From the operator's side:

1. A stage with a human login gate reaches its gate. The gate in the console shows a live view of the stage's browser at the login page, instead of the text "a window was opened on the Host".
2. The operator clicks the username field, types, presses Tab, types the password, presses Enter, then types the two-factor code. If the site opens a "Sign in with <provider>" popup, the live view switches to the popup by itself and switches back when the popup closes.
3. The operator presses the existing confirm control. The Host re-checks the login itself (unchanged). On success the live view detaches and the pipeline carries on; the agent keeps driving the same browser. If the check fails, the operator gets a new gate and the live view is still there.
4. While later stages run, an operator may open a read-only live view of the browser to watch what the agent is doing. They can do anything else on their computer; nothing opens locally.

From the platform's side: a Host reports a display capability (a local window, a virtual display, or none). The gate shows a local-window message only when the Host really has a window; otherwise it shows a live view. A Host that cannot show a login at all keeps failing early with a clear message. A container browser host runs each run's browser in its own locked-down container with a profile volume, so hosted tenants never share a Chrome.

The mechanism is deliberately small. The stream, the input channel, and the popup signals already exist in agent-browser and in Chrome's debugging protocol; Stageflow adds a relay, a gate handoff, a ticketed console API, a viewer component, and a second browser host.

## User Stories

### Operator: logging in through the console

1. As an operator, I want the login gate to show the stage's browser inside the console, so that I can log in without a window opening on the Host machine.
2. As an operator, I want to click into a text field in the live view and type, so that I can enter my username and password normally.
3. As an operator, I want Tab, Enter, Backspace, arrow keys, and shortcuts to work in the live view, so that forms behave like in a normal browser.
4. As an operator, I want to type the two-factor code from my phone into the live view, so that two-factor sign-in works.
5. As an operator, I want pasted text (including a password from my password manager) to reach the browser, so that I do not have to retype long passwords.
6. As an operator on a phone or tablet, I want the on-screen keyboard to type into the live view, so that I can approve a login away from my desk.
7. As an operator, I want clicks to land where I click even when the page is scrolled or the browser window has a different size from my screen, so that I never click the wrong control.
8. As an operator, I want scrolling with the mouse wheel to work in the live view, so that I can reach controls below the fold.
9. As an operator, I want the live view to switch to a popup window when the site opens one (for example "Sign in with Google"), so that I can finish a popup-based login.
10. As an operator, I want the live view to switch back to the original page when the popup closes, so that I see the result of the login.
11. As an operator, I want the live view to show what is currently on screen the moment I open it, even when the page is static, so that I never stare at a black box.
12. As an operator, I want to see the current page address in the gate, so that I can tell I am on the real site.
13. As an operator, I want to confirm "I'm logged in" with the existing confirm control, so that the flow I already know does not change.
14. As an operator, I want the Host to check the login for me after I confirm, so that I cannot wrongly tell the pipeline I am logged in.
15. As an operator, I want a second gate and the same live view if the check says I am still logged out, so that I can retry without restarting the run.
16. As an operator, I want to close the tab and come back later (or from another device) and still find the same live view at the same page, so that a long two-factor wait does not break the run.
17. As an operator, I want a clear message ("waiting for the browser") rather than a blank area while the live view connects, so that I know it is working.
18. As an operator, I want a clear message and a retry control if the live view loses its connection or the Host restarts, so that I can recover without losing the login page.
19. As an operator, I want the live view to be hard to use by anyone else, so that my typed password and my session cannot be hijacked by another user of the console.
20. As an operator, I want typed text never to be stored in run logs, event logs, envelopes, or exports, so that my credentials do not end up in files.
21. As an operator who is not a developer, I want no new setup step for the live view in the console, so that I just open the gate and use it.

### Operator: watching a running browser stage

22. As an operator, I want to open a read-only live view of a running browser stage, so that I can see what the agent is doing without touching it.
23. As an operator, I want a read-only view to be impossible to type into by accident or by a modified client, so that I never disturb a running agent.
24. As an operator, I want the live view to follow the tab the agent is using, so that I see the right page when the agent opens a popup or a new tab.
25. As an operator, I want to leave the live view open or close it at any time without affecting the stage, so that watching is free of side effects.
26. As an operator, I want watching a stage not to keep its browser alive after the stage ends, so that I do not leak resources.

### Pipeline author

27. As a pipeline author, I want to write the same `browser:` stage YAML and the same human login stage for every Host, so that my pipeline works on my laptop and on the hosted service.
28. As a pipeline author, I want no live view setting, URL, port, path, or scope in YAML, so that where the browser runs stays a Host decision (invariant 10).
29. As a pipeline author, I want the existing `browser.check` and the `browser_login` verify item to keep working unchanged, so that I do not rewrite pipelines.
30. As a pipeline author, I want a stage that is not a login stage to behave the same whether the Host has a window, a virtual display, or a container, so that my pipeline is portable.
31. As a pipeline author, I want a pipeline whose login stage cannot be shown on the current Host to fail at the start of the stage with a message that tells me what the Host needs, so that I do not discover it after a long run.

### Agent

32. As a stage agent, I want the login stage's instructions to say the operator logs in through the live view, so that I ask the operator correctly and never type credentials.
33. As a stage agent, I want the browser to be exactly as before after the human login (same session, same tab environment), so that my commands are unchanged.
34. As a stage agent, I want no live view code to change my browser environment, so that agent-browser does not relaunch the browser and lose the page.

### Self-hosting administrator (single Host, Docker or Linux server)

35. As a self-hosting administrator, I want a Linux Host without a screen to run login stages through the live view, so that I can run Stageflow on a server.
36. As a self-hosting administrator, I want a headed browser inside a virtual display, so that sites see a normal headed Chrome user agent instead of `HeadlessChrome`.
37. As a self-hosting administrator, I want the Host to detect the virtual display capability itself, so that I do not set display variables by hand.
38. As a self-hosting administrator, I want to turn on browser launch options (for example automation hiding, software WebGL, an explicit browser executable path, running without the Chromium sandbox in containers) in the Host config, so that I can adapt to my environment and to stricter sites.
39. As a self-hosting administrator, I want those options off by default and never settable from YAML, so that fingerprint-affecting behavior is a deliberate Host decision.
40. As a self-hosting administrator on ARM Linux, I want to point the Host at a distribution Chromium, so that I can run where Chrome for Testing has no build.
41. As a self-hosting administrator, I want a shipped image recipe for the browser, so that I can follow one documented path.
42. As a self-hosting administrator, I want only the console port exposed to users and the live view to be served through it, so that I do not publish an unauthenticated debugging port.
43. As a self-hosting administrator, I want the existing control token and loopback rules to keep applying to the live view, so that no new unauthenticated surface appears.
44. As a self-hosting administrator, I want the Host to refuse a login stage on a Host that cannot show it (no display and no live view), with a clear message, so that failures are early and understandable.

### Platform engineer / hosted service operator

45. As a platform engineer, I want each run's browser to run in its own container, so that tenants never share a Chrome, a cookie jar, or a debugging port.
46. As a platform engineer, I want the container to hold only the browser, a virtual display, and the profile volume (no agent-browser, no Node, no tokens, no relay), so that a compromised page has nothing to steal and the attack surface is small.
47. As a platform engineer, I want containers to run read-only, non-root, with no extra capabilities, no privilege escalation, and memory and process limits, so that a browser exploit is contained.
48. As a platform engineer, I want a narrow orchestrator interface (start, stop, list by run, inspect) behind which I can use Docker for development, my cluster's own job API in production, or a pre-made pool, so that I never have to give the Host a container runtime socket.
49. As a platform engineer, I want the Host never to mount a Docker socket, so that the existing safety rule in the Docker guide holds.
50. As a platform engineer, I want a browser container to start in about a second and use a few hundred megabytes while idle, so that capacity planning is possible.
51. As a platform engineer, I want a restarted container to be recognized (new address, same profile), so that a crash does not lose the profile or confuse the run.
52. As a platform engineer, I want leftover containers of dead runs to be found by label and removed when a Host starts, so that crashes do not leak resources.
53. As a platform engineer, I want a graceful shutdown that flushes the profile before the container is removed, so that a fresh login is not lost.
54. As a platform engineer, I want a profile to live in a volume I can encrypt, size, and back up per owner scope, so that tenant data is protected and bounded.
55. As a platform engineer, I want container egress to be restrictable with a private network and a filtering proxy, so that `allow_domains` becomes a real restriction for profile stages.
56. As a platform engineer, I want the live view tickets and routes to be scoped to an owner scope, so that one tenant can never open another tenant's view.
57. As a platform engineer, I want scope passed in as an input everywhere new, never a literal, so that hosted multi-tenant work does not need a rewrite (the multi-tenant TODO rule).

### Security and privacy

58. As a security reviewer, I want live view access to require a short-lived, single-use ticket bound to one run, one stage, and one mode, so that a leaked link is almost useless.
59. As a security reviewer, I want input to be accepted only for the stage that currently has the login gate pending, and revoked the moment the gate is answered or ends, so that a stale tab cannot drive a browser.
60. As a security reviewer, I want state-changing live view requests to be protected against cross-site request forgery and cross-origin framing, so that a malicious page cannot drive the operator's browser.
61. As a security reviewer, I want input bodies never to be logged, audited, or stored, so that typed credentials never touch disk.
62. As a security reviewer, I want an audit record (ids and mode only; no addresses, no values) when a live view opens and closes, so that access is traceable.
63. As a security reviewer, I want rate limits and size limits on input, so that a client cannot flood the browser.
64. As a security reviewer, I want screen recording and replay to be off for live views, so that frames containing credentials are never kept.
65. As a security reviewer, I want the browser's debugging port never to be reachable by users or by other tenants, so that cookies and full control cannot be taken.
66. As a security reviewer, I want the live view to be an explicit Host capability and not something an agent or a stage can request, so that an agent cannot expose a browser (invariant 17).

### Contributor / maintainer

67. As a contributor, I want live view behind a port with an injectable fake, so that tests need no real browser or network.
68. As a contributor, I want the browser host contract tests to cover the new capability, so that every host implementation is checked the same way.
69. As a contributor, I want the new invariants and limits written in the internals document, so that the next change does not break them (no polling agent-browser, ordered input, image-size coordinates, graceful shutdown before container removal).
70. As a contributor, I want an opt-in smoke test that runs the popup login against a real Chrome, so that the integration is checked without making the normal suite slow.
71. As a maintainer, I want the work cut into slices that each ship without behavior change on desktops until the last slice, so that review stays small and safe.

### Operator: login challenges (popups, dialogs, second factors)

72. As an operator, I want a "Sign in with <provider>" popup to appear in the live view and to be usable, so that popup-based logins work (see D4).
73. As an operator, I want a two-factor code box that is part of the page to just work like any other field, so that I need no special steps.
74. As an operator, I want to approve a login on my phone (authenticator app, SMS code, push notification) and then continue in the live view, so that the usual second factors work.
75. As an operator, I want to solve a CAPTCHA myself in the live view, so that the agent never has to solve one.
76. As an operator, I want a browser alert, confirm, prompt, or "leave this page?" dialog that blocks the login page to be shown to me with accept, dismiss, and text-entry controls, so that the login does not hang on something I cannot see.
77. As an operator, I want to be told when the page is waiting on something the live view cannot show (a permission request, a passkey or security key prompt, a file picker, a password box from the browser), so that I do not wait on a page that looks frozen.
78. As an operator, I want clear guidance that passkeys and hardware security keys do not work through the live view and that I should choose a code, SMS, or backup-code method instead, so that I can finish my login.
79. As an operator watching read-only, I want to see that a dialog is open without being able to answer it, so that I do not disturb a running agent.
80. As a security reviewer, I want text that comes from a dialog or a popup page to be shown as plain text and never to act as an instruction to the agent or to the Host, so that a hostile page cannot inject commands.
81. As a platform engineer, I want a dialog that nobody answers to time out into a clear stage failure rather than hang the run forever, so that capacity is not held by a stuck login.
82. As a platform engineer, I want browser permission requests to be denied by default by the Host, so that a login page cannot enable the camera, microphone, location, or notifications of a server browser.

### Portability across providers

83. As a platform engineer, I want the browser to come from a replaceable adapter (my own Linux box today, a container service or a cloud browser-sandbox provider tomorrow), so that I can change where browsers run without changing pipelines, the runtime, or the console.
84. As a platform engineer, I want the core runtime, the console API, and the gate to depend only on interfaces and a capability record, so that swapping a provider is a configuration and adapter change and not a refactor.
85. As a platform engineer, I want each provider's API client, endpoints, and names kept inside its own adapter, so that nothing else in the codebase breaks when a provider changes or is removed.
86. As a platform engineer, I want a provider that gives its own live view (an embeddable viewer) to plug in without Stageflow's relay, so that I can use a provider's viewer when it is better than ours.
87. As a platform engineer, I want a stage that needs something the chosen adapter cannot do (interactive login on a view-only provider, a hard domain allowlist on a provider without one) to fail at the start with a message naming the missing capability, so that I find mismatches early.
88. As a platform engineer, I want a conformance test suite that any adapter must pass, so that I know a new adapter behaves like the others.
89. As a platform engineer, I want provider credentials to live only in Host configuration or the secret mechanism, never in YAML, run files, envelopes, or logs, so that swapping providers does not leak keys.
90. As a platform engineer, I want a provider's sandbox always to be released on teardown, failure, cancel, and Host restart (by sweep), so that I am not billed for orphaned browsers.
91. As a platform engineer, I want to choose the adapter per Host and later per owner scope, so that different tenants can use different providers.
92. As a pipeline author, I want exactly the same YAML on every provider, so that pipelines stay portable.

## Implementation Decisions

All names below are module and concept names, not file paths. Code shapes are described in prose except where a prototype fixed a protocol detail precisely (marked prototype).

### D1. Principle and architecture

- Live view is a **display capability of the Host**, not a new kind of browser. The browser, profile, lease, anchor, persisted stage env, and teardown model stay exactly as designed in Browser sessions. Three things are added: a display capability on the browser host, a relay that serves the stage session's stream to the console, and a gate handoff plus console API that connect the two.
- The viewer-facing relay runs **inside the Host process**, next to the run manager. It talks to the stage session's agent-browser stream on the Host's own loopback. It does not run inside any browser container (a spike showed a Host-side stage session attached over CDP serves the stream on the Host, so the relay needs no sidecar).
- The whole design is **provider-neutral by construction** (D16): the runtime, gate, console API, and viewer depend only on ports and a capability record, so a self-hosted Linux box, a container service, or a cloud browser-sandbox provider is an adapter choice, not a refactor.
- The mechanism is agent-browser's built-in stream (frames out, input in) plus Chrome DevTools Protocol target events for popups. No third-party live view product is adopted. Alternatives considered are listed in Further Notes.
- The operator's confirm answer remains the existing gate answer path. No new "done" route is added.

### D2. Display capability on the browser host

- `BrowserHost` gains a read-only capability record with two fields:
  - `display`: one of `local_window` (a person at the Host machine can see a headed window), `virtual_display` (headed Chromium inside a virtual display; nobody sees it except through live view), `headless_only` (no way to show a login).
  - `liveView`: whether this Host can serve a live view for its browsers.
- The local browser host derives the capability:
  - macOS and Windows: `local_window`; `liveView` true.
  - Linux with a display variable set: `local_window`; `liveView` true.
  - Linux with no display variable and an Xvfb binary on the path: `virtual_display`; `liveView` true.
  - Linux with neither: `headless_only`; `liveView` true (the stream works, but the page will see a headless browser).
- agent-browser starts its own private Xvfb when it is asked for a headed browser on Linux without a display (spike). The Host therefore does **not** set display variables for `virtual_display`. It keeps copying them only for `local_window`.
- Headed selection (what decides the headed environment value) treats `virtual_display` as headed. This replaces the silent headless fallback for Xvfb Hosts and removes the user-agent change between the login stage and later stages (spike, limitation 8).
- The capability record is extended in D16 beyond these two fields (viewer input, attach style, profile persistence, graceful close, hard allowlist, dialogs, popups, permission policy). The two-field record here is the minimum slice 1 must deliver; the rest follows the same pattern.
- The container browser host (D11) always reports `virtual_display` with live view true. The fake remote host used in tests reports configurable capabilities.
- The human login precondition changes from "has a display" to a capability decision: throw before the agent starts only when the capability is `headless_only` **and** live view is not wired, or when no relay is wired. The no-screen message text and the Docker hint are rewritten to say what is actually missing.

### D3. The live view relay (new port)

A new port, injectable like the browser runner, so tests need no real browser. One relay session exists per (run, stage). It exposes: subscribe to messages (with replay of the last frame for late joiners), send ordered input batches, and close.

Behaviors the production implementation must have (each backed by a spike observation):

- **Source.** It reads the stage session's stream port with the one-shot `stream status` query (or the session's stream file) and connects a WebSocket client to `ws://127.0.0.1:<port>`. The stream is on by default per session with an OS-assigned port; the relay never sets the stream port through the environment, because the persisted stage environment must stay byte-identical (invariant 1). Node's built-in WebSocket client is enough; no new dependency is added.
- **Message relay.** It forwards `frame`, `status`, `tabs`, `url`, and `console`-class messages to subscribers (console messages may be dropped for security: they can contain page data and are not needed).
- **Last frame replay.** The relay keeps the most recent frame (and the latest status, tabs, and url messages) and replays them to every new subscriber immediately. A static page produces **no** frames after the first one, so without replay a late joiner sees nothing. The cache is cleared on a re-target.
- **Input.** It accepts ordered batches of input events and forwards them to the stream in order. It validates the shape (allowed event types and fields, bounded batch size and rate), and it never logs, audits, or persists input content.
- **No timers against agent-browser.** The relay must not run agent-browser commands on a timer, and must not poll the tab list, while it is attached. Any agent-browser command makes the daemon re-attach over the debugging protocol, and a 300 ms tab poll starved the stream completely (no frames reached the viewer). New invariant.
- **Lazy and bounded.** A relay session is created when the first valid ticket is redeemed, closed when the last viewer leaves after a short grace period, when the gate is answered, and on stage or run teardown. A stage with no viewers has no relay.
- **Restart tolerance.** The relay's own browser-facing connection can be torn down and rebuilt (re-target) without dropping console connections.
- **After a Host restart.** A gate may still be pending but the relay is gone. The live view routes rebuild the relay from the stage's persisted browser environment and the run's persisted anchor, as the resume path does.

### D4. Popup re-targeting

- The stream is bound to the tab it was attached to. Switching the agent session's active tab does not move it. Restarting the stream (disable, then enable on the same port) re-binds it to the session's current active tab (spike).
- The agent session already follows a newly opened popup, and falls back to the opener when the popup closes (spike). The stream does not, and emits no tab-change message.
- The relay detects changes by opening its **own** Chrome DevTools Protocol connection to the browser address the Host already holds (the anchor's address), subscribing to target discovery:
  - A new page target that has an opener is a popup or a `target=_blank` tab. Re-target to it.
  - The streamed target being destroyed means go back to its opener if still present, else the most recent remaining page. Re-target to it.
- A re-target does: list tabs (read-only) to map the target to the session's tab id, make that tab active in the stage session, restart the stream on the same port, reconnect the relay's stream client, clear the frame cache, and tell subscribers a re-target happened (with the new tab and address).
- Measured costs: ~100 ms to the popup and ~35–70 ms back with a local browser; ~370 ms and ~180 ms with a browser in a container across the debugging link (spike).
- Frames from a different tab can have a different size (the popup was smaller). Viewers must size themselves from the decoded image each frame (see D10).
- Known unverified cases: several popups at once (last wins), popups opened while no viewer is attached (the re-target still happens; late joiners get the replayed frame), and sites that block automation in popups.

### D5. The `live_view` gate handoff

- The gate handoff type already allows `local_window` or `live_view` with an address. The Host stamps it; the agent can never supply or change it (invariant 17 stays).
- Stamping becomes capability-driven: `local_window` when the Host's display is `local_window`; `live_view` when it is `virtual_display` or when it is `headless_only` with a relay; no handoff otherwise (the stage failed earlier).
- The stamped `live_view` address is a **stable, root-relative path** to the stage's live view (identifying run and stage), not a credential. The gate is persisted and tickets expire, so a credential must never be stored in a gate. The handoff parser (server and UI type guard) therefore accepts a root-relative path in addition to the absolute http and https addresses it accepts today. A path that starts with two slashes is rejected.
- The human login prompt block for the agent changes when the handoff is `live_view`: the operator logs in through the live view in the console, the agent still asks `confirm`, never types credentials, and never drives the browser.
- Confirming is the existing answer path. It runs the existing `browser_login` verification (Host-side re-check, repair loop on a wrong confirm, the "failed retrying" outcome that returns ok with a new gate). Nothing about verification changes.
- A gate that is already answered, abandoned, or cancelled must stop accepting live view input.

### D6. Console API and authentication

The console sends a bearer control token on its requests. The browser's server-sent events and WebSocket clients cannot set headers. So viewer access uses a ticket exchange.

| Operation | Auth | Behavior |
|---|---|---|
| Request a ticket (per run + stage, mode `view` or `control`) | Bearer (read scope for `view`, drive scope for `control`); open loopback mode keeps working as other routes do | Returns a ticket and its expiry. Lifetime ~60 seconds. Single use. Bound to run, stage, mode, and owner scope. `control` is issued only while that stage has a pending gate with a `live_view` handoff. |
| Open the event stream | The ticket (redeemed into an HttpOnly, SameSite=Strict cookie scoped to the live view path; the ticket is then spent) | Server-sent events: frames (base64 JPEG with size metadata), status, tabs, url, re-target, closed. Replays the last frame first. |
| Send input | The cookie plus a custom request header (anti-forgery) | Ordered batches. Rejected (forbidden) for `view` sessions. Rate and size limited. Bodies never logged. |
| Answer the gate | Existing route | Unchanged. |

- Control revocation: answering the gate, abandoning the stage, cancelling the run, or tearing down revokes outstanding control tickets and closes input immediately; the event stream ends with a `closed` message.
- Origin and Host header checks reuse the Host's existing allowed-host machinery. Responses forbid framing (anti-clickjacking) and caching.
- Viewers: any number may watch (`view`). One `control` session at a time is the default; a second `control` request while one is active is refused with a clear error (open question in Further Notes).
- Delivery is **server-sent events down plus ordered, batched HTTP posts up**. This needs no new server dependency (the repository has no WebSocket server library) and works through ordinary reverse proxies. A WebSocket transport is a possible later optimization (see Further Notes).

### D7. Lifecycle integration

Mapping onto the existing runtime lifecycle (numbering follows the internals document):

- Resolve browser env, human login precondition: replace the display probe with the capability decision (D2). Everything else in that step is unchanged: sites check, profile open, anchor, stage env, owner file, open the login page in the stage session.
- Gate wait and resume: unchanged. Browsers stay up and leased. The relay is Host-side and rebuilt on demand (D3).
- Stage end: close the relay first, then the existing order (close the stage tab, then the stage session).
- Run end, cancel, abandon, fail: close all relays of the run before the existing run teardown.
- Host start sweep: nothing to sweep for relays (no persisted state). Orphan daemons and (for the container host) orphan containers are handled by their own sweeps.
- After a successful login the next stages attach to the same shared browser exactly as today.

### D8. Environment contract and Host configuration

- No change to the byte-identical rule. The stage env is computed once, persisted, and reused by every command, attempt, and resume worker.
- New Host-chosen launch options, held in the Host configuration (next to the existing browser section with blocked sites) and **never** in YAML:
  - browser launch arguments (comma separated) for: running without the Chromium sandbox when the container is the sandbox; hiding the automation flag; software GPU for a software WebGL renderer;
  - an explicit browser executable path (needed on Linux ARM64 where Chrome for Testing has no build);
  - all off by default.
- Because these change how the browser launches, they are computed once into the persisted anchor environment, like every other launch-affecting value.
- The "never set" list gains: a stream port through the environment; any live-view related variable in a stage env.
- The Host never takes any browser variable from its ambient environment (existing rule stands).

### D9. Security and privacy decisions

- The stream endpoint of agent-browser is unauthenticated, plaintext, and local (invariant 13). The relay is its only consumer. Nothing else may be told its port.
- Screen content and typed input pass through the Host's memory and the network to the operator's browser only. They are never recorded, never written to run files, logs, activity events, envelopes, exports, or the audit log. Recording and replay features of any provider stay off for live views.
- The audit sink gets two new records: live view opened and live view closed (run id, stage id, mode, caller). No addresses, no values, no input counts that could leak lengths of credentials beyond what is needed for rate limiting.
- Tickets and cookies are scoped to the owner scope, the run, the stage, and the mode. The owner scope is passed in as an input; the literal `local` is never written into new code.
- A live view cannot be requested by an agent, a stage, or YAML.
- The debugging port of any browser (local or container) is never reachable by users or other tenants. Locally it stays on loopback. For containers see D11.

### D10. Console viewer behavior

The viewer is a new component rendered inside the pending gate when the handoff is `live_view`, above the confirm control; a read-only variant is used for watching. Follow the repository's UI rules (the Astryx workflow and chrome exception documented for the console). Behavior decided from the spikes:

- **Drawing.** Draw each frame on a canvas sized to the decoded image. The canvas size changes when the popup or window size changes.
- **Coordinates.** Convert pointer positions using the decoded **image** size. Do not use the width and height reported in the frame metadata: the reported height was 720 for a 577-pixel-tall image (spike), and using it put every click in the wrong place.
- **Mouse.** Send press, release, moved (throttled and coalesced to the latest), and wheel events, with button and click count. Wheel and right click are wired in the prototype but not verified; verifying them is part of the work.
- **Keyboard.** Capture keys with a hidden text area that takes focus on click. Printable keys are sent as key down with the typed character as text. Non-printable keys (Backspace, arrows, Tab, Enter, Delete, and so on) must carry the legacy virtual key code of the key; **without it, Backspace and similar keys are silently ignored** (spike). Enter must also carry a carriage return as its text, or form submission does not happen (spike). Modifier state is sent as a bit mask (alt 1, control 2, meta 4, shift 8); this is unverified in the spike and must be verified.
- **Text input paths that do not produce key events.** Paste, input method composition, speech, and mobile on-screen keyboards produce text-input events. The viewer forwards them as character events, one per character (`char` events were verified).
- **Ordering.** All input goes through **one** ordered queue with at most one request in flight, batching what accumulated meanwhile. One request per event reordered characters ("example.com" arrived as "examle.pomc", spike). Mouse-move events are replaced by the latest while a request is in flight.
- **States.** Show "waiting for the browser" until the first frame, a reconnect banner if the stream drops (and reconnect with a new ticket), a notice on re-target, and a "closed" notice when the gate ends.
- **Accessibility and clarity.** A text instruction above the canvas ("Log in in the browser view below, then confirm"), a visible address bar line showing the current address, keyboard focus handling that does not trap the operator, and a read-only mode that registers no input handlers at all (not merely hides them).
- The viewer displays an image; it can show the operator's own pasted password on the remote page only as the page draws it (password fields mask it). Nothing is echoed outside the canvas.

### D11. Container browser host

A second browser host implementation next to the local one, built on the same interface.

- **What runs in the container.** Only Chromium, a virtual display, a small TCP forwarder (Chrome binds its debugging port to the container's loopback; the forwarder exposes it on the container's network interface), and a process supervisor. No agent-browser, no Node, no relay, no tokens, no Stageflow code, no secrets (spike).
- **Where the rest runs.** The Host runs agent-browser. Stage sessions attach to the container's browser with the same stage environment as today (the attach address plus the pin-tab setting). The stream, relay, tickets, and viewer are Host-side and unchanged (spike).
- **Interface mapping.**
  - Start or reuse the shared browser: ask the orchestrator for a container for (owner scope, profile, run) with the profile volume mounted; wait until the container's debugging endpoint answers; return the attach address and an anchor environment that has **no** profile directory variable (the Host owns no profile folder). If a previous anchor exists, probing its endpoint is the liveness check; a dead one is restarted and reported as restarted (the existing restarted-anchor path closes the old stage daemon and swaps the address).
  - Stage environment: same shape as the local host. The byte-identical rule holds.
  - Capability: `virtual_display`, live view true, always.
- **Reach by IP.** Chrome rejects debugging requests whose Host header is not an IP address or localhost (spike). The host resolves the container's address to an IP and persists the IP-based attach address. Service names are not used.
- **Orchestrator port (new, small).** Operations: start (with labels for owner scope, run, stage, profile), stop (graceful), list by run label, inspect. Implementations: a development implementation that shells out to the local container CLI (development only) and a documented adapter point for a cluster API, a job runner, or a pre-provisioned pool. The Host never mounts or talks to a container runtime socket from inside a Stageflow container (the Docker guide's rule stands).
- **Teardown order (extends run and stage teardown, which assume local sockets today).**
  1. Close stage tabs and sessions as today.
  2. Send the browser's graceful close over the debugging protocol (this flushes cookies; see the next bullet), wait for the container to exit, bounded.
  3. Stop and remove through the orchestrator as a fallback, then release the lease.
- **Graceful close is mandatory for persistence.** In the spike a forced kill and a SIGTERM stop both lost a login made seconds earlier because Chrome had not flushed its cookie store; the debugging-protocol close flushed it, and a new container on the same volume was logged in. After any crash, the last ~30 seconds of cookies are at risk and a login stage should be re-verified.
- **Stale profile lock.** A killed container leaves a profile lock tied to the old container's host name; the next container refuses to start. The image's start script removes the lock files at start. This is safe because the Host's profile lease guarantees one container per profile.
- **Sweep.** At Host start, list containers by the run label, and remove those whose run is dead, with the same liveness rule as the local sweep. Local sockets and daemons keep their existing sweep.
- **Image requirements.** Chromium and a virtual display, non-root, no sandbox flag handled through the Host launch options, fonts installed (a monospace fallback was visible in the spike), start script that clears the lock, starts the display, starts the forwarder, and execs the browser with a persistent profile directory and a fixed window size.
- **Run flags.** Read-only root filesystem, temporary file systems for scratch and home, all capabilities dropped, no privilege escalation, process and memory limits (verified together in the spike). The debugging port is published only to the Host's loopback or kept on a private network; never to users.
- **Egress.** Out of the box the container can reach the internet (spike). The orchestrator design must leave a place for an internal network plus a filtering proxy, which is the way to make `allow_domains` a hard restriction for profile stages. This spec requires the seam, not the proxy.
- **Profile storage.** The profile handle for this host is a volume reference, not a folder path. The profile handle type therefore stops requiring a folder path (make it optional or add a volume reference). Scope stays an input. Per-owner encryption at rest, quotas, and backup are properties of the orchestrator's volume provisioning and are not specified here.
- **Resource profile measured in the spike.** ~1.1 s from create to a usable debugging endpoint; ~230 MB idle (Chromium plus display); graceful close to exit in under 1.5 s.

### D12. Multi-tenant considerations

- New code takes an owner scope as an input and never a literal. New tickets, cookies, routes, audit records, container labels, and profile volumes carry it. The fixed `local` scope remains the only scope used today and stays marked with the existing multi-tenant TODO convention.
- A tenant's live view is only reachable with a ticket issued for that tenant's scope, run, and stage.
- One container per (scope, profile, run) means no shared Chrome between tenants.

### D13. Documentation changes (part of done)

- The user-facing browser page: describe live view for login stages, the capability model, and what happens on each kind of Host.
- The internals page: status table (live view handoff and remote browser host move to implemented as slices land), module map, lifecycle steps, env contract changes, new invariants (below), limitation updates (8, 13 and 1 where applicable), and the container host.
- The Docker guide: a section on the browser image, the orchestrator boundary, and why no socket is mounted.
- New invariants to add: (a) never run agent-browser commands on a timer while a viewer is attached; (b) live view input is ordered; (c) viewer coordinates come from the decoded image size; (d) non-printable keys carry a virtual key code and Enter carries a carriage return; (e) a container browser is closed gracefully through the debugging protocol before removal; (f) debugging ports are reached by IP and never exposed to users; (g) live view input and frames are never logged or stored; (h) gate handoff addresses are stable paths, never credentials.

### D14. Delivery slices

1. **Capabilities, ports, and gate schema.** Define the extensible capability record and the port interfaces of D16 (browser host, sandbox orchestrator, live view relay, live view source, profile store) with in-tree fakes, and add the capability-record cases to the browser host contract suite. Then: display capability on the browser host (local derivation, fake host), capability-driven human login precondition and message, handoff parsing of root-relative paths, capability-driven stamping, prompt block text. No behavior change on desktops (they still stamp `local_window`).
2. **Live view relay and API.** The relay port and its Agent-browser implementation with last-frame replay, input forwarding, and popup re-targeting; ticket, event stream, and input routes; control revocation; audit records; redaction and no-logging guarantees.
2b. **Login challenges.** Blocked on the dialog spike (D15). JavaScript dialog surfacing and answering in the relay and the viewer, the dialog time-out, the default-deny permission policy, launch options that suppress browser credential bubbles, the operator help text. A smoke fixture for dialogs. Document the passkey limit.
3. **Console viewer.** The viewer component and its integration into the pending gate; read-only variant; docs updates.
4. **Virtual display Host support.** Xvfb-based `virtual_display` derivation and headed selection; Host config launch options; an image recipe and documentation for a single self-hosted Linux/Docker Host.
5. **Container browser host.** The sandbox orchestrator port (provider-neutral, D16), the development orchestrator, the container host, image, teardown, label sweep, volume profile handle.
6. **Provider portability proof, watch-the-agent, and multi-tenant hardening.** A conformance suite shared by every port implementation, a second orchestrator adapter (a stub or a recorded-API adapter standing in for a managed provider) that passes it, the `provider_view` path through the live view route with a fake provider viewer, per-owner adapter selection, and Read-only live view of running browser stages, scope plumbing, per-scope volumes, egress seam.

Each slice must leave the full suite, the UI suite, and the type check green.

### D15. Login challenges: popups, dialogs, and second factors

Logins are not only a form. This decision lists every kind of challenge a login can throw at the operator, says whether the live view shows it, and what the Host does. Only the first row was exercised in a spike (and only against a fixture).

| Challenge | Visible in the live view? | Decision | Evidence |
|---|---|---|---|
| Popup window or new tab (`window.open`, `target=_blank`, "Sign in with <provider>") | Yes, after re-targeting | Re-target on open and on close (D4). | Spike with a fixture: popup opened by an operator click in the viewer, authorize click closed it, opener received the message. Not tested against a real provider. |
| In-page second step (code field, modal, overlay, interstitial) | Yes (it is page content) | Nothing special. | Spike: a 2FA code page was completed through the viewer. |
| Out-of-band second factor (authenticator code, SMS code, push approval on a phone, e-mail link) | The code field is visible; the approval itself happens on the operator's own device | Nothing special. The operator reads the code from their device and types it (or pastes it) into the viewer. | Spike for typing a code; the out-of-band channel is outside the system. |
| CAPTCHA and "are you human" checks | Yes | A human solves it in the live view. The agent never solves one. | Not tested against a real CAPTCHA. A site may still refuse an automated browser (out of scope). |
| JavaScript dialogs: alert, confirm, prompt, beforeunload | **No.** They are native dialogs, not drawn in the captured frames, and they block the page's scripts | Surface and answer them (below). | Not tested. What agent-browser does with a dialog by default is unknown and must be established first. |
| Browser permission requests (camera, microphone, location, notifications, clipboard) | No | Deny by default at the Host (below). | Not tested. |
| HTTP authentication box (basic or digest) | No | Not supported in this spec. The page fails with an authorization error. | Not tested. |
| File chooser | No | Not supported in this spec. | Not tested. |
| Browser "save password" or credential bubbles | No | Suppress through Host launch options if possible (below). | Not tested. |
| Passkeys and hardware security keys (WebAuthn) | No, and the key is on the operator's device, not on the Host | Not supported. Documented limit with guidance (below). | Reasoned; not tested. |

#### Popups and new tabs

- Covered by D4. Two additions:
  - Whether a window-open that an operator triggers through the live view counts as a user gesture (so that the browser's popup blocker lets it through) was observed to work in the fixture: the popup opened from a click in a click handler. A provider that opens its popup from a timer or after a network call may be blocked; that is the site's behavior, not something the Host changes.
  - Some providers isolate the popup from its opener (cross-origin isolation headers). The popup's message back to its opener may then fail even though the live view works. This was not tested. Before relying on popup logins for a named provider, run the popup smoke against that provider with the owner's account.
- A re-target never changes which page the operator confirms against. The Host's login check still reads the stage's own tab, as today.

#### JavaScript dialogs (alert, confirm, prompt, beforeunload)

- Behavior to build, after a short spike (below):
  - The relay watches the streamed tab's dialog opened and dialog closed events through the debugging protocol connection it already holds for popup detection (a per-target session; the same rule applies: no agent-browser commands on a timer).
  - On open it sends subscribers a `dialog` message: kind, the dialog's text (plain text only), and for prompts the default value. On close, or when the page navigates and the dialog goes away, it sends a matching `dialog_closed`.
  - The viewer shows a modal overlay above the canvas with accept and dismiss, plus a text field for a prompt. Control sessions can answer. View-only sessions see "a dialog is open" and cannot answer.
  - Answering sends the accept or dismiss command (with the prompt text) through the debugging protocol. The relay accepts one answer per dialog, ignores late answers, and reports "already closed" without error.
  - The dialog text comes from the page and is untrusted: shown as plain text, never interpreted, never passed to the agent as an instruction, never logged with the input.
- **Spike result (ticket 11, tested with agent-browser 0.38.2 and Chrome 154):** agent-browser auto-accepts `alert` and `beforeunload` within milliseconds, even with no command pending; `confirm` and `prompt` stay open and block the page. A second debugging client sees dialog events only if it is attached with the page enabled BEFORE the dialog opens (a late client cannot answer; `Page.enable` blocks until the dialog closes). The stream has no dialog message and its frames freeze while a dialog is open. A relay answer and agent-browser's own handling do not conflict (the loser gets a harmless "no dialog is showing"). An unanswered dialog is never auto-dismissed, and it wedges the session's `screenshot`/`get url` for ~150 s. Therefore: the viewer shows and answers `confirm` and `prompt` only; `alert` and `beforeunload` are read-only; the relay keeps a page-enabled session on every target from creation (browser-level auto-attach); the Host time-out is 60 s by default; the stage environment is not changed to disable agent-browser's auto-handling. The text below remains the original requirement and open pre-work for context.
- Required pre-work (answered by the spike above): a spike must establish what agent-browser does when a dialog opens in a session it owns (it may auto-handle, queue, or report it) and whether the relay answering it conflicts with that. If agent-browser already handles dialogs by default, the viewer's role may be only to show them; the decision must be revisited with that evidence. The slice for this (slice 2b) is blocked on the spike.
- Time-out: a dialog that no one answers within a Host-configured limit is dismissed by the Host and the gate shows a failure notice. A hung dialog must not hold a run open forever.
- When no viewer is attached (an agent is driving), Host behavior for dialogs is whatever agent-browser does today; the relay does not take over unattended dialogs.

#### Permission requests

- The Host denies browser permission requests by default for browsers it launches or attaches to (camera, microphone, location, notifications, clipboard read, and similar). A login page cannot turn on hardware of a server. The exact mechanism (a launch option or a protocol-level permission override) is an implementation choice that must keep the persisted launch environment byte-identical.
- If a login flow needs a permission to proceed, it cannot be granted in this spec; the operator is told through the gate's "if something does not appear" help text (below).
- This default applies to every browser stage, not only login stages, and must be documented as a behavior change before it ships.

#### Native prompts that cannot be shown (HTTP auth, file chooser, credential bubbles)

- HTTP authentication, file choosers, and "save password" style browser UI are out of scope for the live view in this spec. The operator is not given a way to answer them.
- The Host should avoid triggering the credential bubbles in the first place by launching the browser with the options that disable the browser's own password manager and credential service, if that works for the shipped Chromium builds. This is an implementation task with a small verification, not a spec guarantee.
- Because the operator cannot see these prompts, the gate shows static help text (below). The Host does not try to detect them in this spec.

#### Passkeys and hardware security keys (WebAuthn)

- These cannot work through the live view. The authenticator lives on the operator's own device, while the browser runs on the Host or in a container, and the prompt is native browser UI that is not drawn.
- Decision: not supported. Documented as a limit: when a site offers a passkey or security-key prompt, the operator cancels it or picks another method (an authenticator-app code, an SMS code, a backup code, a push approval to a phone). Account setup guidance should recommend keeping one such method available for the account used by pipelines.
- A virtual authenticator in the remote browser is technically possible but would store a credential on the Host. That is a security decision this spec does not make; it is listed as an open question.
- The gate help text names passkeys explicitly because the failure looks like a frozen page.

#### Operator help text

- The live view in the gate carries a short collapsible help line: "If the page seems frozen or asks for something you cannot see here (a passkey or security key, a permission request, a file picker, a browser sign-in box), cancel it or choose another sign-in method such as a code, SMS, or backup code."
- This text is static. Detecting a hidden prompt automatically is not in scope.

### D16. Provider-neutral design: interfaces, capabilities, adapters

The first implementation runs browsers on a self-hosted Linux box (Xvfb) and in per-run containers. The design must make it routine to replace that with a cloud browser-sandbox provider, a cluster job runner, or any other source of browsers later, without touching the runtime, the gate, the console API, the viewer, or any pipeline.

#### Vocabulary

- **Browser sandbox**: the unit of isolation that provides a browser, a display, a place for the profile, and an address to attach to. It can be a local process, a container, a pod, or a provider's session. It is the same idea in every adapter.
- **Adapter**: the one module that knows how to produce sandboxes from a given source. An adapter is the only place where a provider's name, SDK, endpoints, quirks, and credentials appear.
- **Capability record**: what an adapter can and cannot do. The core reads this record and never asks "which provider is this".

#### The interfaces (ports)

| Port | Responsibility | Defined in this spec |
|---|---|---|
| Browser host | Start or reuse the shared browser for a run and profile, return the attach address, build stage environments, report capabilities. | D2, D11 |
| Browser sandbox orchestrator | Create, stop, list by label, and inspect sandboxes; release them reliably. The browser host sits on top of it for container-like sources; a provider adapter implements it against the provider's session API. | D11 |
| Live view relay | Turn a stage's browser into frames out and input in for the console. | D3 |
| Live view source (optional alternative to the relay) | Give the console a viewer that the provider already hosts (an embeddable address) instead of Stageflow's own relay. | below |
| Profile store | Open a profile for an owner scope and name and return a handle that is a folder, a volume reference, or a provider's persistent context id. | D11 |
| Audit sink and run liveness | Unchanged. | existing |

Rules for ports:
- Ports are small, named by the job they do, and expressed in Stageflow's own types. Provider types never cross a port.
- Every port has an in-tree fake and a conformance suite (see Testing Decisions). A new adapter is accepted when it passes the suite.
- Core modules (scheduler, run manager, gate stamping, console routes, the viewer, teardown and sweep) depend on ports and on the capability record only. A search of core modules for a provider's name must find nothing.
- Which adapter is used is a Host configuration choice, never YAML, and the choice is read once at startup (later per owner scope, as an input).

#### Capability record (extends the two-field record in D2)

The record is extensible and versioned in meaning. It states, per adapter:

- `display`: `local_window`, `virtual_display`, or `headless_only` (D2).
- `live_view`: `none`, `relay` (Stageflow's relay over agent-browser's stream; the default), or `provider_view` (the provider hosts the viewer).
- `viewer_input`: `interactive` or `view_only`. A login stage requires `interactive`.
- `attach`: how stage sessions reach the browser (`cdp` address, or `host_launched` for the local desktop and Xvfb cases where agent-browser launches the browser itself).
- `profile_persistence`: `host_volume`, `provider_managed`, or `none`. A stage that names a `profile` requires something other than `none`.
- `graceful_close_required`: whether teardown must close the browser through the debugging protocol before releasing the sandbox (true for self-hosted and container sources; the provider adapter says whether its session release already flushes).
- `hard_allowlist`: whether the adapter can enforce `allow_domains` below the browser (egress control). If false, `allow_domains` stays a soft prompt for profile stages, as today.
- `dialogs`: `relay_handled`, `provider_handled`, or `unsupported` (D15).
- `popups`: `relay_retarget`, `provider_handled`, or `unsupported` (D4).
- `permission_policy`: whether the adapter can deny browser permission requests by default (D15).

Rules for capabilities:
- Preconditions are decided from the record at stage start (a human login stage needs `viewer_input: interactive` and a usable `live_view`; a stage with a `profile` needs persistence; a stage with `allow_domains` and a profile gets the soft behavior unless `hard_allowlist`). A mismatch fails the stage before the agent starts, with a message that names the missing capability and the adapter in plain words.
- New capabilities are added as fields with a safe default (`unsupported`), so older adapters keep working.

#### Provider-hosted live view (the `provider_view` case)

- When an adapter reports `live_view: provider_view`, Stageflow's relay is not used. The gate handoff is still the stable path (D5). The Host's live view route, when called with a valid ticket, asks the adapter for a **short-lived, per-session viewer address** and returns it to the console, which embeds it. The address is never stored in a gate, a run file, a log, or an audit record, because providers often put access tokens in it.
- The console decides whether it may embed the address (frame source rules of the console's own content security policy must allow the provider's viewer origin; the adapter declares the origin). If it cannot, the gate shows a button that opens the viewer address in a new browser tab.
- Read-only versus interactive is controlled by what the provider supports; the capability record says which, and the Host never promises more than it states. Ticket modes (D6) still gate who may ask for the address.
- Popup and dialog handling then depend on the provider's viewer (`popups` and `dialogs` capabilities).

#### Attach address, lifetime, and the byte-identical rule

- Every adapter hands the Host an **attach address** that stage sessions use through the same stage environment as today (attach address plus pin-tab). The byte-identical rule (invariant 1) is unchanged and applies to every adapter.
- A provider's address may expire or change (a session timeout, a reconnect). The Host already has the "shared browser restarted" path (address changed, old stage session closed, new address persisted). An adapter that returns a new address for the same sandbox uses that path. An adapter that loses the sandbox itself reports it as dead so that the Host restarts it, as for a crashed container.
- Persisted state (anchor files, stage environment files, owner files) holds the attach address and an **opaque sandbox reference** plus the adapter's identifier. Adapter-specific data goes in a single opaque, versioned field that only that adapter reads. No provider-specific fields appear at the top level of any persisted record, so removing or replacing an adapter never forces a migration of core state.

#### Teardown, sweep, and cost control

- Releasing a sandbox is part of the port contract and is **idempotent**. Teardown (stage end, run end, cancel, abandon, failure) releases the sandbox through the adapter in the order defined in D11: stage tabs and sessions, graceful close if the adapter requires it, then release.
- The Host-start sweep asks each configured adapter to list sandboxes by label (owner scope, run) and releases those whose run is dead. Provider sessions cost money, so a sandbox that is not tied to a live run is always reaped.
- Adapters label every sandbox they create with owner scope, run id, stage id, and profile name where the provider supports labels, and keep their own mapping where it does not.

#### Errors

- Adapters map provider failures to a small, fixed set of error classes: unavailable, out of quota or capacity, not authorized, not supported, and failed. The core shows each class with a distinct, plain message and decides whether a stage may be retried. Provider error text never reaches an envelope or a log unfiltered.

#### Secrets and configuration

- Provider credentials (API keys, tokens) are read only from Host configuration or the Host's existing secret mechanism, are never in YAML, never in run files or envelopes, and are redacted in logs. They are not placed in the stage environment: agent-browser, running as the stage's tool, must not receive them.
- Adapter-specific settings (region, image, resource limits, network policy, viewer origin) are adapter configuration in the Host config, validated at startup, with a clear error if a selected adapter is misconfigured.

#### Adapters planned and what each means

| Adapter | Sandbox unit | Attach | Live view | Profile | Graceful close | Hard allowlist |
|---|---|---|---|---|---|---|
| Local desktop (today) | local Chrome process launched by agent-browser | host launched | `local_window` handoff, or `relay` when the operator is remote | folder on the Host | agent-browser close | no (soft) |
| Self-hosted Linux with virtual display | local Chromium in Xvfb launched by agent-browser | host launched | `relay` | folder on the Host | agent-browser close | no (soft) |
| Container per run | container labelled by run | CDP address by IP | `relay` (Host-side) | volume reference | debugging-protocol close, then remove | possible with network design (D11) |
| Cluster job or pool | pod or pooled browser | CDP address | `relay` | volume or persistent claim | as for containers | possible with network policy |
| Managed cloud browser provider (future) | provider session | provider's CDP address | `provider_view` or `relay` if the CDP address is reachable | provider-managed context or none | provider's session release | provider-dependent |

Only the first three are built under this spec. The fourth and fifth are specified by the ports; the sixth is out of scope here but must be possible without changing a core module.

#### What stays Stageflow's job on every provider

- The gate, the Host-side login check, the confirm answer path, the tickets and routes, the audit records, the no-logging rules, the invariants about ordered input and image-size coordinates, the persisted byte-identical stage environment, the sweep, and the scope plumbing. A provider replaces where the browser lives and, optionally, how it is viewed; it does not replace these.

#### What must be verified before a provider adapter is trusted

- That it passes the conformance suites for every port it implements.
- That a human login stage works end to end through its viewer, including popups and dialogs as far as its capability record claims.
- That teardown releases the sandbox in the normal path, after a Host crash (sweep), and after a provider-side failure.
- That cookies and the profile persist as claimed across a sandbox restart.
- That nothing about the provider appears in core modules, persisted core records, YAML, envelopes, or logs.

## Testing Decisions

### What a good test looks like here

Test behavior visible across a seam: what a viewer receives, what a browser receives, what a gate carries, what a route returns, what a teardown leaves behind. Do not assert on private ordering of internal calls, polling intervals, or file layouts that are not part of a contract. Tests must not need a real network, real Chrome, or real containers (those are opt-in smokes). Tests must not require sleeping for real time; inject clocks and runners.

### Seams (to be confirmed with the owner)

1. **Existing seam, extended: the browser host contract suite.** Every browser host (local, fake remote, container) runs the same contract: capability reporting, stage env shape and byte-identical env, scoped session names, socket path limit, allowlist omission with profile or attach. The new container host and the capability record are added here. This is the highest existing seam for the host side.
2. **New seam: the live view relay contract suite.** One suite, run against the real agent-browser relay implementation using a fake stream server (a local WebSocket test server that speaks the stream protocol and records input) and a fake debugging-protocol target emitter, and against any future implementation. It covers: last-frame replay for late joiners, ordered input, input validation and rate limits, re-target on popup open and close, cache clearing on re-target, no agent-browser command on a timer, restart tolerance, close idempotence, and "input never logged".
3. **Highest seam for end-to-end behavior: the console API with a fake relay and fake browser host.** Drive tickets, redemption, view versus control, revocation on answer or abandon, gate handoff stamping, and the answer path through the HTTP server (as the existing server tests do) with the relay and host injected. This is where authentication, scoping, and the "agent cannot forge a handoff" rule are verified.

The viewer component is tested at the UI workspace's existing unit-test seam (pure logic: coordinate mapping from image size, key event construction, ordered queue, state transitions), not through a browser.

### Modules to be tested

- Browser host capabilities (local derivation by platform and display variables, Xvfb probe injected; fake remote; container host through a fake orchestrator).
- Human login precondition and messages (throws only for the right capability combinations; Docker hint text).
- Gate handoff parse and stamp (capability-driven stamping, root-relative path accepted, double-slash and non-http schemes rejected, agent-supplied handoff overwritten or stripped for stages without a browser).
- Live view relay (above).
- Ticket service and routes (scope, single use, expiry, mode, control only while the gate is pending, revocation, CSRF header, Origin and Host checks, input size and rate limits, SSE replay).
- Teardown ordering with the relay and with the container host (relay closed first; graceful close before removal; fallback stop; label sweep for dead runs).
- Redaction and logging guarantees (a regression test that input bodies and frame data never reach logs, run files, activity events, envelopes, exports, or the audit sink).
- Port conformance (D16): one suite per port (browser host, sandbox orchestrator, live view relay, live view source, profile store) run against every in-tree implementation and every fake; a new adapter is accepted only when it passes. Capability-driven preconditions (a human login stage needs interactive input and a usable live view; a profile stage needs persistence; unsupported combinations fail at stage start with a message naming the capability). Persisted records contain only the attach address, an opaque sandbox reference, and one opaque versioned adapter field. Sandbox release is idempotent and happens on every teardown path and in the sweep. Provider credentials never appear in stage environments, run files, envelopes, or logs. A structural check (a test that scans core modules) that no provider name or provider SDK import appears outside adapter modules.
- Viewer logic (see above).
- Login challenges (D15): relay contract cases for dialog opened, answered once, late answer reported as already closed, dialog closed by the page, view-only sessions cannot answer, dialog text treated as plain text and kept out of logs; the time-out dismissal; the default-deny permission policy and that it is applied through the persisted launch environment; the help text is present on `live_view` gates. A browser smoke fixture with pages that raise alert, confirm, prompt, and beforeunload dialogs and a window-open popup that posts back, run against a real Chrome (opt-in). Real-provider popup behavior is a manual check by an account owner, not an automated test.
- Env contract (Host launch options are persisted once and reused; never read from ambient env; never from YAML).

### Prior art in the codebase

- The browser host contract test and the fake remote host (same-suite pattern for multiple implementations).
- The injected browser runner pattern in the teardown, anchor, login check, and resume tests, with a per-test socket root and the socket-leak guard in global test setup.
- The gate handoff tests and the human login runtime test.
- The profile store and lock contract suites (one suite, in-memory and local implementations).
- The opt-in real Chrome smoke test (environment-variable gated) for the real-browser flow; a second opt-in smoke should run the popup login fixture (opener, popup, message back, popup close) against a real Chrome, and a third, separately gated, runs the container host against a real container runtime.
- Server route tests with injected run manager for the console API.

## Out of Scope

- Building an adapter for a managed provider (Kernel, Browserbase, Anchor, Hyperbrowser, Cloudflare Browser Run, Steel) as a built-in. D16 requires the ports and a conformance-passing stand-in adapter so that adding one later touches no core module. The browser host interface is the seam for them later; none is built here.
- Credential vaults, stored passwords, or managed authentication flows. The agent never types a password (unchanged).
- Real-site acceptance and anti-bot evasion beyond the optional launch options. The spikes never touched a real site. Whether LinkedIn or similar accept this setup is unknown and is an explicit open question, to be answered by the account owner with a manual run. This spec does not promise it.
- Video recording, screenshots on a schedule, or any retention of frames.
- Replacing the stream with WebRTC, a video codec, or a remote-desktop product. JPEG frames over server-sent events were adequate locally; a faster transport is a later optimization if measurements demand it.
- A Host-side filtering proxy for `allow_domains` (this spec only requires the container design to leave room for it).
- A production container orchestrator, volume encryption, quotas, backup, and capacity management (this spec defines the port and a development implementation).
- Parallel runs on one profile (still impossible by design).
- Passing an open page between stages.
- Mobile-native apps or iOS and Android browsers.
- Windows-specific work beyond not breaking what works today.
- Session-state import and `--restore` style flows (still deliberately unused).
- Audio and clipboard read-back from the remote browser to the operator.
- Changing the human login gate to anything other than a confirm.
- Answering HTTP authentication boxes, file choosers, and browser credential prompts through the live view.
- Passkeys, hardware security keys, and any virtual authenticator.
- Solving CAPTCHAs automatically.
- Granting browser permissions (camera, microphone, location, notifications) to a login page.
- Detecting hidden native prompts automatically.

## Further Notes

### F1. Evidence: what each spike showed

Environment: agent-browser 0.38.2, Chrome 154, macOS arm64 Host; containers were Linux ARM64 on Docker Desktop with Debian's Chromium 154 (Chrome for Testing has no Linux ARM64 build). Spike code and a longer findings file live in a `spikes/live-view` folder in the worktree where this spec was written (untracked at the time of writing; ask the owner whether to commit it).

| Spike | Question | Result |
|---|---|---|
| 1. Live view | Can a human log in through a page in the console to a Host-side browser and hand off to the agent? | Yes. Username, password, Tab, Enter, 2FA code all typed through a canvas. After "Done" the Host verified the page address, turned the stream off, and the agent read the logged-in page in the same session with cookies intact. Local latency: first frame ~30 ms, keystroke to next frame ~15 ms. A login made headless survived a full browser restart through the profile. |
| 2. Popup re-targeting | Do popup logins (OAuth style) work? | Yes after re-targeting. The fixture's opener opened a popup, the viewer switched to it in ~144 ms, the Authorize click closed it, the viewer switched back in ~72 ms, and the opener received the message the popup posted. |
| 3. Headed under Xvfb | Does a headed browser with no screen work, and what do pages see? | Yes. agent-browser starts its own Xvfb. UA is `Chrome/154 (X11; Linux x86_64)`. About 280 MB for the whole container. Login, popup, and handoff all worked. |
| 4. Container per run | Where does the relay run, and what does the container need? | The relay stays on the Host. The container needs only Chromium, a display, a forwarder, and the profile volume. Verified: attach over CDP, login, popup, handoff, persistence through a volume (with graceful close), hardened run flags. |

### F2. Bot-detection signal comparison (spike 3, in the container)

| Signal | Headless | Headed (Xvfb) | Headed + hide-automation + software GL flags |
|---|---|---|---|
| User agent | `HeadlessChrome/154` | `Chrome/154` | `Chrome/154` |
| `navigator.webdriver` | true | **true** | **false** |
| WebGL | software renderer present | **none** | software renderer present |
| Screen size | 800x600 | 1280x720 | 1280x720 |

`navigator.webdriver` is true in both modes by default because the browser is driven over the debugging protocol. The flags used were: hide the automation blink feature, use the ANGLE GL backend with the software (SwiftShader) implementation, and allow unsafe software GL. A software GPU renderer name is itself a known tell. A residential IP and a believable fingerprint probably matter more on hardened sites. **None of this was tested against a real site.**

### F3. Stream and input protocol cheat sheet (agent-browser 0.38.2)

- The stream is on by default for every session; a WebSocket server on a loopback port assigned by the OS. `stream enable` reports "already enabled". `stream status --json` returns the port. `stream disable` then `stream enable --port N` rebinds to the session's active tab on the same port. The session's socket directory also holds a `<session>.stream` file with the port.
- Browser WebSocket clients must come from a localhost origin; others get 403. A Node client with no Origin header works.
- Messages from the server (JSON text): `frame` (base64 JPEG, sequence number, metadata with width, height, scale, scroll offsets, capture time), `status` (connected, screencasting, viewport size, engine), `tabs` (tab list), `url` (main-frame address changes), `console`, and command-echo messages (observed `command` and `launch` messages appear when other CLI commands run).
- Messages to the server: `input_mouse` (event types press, release, moved, wheel; x, y, button, click count; wheel delta fields are unverified), `input_keyboard` (event types key down, key up, char; key, code, text, virtual key code, modifiers), `input_touch` (unverified), `config` (per-client max frame rate, ack pacing), `ack`.
- Frames are sent only when the page repaints. An idle focused text field blinks its caret and so yields about two frames a second; a page with no focus yields none.
- Keyboard rules verified: a printable key needs key and text; Backspace needs the virtual key code (8); Enter needs the virtual key code (13) and a carriage return as text; character events type text without key events; Tab moved focus.
- The frame image size and the reported device height can differ; the image size is the one input coordinates match.
- Daemon rule re-learned: any agent-browser command with a different launch environment from the running daemon silently relaunches Chrome and loses the page.

### F4. Alternatives considered (from vendor documentation; not tested unless noted)

| Option | What it offers | Why not chosen as the base |
|---|---|---|
| agent-browser stream (chosen) | Already in the stack, already running, input included, no new dependency (tested) | Needs a relay for auth, popups, and last-frame replay (all built in the spikes). |
| Kernel cloud (docs) | Live view iframe (read-only parameter), profiles, managed authentication with a hosted login UI | Cloud service; adopt later behind the browser host interface if wanted. Pricing in a third-party summary was not verified. |
| Kernel `kernel-images` (docs) | Apache-2.0 container with headed Chromium, CDP, noVNC and WebRTC live view | Overlaps with what the spikes built from agent-browser; a candidate base image later. |
| Browserbase (docs) | Live view iframe, read-only and interactive, persistent contexts | Cloud only. |
| Cloudflare Browser Run (docs) | A structured handoff command and event pair, expiring live view addresses | Cloud only; the handoff-and-complete model is a useful reference for the gate. |
| Steel Browser (docs) | Open-source browser API with CDP and a debug viewer; public beta | Viewer interactivity unclear from docs. |
| Anchor, Hyperbrowser (docs) | Cloud live view; Anchor has single-use viewer addresses | Cloud only. |
| Neko (docs) | WebRTC virtual browser with many users | CDP exposure not documented; heavier. |
| Plain noVNC on Xvfb | Classic remote desktop | More parts, no input model for the agent, no popup awareness. |

### F5. Gotchas, collected (each cost a debug cycle)

1. Click coordinates must use the decoded image size, not the metadata height.
2. Backspace and other non-printable keys need a virtual key code.
3. Enter needs a carriage return as text.
4. The browser pane's synthetic typing and mobile and input-method input arrive as text-input events, not key events; a hidden text area is needed to receive them.
5. Input must be ordered; one request per event reordered characters.
6. A static page emits no frames; replay the last frame.
7. Polling the tab list starves the stream.
8. Switching tabs does not move the stream; restarting it does.
9. A different launch environment relaunches the browser (invariant 1).
10. A killed container leaves a profile lock that blocks the next container; clear it at start under the lease.
11. A kill or SIGTERM loses the newest cookies; use the protocol's browser close first.
12. Chrome's debugging port refuses non-IP Host headers; reach it by IP.
13. Chrome's debugging port listens on the container loopback only; forward it.
14. A published port accepts connections before Chrome is listening; poll the version endpoint.
15. `agent-browser install` fails on Linux ARM64; use a distribution Chromium and an explicit executable path.
16. Chromium needs the no-sandbox flag as non-root in a default container.
17. A typo in a debug shell command can create stray directories in the temp area; use a script file and a recorded environment file when poking at a live daemon.

### F6. Questions and answers

**Why not just open the remote browser's own window or a remote-desktop product?** The agent must keep driving the same browser. agent-browser's stream already exposes frames and input for the exact session and tab the agent uses, and the CDP target events give popup awareness. A remote desktop would add a second control path with no knowledge of tabs or the gate.

**Why does the relay run in the Host and not in the container?** Spike 4 showed a Host-side stage session attached over CDP serves the stream on the Host's loopback. That keeps auth, tickets, audit, and the viewer in one place, keeps secrets out of the browser container, and keeps the container tiny. If a future host cannot be attached over CDP (for example a provider that gives only a viewer address), it can implement the same port by embedding or proxying the provider's viewer.

**Why server-sent events plus posts, not a WebSocket?** The repository has no WebSocket server dependency, and SSE plus ordered POSTs went through every test (local, headed, container). One in-flight request with batching keeps order. A WebSocket upgrade is a later optimization if measured latency over a real network is a problem.

**Why a ticket and cookie instead of a bearer header?** `EventSource` cannot set headers. The ticket (60 seconds, single use, bound to run, stage, mode, scope) is exchanged for a path-scoped HttpOnly SameSite cookie, so the long-lived credential never appears in a URL that outlives its use.

**Why is the stamped handoff a path and not a URL with a token?** Gates are saved in the run store and shown again after restarts; a token in a saved gate would be stale or leaked. The path identifies the live view; access is separate.

**Can the agent open or expose a live view?** No. The handoff, the capability, and the routes are Host-owned; any handoff an agent supplies is overwritten or stripped.

**What if the operator's connection drops mid-login?** The browser and the gate stay up. The viewer reconnects with a new ticket and the relay replays the last frame; or the operator opens the gate from another device.

**What if the Host restarts during a login gate?** The gate persists, browsers on the local host stay up until the next Host start's sweep rules decide (existing behavior), and the relay is rebuilt from the persisted env and anchor when someone reopens the view. For the container host, containers are labelled and a new Host reattaches by label (to be proven in slice 5; the spike did not restart a Host).

**Do typed credentials ever touch disk?** Not in Stageflow files. They reach the page's cookies in the browser profile (the point of logging in). Input bodies and frames are never logged or stored.

**Can two operators control the same login at once?** Not by default. Many can view; one controls. Whether to allow a handoff between controllers is open.

**What about two-factor prompts and popups at login?** See D15. A popup window or new tab is followed by the live view (spiked with a fixture). A code box or modal in the page is just part of the picture. Codes from an authenticator app, SMS, e-mail, or a push approval on a phone work because the operator handles them on their own device and types any code into the live view. JavaScript dialogs, permission requests, and native browser prompts are not drawn in the frames, so they need either a viewer overlay (dialogs, pending a spike) or a documented limit. Passkeys and hardware security keys cannot work through a remote browser.

**Will a popup that the operator cannot see freeze the run?** For a window popup, no: the live view follows it. For a JavaScript dialog, the page blocks until it is answered, so D15 adds an overlay and a time-out. For native prompts the operator cannot see (a passkey prompt, a permission request), the page can look frozen; the gate carries help text and the Host denies permission requests by default.

**Can we swap the self-hosted Linux box for a cloud browser-sandbox provider later?** Yes by design (D16). Core code depends only on ports and a capability record; a provider is one adapter that supplies sandboxes (attach address, profile, release) and optionally its own viewer. The gate, the tickets, the Host-side login check, the confirm answer path, and the persisted byte-identical stage environment stay Stageflow's. What must be checked before trusting an adapter is listed in D16. The spikes do not prove any provider works, only that the interfaces are the right shape.

**What would not be portable?** Anything that reads a provider's name instead of a capability, provider fields in persisted core records, provider credentials in the stage environment, and viewer addresses stored in gates. D16 forbids all of them and a structural test enforces the first.

**Does a provider's own live view replace the relay?** It can (`provider_view`). The console gets a short-lived viewer address from the Host's live view route and embeds it. Popups and dialogs then depend on that viewer's capabilities, which the capability record states.

**Does headed-in-Xvfb avoid bot detection?** It removes the `HeadlessChrome` user agent and the headless viewport differences. `navigator.webdriver` stays true unless the Host launch option that hides it is enabled. Real-site behavior is untested.

**Why not make stealth flags the default?** They change every browser stage's fingerprint and could break sites that expect normal automation signals. They are a Host opt-in.

**What does the Host need installed for `virtual_display`?** Chromium or Chrome and the Xvfb binary. agent-browser starts and stops Xvfb itself; do not wrap the Host in a virtual-display launcher.

**How much does a container browser cost?** About 230 MB idle and ~1.1 s from creation to a usable debugging endpoint on the test machine. Capacity under real page load was not measured.

**What happens to `allow_domains`?** Unchanged here: soft for stages with a profile. The container host's network design is the route to a hard guarantee (an internal network plus a filtering proxy); the orchestrator port must leave a place for it.

**Does this change `sf browser login` (the CLI helper)?** No. It stays a local headed-window tool. Whether it should support a container profile is a separate decision.

**Where do I look to see how a thing was proven?** The findings file in the spike folder lists each experiment, its commands, and its numbers.

### F8. Known limitation / workaround: dead stage tab after a login submit

Headless=new Chrome 154: after a login form is submitted by real input and the next page loads, the pinned stage tab can stop accepting any input from every client (viewer, agent-browser CLI, raw CDP). Reload, navigate, `bringToFront` and `activateTarget` do not revive it. A fresh tab in the same Chrome works. Root cause unknown; the state cannot be detected. Workaround: the viewer's "Reopen browser tab" (`reopenTab`, see `docs/browser-internals.md`, limitation 18).

### F7. Open questions

1. **Real-site acceptance.** Needs a manual run by the account owner against real services. It decides whether stealth options, a residential proxy, or a managed provider behind the browser host interface is the hosted default.
2. **Who creates containers in production.** The orchestrator port is specified; the production adapter (a separate service, a job runner, or a pool) is a platform decision.
3. **Multiple controllers.** Single controller with an explicit takeover, or last writer wins?
4. **Transport over real networks.** Measure frames over a wide-area link before deciding on ack pacing, lower quality, a WebSocket upgrade, or a video codec.
5. **Stealth flags as defaults.** Recommended no; confirm.
6. **Reattaching to containers after a Host restart.** Specified by label; not spiked.
7. **Hosted profile storage.** Encryption, quotas, backup, and cross-Host leases.
8. **Idle time-out for control.** How long may a login gate hold a live control session before the browser is released?
9. **Unverified protocol details to verify during slice 2 and 3:** modifier bit mask, wheel delta field names, right click, touch, paste of long text, and several simultaneous popups.
10. ~~**Dialog handling in agent-browser.**~~ Answered by the dialog spike (see D15 spike result). Remaining: recovering a dialog that is already open when the relay starts (not possible through the debugging protocol).
11. **Popup behavior with real providers.** Cross-origin isolation, popup blockers, and the message back to the opener were verified only against a fixture.
12. **Virtual authenticator.** Whether to support passkeys by keeping a virtual authenticator in the remote browser, accepting that the credential lives on the Host.
13. **Permission policy.** Whether default-deny breaks any real login flow, and whether it should be a Host setting.
14. **Dialog time-out.** The default limit and where it is configured.
15. **Provider viewer embedding.** Whether the console can embed provider viewers under its content security policy, or must open them in a new tab; which providers allow interactive and read-only addresses separately.
16. **Capability record versioning.** How a new capability field is introduced across adapters (default `unsupported`) and how an adapter declares which version of the record it targets.
17. **Per-owner adapter selection.** Where the mapping from owner scope to adapter lives and who may change it.
18. **Provider cost and quota signals.** Whether sandbox creation should check quota before starting a stage, and how an out-of-quota error is shown to an operator.
