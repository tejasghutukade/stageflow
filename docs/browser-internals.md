---
layout: default
title: Browser sessions internals
---

# Browser sessions internals

For contributors and coding agents. This page says what the browser-sessions feature does, how the code fits together, and how to change or debug it safely. The user-facing page is [Browser sessions](browser.md). The design record is [docs/specs/browser-sessions.md](specs/browser-sessions.md) (Revision 2 wins over the earlier text). If this page and the code disagree, the code wins. Fix this page.

All paths are relative to the repo root. Names were checked against the code at the time of writing.

## 1. Status and scope {#status-and-scope}

### Implemented

- `browser:` stage field (`profile`, `headed`, `allow_domains`, `login_url`, `check`). Load, validate, `agent-browser` requirement added.
- Profile store with owner scope (`local`), validated names, owner-only folders under `$STAGEFLOW_HOME/browser/<scope>/<profile>/`.
- Run-scoped profile lease. One run holds a profile until it ends. Other runs queue and see the holder.
- One shared Chrome per run and profile (the anchor). Each stage gets its own agent-browser session and its own tab through CDP and `AGENT_BROWSER_PIN_TAB=1`.
- Profile-less browser stage: throw-away browser, no lease, native `AGENT_BROWSER_ALLOWED_DOMAINS`.
- Persisted, byte-identical stage browser env. Resume workers reuse it.
- Teardown: per stage (tab, then session), per run (anchor, then lease), cancel, abandon, fail, and a sweep at Host start.
- Host-computed login check (`browser.check`) and the human login stage (`verify: browser_login`), with repair loop on a wrong confirm.
- Host-stamped gate fields `handoff`, `site`, `profile`. The schema accepts `live_view`.
- Bundled `browser` skill (`builtin-skills/browser/SKILL.md`) and the stage prompt block.
- Redaction patterns for browser stages. Audit log. Host `browser.blocked_sites`.
- `sf browser profiles|status|check|login|clear`.
- Example `examples/browser-session/` and an opt-in real Chrome smoke test.

### Not implemented

| Item | State |
|------|-------|
| Live view handoff | Only the schema (`GateHandoff` has `live_view`). The Host always stamps `local_window`. |
| Remote browser host | Only the interface and `fakeRemoteBrowserHost.ts` (test double). |
| Host-side filtering proxy for profile stages | Not built. `allow_domains` is soft for profile stages. |
| Key wiring | `KeyProvider` exists but nothing in the runtime calls it. agent-browser's key does not protect a Chrome profile. |
| Session-state import (CI), `--restore`, `auth`, `--state` | Not used on purpose. |
| Parallel runs on one profile | Not possible by design. Other runs wait. |
| Passing an open page between stages | Out of scope. Pass a URL in the envelope. |
| Credential vault logins | Out of scope. The agent never types a password. |

### Known limitations {#known-limitations}

Found during review and real runs. None of the items below is fixed here.

1. **Soft allowlist audit is best-effort.** For profile stages with `allow_domains`, `teardownStageBrowser` reads `browser-policy.json`, audits explicit `agent-browser open|goto|navigate|tab new <url>` commands found in the stage's persisted tool activity (`store.listStageEvents`), then deletes the file. Redirects, link clicks, in-page navigation and navigation from non-bash tools are not seen. The audit runs after the stage ends and never blocks it. Events of all attempts of the stage are read together. `allow_domains` is still prompt-only for profile stages.
2. **`blocked_sites` runs at stage start only.** `assertBrowserSitesAllowed` runs when the stage has `allow_domains`, `check` or `login_url`, and `sf browser check|login` check their `--url` against the same list. It does not run at `sf validate`.
3. **Scope is hard-coded.** `LOCAL_BROWSER_SCOPE` is used directly in `stageBrowserEnv.ts`, `stageProfileLock.ts`, and `cli/browserCommand.ts`. It is not injected. A service needs this changed (section 8).
4. **Local-only teardown.** `closeBrowserSession` and the sweep assume a local agent-browser runner and a local socket root. A remote `BrowserHost` has no teardown or sweep path yet.
5. **Local paths in run files.** `<runDir>/browser/<profile>/anchor.json` and the `owner.json` of an anchor hold the profile folder path and the CDP address. They are run workspace files, not envelopes or run state. Do not export or share a run workspace dir.
6. **No lease wait limit.** A stage queued behind another run waits until that run ends. Only run end, cancel, abandon, or a Host halt stops the wait.
7. **Resume does not queue.** The resume path (`resumeViaSubprocess`) calls `acquireStageProfile` with `halted: () => true`. If another run took the lease, resume fails with "held by another run".
8. **Silent headless fallback on Linux.** A non-login stage with no `DISPLAY` or `WAYLAND_DISPLAY` runs headless even if it asked for headed. Mixed modes on one profile change the user agent.
9. **Host shutdown leaves browsers up.** On Host shutdown the scheduler skips run teardown (`hostShutdown`). The browsers stay until the next Host start. The sweep leaves live and waiting runs alone.
10. **Anchor death loses pages.** The Host restarts the anchor on the next stage start. Open pages are lost. Cookies stay (profile).
11. **Idle timeout is off.** `AGENT_BROWSER_IDLE_TIMEOUT_MS=0` means daemons never exit on their own. If teardown is skipped, the sweep is the only cleanup.
12. **Failed close.** If a daemon is still alive after `closeWaitMs`, `closeBrowserSession` returns `gone: false`. The `browser-closed.json` marker is not written and the socket files stay. Next teardown or the sweep retries.
13. **Platforms.** The spikes and the smoke test ran on macOS (arm64) with agent-browser 0.38.2 and Chrome for Testing 154. Linux and Windows are not verified in real runs.
14. **Spec items still open.** Story 11 (profile-less stages) is implemented but the user has not confirmed it. Story 47 holds only for profile-less stages. Story 49 is not met by a key (OS keychain and folder permissions are the protection). Tickets 00-12 checkboxes were not updated after Revision 2.
15. **`defaultLock` singleton.** `stageProfileLock()` builds one module-level local lock without `isRunLive`. Liveness comes from the callers (`acquireStageProfile`, sweep).

## 2. Mental model {#mental-model}

```
run R  (Host process: pipelineScheduler + runManager)
 |
 +-- lease: $HOME/browser/locks/local/<profile>.lock  = { runId: R }
 |        taken by the first stage that names <profile>; other stages of R join it
 |        released only by teardownRunBrowsers (run end / cancel / abandon / fail)
 |
 +-- anchor  (one per run + profile)         <runDir>/browser/<profile>/anchor.json
 |     agent-browser session "sf-<profile>", AGENT_BROWSER_PROFILE=<profileDir>
 |     owns the Chrome process; CDP ws://127.0.0.1:<port>/devtools/browser/<id>
 |     closed by: closeRunAnchors  (run end, cancel, abandon, fail, sweep)  -- never at stage end
 |
 +-- stage "check"  -> agent-browser session "sf-<profile>-<h6>"   env: CDP + PIN_TAB=1
 |     its own tab in the anchor Chrome       <runDir>/stages/check/browser-env.json
 |     closed by: teardownStageBrowser  = `tab close`, then `close`   (stage success or fail)
 |
 +-- stage "work-a" -> session "sf-<profile>-<h6>"  its own tab   (parallel, same lease)
 +-- stage "work-b" -> session "sf-<profile>-<h6>"  its own tab
 |
 +-- stage "scrape" with browser but no profile -> session "sf-t-<h12>", own throw-away Chrome,
       no lease, no anchor, native allowlist. closed by teardownStageBrowser (session close).

Who closes what, and when
  stage ends (succeeded or failed)  scheduler.startStage          -> tab + stage session
  stage waits at a gate             nobody                        -> all stay up, lease held
  run ends / fails                  scheduler (end of loop)       -> all stage sessions, anchor, lease
  run cancelled                     runManager.cancelRun          -> same
  last waiting stage abandoned      runManager.abandonStage       -> stage; run teardown if run is dead
  Host start                        sweepBrowserSessions          -> stale locks; sessions of dead runs
  Host shutdown                     nobody                        -> left for the next Host start
```

