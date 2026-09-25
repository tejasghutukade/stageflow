---
name: stageflow-setup
description: >-
  Installs Stageflow, scaffolds a starter catalog with sf init, then hard-stops
  for provider login. Optional Docker Compose path for a standing Host (UI+MCP).
  Use when this project has no Stageflow install, sf is not found, there is no
  catalog, first time running Stageflow here, the user asks to set up Stageflow,
  a provider is not logged in, or the operator wants Compose local try. Install,
  scaffold, and provider-gate only — does not author pipelines or stages, capture
  a session, or auto-start an MCP host.
disable-model-invocation: true
---

# Stageflow setup

Install the CLI, scaffold a catalog, then hard-stop until a provider is configured. Report `ready to author` or `blocked: <reason>`.

Author pipelines and stages with `stageflow-author`. Capture a chat or past session with `stageflow-session-capture`. Start, watch, or answer a run with `stageflow-run`. Codify a repeating pattern with `stageflow-delegate`.

This job does not author catalog YAML, capture a session, or auto-start an MCP host. Its default surface is the `sf` CLI; Compose local try (below) is the optional standing-Host path. Talking jobs cite [`../stageflow/references/control-surface.md`](../stageflow/references/control-surface.md) for MCP-vs-CLI; do not run the host probe in that file from this job.

## Detect-before-mutate

Re-derive readiness every invocation. Do not write a setup-complete marker.

Set `SF=sf`. After an EACCES fallback this invocation, set `SF='npx stageflow'` and use that prefix for every later CLI call.

Probe, in order:

1. `sf --version` — success means the CLI is on PATH. (After EACCES this invocation, use `$SF --version` instead.)
2. `stageflow.yaml` exists at the catalog root: git top-level when `git rev-parse --show-toplevel` succeeds, otherwise the current directory.
3. `$SF providers status` — a provider counts only when a row's second column is `configured`.

**Done when all three pass:** print `ready to author` and stop. Do not run `npm i -g stageflow` or `sf init`.

If any probe fails, repair only the failed phases below, in order. A failure prints `blocked: <reason>` and stops — do not guess the next phase.

## Install

Skip this phase when probe 1 passed.

1. Run `node --version`. **Done when** the major version is `>=20`. If Node is missing or older, stop:

   `blocked: node: Node >=20 is required. Install Node 20 or newer, then re-invoke stageflow-setup.`

   Do not install or switch Node versions.

2. Run `npm i -g stageflow`. Never `sudo`.

   - Success → keep `SF=sf`. **Done when** `sf --version` prints a version.
   - `EACCES` or a permission error → set `SF='npx stageflow'`. Use that prefix for the rest of this invocation only. Tell the operator a later invocation will re-check the global install. Then continue to Scaffold.
   - Any other error (network, registry) → stop. Do not fall back to `npx`.

     `blocked: install: npm i -g stageflow failed. Command: npm i -g stageflow. Error: <verbatim>`

## Scaffold

Skip `$SF init` when probe 2 passed.

1. From the consumer project directory, run `$SF init` only when `stageflow.yaml` is missing. `sf init` creates `stageflow.yaml`, `pipelines/hello.pipeline.yaml`, and `tasks/hello.task.yaml`, and skips any path that already exists. Create catalog files only with this command.

2. After `$SF init`, run `$SF validate --strict`. Print findings verbatim. **Done when** exit code is `0`. If it fails:

   `blocked: scaffold: sf validate --strict failed. <verbatim findings>`

3. If `git rev-parse --show-toplevel` fails after a create, tell the operator the catalog is not git-tracked. Do not run `git init`.

## Provider hard-stop

Run this phase only after Install and Scaffold have succeeded or were already satisfied. Never print `ready to author` while no provider is `configured`.

**Credential surface (do not mix):**

