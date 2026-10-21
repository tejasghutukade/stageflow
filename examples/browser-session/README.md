# browser-session

Stages that keep one browser login across runs: **check the login, ask a person to log in only when needed, then do the work in two parallel stages that share the login, then merge.** The target is a tiny local fixture site, so nothing here touches a third-party service.

| Stage | What it does |
|-------|--------------|
| `check-login` | The Host opens `/home` with the saved profile and computes `{ logged_in, url }`. The stage reports it. Routes to `human-login` only when `logged_in` is `false`. |
| `human-login` | Opens a visible window on `/login`, stops at a `confirm` gate. The operator logs in and confirms. The Host checks the login again (`browser_login` verify, repair policy, up to 3 attempts). |
| `work-a` | Reads `/a` with the same profile in its own tab and writes `result.md`. Joins `check-login` and `human-login`. |
| `work-b` | Reads `/b` with the same profile in its own tab, at the same time as `work-a`. Joins `check-login` and `human-login`. |
| `merge` | No browser. Joins `work-a` and `work-b` and writes one merged `result.md`. |

Only the `check-login` to `human-login` edge has an `if`. The work stages are joins, so their inbound edges carry none. See [docs/browser.md](../../docs/browser.md#login-pattern).

## Prerequisites

- Node.js 20 or newer and this repo's CLI (`npm run build`)
- Provider auth for `sf run`
- agent-browser: `npm i -g agent-browser && agent-browser install`
- A screen on this machine. The login window is visible (headed is the default). A Host with no screen, including the Docker image, cannot run `human-login` yet.

## Run (repo root)

Start the fixture site in one terminal:

```bash
node examples/browser-session/fixture-server.mjs
```

It listens on `http://localhost:4173`. Set `PORT` to change it, and update the URLs in `browser-session.pipeline.yaml` to match.

In another terminal:

```bash
npm run build
node dist/cli.js validate --pipeline examples/browser-session/browser-session.pipeline.yaml --strict
node dist/cli.js run \
  --pipeline examples/browser-session/browser-session.pipeline.yaml \
  --task examples/browser-session/browser-session.task.yaml
```

Use `sf ui` instead of `sf run` if you want to answer the gate in the console.

## First run

1. `check-login` finds no login (`/home` redirects to `/login`). It reports `logged_in: false`.
2. `human-login` opens a browser window on the fixture login page and asks you to confirm.
3. Press **Log in** in that window, then answer the gate with accept. You never give a password to the agent.
4. The Host checks again. If you confirmed too early, the stage asks again.
5. `work-a` and `work-b` start together. They share one Chrome, each in its own tab, and both see the login.
6. `merge` joins them and writes `result.md`.

## Next run

`check-login` finds the saved login and reports `logged_in: true`. `human-login` is skipped. There is no question. `work-a` and `work-b` run straight away.

The fixture sets two cookies. The persistent one (`fixture_login`) is what keeps you logged in across runs. The session-only one (`fixture_session`) is shared by all stages of one run because the browser stays open for the whole run. Do not rely on a session-only cookie across runs. See [docs/browser.md](../../docs/browser.md#cookies-across-runs).

The run holds the profile until it ends. A second run that needs `fixture-site` waits for the whole first run.

## What is stored where

- The profile (a Chrome folder with the cookies) lives under the Stageflow home: `$STAGEFLOW_HOME/browser/local/fixture-site/` (default `~/.stageflow/browser/local/fixture-site/`), owner-only permissions.
- Nothing is written into this repo. Run state and envelopes hold the profile name, never cookie values or paths.
- Profile uses are recorded in `$STAGEFLOW_HOME/browser/audit.jsonl`.

## Clean up

Clear the login with `sf browser clear fixture-site` (see [CLI reference](../../docs/cli-reference.md)).

## Headed and headless

Stages are headed by default. All stages that share a profile should use the same mode, because headless Chrome reports a different user agent. `human-login` must stay headed. To run the check and work stages headless, set `headed: false` on all four `browser` blocks and log in once with a headed run first.

## Real sites

This example is neutral on purpose. Some sites forbid automation in their terms. Read the rules of any site before you point a stage at it. See [docs/browser.md](../../docs/browser.md#sites-can-forbid-automation).