## 3. Module map {#module-map}

### `src/browser/`

| File | Responsibility | Key exports |
|------|----------------|-------------|
| `profileStore.ts` | Profile key types and name validation. Interface only. | `ProfileStore`, `ProfileKey`, `ProfileHandle`, `LOCAL_BROWSER_SCOPE`, `validateProfileKey`, `validateProfileName`, `validateProfileScope`, `InvalidProfileKeyError` |
| `localProfileStore.ts` | Folders under `$STAGEFLOW_HOME/browser/<scope>/<name>/{profile,state}`, mode 0700. Audits create and delete. | `createLocalProfileStore` |
| `memoryProfileStore.ts` | In-memory store with scopes. Test double for contract suites. | `createInMemoryProfileStore` |
| `profileLock.ts` | Lease interface. Identity is the run id. `stageId` is informational. | `ProfileLock`, `ProfileLockOwner`, `RunLiveness`, `sameOwner`, `lockKey`, `ownerMatches` |
| `localProfileLock.ts` | Lock files with `link` for exclusive create, rename-away for stale drop, corrupt-file recovery. | `createLocalProfileLock` |
| `memoryProfileLock.ts` | In-memory lease. Test double. | `createInMemoryProfileLock` |
| `stageProfileLock.ts` | Scheduler-side lease helper. Joins or queues, announces the holder. | `acquireStageProfile`, `profileWaitingMessage`, `stageProfileLock` |
| `browserHost.ts` | `BrowserHost` interface, request and env types, `StageBrowserSupport` (the injection bag), file name constants. | `BrowserHost`, `BrowserRunner`, `BrowserEnv`, `StageBrowserSupport`, `BROWSER_ENV_PREFIX`, `BROWSER_ENV_FILENAME`, `BROWSER_POLICY_FILENAME`, `shortHash` |
| `localBrowserHost.ts` | Builds every `AGENT_BROWSER_*` env, session names, short socket dirs, headed rule. Starts the anchor and reads its CDP address. | `createLocalBrowserHost`, `defaultSocketRoot` |
| `fakeRemoteBrowserHost.ts` | Test double: returns a fixed CDP address, no local profile path. | `createFakeRemoteBrowserHost` |
| `anchor.ts` | One anchor per (run, profile): in-process dedupe, cross-process dir lock, persisted `anchor.json`, restart handling. | `ensureRunProfileBrowser`, `readPersistedAnchor`, `anchorDir`, `BROWSER_ANCHOR_FILENAME`, `PersistedAnchor` |
| `stageBrowserEnv.ts` | The one entry the scheduler and resume use before launching a worker. Persists the env, writes owner and policy files, runs the login check or opens the login page. | `resolveStageBrowserEnv`, `readStagePersistedBrowserEnv`, `defaultStageBrowserSupport` |
| `persistedEnv.ts` | Reads a persisted env file. | `readPersistedBrowserEnv` |
| `browserTeardown.ts` | Graceful close with polling, per-stage and per-run teardown, `owner.json` writer, default runner (spawns `agent-browser`). | `closeBrowserSession`, `teardownStageBrowser`, `teardownRunBrowsers`, `closeRunAnchors`, `writeSessionOwner`, `defaultBrowserRunner`, `BROWSER_OWNER_FILENAME`, `BROWSER_CLOSED_FILENAME` |
| `browserSweep.ts` | Host-start sweep over the socket root using `owner.json`. Stage sessions first, anchors last. | `sweepOrphanBrowserSessions` |
| `runLiveness.ts` | "Is this run still able to use its browser?" from run status. Understands `cli-<pid>-` owner ids. | `createRunLiveness`, `cliRunLive` |
| `loginCheck.ts` | Glob match, check run, persisted result, prompt block, emit validation. | `matchLoginState`, `runLoginCheck`, `ensureStageLoginCheck`, `readStageLoginCheck`, `loginCheckPromptBlock`, `loginCheckIssue`, `BROWSER_LOGIN_CHECK_FILENAME` |
| `humanLogin.ts` | Human login stage detection, display probe, no-screen error, prompt block. | `isHumanLoginStage`, `defaultDisplayProbe`, `noScreenError`, `humanLoginPromptBlock`, `loginPageUrl` |
| `gateHandoff.ts` | Host-owned gate fields. Stamps and strips them. | `GateHandoff`, `HostGateContext`, `hostGateContextFor`, `stampGateRequest`, `parseHostGateContext`, `parseGateHandoff`, `browserSite` |
| `sitePolicy.ts` | Host `blocked_sites` check. | `assertBrowserSitesAllowed`, `BlockedSiteError`, `isBlockedHost`, `hostOf`, `normalizeDomain` |
| `navigationAudit.ts` | Soft allowlist audit from tool activity. Called from `teardownStageBrowser` (limitation 1). | `auditStageNavigations` |
| `auditSink.ts` | Audit records and sinks. Never breaks a run. | `AuditSink`, `AuditRecord`, `createLocalAuditSink`, `createMemoryAuditSink`, `safeAudit`, `localAuditLogPath` |
| `keyProvider.ts` | Host key file. **Unused by the runtime** (limitation, section 1). | `KeyProvider`, `createLocalKeyProvider`, `localKeyFilePath` |

### Other touched files

