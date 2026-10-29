# Browser stages and logins

Read this when a pipeline browses a site that needs a login. Full user docs: [`docs/browser.md`](../../../docs/browser.md#login-handoff).

## Shape

Check, human login, then work. The same `profile` on every stage that touches the site.

| Stage | `browser` | Notes |
|---|---|---|
| `check-login` | `profile`, `headed: false`, `check` | The Host computes `{ logged_in, url }`. The stage only reports it. |
| `human-login` | same `profile`, `login_url`, the **same `check`** | `gate_kinds: [confirm]`, `verify: browser_login`, repair `on_verify_fail`. Route `check-login` to it only when `logged_in` is false. |
| work stages | same `profile`; `headed: false` only for sites that accept a headless browser | Join `check-login` and `human-login`: edges into the work stage carry no `if`. |

## Choosing where a site is browsed

The Host decides, not YAML. Do not write a host, a path or a flag into a stage.

- If the Host has `browser.login_host: attach`, login happens in the operator's own Chrome and work runs headless. After a login the Host copies the session once into the headless browser and runs the login stage's `check` there. That `check` is how it learns whether the site accepts a copied session, so always give the login stage a `check`.
- If the site rejects the copy, the Host keeps the profile on the operator's Chrome from then on. The work stages still run, visibly, in that Chrome. Do not assume a work stage is headless.
- Whether a site accepts a copied session can depend on headed versus headless. Indeed (tested) accepted a copied session in a headed browser on a virtual display and rejected it headless, where the Host fell back to the operator's Chrome. The operator can pin a site to their Chrome with `browser.profile_hosts`. Say so in the pipeline's README rather than in a stage.
- Sites with strict bot or device checks (Google, LinkedIn) are untested for copied sessions. Never add steps that disguise the browser, solve a bot check, or change its user agent.

## Prompts

- The login stage prompt asks the operator to log in in "the open browser" and confirm. It never types credentials and never drives the page.
- Work stage prompts must say what to do when the page shows a login or a "Blocked" page: stop and emit `failure` with the reason. They never try to get around it.
- Keep work read-only unless an operator gate precedes the irreversible click.
