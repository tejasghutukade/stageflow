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
2. `login` runs only when `logged_in` is `false`. The Host opens a visible window. The stage asks the operator with a `confirm` gate. After the operator confirms, the Host checks again (`verify: browser_login`). A wrong confirm repeats the stage.
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

Headed is the default. The operator can watch, and all stages that share a profile look like one device to the site. Set `headed: false` per stage for CI or background work. Use one mode for all stages that share a profile, because headless Chrome reports a different user agent. A human login stage must be headed.

On Linux the Host needs `DISPLAY` or `WAYLAND_DISPLAY` for a headed browser.

## Docker and hosts with no screen

A human login needs a visible window. A Host with no screen, including the Docker image, fails the login stage before the agent starts with a clear message. Log in on a machine with a screen first, or use a headless check only. A live view handoff is planned. The gate payload already allows `handoff: { kind: "live_view", url }` so the console will not need a schema change.

## Host config

Block sites for every browser stage in `$STAGEFLOW_HOME/config.yaml`:

```yaml
browser:
  blocked_sites:
    - example.com
```

A stage whose `allow_domains`, `check`, or `login_url` touches a blocked site (or a subdomain) fails before the browser starts. YAML cannot override it.

## Redaction and audit

Cookie, storage, and token values are registered for redaction in stream logs and run logs. Run state and envelopes hold the profile name only, never a path or a value.

The Host appends audit records to `$STAGEFLOW_HOME/browser/audit.jsonl`: profile created, profile used by a run and stage, profile deleted, and navigation outside the allowlist. Records hold names, ids, and hosts only.

## Allowlist caveat

`allow_domains` is enforced by agent-browser only for stages with no profile. agent-browser rejects its native allowlist together with a profile. For a stage with a profile, `allow_domains` is soft: it goes into the skill instructions and the Host checks navigation after the fact and audits violations. It is not a security boundary for profile stages. Use `browser.blocked_sites` and your own review for hard limits.

## Encryption

The Chrome profile is protected by owner-only folder permissions and by Chrome's use of the OS keychain (on macOS the "Chrome Safe Storage" key). The agent-browser encryption key is not used. It only protects agent-browser's own restore and state files, and Stageflow does not write those. On Linux, Chrome's basic password store is weak. Use disk encryption for the home directory.

## Multi-tenant readiness

Hosted use is not built. The seams are in place: the owner scope (set by the Host), the profile store (all path code), the profile lease, the browser host (starts the shared browser and returns the CDP address and session a stage needs; a remote host can supply the address instead), and the handoff kind in the gate payload. Each can be replaced without changing YAML.

## Sites can forbid automation

Many sites forbid bots and scraping in their terms and can limit or close accounts that break them. For example, the LinkedIn User Agreement prohibits bots and scraping, and LinkedIn can restrict accounts. If you point a stage at such a site, keep volume low, stay read-only, and accept the risk yourself. Stageflow does not judge a site's terms. The example in this repo uses a neutral local site on purpose.

## Cookies across runs

Within a run, every cookie, session-only or persistent, is shared by all stages, because the shared browser stays open. When the run ends the Host closes the browser gracefully so Chrome writes its profile. A real-Chrome test (agent-browser 0.38.2) found that a graceful close and reopen of the profile kept both the persistent and the session-only fixture cookie. Do not rely on this across runs. Chrome and agent-browser may drop session-only cookies in other versions or after a crash or hard kill, and a site can expire the login by itself. Persistent cookies are the safe choice. Check the cookie type of your site. LinkedIn's main login cookie is persistent.
