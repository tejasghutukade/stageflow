# Stage Container Sandbox — Spec (v1, local)

Status: draft, decisions locked with user 2026-09-13
Scope: local-only, single user, single machine
Related: [Stageflow Sandbox Blueprint](https://claude.ai/code/artifact/66a72166-792e-46fb-b311-dfb3287c8114) (architecture diagram), `.stageflow/runs/2026-09-13T05-57-10-857Z-8971b3` (reference run used to validate assumptions)

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

## Architecture

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

## Commit stage

- New stage type: `commit`. Runs `git add -A && git commit -m <message>` against the mounted worktree (message from the run's envelope or pipeline config).
- Requires no credentials beyond git author identity unless it also pushes — pushing uses `GH_TOKEN`, same env-var injection as above.
- `raise-pr` stays the stage that needs GitHub write access to open the PR; it depends on a preceding `commit` having actually run — if nothing was committed, it's an error, not a silent no-op.

## Image (v1 generic image)

- Base: node (matching this repo's `engines`), git, gh CLI, the Pi/agent runtime, and Stageflow's stage-execution entrypoint.
- Built once via a Dockerfile, tagged `stageflow-agent:v1`. Rebuilt manually on toolchain changes — no CI-driven rebuild pipeline in v1.

## Mounted vs. host-only

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

## Next steps

1. Write the generic Dockerfile + entrypoint script.
2. Update the stage runner to shell out to `docker run` instead of spawning a host process, leaving existing checkpoint/attempt bookkeeping untouched.
3. Add the `commit` stage type.
4. Smoke-test against one real pipeline shape (`plan → implement → review (fanout) → join-review → raise-pr`), including a deliberate mid-run failure to confirm retry still resets correctly through a container.
