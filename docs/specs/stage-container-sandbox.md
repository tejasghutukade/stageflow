# Stage Container Sandbox — Spec

Status: **v1 shipped** (commit `f40f1c1`, branch `worktree-stage-container-sandbox`) — **v2 (Bash-in-a-Box) is the current design direction, decisions locked with user 2026-09-13, not yet built.** V2 supersedes v1's container-execution mechanism specifically (the "Architecture" / "Image" / "Mounted vs. host-only" sections under **V1** below); it does not touch the checkpoint mechanism, the commit-stage philosophy, or the non-goals, which still apply unchanged. V1's sections are kept below for history, clearly marked.
Scope: local-only, single user, single machine
Related: [Stageflow Sandbox Blueprint](https://claude.ai/code/artifact/66a72166-792e-46fb-b311-dfb3287c8114) (v1 architecture diagram), [Bash-in-a-Box](https://claude.ai/code/artifact/116c1ac2-7146-4a84-8a79-d5d6dae05390) (v2 architecture diagram), `.stageflow/runs/2026-09-13T05-57-10-857Z-8971b3` (reference run used to validate v1's assumptions)

## V2 — Bash-in-a-Box

### Why this replaces v1's container-execution mechanism

V1 runs the *whole* stage worker — the agent, its file edits, everything — inside a throwaway container (`docker run --rm` wrapping `internal run-stage`). It works and is committed, but building and shipping it surfaced three real costs, all a direct consequence of the worker's own process being the thing inside the container:

- The model credential has to be forwarded into the container (`-e ANTHROPIC_API_KEY`) — it's the box's problem now, not just the host's.
- There is no IPC channel across a `docker run` boundary, so a failed attempt loses its specific reason; v1 patches this with a stderr-tail fallback (`reloadRunCatalog.ts`'s retry aside, this is a separate, real limitation — see `src/runtime/stageProcessLauncher.ts`'s `resultFromExitCode`/`buildChildEnv`).
- The image has to carry node, git, gh, *and* the entire Stageflow runtime (`dist/`, `node_modules`) just so the worker process can run at all inside it.

None of that is actually necessary. `@anthropic-ai/claude-agent-sdk` (already a dependency — see `src/agent/claudeAdapter.ts`) ships `toolAliases`, documented with this exact scenario: *"a host that runs Bash inside a remote sandbox via an MCP tool."* The insight: file edits (`Read`/`Write`/`Edit`) are just I/O against the mounted worktree — running them on the host is no less safe than running them in a container that mounts the identical directory. The only genuinely dangerous surface is `Bash` — arbitrary shell commands. So only `Bash` needs to cross into a container; the agent, its credentials, and its file edits can all stay exactly where they are today.

### Decisions

Resolved with the user on 2026-09-13:

1. **This replaces v1's container-execution mode**, rather than coexisting with it. `STAGEFLOW_STAGE_CONTAINER_IMAGE` (or its successor) comes to mean "sandbox Bash calls in a container," not "run the whole worker in one." V1's `StageProcessLauncher` container branch, `Dockerfile`, and the tests in `tests/runtime.stageContainerLauncher.test.ts` get replaced/removed as part of building this, not kept as a second mode.
2. **The stage worker owns the container's lifecycle**, not the launcher. `stageWorker.ts`'s `runStageWorker` starts a container before calling `runStage`/the agent, and stops it after — scoped to exactly one stage attempt (mirroring v1's "one container per attempt" principle, just at a different layer). `stageProcessLauncher.ts` needs no new container-awareness at all; it goes back to always `fork()`-ing, exactly as it did before v1.
3. **Same generic image as v1 for now** (git, common languages, gh) rather than per-project images — that question is deferred again, on the same reasoning as v1: good enough for known repos, revisit if it isn't.

### Architecture

Per stage attempt, inside `stageWorker.ts`'s `runStageWorker`:

1. Start a container scoped to this attempt (e.g. `docker run -d --name stageflow-bash-<runId>-<stageId>-<attempt> -v <rootDir>:<rootDir> -w <rootDir> stageflow-bash:v1 sleep infinity`) — long-lived for the duration of the attempt, not `--rm`-on-exit like v1's per-attempt containers, since it now gets `exec`'d into repeatedly rather than run once.
2. Call the agent (`claudeAdapter.ts`'s `query()`) with two new options alongside today's `tools: CLAUDE_BUILTIN_TOOLS`:
   - `toolAliases: { Bash: 'mcp__stageflow__sandbox_bash' }`
   - a `sandbox_bash` tool added to the existing `buildStageflowMcpServer` tool list (same `tool(name, description, shape, execute)` pattern as `emit_stage_envelope`/`write_stage_artifact` already use), whose `execute` runs `docker exec <container> bash -c "<command>"` and returns stdout/stderr/exit code as the tool result.
3. `Read`/`Write`/`Edit` are untouched — the SDK's own built-ins, operating directly on the host's copy of the mounted directory (which is the same directory the container sees, so nothing is out of sync).
4. `ANTHROPIC_API_KEY` never leaves the host process — the container only ever receives shell commands, never the credential.
5. When the stage attempt finishes (success, failure, or waiting), the worker stops and removes the container (`docker rm -f`) before returning its result — normal Node exit/IPC (`process.send`) works exactly as it always has, since the worker's own process was never containerized. **This is what makes the v1 "lost failure reason" problem disappear** rather than needing a workaround.

Fanout stages still get one container each (one per worker, and each fanout clone is its own worker) — this falls out of "the worker owns its own container" the same way v1's "one container per launcher attempt" did.

### What doesn't change

- The checkpoint/retry mechanism (`completion-checkout-before.json`, `gitCheckoutCapability`/`completionCheckRunner`) — untouched, same as v1's decision.
- The `commit` stage philosophy (explicit, never implicit) — see "Commit stage" below, still applies.
- `stageProcessLauncher.ts`'s host-process path (`spawnHostProcess`) — unchanged; there is no more container-mode branch to maintain in this file at all.
- Credential forwarding as bare env vars in general (still no full-environment passthrough anywhere) — just relocated: `ANTHROPIC_API_KEY` now never needs to be a container concern at all; `GH_TOKEN`/`GITHUB_TOKEN` only matter if a `Bash`-executed command (e.g. `gh pr create`) needs them, at which point they're forwarded the same bare-`-e` way v1 already established.

### New pieces to build

- A `sandbox_bash` MCP tool (`src/agent/claudeTools.ts`), following the existing `tool()` pattern.
- `toolAliases` wired into `claudeAdapter.ts`'s `query()` options.
- Container lifecycle helpers in `stageWorker.ts` (start-before / stop-after), replacing `stageProcessLauncher.ts`'s `spawnContainer`/`buildContainerRunArgs`/`buildContainerName`/`buildCacheMountArgs` and the `StageContainerOptions` surface, which this removes.
- A new, smaller image (`stageflow-bash:v1`?) — just git/common languages/gh, no node_modules/dist for Stageflow itself, since the container's own process never runs Stageflow code.

### Still open

- What exactly needs to be pre-installed in the box now depends on the *target repo*, not on Stageflow — sharper than it was in v1, since the box's only job is running that repo's own commands. Per-project images may become worth revisiting sooner than v1 expected, even though the decision for now is "same generic image."
- Everything v1 already deferred (auth, hosted orchestration, secrets, network allowlisting, per-project images, resource limits) is still deferred here.

---

## V1 (shipped, superseded by V2's architecture above)

## Context

Stage attempts currently run as plain host processes against a scoped git worktree (`docs/architecture.md:32`). This spec wraps each **stage attempt** in an ephemeral Docker container, so an agent's process — not just its files — is isolated from the host. This is deliberately scoped to local, single-user use: auth, orchestration across users, and secrets management are a separate, later problem once this runs on a server.

Assumptions here were checked against a real run in progress (`.stageflow/runs/2026-09-13T05-57-10-857Z-8971b3`):
- `implement` took 4 attempts; attempt 4 ran ~8 hours after attempt 3.
- `review` fanned out into 4 concurrent clones (`review~1..4`) finishing within ~60 seconds of each other.
- Each attempt already has its own `artifacts/`, `pi-session.jsonl`, `completion-candidate-envelope.json`, and a `completion-checkout-before.json` fingerprint manifest taken before the attempt runs.

These observations rule out a single long-lived container for the whole pipeline (can't span an 8-hour gap or a 4-way concurrent fanout) and confirm the existing checkpoint mechanism is already filesystem-based, not process-based — this spec builds on it rather than replacing it.

## Goals

- Each stage attempt runs inside its own ephemeral Docker container (`docker run --rm`), not a host process.
- No change to existing retry/checkpoint semantics.
- No implicit git commits — committing is a deliberate, visible pipeline action.
- State persists across attempts via the mounted worktree and cache volumes, not container lifetime.
- Runs entirely locally, single user, no server component.

## Non-goals (explicitly deferred)

- Multi-tenant hosting, GitHub App auth, per-user secrets, remote orchestration.
- Per-project custom images — v1 ships one generic image.
- Network egress restriction/allowlisting.
- Container CPU/memory limits.
- Concurrent multi-run infra beyond what already exists.

## Decisions

Resolved with the user on 2026-09-13; do not relitigate without a reason:

1. **Checkpoint/retry mechanism: reuse `completion-checkout-before.json` unchanged.** The container work is purely additive — it changes *what* runs a stage attempt (container vs. host process), not how retry/rollback decides what to reset to.
2. **Credentials: injected via environment variables from the host at `docker run` time** (`ANTHROPIC_API_KEY`, `GH_TOKEN`, etc.). No credential files baked into the image, no secret storage system built for v1.
3. **Commit trigger: a dedicated `commit` stage type**, placed explicitly in the pipeline YAML wherever a real commit should happen. No other stage type commits, ever, implicitly.
4. **Image: one generic base image for v1** (node + git + gh CLI + the agent runtime). Rebuilt manually when the toolchain changes; no per-project Dockerfiles yet.

## Architecture (superseded — see V2's Architecture above)

Per stage attempt, the orchestrator:

1. Resolves paths: the stage's git worktree, its attempt's artifacts directory, and shared cache volume paths (e.g. `node_modules`, npm cache).
2. Takes a checkpoint — **unchanged**, via the existing `completion-checkout-before.json` fingerprint manifest.
3. Runs the container:
   ```
   docker run --rm \
     -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
     -e GH_TOKEN=$GH_TOKEN \
     -v $WORKTREE:/workspace \
     -v $RUN_CACHE/node_modules:/workspace/node_modules \
     -v $RUN_CACHE/npm:/root/.npm \
     stageflow-agent:v1 \
     <stage-entrypoint>
   ```
4. The agent runs inside the container, writes code changes to `/workspace` and cross-stage context to `/workspace/artifacts/<stage>/attempt-N/`. It does not commit anything unless this attempt *is* a `commit` stage.
5. Container exits (`--rm`). The orchestrator reads results straight off the mounted worktree/artifacts — no `docker cp` needed, since nothing was container-local.
6. On failure, retry resets the worktree using the existing checkout-before manifest, then spins up a fresh container for the next attempt — same retry cadence/limits as today (observed: up to at least 4 attempts, with gaps of any length, including 8+ hours).

Fanout stages (`review~1..4`) get one container per clone, run concurrently. This falls out of "one container per attempt" for free — no separate mechanism needed.

## Commit stage (applies to both V1 and V2, unchanged)

- New stage type: `commit`. Runs `git add -A && git commit -m <message>` against the mounted worktree (message from the run's envelope or pipeline config).
- Requires no credentials beyond git author identity unless it also pushes — pushing uses `GH_TOKEN`, same env-var injection as above.
- `raise-pr` stays the stage that needs GitHub write access to open the PR; it depends on a preceding `commit` having actually run — if nothing was committed, it's an error, not a silent no-op.

## Image (v1 generic image) — superseded, see V2's "New pieces to build"

- Base: node (matching this repo's `engines`), git, gh CLI, the Pi/agent runtime, and Stageflow's stage-execution entrypoint.
- Built once via a Dockerfile, tagged `stageflow-agent:v1`. Rebuilt manually on toolchain changes — no CI-driven rebuild pipeline in v1.

## Mounted vs. host-only (superseded — V2 mounts the same way, but only the Bash-exec container needs the mount, not a worker process)

- **Mounted (read-write) into the container:** the stage's git worktree; shared cache volumes.
- **Host-only, never mounted:** `.stageflow/runs/<run-id>/` metadata (envelopes, checkout manifests, session logs) beyond the current attempt's own directory. The container only needs the worktree and the path the orchestrator points it at for its own artifacts — not the run's full bookkeeping.

## Assumptions carried into v1 (flag if any of these are wrong)

- No network egress restriction — containers get normal internet access; isolation is filesystem-only via mounts.
- No CPU/memory limits — single local user, not shared infra.
- One pipeline run at a time is the common case; nothing here blocks two, but concurrent-run behavior isn't explicitly tested in v1.

## Out of scope (future work)

- GitHub App auth, per-user token scoping, multi-tenant orchestration, secrets vault.
- Per-project custom Dockerfiles/images.
- Network allowlisting / restricted egress.

## V1 completion status

Shipped in commit `f40f1c1`. Tickets in `docs/tickets/stage-container-sandbox/`:

1. Run a single stage attempt inside a container — **done**, verified against real Docker.
2. Retry resets correctly through a container — mechanics verified; a live `sf runs retry` wasn't exercised (an active Stageflow host was running and blocked CLI store mutations).
3. Concurrent fan-out attempts each get their own container — **done**, verified (concurrency cap, cache-mount scoping, unique naming), a real multi-clone pipeline run wasn't exercised (no live model credential in that environment).
4. Commit-and-PR pattern works inside a container — safe mechanics verified (git/gh functional, credentials forwarded, a container-made commit persists to the host); live PR creation deliberately not attempted (needs explicit user go-ahead + a real credential).
5. Full pipeline smoke test through containers — blocked on a real model credential.

The `commit` stage type itself needed no new code — see the "Commit stage" section above.

**Next steps are now V2's** — see "New pieces to build" under Bash-in-a-Box.
