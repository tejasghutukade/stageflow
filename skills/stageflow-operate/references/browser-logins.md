# Browser logins

Saved logins are profiles on this computer. `sf browser` manages them. It never starts a Host, and its output never includes a profile path or a cookie value. There is no MCP tool. REST mirrors the same actions at `/api/browser/profiles`.

Confirm before `sf browser login` (it opens a window on the user's screen) and `sf browser clear` (it deletes the saved login).

## Contents

- [Commands](#commands)
- [Login in the operator's Chrome](#login-in-the-operators-chrome)
- [A gate during a run](#a-gate-during-a-run)
- [Exit codes](#exit-codes)

## Commands

Run from the machine where the profile lives. Add `--json` and read the document on stdout.

| Command | What it does | Success JSON |
|---|---|---|
| `sf browser profiles` | List profiles. | `{ "profiles": [ { "name", "last_used", "sites", "login_where", "last_login_at", "last_verified_at", "pinned", "in_use" } ] }` |
| `sf browser status <name>` | Whether the profile exists, who holds it, and whether a browser session is open. | `{ "name", "exists", "locked", "lock", "session_open" }`. `lock` is `{ "run_id", "stage_id", "live" }` or null. |
| `sf browser check <name> --url <url> --logged-in <glob> [--logged-out <glob>]... [--headless]` | Open the URL in that profile and classify the final URL. | `{ "logged_in", "url", "state" }`. `state` is `logged_in`, `logged_out`, or `unknown`. |
| `sf browser login <name> --url <login-url> --logged-in <glob> [--timeout-sec <n>]` | Open a window and wait until the URL matches `--logged-in`. Default timeout is 300 seconds. Creates the profile. | `{ "logged_in", "url", "state" }`. `state` is `logged_in`, `timeout`, `closed`, or `interrupted`. |
| `sf browser clear <name> [--yes]` | Delete the profile. Without `--yes`, a terminal asks; a non-interactive shell exits `1` with code `confirmation_required`. | `{ "cleared": true, "name" }`. A declined prompt is `{ "cleared": false, "name" }` and exit `1`. |
| `sf browser unpin <name>` | Drop a learned pin so the Host uses its own browser for this profile again. | `{ "unpinned": true, "name", "profile" }` |

`login_where` is `host_browser`, `own_chrome`, or null. `pinned` is null, or `{ "by", "reason", "at" }` with `by` of `config` when Host config pins the profile.

`--url` is refused when the host is on the Host's `browser.blocked_sites` list (`blocked_site`). A missing profile on `check`, `clear`, or any command that does not create one is `not_found` (exit `1`). `login` is the command that creates a profile.

When the store schema is older than this binary, an existing profile lock is treated as still held by a live run. The command exits `2` with code `profile_busy` instead of opening the profile. `sf browser` will not start a Host to migrate the store. Run a command that does (see [control-surface.md](control-surface.md)), or migrate by starting `sf mcp`, then retry.

A profile held by a live run exits `2` with `profile_busy` and the holding run id. Wait until that stage finishes. Do not clear it out from under the run.

## Login in the operator's Chrome

The operator signs in themselves. You never type a password, a cookie, or a one-time code.

`sf browser login` opens a headed window on a computer that has a screen and waits until `--logged-in` matches the URL. Tell the user the window is theirs and what "done" looks like. Ctrl-C stops the wait (exit `130`). Closing the window or timing out exits `5`.

When Host config sets `browser.login_host: attach` and `browser.attach.cdp_url` to the operator's own Chrome (they start Chrome; Stageflow only attaches), a console or REST login opens a new tab in that Chrome. Those routes use the check already recorded on the profile (from a stage that ran with `browser.check` for this name). They take no body. `sf browser login` is the command that supplies `--url` and `--logged-in` itself.

- `POST /api/browser/profiles/<name>/login` starts it and returns `{ "where": "own_chrome" | "host_window", "site", "profile" }`.
- `POST /api/browser/profiles/<name>/login/finish` checks the login and records `login_where`. The body is `{ "ok", "state", "where", "profile" }`.
- `DELETE /api/browser/profiles/<name>/login` cancels it and returns the profile summary.

A profile with no recorded check fails with `no_recipe` (HTTP 409). A login already in progress is `login_in_progress`. A Host with no window and no attach config is `login_unsupported`. Tell the user to run `sf browser login` on a machine with a screen, or to set `browser.login_host: attach`.

After a successful attach login, the Host copies the session into its own browser when the site accepts the copy. When the site rejects that copy, the profile stays pinned to the operator's Chrome (`login_where: own_chrome`). Later stages for that profile use their Chrome.

`sf browser unpin` clears a pin the Host learned. A pin from `browser.profile_hosts` stays: the error code is `pinned_by_config`, and the user removes it in Host config. Unpinning a profile that is not pinned is `not_pinned`.

`POST /api/browser/profiles/<name>/check` re-checks a saved profile with the recorded check. `DELETE /api/browser/profiles/<name>` deletes it. Responses carry sites, times, and flags only.

## A gate during a run

A browser stage's waiting gate can include a host `handoff`. Read it from `list_waiting` or `sf runs waiting --json` and tell the user where to finish before you ask them to accept:

| `handoff` | Tell the user |
|---|---|
| `{ "kind": "local_window", "window": "own_browser" }` | A new tab in their own Chrome. Sign in there. |
| `{ "kind": "local_window" }` | A browser window on their screen. |
| `{ "kind": "live_view", "url" }` | The live view in the operator console (the URL is on the Host). |

The agent running the stage must not type credentials. Your job is to point the user at that window and then submit their confirm through `answer_gate`. See [native-question-ui.md](native-question-ui.md).

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | Ok, or the check/login saw a logged-in URL. |
| 1 | Error, missing profile, bad usage, blocked site, confirmation refused, or a pin that cannot be changed. |
| 2 | Profile held by a live run (`profile_busy`). |
| 3 | Check concluded logged out. |
| 4 | Check could not tell (`unknown`). |
| 5 | Login timed out or the window was closed. |
| 130 | Login interrupted (Ctrl-C). |

With `--json`, a failure is `{ "error", "code" }` on stdout and the exit code above. Branch on `code` and the exit code.
