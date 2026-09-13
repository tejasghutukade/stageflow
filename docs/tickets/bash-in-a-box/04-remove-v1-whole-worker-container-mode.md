# 04: Remove v1's whole-worker container mode

**What to build:** With Bash-in-a-Box working end to end (tickets 01-03), retire v1's "run the whole worker in a throwaway container" mechanism so there's exactly one container mode, not two. Remove `stageProcessLauncher.ts`'s `spawnContainer`, `buildContainerRunArgs`, `buildContainerName`, `buildCacheMountArgs`, and the `StageContainerOptions`/`container` constructor option entirely; the launcher always `fork()`s. Remove `tests/runtime.stageContainerLauncher.test.ts` and `tests/fixtures/mockDockerBin.mjs` (no longer exercised). Remove or repurpose v1's `Dockerfile` in favor of ticket 03's image. `STAGEFLOW_STAGE_CONTAINER_IMAGE`/`STAGEFLOW_STAGE_CONTAINER_DOCKER_BIN` env vars, if kept, now mean "image/bin for sandboxed Bash calls," not "image for the whole worker" — document the meaning change wherever they're referenced.

**Blocked by:** 02 (Stage worker owns per-attempt container lifecycle), 03 (New minimal sandbox image)

**Status:** ready-for-agent

- [ ] `spawnContainer`, `buildContainerRunArgs`, `buildContainerName`, `buildCacheMountArgs`, `StageContainerOptions`, and the launcher's `container` option are deleted from `stageProcessLauncher.ts`; `spawnAndWait` always uses `spawnHostProcess`.
- [ ] `tests/runtime.stageContainerLauncher.test.ts` and `tests/fixtures/mockDockerBin.mjs` are removed (superseded by tests added in tickets 01/02).
- [ ] v1's `Dockerfile` is removed or clearly repointed at ticket 03's image so there's exactly one image-build path left in the repo.
- [ ] Full test suite passes with no reference to the removed container-mode launcher surface anywhere (including `resolveContainerOptions`, `nextContainerNameSuffix`, `sanitizeContainerNameSegment` if unused elsewhere).
- [ ] Any leftover env var docs/comments describing "container mode runs the whole worker" are updated to reflect the new meaning (sandboxed Bash only).
