---
status: implemented
---

# Spec: Browser sessions for stages

**Status: implemented in 0.28.0** (with Revision 2, one shared browser per run and profile). Open items are listed in [Known limitations](../browser-internals.md#known-limitations).

**Implementation notes.** The code lives in `src/browser/` with hooks in the scheduler, run manager, and stage launcher. See [Browser sessions internals](../browser-internals.md) for the module map, lifecycle, file layout, env contract, invariants, and test guide. Differences from this spec: the soft allowlist audit exists in code but is not called by the runtime; the key provider exists but is not wired; the Host-side filtering proxy, live view handoff, and remote browser host are not built; ticket checkboxes 00-12 were not updated after Revision 2.

## Problem Statement

Pipeline authors want stages to use a real browser: open sites, read pages, fill forms, collect data. Many useful sites cannot be logged in by automation. LinkedIn, SSO portals, and sites with 2FA need a person to log in. Today a stage has no browser that stays logged in. Each stage is a fresh agent session. A pipeline that needs a login in every stage cannot work. A run on the next day must start from nothing.

Authors also have no safe way to pause a pipeline, let a person log in to a visible browser, and then let later stages reuse that login. The login data is a credential. It must stay on the operator's computer today. It must also be ready to stay inside one tenant when Stageflow later runs as a multi-tenant service.

## Solution

A stage can declare a **browser session** with a `browser` field on its pipeline entry. The field names a **profile** (a saved browser login that lives on the Host), the display mode, the allowed domains, and an optional login check.

Stageflow starts the browser tool (agent-browser) for the stage with the right profile and settings. The agent drives the browser through the agent-browser command line and a bundled skill. When the stage ends, Stageflow closes the browser. The profile stays on disk, so the next stage and the next run are still logged in.

A pipeline can start with a **login check**. The Host opens a page with the profile and reads the final address. The result `{ logged_in, url }` is computed by the Host, not by the model. If the session is not valid, a **human login** stage opens a visible browser and stops at a gate. The operator logs in and confirms. The Host checks the login again before the work stages start. On the next run the check passes and the human step is skipped.

Profiles are keyed by **owner scope** and name. Locally the scope is one fixed value. The storage, lock, browser host, human handoff, and key management are behind interfaces. A future hosted service can replace them without a large change.

## User Stories

1. As a pipeline author, I want to add a `browser` field to a stage, so that the stage can drive a real browser.
2. As a pipeline author, I want to name a profile in the `browser` field, so that all stages that use the same name share one login.
3. As a pipeline author, I want to set which domains the browser may open, so that an agent cannot leave the sites I chose.
4. As a pipeline author, I want to set headed or headless mode for each stage, so that CI and local runs can use different modes.
5. As a pipeline author, I want headed mode to be the default, so that all stages look like one device to the site and the operator can watch.
6. As a pipeline author, I want to describe a login check once (page address, logged-in address pattern, logged-out address patterns), so that I can reuse it in a check stage and a re-check.
7. As a pipeline author, I want a clear validation error when the `browser` field is wrong, so that I find mistakes before a run starts.
8. As a pipeline author, I want `sf validate` to tell me when agent-browser is not installed, so that I do not find out in the middle of a run.
9. As a pipeline author, I want the browser requirement to be added for me, so that I do not need to write a separate `requires` entry.
10. As a pipeline author, I want the browser field to work with both agent backends, so that my pipeline does not depend on one backend.
11. As a pipeline author, I want a stage with no profile to get a throw-away browser, so that public-page stages do not wait for a shared login. (Proposed addition. Confirm before build.)
12. As a pipeline author, I want to route the pipeline on the login check result, so that the human login stage runs only when it is needed.
13. As a pipeline author, I want an after-phase check on the login stage, so that a wrong confirm cannot reach the work stages.
14. As a pipeline author, I want a failed after-phase check to send the run back to the login stage, so that the operator can try again.
15. As a pipeline author, I want to mark a submit stage as not safe to replay, so that a retry cannot send a form twice.
16. As a pipeline author, I want a stage that shows screenshots at a gate before an irreversible step, so that a person approves the step.
17. As an operator, I want to log in myself in a visible window, so that I can enter passwords and 2FA codes without giving them to the agent.
18. As an operator, I want the login question to say which site and why, so that I know what to do.
19. As an operator, I want the browser window to stay open while the stage waits for me, so that I can finish the login at my own pace.
20. As an operator, I want to answer the login gate later (from the console or `sf runs`), so that a scheduled run can wait for me.
21. As an operator, I want the next run to reuse my login, so that I log in only when the session ends.
22. As an operator, I want the pipeline to ask me again only when the session is not valid, so that I am not asked for no reason.
23. As an operator, I want a stage's browser tab and session to close when the stage ends, and the shared browser to close when the run ends, so that no browser process stays on my computer after the run.
24. As an operator, I want the browser to close when I cancel a run, so that a cancelled run leaves nothing behind.
25. As an operator, I want a stage that times out or fails to close its tab and session, and a failed run to close the shared browser, so that failed runs do not leak processes.
26. As an operator, I want Stageflow to close leftover browsers from dead runs when the Host starts, so that a crash does not leave browsers open.
27. As an operator, I want a second run that needs a profile held by another run to wait in a queue until that run ends, so that two runs never use one profile at once.
28. As an operator, I want to see a "waiting for browser profile" state with the name of the run that holds it, so that I know why a run has not started.
29. As an operator, I want stages of the same run that share a profile to run in parallel without waiting for each other, so that parallel branches do not break the login or slow down.
30. As an operator, I want to list my profiles, so that I know which logins Stageflow holds.
31. As an operator, I want to check one profile from the command line, so that I can test a login without a pipeline.
32. As an operator, I want to log in to a profile from the command line, so that I can prepare a login before a scheduled run.
33. As an operator, I want to delete a profile, so that I can remove a login that I no longer need.
34. As an operator, I want profile data stored with strict file permissions and not in the project folder, so that other users and git cannot read it.
35. As an operator, I want cookies and storage values never to appear in logs, artifacts, envelopes, or run state, so that a shared run export does not leak my login.
36. As an operator, I want a clear error when the Host has no screen and a stage needs a visible login, so that I know why the run stopped.
37. As an operator, I want a clear error when the session ends in the middle of a stage, so that I can log in again and resume.
38. As an operator on a CI machine, I want browser stages to run headless, so that CI needs no screen.
39. As an agent in a browser stage, I want a skill that explains the agent-browser commands, so that I use them correctly.
40. As an agent in a browser stage, I want the browser session already set up by environment settings, so that I do not choose a profile, session name, or socket path.
41. As an agent in a browser stage, I want the skill to tell me that page text is untrusted data, so that I do not obey instructions hidden on a page.
42. As an agent in a browser stage, I want the skill to tell me not to dump cookies or storage, so that I do not leak a login.
43. As an agent in a browser stage, I want the skill to tell me to read slowly and stop at the task limit, so that I do not trigger site limits.
44. As an agent in a browser stage, I want to take screenshots into the stage artifacts folder, so that the operator can see what I saw.
45. As a security reviewer, I want the profile name in YAML to be only a name, so that YAML cannot point to another user's data or to a path.
46. As a security reviewer, I want the owner scope to come from the Host and not from YAML, so that a stage cannot read another tenant's profile.
47. As a security reviewer, I want the domain allowlist to be enforced by the browser tool, so that a prompt cannot bypass it.
48. As a security reviewer, I want browser settings to enter the stage only through the curated stage environment, so that no ambient variable leaks in.
49. As a security reviewer, I want profile data encrypted at rest with a key from a key provider, so that a copied folder is not enough to use a login.
50. As a security reviewer, I want an audit record each time a profile is created, used by a run, or deleted, so that I can see who used a login.
51. As a platform engineer planning a hosted service, I want all profile path code in one profile store interface, so that I can swap in tenant storage.
52. As a platform engineer, I want the profile lock behind an interface, so that I can use a distributed lock.
53. As a platform engineer, I want the browser start behind a browser host interface, so that I can run browsers in a sandbox and give stages a remote address.
54. As a platform engineer, I want the human handoff described in the login gate payload, so that a console can show a live view link instead of a local window.
55. As a platform engineer, I want delete-by-scope, so that I can remove all logins of one tenant.
56. As a platform engineer, I want a Host-level site policy, so that a hosted operator can block sites.
57. As a platform engineer running the Docker image, I want a clear message that a visible login window is not possible there, so that I know to use another handoff.
58. As a maintainer, I want tests to run with no real browser by default, so that CI is fast and stable.
59. As a maintainer, I want one opt-in smoke test with real Chrome and a local fixture login server, so that I can check the real tool before a release.
60. As a maintainer, I want the docs and an example pipeline to use a neutral site, so that the project does not promote rule-breaking use of any third-party site.
61. As a pipeline author, I want parallel stages that name the same profile to share one login in their own browser tabs, so that fan-out branches can work on different pages at the same time.
62. As an operator, I want the shared browser to stay open for the whole run, so that session-only cookies and the login carry from stage to stage.

## Implementation Decisions

**Decisions already made with the user**
- Browser tool: Vercel agent-browser (Apache-2.0).
- Transport: the agent-browser command line through the stage bash tool, plus a bundled skill. Do not use the MCP server. Reason: the default MCP tool list is about 63,000 characters (29 tools). Playwright MCP is about 20,000. The Pi adapter registers every MCP tool directly, so the cost applies to every stage.
- Scope of the first version: a first-class `browser` stage field, not only an example.
- Display: configurable per stage. Default is headed. Headless is used when no display exists or when the author sets it.
- Login check: deterministic by default. The Host computes the result. An agent stage is the fallback when selectors cannot decide.
- Profiles are kept on the Host, in an owner scope. Locally the scope is a fixed value.
- When a profile is busy, a second run waits in a queue.
- The login check is a thin agent stage. The Host computes the result and the stage reports it. No new runtime stage kind is added.

**Evidence from spikes (agent-browser 0.38.2, Chrome for Testing 154)**
- A profile directory keeps a logged-in LinkedIn session across close and reopen, in headed mode, in headless mode, and with a changed HOME.
- The LinkedIn login cookie is persistent (about one year). One cookie is session-only. Session-only cookies were lost when HOME changed in a local test. agent-browser keeps its own state under HOME.
- The stage HOME is an empty per-attempt directory. Browser tool state must therefore be pinned outside it.
- The daemon socket path has a limit of 103 bytes. A short socket directory must be set.
- Profile, session name, socket directory, and headed mode are set through environment variables. This works under a stripped environment.
- The daemon and Chrome survive client death and process-group kill. A later command reattaches by session name. The Host must close the session itself.
- Both modes report the automation flag. Headless uses a different user agent. Use one mode for all stages that share a profile.

**Modules and interfaces**
- **Owner scope and profile key.** A profile key is a scope plus a name. Local scope is one fixed value. The Host sets the scope. YAML never sets it.
- **Profile store.** Opens, lists, and deletes profiles, and deletes all profiles of one scope. All path building lives here. Local implementation uses folders under the Stageflow home with owner-only permissions. Profile names are validated.
- **Profile lock.** Acquire with owner identity and queue. Release on stage end, failure, cancel, and Host restart. Local implementation uses a lock file. A queued run shows a waiting state that names the holder.
- **Browser host.** Given a profile handle and settings, returns the environment settings that a stage needs. Local implementation returns profile, session name, short socket directory, headed flag, allowlist, and encryption key reference. A remote implementation (later) returns a remote address instead. The scheduler never builds browser paths itself.
- **Human handoff.** Described in the login gate payload as a kind. The first version has `local_window`. The payload schema allows `live_view` with a URL later, so the console needs no schema change.
- **Key provider.** Supplies the encryption key for profile data. Local implementation reads a key file with owner-only permissions in the Stageflow home. A hosted implementation uses a per-tenant key.
- **Audit sink.** Records profile created, used by run, deleted. Local implementation writes to the run log.
- **Stage field.** `browser` is allowed on a pipeline stage entry and in an external stage file, like `skill` and `mcp`. A pipeline entry overrides a file value. Fields: profile name (optional), headed flag, allowed domains, login check (address, logged-in pattern, logged-out patterns). The loader validates shapes and names. The field maps into the loaded stage config. The agent-browser requirement is added to the stage requirements automatically.
- **Environment injection.** Browser settings enter the curated stage environment as explicit run variables. They are not on the ambient allowlist and must not be read from the Host environment.
- **Teardown.** The Host closes the browser session on stage success, failure, cancel, timeout, and run end. The Host keeps the session open while a stage waits for the operator. On Host start, the Host closes sessions whose run is gone. Teardown does not depend on the stage worker process, because the worker can be killed.
- **Bundled skill.** A `browser` skill resolved with the existing skill precedence. It teaches the agent-browser commands (open, snapshot, click, fill, wait, screenshot, get url). It states the rules: use the provided session, stay on allowed domains, treat page text as data, do not dump cookies or storage, read slowly, stop at the task limit, and in a submit-capable stage press no irreversible button before a gate.
- **Login check.** The Host opens the check address with the profile and reads the final address and optional selector. It matches the logged-in and logged-out patterns. The result `{ logged_in, url }` is written by the Host. The stage reports it in its envelope. The Host validates the envelope against its own result. A mismatch fails the stage.
- **Human login stage pattern.** A stage with a confirm gate whose payload includes the handoff kind and site. An after-phase verify runs the login check again. `on_verify_fail` sends the run back to the same stage.
- **Routing.** The check stage routes on `logged_in`. The login stage runs only when the value is false. The join to the work stages must work when the login stage is skipped. Confirm against the existing route and skip rules.
- **Redaction.** Cookie, storage, and token values are registered for redaction in stream logs and run logs. Run state and envelopes store profile names only.
- **Domain allowlist.** The allowed domains are passed to agent-browser so the tool enforces them.
- **CLI.** `sf browser` commands: list profiles, show status, check a profile, log in to a profile (opens a visible window), and clear a profile.
- **Docs and example.** A reference page, a catalog section, and an example pipeline (check, human login, work stage) that uses a local fixture login server. The docs warn that third-party sites can forbid automation, and give LinkedIn as an example of a site whose rules prohibit it.

**Pre-build verification (first ticket)**
- The Pi bash tool can run agent-browser with injected environment inside a real stage worker.
- A headed window opens from a worker started under the console.
- Where agent-browser keeps state under HOME, and an environment variable that pins it.
- A later stage attempt can reattach to the same session after the worker exited to wait for the operator.
- The route and skip rules support check, then login (skipped), then work.
- How the domain allowlist is configured and enforced.
- The effect of the encryption key variable on profile data and state files.
- Remote attach with `--cdp` keeps a login. Streaming accepts operator input or is view only.

## Testing Decisions

- A good test checks external behavior only: what a pipeline run produces (envelopes, run state, queue and waiting state, gate payloads, what was passed to the browser host, whether teardown ran). It does not check private functions or the order of internal calls.
- **Seam 1 (existing, highest): a whole pipeline run through the runner with the fake agent.** Cover: the browser field flows into the stage environment; a stage with a profile gets the settings; a second run waits when the profile is busy; teardown runs on success, failure, cancel, and timeout; the session stays open at a gate; the check result routes the run; the human login stage is skipped when the login is valid; the after-phase check loops back on failure; cookies never appear in run state or envelopes.
- **Seam 2 (new): the profile store, lock, and browser host interfaces.** One contract suite runs against the local implementation and an in-memory fake that has two scopes. It proves: scope A cannot open scope B's profile by name or by path; delete by scope removes only that scope; the lock queues and releases; the fake host returns a remote address and the stage uses it with no local profile path.
- A real-Chrome smoke test against a local fixture login server stays opt-in and is not a seam. The fixture server sets one persistent cookie and one session-only cookie and shows them back on a page.
- Loader and validator tests use fixture YAML for valid and invalid `browser` fields.
- Prior art: the whole-pipeline fake-agent tests (for example the agent port contract and pi adapter session tests), the stage MCP resolve tests, the CLI run tests with JSON output, the skill binding tests, and the stream log redaction tests.

## Out of Scope

- Multi-tenant service, authentication, billing, and tenant database. Only the interfaces are in scope.
- A live view handoff and a remote browser host. The payload field and interfaces are in scope. The implementations are later.
- Parallel stages on one profile. They queue in the first version. A shared Chrome with tab pinning is later.
- Solving CAPTCHAs, stealth or anti-detection features, and proxy rotation.
- Importing a saved login state into CI.
- Credential vault logins (the agent never types a password in this feature).
- Playwright MCP, Chrome DevTools MCP, and other browser tools.
- Any change to how third-party site rules are enforced. Stageflow does not judge a site's terms.

## Further Notes

- The domain glossary and ADR files do not exist in this worktree. Vocabulary follows `docs/architecture.md`, `docs/hitl.md`, and `docs/yaml-catalog.md`: pipeline, stage, Host, operator, gate, envelope, curated stage environment, skill binding.
- Proposed addition, not yet confirmed: stages with no profile get a throw-away profile and can run in parallel (user story 11). Decide before the lock slice.
- Risk: LinkedIn rules prohibit bots and scraping and can limit or close accounts. The example and docs must use a neutral site.
- Risk: Docker Hosts have no screen. Until the live view handoff exists, a human login stage on a Docker Host must fail with a clear message.
- Related local plan: `docs/plans/browser-sessions.md`. Related use-case page was published as an artifact for review.
- This project has no issue tracker. This spec lives in `docs/specs/`. Implementation slices are in `docs/tickets/browser-sessions/`.

## Pre-build verification results (ticket 00)

Method: agent-browser 0.38.2, Chrome for Testing 154, macOS arm64, local node fixture server (one persistent cookie `pers`, one session-only cookie `sess`), `env -i` stripped environments, scratch HOMEs. Items marked UNVERIFIED were answered from code reading only. No `src/` or `tests/` changes were made. The throw-away experiment code lives in the session scratchpad only.

Headline changes to the design (details per item below):
- **`--allowed-domains` cannot be combined with `--profile`, `--restore`, `--state`, `--cdp`, or auto-connect.** Spec decision "allowlist enforced by the tool" does not hold for logged-in profiles. Needs a decision before tickets 03 and 11.
- **All commands of one session must carry byte-identical launch env.** A client whose launch env differs from the running daemon silently kills and relaunches the browser (page and session-only cookies lost).
- **Headless daemon self-exits after 1 hour idle** (default). Headed is exempt. A headless stage that waits at a gate for more than an hour loses its page.
- **There is no env var that moves `~/.agent-browser/`.** Avoid features that write there (`--restore`, `auth`, `state`). `--profile` alone writes nothing under HOME.
- **`./agent-browser.json` in the stage cwd (the project checkout) is honored.** Pin `AGENT_BROWSER_CONFIG`.

- **1. Pi bash tool runs agent-browser with injected env in a stage worker. Verdict: PARTIAL (tool verified, real worker UNVERIFIED).**
  - Ran: Pi's real `createBashToolDefinition(...).execute` with `process.env` set to HOME + `AGENT_BROWSER_*` and agent-browser on PATH. Env reached the shell; `open`, `get text`, `close` returned in 1.2 s, 57 ms, 157 ms. The daemon does not hold the bash tool's pipes open (no hang).
  - Code reading: Pi's bash tool uses `getShellEnv()` = `{...process.env}` (`pi-coding-agent/dist/utils/shell.js`). Stageflow passes no `spawnHook`. So the bash env is the worker's `process.env`, which is the forked child env built in `StageProcessLauncher.launch` (`buildStageEnvironment` + `overlayStageBindingEnv` + `explicitChildExtras`). `stageEnv` in `stageWorker.ts` / `stageRunner.ts` feeds MCP resolve and completion checks only, not the Pi bash tool. In-process mode (`executionMode !== "process"`) would use the Host `process.env` instead, but the scheduler defaults to `"process"`.
  - Not run: a real `sf run` with a provider (no provider auth).
  - Consequence for ticket 03: inject through the child env of the forked worker. `buildStageEnvironment` already accepts `runVars` but `launch()` does not pass any; the clean seam is a new `browserEnv` input to `launch()` merged into `built.env` (not `explicitChildExtras`, which is a global per-launcher extra). Also add it to the in-process `stageEnv` for completion checks. `agent-browser` must be on the stage `PATH` (Host `PATH` is allowlisted; preflight requirement covers it). Setting `HOME` is already per-attempt and is irrelevant to the profile (see item 3).

- **2. Headed window from a worker started under the console. Verdict: VERIFIED on macOS for a detached stripped-env child; console path UNVERIFIED.**
  - Ran: a node child spawned `detached: true` with env containing only PATH, HOME, `AGENT_BROWSER_HEADED=1` (no DISPLAY, no TERM) opened Chrome. Page reported UA without "Headless", `window.outerWidth/Height` 1280x720, no `--headless` flag. I did not visually confirm a window (the osascript window count call failed), so "window is on screen" rests on those signals.
  - Code reading: the launcher forks the worker `detached: true` with `stdio` pipes, so it stays in the login session.
  - Gaps: Linux/WSL need `DISPLAY` / `WAYLAND_DISPLAY` / `XAUTHORITY`, none of which are in `STAGE_ENV_ALLOWLIST`. agent-browser auto-starts a private Xvfb on displayless Linux (`AGENT_BROWSER_NO_XVFB` opts out), which is not visible to the operator. Ticket 08 must decide: on Linux either pass the display vars through the browser env or fail with the "no screen" error (user story 36). On Docker it must fail (story 57).

- **3. Where state lives under HOME and what pins it. Verdict: VERIFIED.**
  - `--profile <dir>` (Chrome user-data-dir, env `AGENT_BROWSER_PROFILE`) writes nothing under HOME. Persistent cookies survive close/reopen and survive a different HOME (tested h1 to h2). The session-only cookie `sess` is lost on every close (plain Chrome behavior), regardless of HOME.
  - What does write under HOME: `--restore` / `AGENT_BROWSER_RESTORE` writes `$HOME/.agent-browser/sessions/<key>-<session>.json` (`.json.enc` with a key). The README says the auth vault writes `$HOME/.agent-browser/.encryption-key`. Config is read from `$HOME/.agent-browser/config.json`. The binary has no `AGENT_BROWSER_HOME`, no XDG state var (only `XDG_RUNTIME_DIR`), and `AGENT_BROWSER_NAMESPACE` only adds a subfolder inside HOME.
  - Daemon files (outside HOME): `AGENT_BROWSER_SOCKET_DIR` (verified, files `<session>.sock/.pid/.config/.engine/.version/.target/.stream`). Use a short dir (103-byte socket limit). After `close`, `<session>.config` and `<session>.target` (mode 0600, holds the last URL and target id) remain in the socket dir.
  - Consequence for ticket 03 (pin set): `AGENT_BROWSER_PROFILE=<store path>`, `AGENT_BROWSER_SESSION=<deterministic name>`, `AGENT_BROWSER_SOCKET_DIR=<short Host dir>`, `AGENT_BROWSER_HEADED=1|0`, `AGENT_BROWSER_IDLE_TIMEOUT_MS=0`, `AGENT_BROWSER_CONFIG=<Host-owned empty json>`. Do NOT use `--restore`, `auth`, or `--state`. `HOME` stays the empty per-attempt dir. Pinning `AGENT_BROWSER_CONFIG` is required, not optional: a `./agent-browser.json` in the project checkout (stage cwd) was applied (`{"profile":"./cfgprof"}` created `cfgprof`); with `AGENT_BROWSER_CONFIG` set to another file it was ignored. Also forbid the skill from passing `--profile/--session/--headed/--proxy/--user-agent/--args` etc.
  - Consequence for ticket 04: sweep the socket dir for leftover `.config/.target/.sock/.pid` of dead sessions.
  - Earlier spike claim "session-only cookie lost when HOME changed" is not a HOME effect: it is lost on every close.

- **4. Later attempt reattaches after the worker exited to wait. Verdict: VERIFIED at the tool level; Stageflow resume path UNVERIFIED (code reading only).**
  - Ran: worker = detached `bash -c` process group running `agent-browser open` then `sleep`; `kill -9 -<pgid>`. Daemon survived (own pgid, ppid 1). A new process with a different HOME and the same session/profile/socket-dir env ran `get url` and got the same URL and cookie. This confirms the spec evidence.
  - Gotcha 1 (breaks reattach): if any command in the session has different launch-affecting env than the daemon's (tested `AGENT_BROWSER_IDLE_TIMEOUT_MS`, `AGENT_BROWSER_USER_AGENT`; `AGENT_BROWSER_SCREENSHOT_DIR` is non-launch and harmless), the CLI silently relaunches the browser: page back to `about:blank`, session-only cookies gone, profile cookies kept. The daemon compares a hash (`<session>.config`). Consequence for ticket 03: compute the browser env once per profile/session and persist it (do not recompute from changing inputs in a resume worker). Resume must produce the identical env.
  - Gotcha 2: headless daemon exits after 1 h idle by default; with `AGENT_BROWSER_IDLE_TIMEOUT_MS=3000` the page was gone after 8 s. Headed is exempt by default. Set `AGENT_BROWSER_IDLE_TIMEOUT_MS=0` (identically in every command) so gates can wait beyond 1 h; teardown then must never be skipped (ticket 04).
  - Gotcha 3: `close` returns before the daemon fully exits. An immediate `open` after `close` failed twice with "Could not configure browser: Failed to connect"; a 2 s pause fixed it. Teardown followed by an immediate login re-check on the same profile (ticket 07, 08) needs a wait/retry, or must reuse the open session.
  - Code reading: resume launches a new worker via `launcher.launch` (`mode: "resume"`), env rebuilt each launch (`stageProcessLauncher.ts`); cancel kills `-pid` of the worker group only (daemon survives, so teardown must call `agent-browser close` itself). Pi bash `killProcessTree` on abort/timeout also does not kill the daemon (it detaches).

- **5. check, then login (skipped), then work routes correctly. Verdict: VERIFIED with a required topology (no change to route/skip rules needed).**
  - Ran: whole pipelines through `RunManager` with the fake agent (against a copy of `src/` in the scratchpad). Topology A: `check` routes `login` with `if: logged_in eq false` and `work` with NO `if`; `login` routes `work`. Result: `logged_in=true` opened `[check, work]`, run succeeded (login skipped); `logged_in=false` opened `[check, login, work]`, run succeeded.
  - Topology B (same, but `check -> work` also has `if: logged_in eq true`): `logged_in=true` ok, but `logged_in=false` opened `[check, login]` and `work` was SKIPPED (a Join whose parents all succeeded runs only if every inbound `if` fired; the `check -> work` edge missed). Run still reported `succeeded`, so it fails silently.
  - Consequence for tickets 07/08/09: the work stage is a two-parent Join (`check`, `login`). The `check -> work` and `login -> work` edges must have no `if`. Only `check -> login` carries the `if`. Work `io.input` must be a structural subset of both parents' `io.output` (a loose or `{ logged_in, url }` shape). Document this as the canonical pattern and put it in the example pipeline and a loader/validator test. `sf validate` prints `pipeline.route_all_gated` only when every route entry has `if` (B printed it; A does not).

- **6. Domain allowlist: how configured and whether enforced. Verdict: VERIFIED, with a blocker.**
  - Config: `--allowed-domains a.com,*.a.com` or `AGENT_BROWSER_ALLOWED_DOMAINS` (wildcards also match the bare domain).
  - Enforcement (verified, no profile): `open` of a disallowed host fails ("Domain '127.0.0.1' is not in the allowed domains list"); in-page `fetch` to a disallowed host is blocked ("Fetch blocked"). README: sub-resources, WebSocket/EventSource, `sendBeacon`, workers, and WebRTC are contained.
  - BLOCKER (verified): with `--profile`: "--allowed-domains is not supported with --profile because Chrome may restore existing pages before network containment is installed". Same rejection for `--restore`, `--cdp`, auto-connect, `--state`, unsafe `--args`. So a stage that needs a persistent login cannot also get tool-enforced domains.
  - Workaround verified: a Host-run filtering HTTP(S) proxy passed via `AGENT_BROWSER_PROXY` works together with `--profile` (tested with a 40-line node proxy: `fixture.test` allowed, `example.com` got 403 from the proxy, Chrome background calls to google domains also denied). HTTPS can be filtered by CONNECT host only (no path). This keeps enforcement outside the page and outside the agent. `--host-resolver-rules` via `--args` was not usable (args are split on commas and it needs a comma; localhost/IP literals bypass it).
  - Decision needed (user story 3 and 47): (a) Host-side proxy for profile stages (new moving part, ticket 03/11), (b) allowlist only for no-profile stages (story 11 throw-away), (c) soft enforcement only (skill rule plus `--action-policy`), documented as not a security boundary for profile stages. Until decided, ticket 11 should not promise tool enforcement with a profile. The Host-level site policy (story 56) fits the proxy option.

- **7. Effect of `AGENT_BROWSER_ENCRYPTION_KEY`. Verdict: VERIFIED.**
  - Applies only to agent-browser's own state files (`--restore`, `--state`, auth vault), not to the Chrome profile directory.
  - Without a key, `--restore` wrote plaintext JSON (cookie names and values, including the session cookie) at `~/.agent-browser/sessions/<key>-<session>.json`, mode 0644 (world-readable). With a 64-hex key it wrote `<key>-<session>.json.enc` (still mode 0644, but encrypted). Reopen with the right key: `restore: loaded`, session-only cookie came back. No key or wrong key: `restore: load_failed`, non-fatal, profile cookies still loaded.
  - The Chrome profile (`--profile`) is unaffected by the key: cookie values are in `Default/Cookies` sqlite as `encrypted_value` (v10), encrypted by Chrome with the OS credential store (macOS Keychain "Chrome Safe Storage"; on Linux basic password store is effectively obfuscation only). So story 49 (encrypted at rest with a key from a key provider) is NOT provided by `AGENT_BROWSER_ENCRYPTION_KEY` for profile dirs.
  - Consequence for ticket 11: since profile-only mode writes no agent-browser state files, the key variable is unnecessary unless restore is adopted. If a copied folder must not be enough to use a login (story 49), Stageflow needs its own protection: owner-only mode 0700 dirs plus OS disk/volume encryption (local), per-tenant encrypted volume or KMS (hosted). Alternative: adopt `--restore` + key to get session-only cookie persistence, but that also needs `HOME` pinned (no override exists) and forbids the allowlist. Not recommended for v1. Rename the "encryption key reference" in the browser host interface accordingly or drop it for v1.

- **8. `--cdp` attach and streaming. Verdict: VERIFIED.**
  - `--cdp`: launched Chrome for Testing myself with `--user-data-dir` and `--remote-debugging-port`; agent-browser attached by port. A login set through one agent-browser session was visible to a second, later attach (both `sess` and `pers`), because the login lives in the Chrome process and its profile. `agent-browser close` detaches and does NOT kill the external Chrome. After a graceful CDP `Browser.close` and relaunch of Chrome, cookies persisted; after `SIGTERM` the same cookies were lost in my test, so a Host-owned Chrome must be closed gracefully. Allowlist is rejected with `--cdp`. Remote attach therefore keeps a login, but with a Host/hosted-owned browser, not agent-browser's launch path.
  - Streaming: each session starts a WebSocket server (`stream status`; fixed port via `AGENT_BROWSER_STREAM_PORT`). It sends JPEG frames and URL updates and ACCEPTS input. Verified by connecting `ws://127.0.0.1:<port>` in node, sending `input_mouse` (click) and `input_keyboard` (typing): the input value became "hi" and a button click handler ran. Works while headless.
  - Caveats: binds 127.0.0.1 with no token (any local process can drive the browser); the dashboard (`dashboard start`, port 4848) uses a token only for reverse-proxied origins. Streaming makes a live-view handoff (story 54, hosted) feasible with no local window; the console would proxy it with its own auth. Out of scope for v1 per spec, but ticket 08's payload schema (`live_view` with URL) is confirmed viable.

- **Extra findings (not in checklist).**
  - Two sessions on one profile: the second `open` fails with Chrome's `ProcessSingleton ... SingletonLock` error dump on stderr and leaves a dangling second session record. Stageflow's own profile lock (ticket 05) must prevent this; Chrome's lock is a safety net only.
  - Stage env must not leak `AGENT_BROWSER_*` from the Host: with `env -i` plus explicit vars everything worked; the Host must not read them from ambient env either.
  - `AGENT_BROWSER_PROXY` also falls back to `HTTP_PROXY`/`HTTPS_PROXY` (both in `STAGE_ENV_ALLOWLIST`). Chrome bypasses proxies for loopback.
  - Stray processes: all agent-browser sessions, Chrome for Testing processes, and the fixture servers started here were closed/killed. `prof-li` was not touched.

- **9. Throw-away profile for stages with no profile (user story 11). Verdict: NOT DECIDED, technical considerations only.**
  - Mechanism exists: with no `AGENT_BROWSER_PROFILE`, agent-browser creates a fresh temp user-data-dir `$TMPDIR/agent-browser-chrome-<uuid>` per session and deletes it on `close` (verified: two parallel sessions e1/e2 each had their own dir; `sess` set in e1 was invisible in e2; dirs gone after close). `TMPDIR` comes from the Host allowlist, so a stage with a custom `TMPDIR` changes where it lives.
  - Parallelism: distinct session names run side by side with no lock. Session name must be unique per stage attempt (for example derived from run id, stage id, attempt), and socket dir shared or per-run.
  - Only this mode supports `--allowed-domains` (tool-enforced, verified). That makes it the natural home for strict domain lists and for hosted multi-tenant public-page stages.
  - Costs: no login ever carries over (by definition). Session-only and persistent cookies are lost at stage end. Headless/headed UA difference still applies; mixing a throw-away stage with profile stages yields a different browser fingerprint (spec risk in "one mode per profile" carries over to "per pipeline").
  - Teardown matters more: a hard-killed daemon cannot delete its temp dir (not tested, expected to orphan `agent-browser-chrome-*` dirs). The Host sweep (ticket 04) would need to clean temp dirs for dead sessions, which requires recording them, since the path is chosen by agent-browser. Alternative: Stageflow creates the temp dir itself and passes it as `AGENT_BROWSER_PROFILE`, which then disables the allowlist (so story 11 and story 3 conflict unless the dir is agent-browser-managed).
  - Schema questions: is "no profile" implicit (field omitted) or explicit (`profile: false` / `ephemeral: true`)? Should a `browser` field with no profile still add the agent-browser requirement and the lock-free path? Decide before the lock slice (ticket 05).

## Design decisions after verification (set during implementation)

These resolve conflicts found in ticket 00. They are the implementer's defaults. The user has not yet reviewed them.

1. **Allowlist vs profile.** agent-browser rejects `--allowed-domains` together with `--profile`. v1 passes the native allowlist only to stages with no profile. For stages with a profile, `allow_domains` is soft: it is written into the skill instructions and checked after the fact. A Host-side filtering proxy is a later option. Spec story 47 is met only for profile-less stages.
2. **Encryption key.** The agent-browser key only protects agent-browser's own restore and state files. It does not protect the Chrome profile folder. v1 uses profile-only mode, which writes no such files. The key provider interface exists, but is not wired to agent-browser. Spec story 49 is not met by the key; the OS keychain and folder permissions are the protection in v1.
3. **Profile-less stages.** A `browser` field with no profile gives a throw-away browser (agent-browser temp profile, deleted on close). No lock is taken. This follows from agent-browser behavior and is cheap, so it is implemented and flagged. Spec story 11 stays open for the user to confirm.
4. **Env stability.** Every agent-browser command in a session must carry the same launch environment. The Host computes it once, stores it, and reuses it for resume workers. The Host pins `AGENT_BROWSER_CONFIG` to an empty file, sets `IDLE_TIMEOUT_MS=0`, and does not use `--restore`, `auth`, or `--state`.
5. **Join topology.** Pattern for check, login, work: only the edge check to login has an `if` on `logged_in`. The edges check to work and login to work have no `if`.

## Revision 2: one shared browser per run and profile (supersedes earlier lock and teardown decisions)

Decided with the user after the code review. This replaces: the stage-level profile lock (story 27-29), "close the browser after every stage" (stories 23, 25 for profile stages), and the per-stage `AGENT_BROWSER_PROFILE` launch.

**Rules**
1. **Run-scoped profile lease.** A profile is leased to one RUN, from the first stage that needs it until the run ends (success, failure, cancel, or abandon). All stages of that run share the lease. Stages of the same run are never blocked by each other, including parallel stages.
2. **Other runs wait for the whole run.** A different run that needs the same profile waits in a queue until the lease holder's run is terminal. The waiting stage shows the holder run id.
3. **One Chrome per run and profile (the anchor).** The Host starts one anchor agent-browser session with the profile (headed or headless as configured). The anchor owns Chrome and keeps it open for the whole run, so session-only cookies survive between stages. The Host reads its CDP address (`agent-browser get cdp-url`).
4. **Each stage gets its own tab.** A stage runs its own agent-browser session attached to the anchor with the CDP address and `AGENT_BROWSER_PIN_TAB=1`. The stage env has no `AGENT_BROWSER_PROFILE`. The session name is unique per stage. All tabs share the same cookies and login, like several tabs in one browser window. Parallel stages do not interfere.
5. **Hand-over between stages.** The shared browser context is the hand-over: cookies, storage, and the login pass from stage to stage with no extra step. Passing one exact open page to the next stage is out of scope; a stage can pass a URL in its envelope.
6. **Teardown.** When a stage ends, the Host closes that stage's tab and its agent-browser session. Chrome stays open. The Host closes the anchor (gracefully) and releases the lease when the run reaches a terminal state, is cancelled, or is abandoned. A run that waits at a gate keeps the anchor open and the lease held. The orphan sweep closes anchors and stage sessions of runs that no longer exist.
7. **Profile-less stages** keep their own throw-away browser and take no lease.
8. **Remote readiness.** The stage env is just a CDP address, a session name, and pin-tab. A remote browser host (service) can supply a CDP address in place of the local anchor with no stage-side change.
9. **Soft allowlist** unchanged: agent-browser rejects its native allowlist with `--cdp`, so profile stages keep the soft check.

**Spike evidence (this revision, agent-browser 0.38.2):** an anchor session with a profile exposes a `ws://127.0.0.1:<port>/devtools/browser/<id>` address through `get cdp-url`. Two sessions attached with `--cdp` and pin-tab each got their own tab and kept it through parallel navigation. All tabs saw the same cookies, including the session-only cookie. Closing one stage session left Chrome and the other stage working. It left that stage's tab open, so the Host must close the tab first. Closing the anchor ended Chrome, and the persistent cookie survived a reopen.

**Risks:** the CDP port is bound to 127.0.0.1 without a token, so any local process can drive the browser while a run is active (single-user laptop only; the hosted service must isolate it in a sandbox). If the anchor dies mid-run, the lease holder's stages lose their browser; the Host must restart the anchor and refresh the persisted stage env.
