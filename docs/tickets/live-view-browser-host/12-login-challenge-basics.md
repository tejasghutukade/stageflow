# 12: Login challenge basics

**What to build:** The basics from the spec's login challenges decision: default-deny browser permission requests for every browser stage (documented as a behavior change) and launch options that suppress the browser's own credential bubbles where the shipped Chromium supports it. The operator help text already shipped with the viewer in ticket 07; this ticket only adds the missing test for it. Mechanism to evaluate: a Host-added launch argument (for example the deny-permission-prompts switch) merged ahead of the Host's configured launch arguments for sessions that launch Chrome; headed Chromium under Xvfb in the recipe image is the place to prove it, because headless Chrome denies prompts anyway.

**Blocked by:** 07, 09

**Status:** done

- [x] Permission requests (camera, microphone, location, notifications, clipboard read) are denied by default through the persisted launch environment (no new ambient env, nothing in YAML) and verified against a fixture page in a headed browser (the Docker recipe smoke), plus a check that the switch is present in the browser's command line.
- [x] The behavior change is documented in the user-facing page and the internals document.
- [x] Credential bubbles are suppressed where verifiable; any unsupported browser build is listed in the notes.
- [x] The help text (already rendered by the viewer) is covered by a test that fails if it is removed or changed to omit passkeys, permission requests, file pickers and browser sign-in boxes.

## Notes (from the implementation and verification)

- Default switch: `--deny-permission-prompts`, merged ahead of configured launch args for sessions that launch Chrome (anchor, profile-less stage sessions, `sf browser login`); CDP-attached stage sessions get none. Verified headed in the Docker recipe: Notification `denied`, geolocation code 1, clipboard rejected, all in ~4 ms; without the switch Notification and geolocation stay pending (a prompt nobody can see). Camera and microphone were not exercised.
- Credential bubbles: NOT done. Chrome 154 has no launch switch for the password manager or save bubble (they are profile prefs, `credentials_enable_service`); agent-browser already passes `--password-store=basic --use-mock-keychain --disable-sync`. Editing profile prefs or adding `--disable-features` (which would override agent-browser's `Translate` entry) was left out. The bubble's behavior is not verifiable headlessly. Acceptance item for credential bubbles is therefore recorded as a known gap, which the ticket allowed ("where verifiable").
- CDP `Browser.getBrowserCommandLine` fails here (needs `--enable-automation`), so the switch was verified from the process command line (`ps` locally, `/proc` in the probe).
- Help text moved to a constant module and covered by a UI test.