| File | Browser responsibility |
|------|------------------------|
| `src/types/stage.ts` | `StageBrowserConfig` type and `StageConfig.browser`. |
| `src/config/stageBrowser.ts` | `parseStageBrowser` (shape checks, rejects `path`, `scope`, `secret`), `withBrowserRequires`, `BROWSER_TOOL_NAME`. |
| `src/config/loadStage.ts`, `loadPipeline.ts`, `normalizePipelineStageEntry.ts`, `pipelineStageKeys.ts`, `resolvePipelineDag.ts` | Carry `browser` from stage file and pipeline entry (entry replaces file value). |
| `src/config/parseCompletionContract.ts`, `validateCompletionContract.ts`, `src/types/completion.ts` | `browser_login` verify item. Needs `browser.check`, rejects `headed: false`, after-phase only. |
| `src/config/builtinSkills.ts` | `BROWSER_SKILL_NAME`, `resolveBuiltinSkillFile` (finds `builtin-skills/browser/SKILL.md`). |
| `builtin-skills/browser/SKILL.md` | What the agent may run and the rules. |
| `src/config/hostConfig.ts` | `browser.blocked_sites` in `$STAGEFLOW_HOME/config.yaml` (`browserBlockedSites`). |
| `src/runtime/pipelineScheduler.ts` | Lease acquire, env resolve, launch with `browserEnv`, stage-end and run-end teardown. |
| `src/runtime/runManager.ts` | `sweepBrowserSessions`, `abandonStage`, `cancelRun`, `resumeViaSubprocess`, passes `browser` support down. |
| `src/runtime/stageAttemptBootstrap.ts` | Browser skill resolution, login-check and human-login prompt blocks, `browser_login_check` pre-emit check, redaction hooks for stream log and activity. |
| `src/runtime/stageRunner.ts` | Stamps Host gate fields, redacts the final envelope, passes `browserLogin` to verification. |
| `src/runtime/stageProcessLauncher.ts` | Merges `browserEnv` into the worker env, strips ambient `AGENT_BROWSER_*`, sets `STAGEFLOW_PI_HOME_AUTH_PATH`. |
| `src/runtime/stageEnvironment.ts` | `buildStageEnvironment` takes `runVars`. |
| `src/runtime/stageHitl.ts`, `src/tools/askOperator.ts` | Read and carry the Host gate fields on pending prompts. |
| `src/runtime/verifiedStageExecution.ts`, `completionCheckRunner.ts` | `browser_login` check: re-run the login check with the stage's persisted env. |
| `src/envelope/preEmitChecks.ts`, `src/types/preEmitCheck.ts` | `browser_login_check` pre-emit check (emit payload must match the Host result). |
| `src/agent/piAdapter.ts`, `src/agent/port.ts`, `src/agent/fakeAgent.ts` | Browser skill path, prompt guidance (`formatBrowserGuidance`), `/skill:browser` invocation; fake agent answers the login check. |
| `src/logging/redact.ts`, `src/agent/streamLogRedact.ts` | `BROWSER_SECRET_PATTERNS`, `BROWSER_STAGE_PATTERNS`, `redactBrowserSecrets`, `redactBrowserActivityEvent`. |
| `src/runtime/credentialBinding.ts` | `PI_HOME_AUTH_PATH_ENV`, `piHomeAuthPath`. |
| `src/server/bootstrap.ts` | Calls `manager.sweepBrowserSessions()` at Host start. |
| `src/cli/browserCommand.ts`, `src/cli.ts` | `sf browser`. Exit codes in `BROWSER_EXIT`. |
| `examples/browser-session/` | Fixture site (`fixture-server.mjs`) and the check, login, parallel work, merge pipeline. |

## 4. Runtime lifecycle {#runtime-lifecycle}

Hook points, in order. Process mode is the default. Names are in `src/runtime/pipelineScheduler.ts` unless noted.

1. **Lease acquire** (`launchStage`, before anything else for a stage with `browser.profile`). `acquireStageProfile` calls `ProfileLock.acquire({ scope: local, name }, { runId, stageId })`. Same run: joins at once. Other run: `queued`. While queued it releases one active slot, appends a `message` event with role `host` (`waiting for browser profile "<p>" held by run <id>`), reclaims stale locks, and polls every 250 ms. `schedulingHalt.halted` makes it return `halted` and the stage is skipped. Profile-less stages skip this step.
2. **Resolve the browser env** (`resolveStageBrowserEnv` in `stageBrowserEnv.ts`):
   1. Human login stage: probe the display. No screen: throw `noScreenError`.
   2. If `allow_domains`, `check` or `login_url` exist: `assertBrowserSitesAllowed` with Host `blocked_sites`.
   3. With a profile: `profiles.open` (creates the folder, audits `profile_created` once), then `ensureRunProfileBrowser` (anchor, below).
   4. `host.stageEnv(...)` builds the fresh env. `browser-closed.json` is removed.
   5. If `<stageDir>/browser-env.json` exists, it wins. If the anchor address changed, the old stage session is closed and only `AGENT_BROWSER_CDP` is replaced. If it did not exist, the fresh env is written and `profile_used` is audited. `browser-policy.json` is written on every env resolve when a profile and `allow_domains` are both set, and removed at teardown after the audit.
   6. `owner.json` is written into the stage's socket dir.
   7. Human login stage: open `login_url` (else `check.url`) in the stage session. Skipped when `resuming`. No pre-agent login check.
   8. Other stage with `check`: `ensureStageLoginCheck` opens the check URL, waits for network idle, reads the URL until it settles, matches the globs, and writes `browser-login-check.json` for this attempt.
   A throw here fails the stage through `onStageFailure`.
3. **Anchor** (`anchor.ts`, `localBrowserHost.ensureProfileBrowser`). An in-process promise map dedupes callers. A `anchor.lock` dir (pid inside, stale when the pid is dead, 120 s wait) serializes processes. No stored anchor: `open about:blank` with the anchor env, then `get cdp-url`. Stored anchor: `get cdp-url` is the liveness probe (any command relaunches a dead daemon). A headless stored anchor is closed and replaced when a human login stage needs it headed. Result goes to `anchor.json` (mode 0600, atomic rename) and the anchor's `owner.json`.
4. **Launch** (process mode). `launcher.launch({ ..., browserEnv })`. The launcher builds the worker env, removes every ambient `AGENT_BROWSER_*`, adds `browserEnv`, and sets `STAGEFLOW_PI_HOME_AUTH_PATH`. In the worker, `stageAttemptBootstrap` resolves the `browser` skill (run, checkout, Host, then built-in), reads the login check result (error `browser login check result is missing` if absent), appends the login-check or human-login prompt block, adds the `browser_login_check` pre-emit check, and turns on browser redaction. `stageRunner` stamps Host gate fields on every gate and, after verification, redacts the envelope before writing it.
5. **Verify.** A `browser_login` item calls `runLoginCheck` with the persisted env and `stage.browser.check` (`verifiedStageExecution.ts`). It passes only when the state is `logged_in`.
6. **Stage end.** `startStage` waits for `launchStage`. If the stage state is `succeeded` or `failed` it calls `teardownStageBrowser`: skip when `browser-closed.json` exists, `tab close` (only when the env has `AGENT_BROWSER_CDP`), `close`, poll until the socket and pid are gone, remove the session's socket files, write `browser-closed.json`. A `waiting` stage is not torn down.
7. **Run end** (end of the scheduler loop). If no stage is waiting (or scheduling was halted) and it is not a Host shutdown: `teardownRunBrowsers` closes every stage dir's session, then `closeRunAnchors` (graceful `close` with the stored anchor env, then deletes `anchor.json`), then `releaseOwner({ runId })`.
8. **Gate wait and resume.** The worker exits waiting. Everything stays open and leased. On answer, `runManager.resumeViaSubprocess` joins the lease (no waiting), calls `resolveStageBrowserEnv` with `resuming: true` (persisted env, no navigation), and launches mode `resume`. After the worker: not waiting means `teardownStageBrowser`. A failed result goes through `scheduleRepairAfterVerifyFailure`: if a repair attempt exists, `retryRun` runs and the answer returns `{ ok: true, verification: "failed_retrying" }` (this is the wrong-confirm loop). Otherwise the stage fails, the run fails, and `teardownRunBrowsers` runs. Success continues with `resumeRun`.
9. **Cancel.** `runManager.cancelRun` kills workers (`launcher.cancelRun`), then `teardownRunBrowsers`.
10. **Abandon.** `runManager.abandonStage` kills workers and calls `teardownStageBrowser`. If no stage waits and the run is no longer live, `teardownRunBrowsers`.
11. **Host start** (`server/bootstrap.ts`, after `reconcileOrphanedStages`). `sweepBrowserSessions`: `reclaimStale` on locks, then `sweepOrphanBrowserSessions` reads each `<socketRoot>/<hash>/owner.json`, skips live runs (an error counts as live), closes stage sessions first and anchors second, and removes the socket root when empty.
12. **Retry after the run ended.** A new anchor starts and the stage env gets the new address (covered by `runtime.browserEnv`).

