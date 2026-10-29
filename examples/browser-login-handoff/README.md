# browser-login-handoff

Log in to a site once in **your own Chrome**, then run headless in the Host's own browser. The Host copies the session after the login, checks that the headless browser stays logged in, and falls back to your Chrome when the site rejects a copied session. Reference: [docs/browser.md](../../docs/browser.md#login-handoff).

| Stage | What it does |
|-------|--------------|
| `check-login` | The Host opens GitHub's profile page in the headless browser and computes `{ logged_in, url }`. Routes to `human-login` only when `logged_in` is `false`. |
| `human-login` | Runs in your own Chrome (a new tab). You log in and accept the gate. The Host re-checks the login, then copies the session into the headless browser and runs the same `check` there. |
| `read-profile` | Reads `github.com/settings/profile` in the headless browser with the saved login. |

## Prerequisites

- Host config with a login host, for example [`docker/browser.login-handoff.config.example.yaml`](../../docker/browser.login-handoff.config.example.yaml) (`browser.login_host: attach` and `browser.attach.cdp_url`).
- Your own Chrome with a debugging port and a dedicated profile folder (see [Attach host](../../docs/browser.md#attach-host)):

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="$HOME/.stageflow-chrome"
```

## Run

```bash
npm run build
node dist/cli.js run \
  --pipeline examples/browser-login-handoff/github-handoff.pipeline.yaml \
  --task examples/browser-login-handoff/github-handoff.task.yaml
```

Use `sf ui` to answer the gate in the console.

## What to expect

1. First run: `check-login` finds no login in the headless browser, so `human-login` opens GitHub's sign-in page in your Chrome. Log in, accept the gate. `read-profile` then runs headless.
2. Second run: `check-login` finds the saved login in the headless browser. There is no gate and nothing happens in your Chrome.
3. If a site rejects the copied session, the Host keeps the run in your Chrome and remembers the profile (`host-hint.json` in the profile's state folder). Later runs of that profile use your Chrome from the start. Delete that file, or pin profiles yourself with `browser.profile_hosts`, to change it.

The session file is deleted as soon as it has been copied. Stages never see cookies. Some sites forbid automation in their terms: read them before pointing a stage at a real service ([docs/browser.md](../../docs/browser.md#sites-can-forbid-automation)).
