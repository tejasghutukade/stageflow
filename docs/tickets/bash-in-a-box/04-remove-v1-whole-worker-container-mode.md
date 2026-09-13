# 04: Remove v1's whole-worker container mode

**What to build:** With Bash-in-a-Box working end to end (tickets 01-03), retire v1's "run the whole worker in a throwaway container" mechanism so there's exactly one container mode, not two. Remove `stageProcessLauncher.ts`'s `spawnContainer`, `buildContainerRunArgs`, `buildContainerName`, `buildCacheMountArgs`, and the `StageContainerOptions`/`container` constructor option entirely; the launcher always `fork()`s. Remove `tests/runtime.stageContainerLauncher.test.ts` and `tests/fixtures/mockDockerBin.mjs` (no longer exercised). Remove or repurpose v1's `Dockerfile` in favor of ticket 03's image. `STAGEFLOW_STAGE_CONTAINER_IMAGE`/`STAGEFLOW_STAGE_CONTAINER_DOCKER_BIN` env vars, if kept, now mean "image/bin for sandboxed Bash calls," not "image for the whole worker" — document the meaning change wherever they're referenced.

**Blocked by:** 02 (Stage worker owns per-attempt container lifecycle), 03 (New minimal sandbox image)

**Status:** done — implemented and verified (typecheck clean, full suite green)

- [x] `spawnContainer`, `buildContainerRunArgs`, `buildContainerName` (v1's copy), `buildCacheMountArgs`, `StageContainerOptions`/`StageContainerCacheMount`, `resolveContainerOptions`, `nextContainerNameSuffix`, and the launcher's `container` constructor option are all deleted from `stageProcessLauncher.ts`; `spawnAndWait` now always calls `spawnHostProcess` — no branch left. `buildContainerName`/`sanitizeContainerNameSegment` still exist, but relocated into `src/runtime/sandboxContainer.ts`, their one remaining consumer (ticket 02's real usage), not left dangling in the deleted file.
- [x] `tests/runtime.stageContainerLauncher.test.ts` and `tests/fixtures/mockDockerBin.mjs` removed.
- [x] v1's `Dockerfile` replaced by ticket 03's `stageflow-bash:v1` image content — one image-build path left in the repo, confirmed rebuilding from the new canonical `Dockerfile` path is a clean cache hit against the same image.
- [x] Full suite: 195 files / 2117 tests passed (down from 196/2137 pre-removal — exactly the 1 file / 22 tests deleted, no other regressions); typecheck clean; repo-wide grep confirms zero references left to any removed symbol.
- [x] `SANDBOX_CONTAINER_IMAGE_ENV`/`SANDBOX_CONTAINER_DOCKER_BIN_ENV` (`sandboxContainer.ts`) are now the only definitions of these env var names in the repo — the "reuses v1's names, temporarily duplicated" comment from tickets 01/02 was removed since there's no longer a second definition to reconcile with.