## 5. Data and file layout {#data-and-file-layout}

`$HOME` below is `$STAGEFLOW_HOME` (default `~/.stageflow`). `<runDir>` is the run workspace dir (`run.workspaceDir`). `<stageDir>` is `<runDir>/stages/<stageId>`.

| Path | Written by | Mode | Lifetime | Sensitive? |
|------|-----------|------|----------|-----------|
| `$HOME/browser/<scope>/<profile>/profile/` | Chrome (via agent-browser) | 0700 dir | Until `sf browser clear` or store delete | **Yes.** Cookies and site data. Protected by folder mode and the OS keychain. |
| `$HOME/browser/<scope>/<profile>/state/` | `localProfileStore.open` | 0700 dir | Same | Empty today. Reserved. |
| `$HOME/browser/locks/<scope>/<profile>.lock` | `localProfileLock` | 0600 | While the run holds the lease | No. Holds `{ runId, stageId }`. Temp files `*.tmp` and `*.stale` are transient. |
| `$HOME/browser/audit.jsonl` | `createLocalAuditSink` | 0600, dir 0700 | Forever (append only) | Names, ids only. No paths, URLs, values. |
| `$HOME/browser/agent-browser.empty.json` | `localBrowserHost.build` (rewritten each time) | 0600 | Forever | No. `{}`. Pins `AGENT_BROWSER_CONFIG` so a project `agent-browser.json` is ignored. |
| `$HOME/browser/browser.key` | `createLocalKeyProvider.getKey` | 0600 | Only exists if something called `getKey` (the runtime does not) | Yes. |
| `/tmp/sfb-<uid>/<sha256(identity)[0:8]>/` (socket dir; `os.tmpdir()` on Windows) | `localBrowserHost.build` | 0700 | Per session. Removed by `closeBrowserSession` and the sweep. | Daemon files hold the last URL (`<session>.target`). |
| `<socketDir>/<session>.{sock,pid,config,engine,version,target,stream}` | agent-browser | 0600 | Until close | URL only. |
| `<socketDir>/owner.json` | `writeSessionOwner` | 0600 | Per session | The full session env, so an anchor's holds the profile path. |
| `<runDir>/browser/<profile>/anchor.json` | `anchor.ts` | 0600 | Until `closeRunAnchors` | CDP address and anchor env, **including the profile folder path**. |
| `<runDir>/browser/<profile>/anchor.lock/pid` | `anchor.ts` | default | While the anchor is being ensured | No. |
| `<stageDir>/browser-env.json` | `resolveStageBrowserEnv` | 0600 | Run life | CDP address (drives the browser while it is up), socket dir, session. No profile path. |
| `<stageDir>/browser-policy.json` | `resolveStageBrowserEnv` | 0600 | Run life | Names and domains. Written, never read (limitation 1). |
| `<stageDir>/browser-login-check.json` | `ensureStageLoginCheck` | 0600 | Run life | Final URL of the check page. Query strings may carry tokens, so treat as sensitive. |
| `<stageDir>/browser-closed.json` | `teardownStageBrowser` | default | Cleared when the env is resolved again | No. `{}`. |

The profile-less throw-away profile is made by agent-browser in `$TMPDIR/agent-browser-chrome-<uuid>` and deleted on `close`. A hard-killed daemon can orphan it. The sweep does not look for it.

## 6. Environment contract {#environment-contract}

The Host builds these in `localBrowserHost.ts` and persists them per stage. The agent never chooses them. The worker gets them as real process env (the Pi bash tool uses `process.env`).

| Variable | Anchor (owns Chrome) | Stage with profile | Stage without profile | Why |
|----------|---------------------|--------------------|-----------------------|-----|
| `AGENT_BROWSER_SESSION` | `sf-<profile>` (cut to 48 chars with a hash) | `sf-<profile>-<hash6(run/stage)>` | `sf-t-<hash12(run/stage)>` | Stable, unique, short. One daemon per session. |
| `AGENT_BROWSER_SOCKET_DIR` | `<root>/<hash8>` | same scheme | same scheme | Short dir (103-byte socket limit). Per-session so the sweep and teardown are local. |
| `AGENT_BROWSER_HEADED` | `1` or `0` | same | same | Headed unless the stage says `false`, or Linux has no display. Human login forces `1`. |
| `AGENT_BROWSER_IDLE_TIMEOUT_MS` | `0` | `0` | `0` | A headless daemon would exit after 1 h idle and lose the page while a gate waits. |
| `AGENT_BROWSER_CONFIG` | empty config file | same | same | Ignore `./agent-browser.json` in the stage cwd. |
| `AGENT_BROWSER_PROFILE` | profile folder | **never** | never | Only the anchor owns the profile. |
| `AGENT_BROWSER_CDP` | never | anchor CDP address | never | Attach to the shared Chrome. |
| `AGENT_BROWSER_PIN_TAB` | never | `1` | never | Own tab, stays on it. |
| `AGENT_BROWSER_ALLOWED_DOMAINS` | never | never | `allow_domains` joined by comma, if set | Native allowlist, only valid with no profile and no CDP. |
| `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY` | Linux, headed, copied from Host env if set | same | same | The stage env allowlist does not carry them. |

Other variables:

- `STAGEFLOW_PI_HOME_AUTH_PATH` (`PI_HOME_AUTH_PATH_ENV`). Set by `StageProcessLauncher` for every stage worker. A worker's `HOME` is an empty attempt dir, so Pi would not find `~/.pi/agent/auth.json` and the stage failed with "No API key". `piHomeAuthPath()` reads this variable first and falls back to `~/.pi/agent/auth.json`. Not browser specific, but real browser runs found it. Guard: `tests/runtime.piHomeAuthWorker.test.ts`.
- The default runner (`defaultBrowserRunner`) spawns `agent-browser` with only `PATH`, the Host's `HOME`, and the given env. `HOME` does not matter to the daemon match (spikes).

**Byte-identical rule.** Every agent-browser command of one session must carry the same launch-affecting env. If a client's env differs from the running daemon's, agent-browser silently kills and relaunches the browser. The page and session-only cookies are lost. So the env is computed once, written to `browser-env.json`, and read back by every attempt and resume worker. The only allowed change is `AGENT_BROWSER_CDP` after an anchor restart, and then the old stage daemon is closed first.

**Never set:**

- `AGENT_BROWSER_PROFILE` together with `AGENT_BROWSER_CDP`. Two owners of one profile.
- `AGENT_BROWSER_ALLOWED_DOMAINS` with a profile or CDP. agent-browser rejects it.
- `--restore`, `AGENT_BROWSER_RESTORE`, `agent-browser auth`, `--state`, `AGENT_BROWSER_ENCRYPTION_KEY`. They write under `$HOME/.agent-browser` which cannot be moved.
- Anything read from the Host's ambient env. `AGENT_BROWSER_*` in the Host env is ignored and stripped from workers.
- `HTTP_PROXY` / `HTTPS_PROXY` are on the stage env allowlist and agent-browser uses them as a proxy fallback. Do not widen the allowlist.
- A different `AGENT_BROWSER_IDLE_TIMEOUT_MS`, `AGENT_BROWSER_USER_AGENT`, or any launch flag in one command of a session. It relaunches the browser. The skill tells the agent to run bare commands.

