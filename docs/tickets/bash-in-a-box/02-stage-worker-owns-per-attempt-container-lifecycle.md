# 02: Stage worker owns per-attempt container lifecycle

**What to build:** `stageWorker.ts`'s `runStageWorker` starts a long-lived container scoped to the current stage attempt (`docker run -d --name stageflow-bash-<runId>-<stageId>-<attempt> -v <rootDir>:<rootDir> -w <rootDir> <image> sleep infinity`) before calling the agent, passes that container's name/id through to the `sandbox_bash` tool (ticket 01) for the duration of the attempt, and stops/removes it (`docker rm -f`) after the attempt finishes — on success, failure, or waiting. `stageProcessLauncher.ts` needs no new container-awareness for this: it goes back to always `fork()`-ing.

**Blocked by:** 01 (Route Bash calls into a container via toolAliases)

**Status:** done — implemented, code-reviewed, and verified (typecheck clean, full suite green)

- [x] A container is started at the beginning of a stage attempt (`stageWorker.ts`'s `runStageWorker`), named uniquely per run id + stage id + attempt via the reused `buildContainerName`/`sanitizeContainerNameSegment`/`randomUUID`-suffix approach from v1 (imported from `stageProcessLauncher.ts`, not reimplemented) — only when `STAGEFLOW_STAGE_CONTAINER_IMAGE` is set; unset is a complete no-op.
- [x] The mount is the identical absolute path on both sides (`<rootDir>:<rootDir>`, `-w <rootDir>`) — verified in `buildStartContainerArgs` tests.
- [x] `sandbox_bash` calls for an attempt route to that attempt's own container — `roots.containerName` (and now `containerDockerBin`, added during code review so a non-default docker binary is honored consistently for exec calls too, not just start/stop) is per-worker-invocation state, never shared.
- [x] The container is stopped and removed after the attempt concludes regardless of outcome (success, failure, or waiting) — a `finally` block in `runStageWorker` calls `stopSandboxContainer` unconditionally and swallows stop-failures without masking the real stage outcome; verified by dedicated tests for each of the three outcomes.
- [x] Fan-out clones get their own container for free — verified with a concurrent two-worker test (`tests/runtime.stageWorker.sandbox.test.ts`) showing distinct container names and independent start/stop pairs, no shared state.
- [x] `stageProcessLauncher.ts` was not touched by this ticket — it still always `fork()`s in host-process mode.

Code review caught and fixed two real issues before landing: (1) `containerDockerBin` wasn't threaded from container-start through to the `sandbox_bash` exec calls, so a non-default `STAGEFLOW_STAGE_CONTAINER_DOCKER_BIN` would silently fall back to plain `"docker"` at exec time — fixed by carrying it on `StageRoots`. (2) `execInSandboxContainer` mis-reported a genuine spawn failure (e.g. a bad docker binary) as a fake `exitCode: 1` command result instead of surfacing it as an infra error — fixed to throw on non-exit-code failures, now surfaced as `isError: true` from the `sandbox_bash` tool.
