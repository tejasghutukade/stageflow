---
layout: default
title: Browser sessions
---

# Browser sessions

A stage can drive a real browser that stays logged in. The browser tool is [agent-browser](https://github.com/vercel-labs/agent-browser). The agent uses it through the bash tool and the bundled `browser` skill.

Install it first: `npm i -g agent-browser && agent-browser install`.

## Concepts

- **Profile.** A saved browser login: a Chrome folder with cookies and site data. It lives on the Host, in the Stageflow home. YAML names it; YAML never gives a path.
- **Scope.** The owner of a profile. Locally the scope is one fixed value (`local`). The Host sets it. YAML cannot.
- **Shared browser (anchor).** One Chrome per run and profile. The Host starts it for the first stage that needs the profile and keeps it open until the run ends.
- **Stage session.** One agent-browser session per stage. It attaches to the shared browser and gets its own tab. The Host closes the tab and the session when the stage ends.

Profile folder: `$STAGEFLOW_HOME/browser/<scope>/<profile>/` (default `~/.stageflow/browser/local/<profile>/`), owner-only permissions. It is never in the project checkout.

## YAML

A stage declares `browser:` with `profile`, `headed`, `allow_domains`, `login_url`, and `check`. The `agent-browser` requirement is added for you. Field reference: [YAML catalog: Stage browser](yaml-catalog.md#stage-browser). The login check and human login stage are in [Login check stage](yaml-catalog.md#browser-login-check) and [Human login stage](yaml-catalog.md#browser-human-login).

A `browser` field with no `profile` gives a throw-away browser. It takes no lease, shares no login, and its profile is deleted when it closes.

## Login pattern

Check, human login, then work. The work can be one stage or several parallel stages.

1. `check` has `browser.check`. The Host opens the check page with the profile and computes `{ logged_in, url }`. The stage reports it.
2. `login` runs only when `logged_in` is `false`. The Host opens a browser the operator can see (a window on the Host's screen, or the [live view](#live-view) in the console). The stage asks the operator with a `confirm` gate. After the operator confirms, the Host checks again (`verify: browser_login`). A wrong confirm repeats the stage.
3. `work` stages use the saved login. Parallel work stages share it in their own tabs.

Use the join topology. Only the `check` to `login` edge has an `if` on `logged_in`. The edges `check` to `work` and `login` to `work` have no `if` (for every work stage). If `check` to `work` also has an `if`, `work` is silently skipped when the login stage runs. The `work` input schema must fit the output of both parents.

Runnable walkthrough: [`examples/browser-session/`](../examples/browser-session/). Fixtures: `tests/fixtures/pipelines/browser-login-check.pipeline.yaml` and `browser-human-login.pipeline.yaml`.

## Shared browser and tabs {#shared-browser-and-tabs}

A profile is leased to one run, from the first stage that needs it until the run ends. All stages of that run share the lease and one Chrome. Stages of the same run never block each other, including parallel stages.

- The Host starts the shared browser (the anchor) with the profile and reads its CDP address.
- Each stage runs its own agent-browser session. It attaches to the shared browser with `AGENT_BROWSER_CDP` and `AGENT_BROWSER_PIN_TAB=1`, so it gets its own tab and stays on it. The stage env has no profile path.
- All tabs share cookies and login, like tabs in one window. Parallel stages do not move each other's pages.
- Session-only cookies survive from stage to stage, because Chrome stays open for the whole run.

The example has two parallel work stages that share one login: [`examples/browser-session/`](../examples/browser-session/).

## Hand-over between stages

The shared cookies and login are the hand-over. A later stage is logged in with no extra step. Passing one exact open page to the next stage is out of scope. To hand over a page, put its URL in the envelope and open it in the next stage.

## Queueing and lease

A stage of a different run that needs the profile waits until the holder run is success, failed, cancelled, or abandoned. It shows a "waiting for browser profile" message that names the holder run. The wait covers the whole run, not one stage. A waiting stage does not use one of its run's active stage slots. The lease stays held while a gate waits for the operator. Leases of dead runs are reclaimed at Host start and while waiting. Waiting has no time limit.

Stages with no profile take no lease and can run in parallel.

## Teardown and orphan sweep

When a stage succeeds, fails, times out, or is cancelled, the Host closes that stage's tab and its session. The shared browser and the other stages stay up. When the run ends, fails, is cancelled, or is abandoned, the Host closes the shared browser gracefully and releases the lease. It does not rely on the stage worker, which can be killed. The browser stays open while a stage waits at a gate.

When the Host starts, it closes browsers and stage sessions whose run no longer exists and removes their leftover socket files.

If the shared browser dies in the middle of a run, the Host restarts it on the next stage start and points the stage sessions at the new address. Pages open in the dead browser are lost. Cookies are not, because they are in the profile.

## CDP port risk

The shared browser listens on a CDP port bound to `127.0.0.1` with no token. While a run is active, any local process can drive that browser. This is acceptable on a single-user laptop. A hosted multi-user service must run the browser in a sandbox and must not use this local port.

## Headed and headless

Headed is the default. The operator can watch, and all stages that share a profile look like one device to the site. Set `headed: false` per stage for CI or background work. Use one mode for all stages that share a profile, because headless Chrome reports a different user agent. A human login stage always gets a visible browser, whatever `headed` says: a window on a Host with a screen, or the live view on a Host without one.

To watch any running browser stage, use **Watch browser** on the stage in the run page. It is a read-only live view: the server refuses input from it, it follows popups, closing it does not affect the stage, and it ends when the stage ends.

On Linux the Host needs `DISPLAY` or `WAYLAND_DISPLAY`, or `Xvfb` on `PATH` (see [Linux hosts with no screen](#linux-hosts-with-no-screen)), for a headed browser. With none of them, a stage that did not ask for a login window quietly runs headless. macOS and Windows always count as having a screen.

## Live view {#live-view}

Live view lets the operator log in to a browser that runs on a Host with no screen, or on another machine. The console shows the Host's browser as a picture on a canvas in the gate, and sends the operator's clicks and keys back to it. Nothing is installed on the operator's side.

### What each Host shows

The Host decides how a human login gate is handed over. YAML does not choose it, and launch options are not set in YAML.

| Host | What the operator sees at the gate |
|------|------------------------------------|
| Desktop (macOS, Windows, Linux with `DISPLAY` or `WAYLAND_DISPLAY`) | A browser window on the Host's screen (`local_window`). Nothing changes: the console only asks to confirm. |
| Linux with no screen, started with the console (`sf ui` or `sf mcp`) | The live view in the console gate (`live_view`). The browser runs without a window on the Host. |
| No screen and no live view (for example a run started only from the CLI, or a host that cannot stream) | The login stage fails before the agent starts: "A visible browser is needed for login, but this Host has no screen and no live view." In Docker the message adds a hint to log in on a machine with a screen first. |

The live view needs the process that serves the console routes: `sf ui`, or the MCP service (`sf mcp`) that serves the console API. A CLI run without a console never offers it. The gate carries a stable path (`/api/runs/<run>/stages/<stage>/live-view`), never a token; the console asks the Host for a short-lived ticket when the operator opens the gate.

### Using it during a login gate

1. Open the run in the console. The gate shows a line "Log in in the browser view below, then confirm.", the page address, and the browser picture.
2. Click in the picture to focus a field, then type. Tab, Enter, Backspace, the mouse wheel and right click work. Paste with the keyboard shortcut. Long text is sent in small batches, so a long paste takes a moment.
3. If the site opens a popup (for example "Sign in with a provider"), the view follows the popup. When the popup closes, the view returns to the page that opened it. The opener still receives the result.
4. When the page shows you are logged in, press Accept. The Host then re-checks the login itself (`verify: browser_login`). If it still sees a logged-out page, the stage runs again with a new gate, and the live view works there too.
5. Accepting, rejecting, cancelling or ending the run closes the live view and revokes its ticket. Input sent after that is refused.

If typing and clicking do nothing (a known issue after submitting some login forms), open "Page seems stuck?" under the picture and press **Reopen browser tab**. The Host opens the same address in a fresh tab of the same browser (you stay signed in; page state held only in the old tab is lost), moves the view to it and closes the old tab. It can be pressed once every couple of seconds.

The live view is interactive by default. The Host can also issue a view-only ticket (read access) that shows the page but refuses input. The console gate always asks for the interactive one.

### Page dialogs {#page-dialogs}

JavaScript dialogs are not drawn in the picture, and the page stays blocked until one is answered. The console shows them as an overlay on top of the picture, as plain text (the page's text is never treated as HTML).

- `confirm` and `prompt` show **Accept** and **Dismiss**. A prompt also shows a text box, filled with the page's default text. Accept without editing sends that default. Only an interactive (control) session can answer. A view-only session sees the dialog and who it waits for, with no buttons.
- `alert` and `beforeunload` are accepted automatically by agent-browser within milliseconds, so there is nothing to answer. The overlay only shows what was said, for a few seconds, without buttons.
- A dialog nobody answers is dismissed by the Host after a time-out (60 seconds by default, `browser.dialog_timeout_seconds`, see [Host launch options](#host-launch-options)). The overlay then shows "The page dialog was dismissed after waiting too long." The stage is not failed by the time-out. The page sees a dismissed dialog (confirm gives false, prompt gives null).
- If the agent or the page answers first, your answer is ignored without an error.
- Popups that open a dialog on load are covered, because the Host attaches to every page before its scripts run.
- If the Host's live view relay restarts while a dialog is already open, the overlay does not appear and cannot answer it (the browser protocol gives a late client no way to see it). Wait for the time-out, or answer it on the Host's own browser.

### Limits

- Passkeys and hardware security keys do not work. Choose another sign-in method (code, SMS, backup code).
- Native browser prompts are not drawn in the picture and cannot be used: permission requests (camera, location, notifications), file pickers, HTTP authentication boxes, and the browser's own password or credential bubbles. If the page seems frozen or asks for something you cannot see, cancel or pick another method. The console shows this tip under the picture.
- Page dialogs are handled as described under [Page dialogs](#page-dialogs).
- Only the page picture, the address, and your input are carried. Sound is not.
- The picture is a stream of images, so it can lag on a slow link.

Everything typed in the live view, including passwords, goes to the Host's browser only. The Host never logs, stores or audits input or frames.

## Docker and hosts with no screen

A human login needs a browser the operator can see. A Host with no screen shows the [live view](#live-view) when it serves the console. A Host with no screen and no live view, such as a CLI-only run, fails the login stage before the agent starts with a clear message. Log in on a machine with a screen first, or use a headless check only.

## Host config

Block sites for every browser stage in `$STAGEFLOW_HOME/config.yaml`:

```yaml
browser:
  blocked_sites:
    - example.com
```

A stage whose `allow_domains`, `check` URLs or `login_url` touch a blocked site (or a subdomain) fails when the stage starts, before the browser opens. `sf browser check` and `sf browser login` refuse a blocked `--url` the same way (exit code 1, JSON `code: "browser_site_blocked"`). YAML cannot override the list.

### Permission requests are denied by default

Every browser the Host launches (the shared browser of a profile, profile-less stages, `sf browser login`) starts with Chrome's `--deny-permission-prompts` switch. A page that asks for location, notifications, camera, microphone or clipboard read gets "denied" at once instead of a prompt nobody can see (a headed browser on a Host with no screen, or the [live view](#live-view), does not draw native prompts, so the page would wait forever). This applies to every browser stage, not only login stages.

- Pages that need geolocation, notifications, camera or microphone will not get them. A login that requires one of these cannot be completed.
- It is not configurable: there is no stage YAML key and no Host config key to turn it off. The switch is added by the Host, ahead of your `launch_args`.
- This is a behavior change for existing pipelines. Browsers already running keep the flags they started with.

Browser sign-in and password-save prompts are not drawn in the live view either. Stageflow does not add a switch for them: Chrome has no launch switch for its password manager (it is a profile preference), and agent-browser already starts Chrome with `--password-store=basic` and `--disable-sync`. See the help text on a live view gate for what operators should do.

### Host launch options

Optional keys tune how the Host starts Chrome and handles live view dialogs. `launch_args` and `executable_path` are off by default.

```yaml
browser:
  launch_args:
    - --no-sandbox
    - --use-gl=angle
  executable_path: /usr/bin/chromium
  dialog_timeout_seconds: 60
```

- `launch_args`: list of Chrome flags. Each item must be non-empty with no comma or newline (agent-browser splits on both).
- `executable_path`: absolute path to a Chrome or Chromium binary. Use it where Chrome for Testing has no build, for example Linux ARM64 with a distribution Chromium.
- `dialog_timeout_seconds`: positive integer, default 60. How long a live view page dialog (`confirm` or `prompt`) may wait before the Host dismisses it. Keep it well under the ~150 seconds after which an unanswered dialog wedges agent-browser's `screenshot` and `get url`. Read when the live view relay is built, so a change needs a Host restart.

`launch_args` come after the Host's own switches (`--deny-permission-prompts`; listing it again has no effect). They apply to every browser the Host launches (the shared browser of a profile, profile-less stages, `sf browser login`) and are computed once per stage, so every command and resume uses the same values. They are never read from the environment and cannot be set in YAML: a stage `browser:` block with `launch_args`, `args`, `executable_path`, `executable` or `display` fails to load.

### Container browser host {#container-browser-host}

Development only; there is no production orchestrator yet. With `browser.host: container` the shared browser of each (run, profile) runs in its own container instead of on the Host. The container holds Chromium, a virtual display and the profile volume, nothing else. It always has a virtual display, so human login stages use the [live view](#live-view).

```yaml
browser:
  host: container
  container:
    image: stageflow-browser-sandbox:local
    shm_size: 1g
    memory: 1g
    pids_limit: 512
```

- Build the image with `docker build -f docker/Dockerfile.browser-sandbox -t stageflow-browser-sandbox:local docker`.
- The Host uses the local `docker` CLI to start containers, so it must run on a machine with a Docker daemon and must not itself run in a Stageflow container. A production orchestrator plugs in behind the same port.
- The container runs read-only and non-root, with all capabilities dropped, no privilege escalation, and process and memory limits. Its debugging port is published on `127.0.0.1` only.
- The profile lives in a Docker volume named `sf-profile-<scope>-<profile>`. It survives container removal; the Host closes the browser gracefully before removing the container so a fresh login is kept. After a crash the last seconds of cookies may be lost, so re-verify the login.
- At Host start, containers of runs that are gone or finished are removed (label `stageflow.run`). Only use one Host per Docker daemon, or a second Host would see the first one's runs as dead.
- Profile-less browser stages still launch Chrome on the Host. `sf browser login` stays a local-host tool.
- `browser.container` keys: `image` (image reference), `shm_size` and `memory` (a number with optional `b`, `k`, `m` or `g`), `pids_limit` (positive integer). All are optional; unknown keys fail config load.
- `browser.host` is read when the Host starts.
- Image and `docker run` flags are described in the [Docker guide](docker.md#container-browser-host).
- `browser.owner_hosts` (map of owner scope to `local` or `container`) overrides `browser.host` for one owner scope; scopes not listed use `browser.host`. Today every run belongs to the single `local` owner, so only `local` is consulted.

### Linux hosts with no screen

A Linux Host with no `DISPLAY` or `WAYLAND_DISPLAY` but with `Xvfb` on `PATH` runs browsers headed on a private virtual display that agent-browser starts itself. Nothing is shown on the Host, but the browser behaves like a headed one (same user agent as a desktop). A stage that sets `headed: false` still runs headless. Without Xvfb the Host falls back to headless as before. For Docker, the [browser image recipe](docker.md#browser-stages) installs Xvfb, Chromium and agent-browser.

## Redaction and audit

Stages with a `browser` field get extra pattern redaction for cookie, storage, header, and token shapes in stream logs, live activity, and envelopes. Other stages are not changed. Pattern redaction is best effort. The skill also tells the agent never to print cookies or storage. Run state and envelopes hold the profile name only, never a path or a value.

The Host appends audit records to `$STAGEFLOW_HOME/browser/audit.jsonl`: profile created, profile used by a run and stage, and profile deleted. Records hold names and ids only. For profile stages with `allow_domains` it also records `navigation_outside_allowlist` (host only, once per host) and `allowlist_unverified` (stage activity log unreadable); see the soft allowlist below.

## Allowlist caveat

`allow_domains` is enforced by agent-browser only for stages with no profile. agent-browser rejects its native allowlist together with a profile. For a stage with a profile, `allow_domains` is soft: it goes into the stage prompt and the agent is told to obey it. The Host does not enforce it. When the stage ends it audits explicit `agent-browser open|goto|navigate|tab new <url>` commands from the stage's tool activity and records hosts outside the list (`navigation_outside_allowlist`). Redirects, link clicks and in-page navigation are not seen. It is not a security boundary for profile stages. Use `browser.blocked_sites` and your own review for hard limits.

## Encryption

The Chrome profile is protected by owner-only folder permissions and by Chrome's use of the OS keychain (on macOS the "Chrome Safe Storage" key). The agent-browser encryption key is not used. It only protects agent-browser's own restore and state files, and Stageflow does not write those. On Linux, Chrome's basic password store is weak. Use disk encryption for the home directory.

## What is not built

- No production container orchestrator. The container host uses the local `docker` CLI and is for development.
- No console component for a provider-hosted viewer (`provider_view`). The route and ports exist; no provider adapter ships.
- No egress proxy: `allow_domains` stays soft for profile stages, container host included.
- Not tried against real sites. Popups, dialogs and second factors were checked on local fixtures. Sites may refuse a headed Chromium in a virtual display or a container.
- Several people can hold an interactive session on one gate; there is no single-controller rule.
- Some pages stop taking input after a login submit; the workaround is **Reopen browser tab** (see [Using it during a login gate](#using-it-during-a-login-gate)).

Contributor detail and the full list: [Browser sessions internals](browser-internals.md#status-and-scope).

## Multi-tenant readiness

Hosted use is not built. The seams are in place: the owner scope (set by the Host), the profile store (all path code), the profile lease, the browser host (starts the shared browser and returns the CDP address and session a stage needs; a remote host can supply the address instead; it reports what it can do, such as screen and live view), and the handoff kind in the gate payload. Each can be replaced without changing YAML.

## Sites can forbid automation

Many sites forbid bots and scraping in their terms and can limit or close accounts that break them. For example, the LinkedIn User Agreement prohibits bots and scraping, and LinkedIn can restrict accounts. If you point a stage at such a site, keep volume low, stay read-only, and accept the risk yourself. Stageflow does not judge a site's terms. The example in this repo uses a neutral local site on purpose.

## Cookies across runs

Within a run, every cookie, session-only or persistent, is shared by all stages, because the shared browser stays open. When the run ends the Host closes the browser gracefully so Chrome writes its profile. A real-Chrome test (agent-browser 0.38.2) found that a graceful close and reopen of the profile kept both the persistent and the session-only fixture cookie. Do not rely on this across runs. Chrome and agent-browser may drop session-only cookies in other versions or after a crash or hard kill, and a site can expire the login by itself. Persistent cookies are the safe choice. Check the cookie type of your site. LinkedIn's main login cookie is persistent.

## For contributors

How the feature is built, its file layout, invariants, and test guide: [Browser sessions internals](browser-internals.md).