## 7. Invariants and gotchas {#invariants-and-gotchas}

| # | Rule | Reason | Guarded by |
|---|------|--------|-----------|
| 1 | The stage browser env is byte-identical for every command, attempt, and resume worker. | A different launch env makes agent-browser relaunch the browser and lose the page. | `runtime.browserEnv` ("same env on every attempt"), `browser.host.contract` ("identical env"), `runtime.browserResume` |
| 2 | The socket path stays at or below 103 bytes. The host throws if it is longer. | Unix socket limit. Short root `/tmp/sfb-<uid>`, hashed dir, capped session name. | `browser.host.contract` ("socket path stays under 103 bytes"), `runtime.browserEnv` |
| 3 | `agent-browser close` returns before the daemon is gone. Poll for the socket and pid, then remove files. | An immediate re-open fails with "Failed to connect". | `closeBrowserSession`; `runtime.browserTeardown` fake runner removes `.sock` on close |
| 4 | Close the tab before the session. | Closing a session leaves its tab open in the shared Chrome. | `runtime.browserTeardown` ("closes the stage tab then its session"), smoke test |
| 5 | The anchor is never closed at stage end. | Session-only cookies and the other stages' tabs live in it. | `runtime.browserTeardown` ("keeps the anchor open between stages") |
| 6 | The lease is per run. Stage ids never matter. | Parallel stages of one run must not block each other. Other runs wait for the whole run. | `browser.profileLock.contract`, `runtime.browserLock` |
| 7 | A stage queued behind another run does not hold an active slot of its run. | A waiting stage would take a slot that this run's other stages need. | `runtime.browserLock` |
| 8 | Join topology for check, login, work: only `check -> login` has an `if`. The `check -> work` and `login -> work` edges have none. The work `io.input` must fit both parents' outputs. | A join runs only when every inbound `if` fired. With an `if` on `check -> work`, work is skipped when login runs, and the run still reports success. | `examples.browserSession`, `runtime.browserLoginCheck`, fixtures `browser-login-check` and `browser-human-login` |
| 9 | Redaction patterns apply to browser stages only. | They are broad and would damage ordinary output elsewhere. | `browser.redaction` ("does not apply browser patterns to the global default"), `runtime.browserPolicy` (non-browser stage unchanged) |
| 10 | YAML never carries a path or a scope. `path`, `scope`, `secret` fail load. | Scope and location are Host decisions (tenant isolation). | `config.loadStageBrowser`, `browser.profileStore.contract` |
| 11 | A human login stage forces headed and fails before the agent starts when the Host has no screen. | A hidden window cannot be used by a person. Docker has no live view yet. | `runtime.browserHumanLogin` ("no display"), `browser.host.contract` |
| 12 | Session-only cookies carry between stages of one run only because Chrome stays up. Across runs they are not guaranteed. | Chrome and agent-browser version dependent. Persistent cookies are safe. | smoke test log line, `docs/browser.md` |
| 13 | The CDP port is on `127.0.0.1` with no token. | Any local process can drive the browser while the run is active. A service must sandbox the browser. | Documented only |
| 14 | `allow_domains` is soft for profile stages. | agent-browser rejects its allowlist with `--profile` and `--cdp`. | `browser.host.contract` ("allowlist omitted on both") |
| 15 | After a failed `browser_login` verify the answer path returns `ok: true` with `verification: "failed_retrying"`, not an error. | The operator must get a new gate, not a failure. | `runtime.browserResumeVerify` |
| 16 | In-process execution cannot give the Pi bash tool the browser env. | The bash tool reads `process.env` of the Host. `stageEnv` in the scheduler feeds only completion checks. The scheduler default is `process` mode. | Design note. Browser tests use `executionMode: "process"`. |
| 17 | Host gate fields (`handoff`, `site`, `profile`) are stamped over whatever the agent sent, and stripped for stages without a browser. | The agent must not forge a handoff. | `runtime.browserHumanLogin`, `browser.gateHandoff` |
| 18 | The login check result comes from the Host, once per attempt, and the emit is checked against it. | The model must not decide whether it is logged in when patterns can decide. | `browser.loginCheck`, `runtime.browserLoginCheck` |
| 19 | A resume worker must not re-open the login page or re-run the check. | The operator's window is already on the page. | `runtime.browserResume` |
| 20 | `browser-closed.json` stops a second teardown. It is cleared when the env is resolved again. | A repeated `tab close` would re-attach to the shared browser and close another stage's tab. | `runtime.browserTeardown` |
| 21 | Teardown never signals Chrome. It uses `agent-browser close`. | A hard kill loses cookie persistence. | `closeBrowserSession` comment, smoke test |
| 22 | The sweep closes stage sessions before anchors and leaves live or waiting runs. An unknown liveness counts as live. | Stage daemons are attached to the anchor. A wrong close would destroy a waiting run's login window. | `runtime.browserTeardown` (orphan sweep tests) |
| 23 | `AGENT_BROWSER_CONFIG` always points at the Host's empty file. | `./agent-browser.json` in the checkout is honored otherwise. | `browser.host.contract` ("pins agent-browser config") |
| 24 | Tests inject a per-test `socketRoot` and the real socket root stays unused. | Leaked daemon files under `/tmp/sfb-<uid>`. | `tests/globalSetup.socketLeakGuard.ts` |
| 25 | Profile-less stages take no lease and no anchor. | Public pages should not queue behind a login. | `runtime.browserEnv` ("profile-less"), `runtime.browserLock` |
| 26 | Audit never breaks a run (`safeAudit` swallows errors). | Audit is not a gate. | `browser.auditPolicy` |
| 26a | A profile stage with `allow_domains` gets its navigations audited at teardown: `navigation_outside_allowlist {host}` once per host (hosts only), or `allowlist_unverified` when the log cannot be read. Stages without `browser-policy.json` write nothing. Callers pass an `events` reader. | Native allowlist is rejected with a profile. | `runtime.browserAllowlistAudit` |
| 26b | `blocked_sites` covers `allow_domains`, `check` URLs and `login_url` at stage start, and the `--url` of `sf browser check\|login` (exit 1, `browser_site_blocked`). | A blocked site must not be reached through any declared URL. | `browser.auditPolicy`, `cli.browser` |
| 27 | Profile names are validated in the store (letters, digits, `.`, `_`, `-`, no `..`) and stricter in YAML (no `.`). | Names become folder names. | `browser.profileStore.contract`, `config.loadStageBrowser` |

## 8. Seams for a multi-tenant service {#seams}

Hosted use is not built. These are the places a service would replace. Do not add local-only assumptions to callers.

