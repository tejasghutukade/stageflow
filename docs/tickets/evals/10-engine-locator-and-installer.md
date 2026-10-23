# 10: Engine locator, installer and telemetry guard

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 00

## Why this story exists

promptfoo is not an npm dependency of Stageflow (P1). Something must find it, install it on demand into `$STAGEFLOW_HOME`, refuse politely on an old Node, and provide the network guard that keeps promptfoo from contacting its servers.

## Read first

- [Epic](../../specs/evals.md): P1. [engine-interface.md](../../specs/evals-engine-interface.md): "Engine install layout", "Generated config" (telemetry paragraph).
- **Story 00 results** (items 1, 8, 9): the pinned version, minimum Node, install size/time, the exact telemetry hosts and the guard that worked, the kill sequence.
- `src/runstore/paths.ts` and `docs/data-directory.md` (how `$STAGEFLOW_HOME` is resolved; use the same helper, do not read the env directly), `src/agent/providerAuth.ts` (patterns for host-level state), `Dockerfile` (the build stage and runtime stage; Node 22 image), `docs/docker.md`.
- `src/cli/doctorCommand.ts` (add an engine check the way other checks are added).

## Decisions already made (do not revisit)

- Install location `$STAGEFLOW_HOME/eval-engine/<version>/`, marker file `.stageflow-installed` (JSON), installed with `npm` from `dirname(process.execPath)` into that directory only. Never global, never into the repo or the project.
- The pinned version and minimum Node come from story 00 and live in `src/evals/engine/promptfoo/pinned.ts` as constants (`PINNED_PROMPTFOO_VERSION`, `MIN_NODE`).
- The guard is a CommonJS preload that makes `fetch`, `http.request/get` and `https.request/get` to `*.promptfoo.app` and `*.promptfoo.dev` fail immediately; it is stored as a **string constant in TypeScript** and written to the engine work directory at run time (so nothing extra must be packaged in `dist/`).
- Errors: `EVAL_NODE_TOO_OLD` (message names the found and required versions), `EVAL_ENGINE_UNAVAILABLE` (not installed / wrong version / install broken; message includes `sf eval engine install`).

## What to build

1. **`src/evals/engine/promptfoo/pinned.ts`** (constants), **`nodeVersion.ts`** (`checkNode(version = process.versions.node, min = MIN_NODE)` using `semver`, already a dependency).
2. **`locate.ts`:** `locatePromptfoo({ home })` → `{ installed: true, version, binPath, dir } | { installed: false, reason }`; verifies the marker, the directory contents and that the installed `package.json` version equals the pinned one; a different installed version counts as not installed (message says which).
3. **`install.ts`:** `installPromptfoo({ home, runNpm, log })` creating the directory, running `npm install --no-audit --no-fund promptfoo@<pinned>` with `cwd` = the directory (`runNpm` injectable; the real one spawns the npm found beside `process.execPath`, streams output lines to `log`), verifying the version, writing the marker. Re-running with a good install is a no-op that says so. Failure leaves no marker and removes a half-created directory.
4. **`guard.ts`:** exports `GUARD_SOURCE` (the preload text) and a test helper that runs the guard in a child Node process to prove blocked hosts fail and other hosts are untouched.
5. **`status.ts`:** `engineStatus({ home })` → `{ installed, version, pinned, node, nodeOk, path, installCommand: "sf eval engine install" }`, used by the API (story 13), CLI (story 14) and `sf doctor`.
6. **`sf doctor`:** add a non-fatal check line for the eval engine (not installed is informational, not a failure) following the existing check structure.
7. **Docker:** in the runtime stage, install the engine at build time into the default `$STAGEFLOW_HOME` location the image uses (read `Dockerfile` and `docs/docker.md` for the home path), pinned, and note it in `docs/docker.md`. If installing at build time cannot be done without breaking a cached layer or the final user's home, stop and ask.

## Acceptance

- [ ] `checkNode` accepts and rejects around the minimum (tests with explicit version strings).
- [ ] `locatePromptfoo` returns not-installed for: no directory, no marker, wrong version, marker without binary; installed for a valid fake layout (tests build fake directories in a temp home).
- [ ] `installPromptfoo` with a fake `runNpm` writes the marker on success; on failure leaves nothing behind; a second run is a no-op; tests never run real npm.
- [ ] The guard test shows `fetch("https://r.promptfoo.app/x")` and `https.request` to `a.promptfoo.app` and `api.promptfoo.dev` reject, while a request to `127.0.0.1` on a local test server succeeds.
- [ ] `engineStatus` returns the documented shape; `sf doctor` prints the engine line without failing when not installed.
- [ ] Dockerfile installs the pinned engine (or the story is stopped with a question).
- [ ] `npm test` and `npm run typecheck` pass.

## Out of scope

The CLI command wiring (story 14), the HTTP endpoint (story 13), generating promptfoo config (story 11).

## Open questions

_(agent fills; stop and ask the owner)_
