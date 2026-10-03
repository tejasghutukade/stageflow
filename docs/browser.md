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
- **Session.** One running browser for a profile during a stage. The Host starts it and closes it. The profile stays on disk, so the next stage and the next run are still logged in.

Profile folder: `$STAGEFLOW_HOME/browser/<scope>/<profile>/` (default `~/.stageflow/browser/local/<profile>/`), owner-only permissions. It is never in the project checkout.

## YAML

A stage declares `browser:` with `profile`, `headed`, `allow_domains`, `login_url`, and `check`. The `agent-browser` requirement is added for you. Field reference: [YAML catalog: Stage browser](yaml-catalog.md#stage-browser). The login check and human login stage are in [Login check stage](yaml-catalog.md#browser-login-check) and [Human login stage](yaml-catalog.md#browser-human-login).

A `browser` field with no `profile` gives a throw-away browser. It takes no lock, shares no login, and its profile is deleted when it closes.

## Login pattern

Three stages: check, human login, work.

1. `check` has `browser.check`. The Host opens the check page with the profile and computes `{ logged_in, url }`. The stage reports it.
2. `login` runs only when `logged_in` is `false`. The Host opens a visible window. The stage asks the operator with a `confirm` gate. After the operator confirms, the Host checks again (`verify: browser_login`). A wrong confirm repeats the stage.
3. `work` uses the saved login.

Use the join topology. Only the `check` to `login` edge has an `if` on `logged_in`. The edges `check` to `work` and `login` to `work` have no `if`. If `check` to `work` also has an `if`, `work` is silently skipped when the login stage runs. The `work` input schema must fit the output of both parents.

Runnable walkthrough: [`examples/browser-session/`](../examples/browser-session/). Fixtures: `tests/fixtures/pipelines/browser-login-check.pipeline.yaml` and `browser-human-login.pipeline.yaml`.

## Queueing and lock

One profile can have one browser at a time. A stage that needs a busy profile waits in a queue. The run shows a "waiting for browser profile" state that names the run and stage that hold it. The lock is held from stage start to teardown, including while a gate waits for the operator. It is released on success, failure, cancel, and Host restart.

Stages with no profile do not lock and can run in parallel.

## Teardown and orphan sweep

The Host closes the browser when a stage succeeds, fails, times out, or is cancelled, and when the run ends. It does not rely on the stage worker, which can be killed. The browser stays open while a stage waits at a gate.

When the Host starts, it closes browsers whose run no longer exists and removes their leftover socket files.

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

Hosted use is not built. The seams are in place: the owner scope (set by the Host), the profile store (all path code), the profile lock, the browser host (returns the environment a stage needs, or later a remote address), and the handoff kind in the gate payload. Each can be replaced without changing YAML.

## Sites can forbid automation

Many sites forbid bots and scraping in their terms and can limit or close accounts that break them. For example, the LinkedIn User Agreement prohibits bots and scraping, and LinkedIn can restrict accounts. If you point a stage at such a site, keep volume low, stay read-only, and accept the risk yourself. Stageflow does not judge a site's terms. The example in this repo uses a neutral local site on purpose.

## Session-only cookies

The Host closes the browser when a stage ends. Chrome keeps persistent cookies on close and drops session-only cookies. A real-Chrome test confirmed this. A site whose login depends on a session-only cookie asks for a new login in the next stage. LinkedIn's main login cookie is persistent, so it survives. Check the cookie type of your site before you rely on a saved login. A later change can keep the browser open across the stages of one run.