| Seam | Local implementation | A service implementation must | Do not build into callers |
|------|---------------------|-------------------------------|---------------------------|
| `ProfileStore` (`profileStore.ts`) | `localProfileStore.ts` (folders, 0700, audit) | Store per-tenant data (encrypted volume or object store), implement `deleteScope`, never let scope A open scope B by name or path. | Path building. Only the store builds paths. Callers must use `ProfileHandle`. |
| Owner scope | Constant `LOCAL_BROWSER_SCOPE` | Derive the scope from the authenticated run owner. | The literal `local` (today in `stageBrowserEnv.ts`, `stageProfileLock.ts`, `browserCommand.ts`: pass the scope in instead). |
| `ProfileLock` (`profileLock.ts`) | `localProfileLock.ts` (files) | Distributed lease keyed by scope and name, identity = run id, `reclaimStale` against run status, idempotent release. | Anything that reads lock files, or assumes one process. |
| `BrowserHost` (`browserHost.ts`) | `localBrowserHost.ts` | `ensureProfileBrowser` returns a CDP address (a sandboxed or remote browser). `stageEnv` returns `AGENT_BROWSER_CDP`, a session, and pin-tab only. `profileBrowserEnv` returns the owning env. | `AGENT_BROWSER_PROFILE` in a stage env. The Chrome process on the Host. Socket dirs in teardown and sweep (limitation 4). |
| `BrowserRunner` | `defaultBrowserRunner` (spawns `agent-browser`) | Run agent-browser where the daemon lives. | A direct `execFile` call. |
| `KeyProvider` (`keyProvider.ts`) | Key file, unused by the runtime | Return a per-tenant key if a feature needs one. | Wiring it to agent-browser. Its key does not protect a Chrome profile. |
| `AuditSink` (`auditSink.ts`) | JSONL file; memory sink in tests | Write to the tenant's audit store. Never throw into the run. | Writing audit lines directly. Use `safeAudit`. |
| Handoff kind (`gateHandoff.ts`) | Always `local_window` (`hostGateContextFor`) | Stamp `{ kind: "live_view", url }` from a proxy with its own auth. | Showing a window from a worker. The console reads `handoff` only. |
| `RunLiveness` (`runLiveness.ts`) | Run status in the local store, plus `cli-<pid>-` ids | Answer from the service's run table. | Reading run meta from files. |
| `DisplayProbe` (`humanLogin.ts`) | `defaultDisplayProbe` | Say a screen exists only when a live view handoff exists. | `process.platform` checks. |

The shape that makes this work: a stage env is a CDP address, a session name, and pin-tab. The stage side does not care who owns Chrome.

## Multi-tenant to-do list {#multi-tenant-todo}

The feature is local and single-user today. These places must change before a hosted service. Each has a `TODO(multi-tenant)` comment in the code. Find them all with `grep -rn "TODO(multi-tenant)" src`.

| Item | Where | What to do |
|------|-------|------------|
| Fixed owner scope | `profileStore.ts` (`LOCAL_BROWSER_SCOPE`), used in `stageBrowserEnv.ts`, `stageProfileLock.ts`, `cli/browserCommand.ts` | Give each run an owner scope set by the Host from the signed-in user. Pass it to the store, the lease, the audit record, and the CLI. Never read it from YAML. Add a test with two scopes that proves scope A cannot reach scope B. |
| Key provider unused | `keyProvider.ts` | Call it where profile data is written, with a per-tenant key. Decide what it protects. |
| Local-only teardown and sweep | `browserTeardown.ts`, `browserSweep.ts` | Add a close and sweep path for a remote browser host. |
| Paths in run files | `anchor.json`, anchor `owner.json` | They hold a profile path and CDP address. Do not export or share a run folder as-is. A service should keep them out of tenant-visible files. |
| Unauthenticated local control port | shared browser (CDP on 127.0.0.1) | Run each tenant's browser in an isolated sandbox. |

When you remove a TODO, also update this table and "Known limitations".

## 9. How to extend {#how-to-extend}

### Add a `BrowserHost` implementation (for example remote)

1. Create `src/browser/<name>BrowserHost.ts` implementing `BrowserHost`. Follow `fakeRemoteBrowserHost.ts`: `ensureProfileBrowser` returns `{ cdpAddress, anchorEnv, restarted }`. `stageEnv` returns `AGENT_BROWSER_CDP`, `AGENT_BROWSER_SESSION`, `AGENT_BROWSER_IDLE_TIMEOUT_MS=0`, and `AGENT_BROWSER_PIN_TAB=1` for profile stages.
2. Inject it with `StageBrowserSupport.host` (`runManager` option `browser`, `startPipeline({ browser })`). Do not edit the scheduler.
3. Decide teardown. `closeBrowserSession` uses `AGENT_BROWSER_SOCKET_DIR`. If your env has none it returns `gone: true` after `close`. Check `owner.json` and the sweep for your case.
4. Tests: add the implementation to the `implementations` list in `tests/browser.host.contract.test.ts` (set `remote`). Add a pipeline test like `runtime.browserEnv` "with a remote host".

### Add a verify check type that touches the browser

1. Types: `src/types/completion.ts` and `parseCompletionContract.ts`. Rules in `validateCompletionContract.ts`.
2. Runner: add a case in `src/runtime/completionCheckRunner.ts` and an input callback like `browserLogin`. Feed it from `verifiedStageExecution.ts`, reading the env with `readStagePersistedBrowserEnv`. Never recompute the env.
3. Whole-run behavior: `stageRunner.ts` passes seams (`browser: { runner, loginCheck }`).
4. Update `docs/yaml-catalog.md` (verify table) and `docs/verified-stage-execution.md`.
5. Tests: `config.loadStageBrowser` (load and rejects), a fake-agent pipeline test with an injected runner (see `runtime.browserLoginCheck`).

### Add a Host config key

1. `src/config/hostConfig.ts`: extend the `browser` block parse (it rejects unknown keys under `browser`). Add a field to the config type.
2. Read it where used. `stageBrowserEnv.ts` reads `loadHostConfig().browserBlockedSites` only when `support.blockedSites` is unset. Add a matching optional field on `StageBrowserSupport` so tests can inject it.
3. Docs: `docs/browser.md` (Host config) and the Host config docs.
4. Tests: `browser.auditPolicy` has a "loads browser.blocked_sites from host config" example.

### Add a new login-check source

1. Keep the result shape `{ state, logged_in, url }`. The emit check (`loginCheckIssue`) and prompt block depend on it.
2. Add the matching in `loginCheck.ts` (`matchLoginState` is pure). New YAML keys go in `src/config/stageBrowser.ts` (`CHECK_KEYS`) and `StageBrowserConfig` in `src/types/stage.ts`. `sitePolicy.assertBrowserSitesAllowed` must see any new URL key.
3. The result is persisted once per attempt (`ensureStageLoginCheck`). A new source must keep that.
4. Docs: `docs/yaml-catalog.md` (Login check stage). Tests: `browser.loginCheck`, `config.loadStageBrowser`, `runtime.browserLoginCheck`.

### Change the stage env

1. Edit `localBrowserHost.ts` (`build` or the three env builders). Think about the byte-identical rule: any new variable that affects launch must be the same in anchor-attached stage sessions, and it changes every new stage. Existing persisted envs are not rewritten, which is correct for runs in flight.
2. Never add a variable that the agent or the Host's ambient env can choose.
3. Update the table in section 6.
4. Tests: `browser.host.contract` (local settings block), `runtime.browserEnv`. If the new variable is launch-affecting and the anchor and stage both carry it, check the anchor test too.

## 10. Testing guide {#testing-guide}

### The two seams

1. **Whole-pipeline fake-agent tests.** Start a pipeline through `startPipeline` (or `RunManager`) in `executionMode: "process"` with a fake `forkFn` launcher and an injected `BrowserRunner`. Assert on external behavior: launched worker env, `browser-env.json`, runner calls, run status, queue messages, gate payloads. Do not assert private call order.
2. **Contract suites.** `describe.each(implementations)` over the local and the in-memory (or fake remote) implementations: `browser.profileStore.contract`, `browser.profileLock.contract`, `browser.host.contract`. A new implementation joins the list.

### Helpers and patterns

