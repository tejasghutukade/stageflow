# 03: New minimal sandbox image (stageflow-bash:v1)

**What to build:** A new, smaller Dockerfile producing `stageflow-bash:v1` — git, common languages, and `gh`, but no node_modules/dist for Stageflow itself, since (unlike v1's image) this container's own process never runs Stageflow code — it only ever receives `docker exec bash -c` commands from the host-side worker.

**Blocked by:** None (can start immediately, in parallel with 01/02)

**Status:** done — implemented and verified against real Docker

- [x] Dockerfile (`Dockerfile.stageflow-bash`) builds successfully and produces a working `stageflow-bash:v1` image.
- [x] `git` and `gh` are present and functional inside the image — verified via `git version 2.39.5` / `gh version 2.100.0` inside a real running container.
- [x] The image does not bundle Stageflow's own `dist`/`node_modules` — confirmed by size comparison: `stageflow-bash:v1` is 908MB vs. v1's `stageflow-agent:v1` at 2.23GB.
- [x] Image starts and stays running under `docker run -d ... sleep infinity` and accepts `docker exec` commands against the mounted worktree (verified with a real container mounting this repo at its own absolute path).