- **Local CLI** (this job's default path): `providers login --api-key-env` / bare `<ID>_API_KEY` (e.g. `ANTHROPIC_API_KEY`). See Stageflow docs: Providers.
- **Host / Compose boot:** `STAGEFLOW_PROVIDER_<ID>_API_KEY` or `STAGEFLOW_PROVIDER_<ID>_API_KEY_FILE`. Bare `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` alone does **not** configure Host boot. See Stageflow docs: Providers — Non-interactive Host boot credentials; Docker and self-hosting — Local try.

1. Run `$SF providers status`. **Done when** any row is `configured` — go to Completion. If a non-interactive login just succeeded, name that provider id.

2. If none are configured, run `$SF providers list`. For each id (first column), test whether the environment has `<ID>_API_KEY` with `ID` uppercased (`anthropic` → `ANTHROPIC_API_KEY`). Test presence only — do not read or print the value. Do not treat `STAGEFLOW_PROVIDER_*` as satisfying this local CLI gate.

3. On the first match, run:

   `$SF providers login <id> --type api_key --api-key-env <VAR>`

   Re-run `$SF providers status`. If that id is `configured`, go to Completion and name the provider. If the login fails, print the error verbatim, then continue to the walkthrough.

4. On no match, a failed login, or a session that cannot complete OAuth (no attached terminal, CI-shaped), stop. Print the commands; do not start a browser or device flow.

   `blocked: provider: no provider configured.`

   Then print these commands for the human (substitute real ids from `list`):

   ```
   $SF providers list
   $SF providers login <id> --type api_key --api-key-env <ID>_API_KEY
   $SF providers login <id> --type oauth
   ```

   Point at Stageflow docs: Providers (`pi_home` vs `sf_owned`). Leave the storage mode to the human. If the operator will use Compose instead, point them at the Docker Compose section below and `STAGEFLOW_PROVIDER_<ID>_API_KEY(_FILE)`.

## Completion

First line is exactly one of:

- `ready to author` — CLI present, catalog present, at least one provider `configured`.
- `blocked: <reason>` — name the phase (`node`, `install`, `scaffold`, or `provider`) and the next command.

If a non-interactive login just wired a provider, add a following line:

`provider: <id>`

If this invocation used the `npx` fallback, add a following line:

`CLI: npx stageflow (EACCES on npm i -g stageflow; this session only — a later invocation will re-check the global install)`

A later job calls this skill as preflight. It does not re-implement the provider gate.

## Optional: Docker Compose (standing Host)

This job does **not** auto-start `sf ui` or `sf mcp`. Compose local try is the path to a standing Host (operator console **and** MCP on port **3847**). Keep the npm / `sf init` / local provider path above for CLI authoring; use Compose when the operator wants a container Host.

Do not invent compose flags or env names. See Stageflow docs: Docker and self-hosting — Local try (checkout: `docs/docker.md`; also `.env.example`).

1. From a Stageflow checkout (or image + compose that matches shipped contracts), copy `.env.example` → `.env`. Do not commit `.env`.

2. Set `STAGEFLOW_CONTROL_TOKEN` to ≥32 characters, no whitespace (e.g. `openssl rand -hex 32`). Required when the image binds non-loopback.

3. Set Host boot providers as `STAGEFLOW_PROVIDER_<ID>_API_KEY` or `_FILE` (e.g. `STAGEFLOW_PROVIDER_OPENROUTER_API_KEY`). Not bare `OPENROUTER_API_KEY` alone.

4. Optional: `GITHUB_TOKEN` (or `GH_TOKEN`) for Host clone/fetch askpass — needed even for public repos.

5. **Shell env overrides Compose `.env`.** Empty exported `GITHUB_TOKEN` / `GH_TOKEN` blanks the container value. Prefer:

   ```bash
   env -u GITHUB_TOKEN -u GH_TOKEN docker compose up --build -d
   ```

6. Wait for live: `curl -fsS http://127.0.0.1:3847/livez` → `{"ok":true,"status":"live",…}`.

7. Open `http://127.0.0.1:3847` and paste the same control token under **Settings** (drive bearer for API/MCP).

After Compose is up, talking jobs use MCP with `Authorization: Bearer <drive-token>` — see [`../stageflow/references/control-surface.md`](../stageflow/references/control-surface.md). `/api/health` is ungated; a health 200 is not authenticated MCP.