- **Fake runner.** A `BrowserRunner` that records `{ args, env }`. It answers `get cdp-url` with `ws://127.0.0.1:41000/devtools/browser/anchor` (the anchor start reads it). In teardown tests `close` removes the `.sock` file so the poll sees the daemon gone. Tell the anchor call from a stage call by `env.AGENT_BROWSER_PROFILE !== undefined`.
- **Fake manifest.** `STAGEFLOW_TOOLCHAIN_MANIFEST` points at a JSON file: `{ "tools": { "agent-browser": { "path": "/bin/true", "version": "0.38.2" } } }`. Without it the `agent-browser` requirement fails preflight on a machine with no binary.
- **Per-test home and sockets.** `STAGEFLOW_HOME` to a temp dir plus `resetGlobalStageflowHomeForTests()`. Pass `socketRoot` to `createLocalBrowserHost` and to `StageBrowserSupport`. Remove the temp dir in `afterEach`.
- **Fake process launcher.** `new StageProcessLauncher({ forkFn, cliEntry: "unused" })` with a `forkFn` that returns an `EventEmitter` child and writes store events and the envelope itself.
- **Fake agent.** `scriptedFakeAgent` for the in-process path. `fakeAgent.ts` answers the `browser_login_check` pre-emit check.
- **Display control.** `createLocalBrowserHost({ platform, hostEnv })` and `support.display` to simulate Linux with or without a screen.
- **Socket leak guard.** `tests/globalSetup.socketLeakGuard.ts` (set in `vitest.config.ts`) fails the whole run and removes folders if a test left new dirs under `/tmp/sfb-<uid>`. The fix is a per-test `socketRoot`.

### Test files

| File | What it guards |
|------|----------------|
| `config.loadStageBrowser.test.ts` | Field load from stage file and pipeline entry, override, `requires` merge, invalid shapes and rejected keys, `login_url`, `browser_login` rules |
| `browser.profileStore.contract.test.ts` | Name and scope validation, idempotent open, per-scope list and delete, `deleteScope`, scope isolation, local 0700 |
| `browser.profileLock.contract.test.ts` | Exclusive lease, same-run join, run-level queue and release, stale reclaim, scope independence, corrupt lock files, concurrent acquirers |
| `browser.host.contract.test.ts` | Env purity and stability, anchor and stage env shapes, remote host, socket length, headed rules, Linux display, config pin |
| `browser.anchor.test.ts` | One anchor for concurrent callers, persist and reuse, address refresh, missing address error |
| `browser.loginCheck.test.ts` | Glob rules, logged-out wins, unknown state, timeouts, emit validation |
| `browser.gateHandoff.test.ts` | Handoff parsing, Host gate stamping, site rule |
| `browser.auditPolicy.test.ts` | Audit records, key file, `blocked_sites` (incl. `login_url`), navigation audit function |
| `runtime.browserAllowlistAudit.test.ts` | Whole pipeline: outside host audited once, allowed hosts silent, unreadable log gives `allowlist_unverified`, no records without a profile, policy file removed |
| `browser.redaction.test.ts` | Browser patterns, no effect on the default patterns, stream log |
| `browser.runLiveness.test.ts` | `cli-<pid>-` owner liveness |
| `browser.realChrome.smoke.test.ts` | Opt-in. Real Chrome: shared anchor, parallel tabs, per-stage and per-run teardown, no leftover files, cookies after reopen |
| `runtime.browserEnv.test.ts` | Env reaches the worker, ambient env ignored, headless rules, same env per attempt, remote host, one anchor for parallel stages, anchor per run, retry after run end |
| `runtime.browserLock.test.ts` | Run-level lease in pipelines (local and in-memory lock), queue message and holder, slot not held while waiting, release on fail and cancel, gate keeps lease, Host-start stale reclaim |
| `runtime.browserTeardown.test.ts` | Tab then session, anchor at run end, failure and timeout, gate wait, cancel, no browser calls without a field, orphan sweep order and cleanup |
| `runtime.browserLoginCheck.test.ts` | Host result handed to the agent, routing through login or skip, mismatch fails, unknown state |
| `runtime.browserHumanLogin.test.ts` | Host-stamped gate, window and lease stay open, wrong confirm loop, no-screen failure, non-browser gates clean |
| `runtime.browserResume.test.ts` | Resume does not reopen the page or re-run the check |
| `runtime.browserResumeVerify.test.ts` | Wrong confirm in process mode returns a retry, then success. Exhausted repair keeps the error |
| `runtime.browserPolicy.test.ts` | No cookie values or paths in envelopes, run state, artifacts. Audit of use. Blocked site fails the stage |
| `agent.piAdapter.browserSkill.test.ts` | Skill ships, resolution order, stage prompt guidance |
| `cli.browser.test.ts` | `sf browser` subcommands, exit codes, JSON shapes, lock behavior |
| `examples.browserSession.test.ts` | Example pipeline topology and the fixture server |
| `runtime.piHomeAuthWorker.test.ts` | Worker gets the Host's Pi auth path |

### Run the browser tests

```bash
npx vitest run tests/browser.*.test.ts tests/runtime.browser*.test.ts \
  tests/cli.browser.test.ts tests/config.loadStageBrowser.test.ts \
  tests/examples.browserSession.test.ts tests/agent.piAdapter.browserSkill.test.ts \
  tests/runtime.piHomeAuthWorker.test.ts
```

Then `npm test`, `npm run typecheck`, `npm run ui:test`.

### Real Chrome smoke test (opt-in)

Needs `agent-browser` on `PATH` and its Chrome (`npm i -g agent-browser && agent-browser install`). It uses the fixture server from `examples/browser-session/` on an ephemeral port and a temp home.

```bash
STAGEFLOW_BROWSER_SMOKE=1 npx vitest run tests/browser.realChrome.smoke.test.ts
```

Without the variable the suite is skipped. It runs headless. It checks the shared anchor, two parallel tabs, per-stage and per-run teardown, no Chrome left for the profile, no leftover socket files, and prints whether the session-only cookie survived a full close and reopen.

### Run a real end-to-end pipeline safely

Goal: run `examples/browser-session` without touching your own Host (default port 3847) or your own profiles.

1. Use a temporary home and a different service port in the shell that runs `sf`:
   ```bash
   export STAGEFLOW_HOME="$(mktemp -d)"
   export STAGEFLOW_SERVICE_PORT=3999     # any free port, not 3847
   export STAGEFLOW_MIN_FREE_DISK_BYTES=1073741824 # optional: enable free-disk admission (bytes or N%)
   ```
   `sf run` and `sf runs` auto-start a Host on that port when none answers, so the Host and the run state live in the temp home.
2. Credentials. A new home has no provider auth. Either point the credential source at the Pi home (`sf providers source set pi_home`, uses `~/.pi/agent/auth.json`, and workers get it through `STAGEFLOW_PI_HOME_AUTH_PATH`), or give Host-boot provider env such as `STAGEFLOW_PROVIDER_<ID>_API_KEY` (see [Providers](providers.md)). Never paste keys into pipeline files or logs.
3. Start the fixture site: `node examples/browser-session/fixture-server.mjs` (port 4173, or `PORT=...` and edit the pipeline URLs).
4. Build and run: `npm run build`, then `node dist/cli.js run --pipeline examples/browser-session/browser-session.pipeline.yaml --task examples/browser-session/browser-session.task.yaml --json`. Needs a screen for the login window. A machine with no screen fails the login stage on purpose.
5. Answer gates with `sf runs waiting` then `sf runs answer --run <runId> --stage <stageId> --answer '<json>'`. The JSON is an `AskOperatorAnswer`: for the login confirm gate it is `{ "kind": "confirm", "promptId": "<id from the pending prompt>", "decision": "accept" }`. Take `promptId` and `kind` from the prompt shown by `sf runs waiting` or `sf runs show`. Log in in the visible window first. A too-early accept returns `verification: "failed_retrying"` and a new gate.
6. Clean up: `sf browser clear fixture-site --yes`, stop the fixture server, stop the Host on the temp port, remove the temp home. Check with `ps` that no agent-browser or Chrome for Testing process remains for the temp profile.

