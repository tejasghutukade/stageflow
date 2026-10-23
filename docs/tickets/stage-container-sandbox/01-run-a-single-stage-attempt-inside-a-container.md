# 01: Run a single stage attempt inside a container

**What to build:** A generic Docker image (node, git, gh CLI, the Stageflow stage-worker runtime) and a change to the stage launcher so a stage attempt runs via `docker run --rm`, mounting the stage's worktree read-write, instead of forking a Node worker process. Model credentials and GitHub tokens are forwarded into the container as explicit env vars, and the container's exit code is translated back into the same result the forked-worker path produces today.

**Blocked by:** None (can start immediately)

**Status:** done — implemented and verified against real Docker

- [x] A Dockerfile builds a generic agent image containing node, git, gh CLI, and the Stageflow stage-worker runtime, tagged `stageflow-agent:v1`.
- [x] The stage launcher starts a stage attempt via `docker run --rm`, mounting the stage's worktree read-write, instead of `fork()`-ing a Node worker process.
- [x] The model credential (e.g. `ANTHROPIC_API_KEY`) and `GH_TOKEN`/`GITHUB_TOKEN` are forwarded into the container via explicit env vars — not the full host environment.
- [x] The container's exit code is translated into the existing `StageLaunchResult` (`succeeded` / `failed` / `waiting`) the same way today's forked-worker exit code is.
- [x] Running `hello-world`'s `research` stage end-to-end through a container reaches the identical point host-process mode does (fails with the real, specific reason — no ANTHROPIC_API_KEY in this environment — not a container-mechanics error). Could not verify a full *success* end-to-end since no live model credential was available in this environment.
- [x] The container is removed after the attempt completes, on both success and failure (`--rm`) — no leftover containers.

Notes from real verification (not just unit tests):
- Mount had to be at the *same absolute path* as the host, not a fixed `/workspace` — the run store keeps absolute host paths the worker resolves verbatim. See the Dockerfile's own top comment.
- Discovered and fixed a Docker-Desktop-on-macOS virtiofs cache-coherency lag: a container's very first read of a SQLite row the host just wrote could see it as missing. Fixed with a bounded retry in `reloadRunCatalog.ts`.
- Container-mode failures initially lost the specific failure reason (no IPC channel across the docker boundary). Fixed by falling back to the captured stderr tail.