## 11. Debugging cheatsheet {#debugging}

| Symptom | Likely cause | Where to look |
|---------|--------------|---------------|
| Stage fails with "No API key" in a worker | Worker `HOME` is an empty attempt dir and the Pi auth path was not passed | `STAGEFLOW_PI_HOME_AUTH_PATH` in the launcher (`stageProcessLauncher.ts`), `credentialBinding.ts`, `runtime.piHomeAuthWorker.test.ts`, `sf providers source get` |
| "browser socket path is N bytes (limit 103)" | `socketRoot` override is too deep, or a very long session name | `localBrowserHost.build`; use a short root |
| "waiting for browser profile X held by run Y" | Another run holds the lease | `sf browser status X` (holder and `live`), `sf runs show --run Y`. Locks of dead runs are reclaimed at Host start and while waiting. Lock file: `$HOME/browser/locks/local/X.lock` |
| Stage stuck in waiting for the profile | The holder run is alive and at a gate, or never reached a terminal state | Answer or cancel the holder run. Check `createRunLiveness` status rules (`created`, `queued`, `running` are live). There is no wait limit. |
| `sf browser` exit 2 | A live run holds the profile | `sf browser status <name>` |
| Orphan Chrome or `agent-browser` daemon | Teardown skipped (Host shutdown), Host killed, or `close` did not finish | Socket dirs under `/tmp/sfb-<uid>/*/owner.json` name the run. Restart the Host to run the sweep. Manual: run `agent-browser close` with the env from `owner.json`. Do not `kill` Chrome (cookie loss). |
| Leftover `.sock` or `.pid` files | `close` returned but the daemon was slow (`gone: false`) | `closeBrowserSession` and the sweep retry. `closeWaitMs` default 10 s |
| Wrong confirm loops without an error | Intended: failed `browser_login` check, repair policy runs the stage again | `on_verify_fail` on the login stage, `max_attempts`, `runtime.browserResumeVerify` |
| Wrong confirm returned an error response | Bug class fixed in `19d77723`. The answer must return `ok` with `verification: "failed_retrying"` | `resumeViaSubprocess`, `scheduleRepairAfterVerifyFailure` |
| Login window does not open in Docker | No screen. The login stage fails before the agent starts with the no-screen message | `defaultDisplayProbe` (`/.dockerenv`, `container` env, `STAGEFLOW_IN_DOCKER=1`), `humanLogin.ts`. Log in on a machine with a screen and reuse the profile, or use a headless check only |
| Login window does not open on Linux | No `DISPLAY` or `WAYLAND_DISPLAY` in the Host env | Same probe. The stage env gets them only for headed Linux sessions |
| Work stage skipped after login | `if` on the `check -> work` edge | Join topology rule (invariant 8) |
| Page and cookies vanish between commands | Launch env differs between commands of one session, or the anchor died | Compare `browser-env.json` with the env the command ran with. Check `anchor.json` `restarts` |
| Stage sees `about:blank` after attach | Fresh tab. The Host does not carry the open page between stages | Pass a URL in the envelope |
| `could not read the shared browser address` | `agent-browser get cdp-url` failed (old agent-browser, Chrome did not start) | Run the anchor commands by hand with the env from `owner.json`. Check the agent-browser install (`agent-browser install`) |
| `timed out waiting for the shared browser lock` | A dead process left `anchor.lock` and its pid is alive, or a long start | `<runDir>/browser/<profile>/anchor.lock/pid`. Stale locks (dead pid) are removed on their own |
| "login check: could not open URL" | agent-browser cannot start, or URL unreachable | Runner `open` timeout 60 s; check `agent-browser` on the stage `PATH` and the fixture server |
| Profile will not delete or open ("ProcessSingleton / SingletonLock") | Another Chrome has the profile | Two owners (a `sf browser login` and a run). The lease should prevent it. Close the stray Chrome gracefully |
| Stage failed with "blocked by Host policy" | `browser.blocked_sites` | `$STAGEFLOW_HOME/config.yaml`, `sitePolicy.ts` |
| Cookies or paths in a log | Stage has no `browser` field, so no browser patterns | `stage.browser` gates redaction in `stageAttemptBootstrap.ts` and `stageRunner.ts` |

## 12. Decision log {#decision-log}

| Decision | Reason | Spec |
|----------|--------|------|
| agent-browser, not Playwright MCP or Chrome DevTools MCP | Small CLI, profile and CDP support, daemon that survives worker death, Apache-2.0. | Implementation Decisions |
| CLI through the bash tool plus a skill, not an MCP server | The default MCP tool list is about 63,000 characters (29 tools). Playwright MCP is about 20,000. The Pi adapter registers every MCP tool, so the cost lands on every stage. | Implementation Decisions |
| Anchor plus CDP plus pin-tab, one tab per stage | agent-browser rejects two sessions on one profile (SingletonLock). A shared Chrome keeps session-only cookies and lets parallel stages work. Spiked with two attached sessions. | Revision 2, rules 3 and 4 |
| Run-scoped lease, not stage-scoped | Stages of one run must share the login and never block each other. Another run waits for the whole run. | Revision 2, rules 1 and 2 |
| Teardown does not depend on the worker | The worker can be killed. Daemon and Chrome survive it and need an explicit `close`. | Pre-build verification items 1 and 4 |
| Env computed once and persisted | A different launch env silently relaunches the browser. | Design decision 4 |
| Host-computed login check | A model should not decide a fact that a URL match can. The emit is checked against the Host result. | Implementation Decisions (Login check) |
| Join topology for check, login, work | Skip rules need it. Verified with the real runner. | Pre-build verification item 5, Design decision 5 |
| Soft allowlist for profile stages | agent-browser refuses its allowlist with a profile or CDP. A Host proxy is the later hard option. | Pre-build verification item 6, Design decision 1 |
| No key wiring | The agent-browser key protects only its own restore and state files, which this feature does not write. The Chrome profile uses the OS keychain and folder mode. | Pre-build verification item 7, Design decision 2 |
| Profile-less stage gets a throw-away browser | Follows from agent-browser behavior, is cheap, and is the only mode with a native allowlist. Awaiting user confirmation. | Pre-build verification item 9, Design decision 3 |
| Human login uses a visible window and the agent only asks for a confirm | Passwords and 2FA must not pass through the agent. The Host re-checks the login itself. | User stories 17 and 40 |
| `handoff` in the gate payload now, `live_view` accepted by schema | A hosted console can show a live view later with no schema change. | Pre-build verification item 8 |
| Graceful close only | Chrome loses cookie persistence on a hard kill. | Pre-build verification item 8 |
| Neutral local fixture site | Sites such as LinkedIn forbid automation in their terms. | Further Notes |

Spec: [docs/specs/browser-sessions.md](specs/browser-sessions.md). Tickets: `docs/tickets/browser-sessions/`.
