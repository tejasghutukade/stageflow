# Docker and hosted

Use this instead of checklist steps 2 and 6 in `SKILL.md` when the user wants a container or wants Stageflow embedded in another application. Confirm before `docker pull`, `docker run`, or `docker compose up`. Those publish a process and can spend model money once a provider key is present. Do not put a key in a compose file that will be committed. Use an untracked env file or a secret the user exports.

This skill was checked against Stageflow 0.54.0. The image is published when that npm release is published.

## Contents

- Published image
- Run it
- Compose against the published image
- Checkout compose
- Commands inside the container
- Hosted library

## Published image

The image is `ghcr.io/tejasghutukade/stageflow`. Each release is tagged `x.y.z` and `x.y` (same digest, linux/amd64 and linux/arm64). For this skill that is `0.54.0` and `0.54`. Prefer a digest pin (`ghcr.io/tejasghutukade/stageflow@sha256:…`) for anything you will run again. The image is signed with keyless cosign on that digest.

The image already contains the CLI at `/usr/local/bin/sf`, the console assets, and the eval engine (promptfoo, about 1.2 GB under `/data/eval-engine/`). It does not contain a browser, `gh`, or your project's pipelines. It does not mount a Docker socket, so stage shell tools run inside this container.

Defaults baked into the image:

| Variable | Value | Why it matters |
|---|---|---|
| `STAGEFLOW_HOME` | `/data` | Store, logs, backups. Declare a volume here. |
| `STAGEFLOW_CREDENTIAL_HOME` | `/data` | `agent/auth.json` survives with the volume. |
| `STAGEFLOW_BIND` | `0.0.0.0` | Docker port publish needs a non-loopback bind. |
| `STAGEFLOW_NO_AUTOSTART` | `1` | The entrypoint is already the Host. A second one must not spawn. |
| `STAGEFLOW_NO_OPEN` | `1` | No browser to open inside the container. |
| `TMPDIR`, `SQLITE_TMPDIR` | `/data/tmp` | SQLite temp files stay on the volume. |

The image runs as uid 10001 (`stageflow`, `HOME=/data`) from the start. The entrypoint drops from root only if the container is started as root. The default command is `sf mcp` (headless REST and `/mcp`). Pass `sf ui` when you want the console. The health check is `GET /livez`, not `sf doctor`.

A new volume is seeded from the image, including the baked eval engine. A bind mount over `/data` hides that copy. Install the engine again inside the container if you need it on a bind mount.

## Run it

Local console, port published only on this machine, no token. Safe only because `127.0.0.1` is the published address. The allow flag is required: inside the container the bind is `0.0.0.0`.

```bash
docker pull ghcr.io/tejasghutukade/stageflow:0.54.0
docker run --rm --name stageflow \
  -e STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND=1 \
  -e STAGEFLOW_PROVIDER_OPENROUTER_API_KEY \
  -p 127.0.0.1:3847:3847 \
  -v stageflow-data:/data \
  ghcr.io/tejasghutukade/stageflow:0.54.0 \
  sf ui
```

`-e STAGEFLOW_PROVIDER_OPENROUTER_API_KEY` with no value forwards the variable from the shell. A bare `OPENROUTER_API_KEY` does not log the provider in at boot. See `providers-and-models.md`.

Open `http://127.0.0.1:3847`. MCP is `http://127.0.0.1:3847/mcp`. Wait for:

```bash
curl -fsS http://127.0.0.1:3847/livez
```

The body is `{"ok":true,"status":"live"}`. `/readyz` may still be 503 for a moment.

When the port is not limited to this machine, drop the allow flag, set a token, and publish deliberately:

```bash
export STAGEFLOW_CONTROL_TOKEN="$(openssl rand -hex 32)"
docker pull ghcr.io/tejasghutukade/stageflow:0.54.0
DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/tejasghutukade/stageflow:0.54.0)"
docker run --rm --name stageflow \
  -e STAGEFLOW_CONTROL_TOKEN \
  -p 3847:3847 \
  -v stageflow-data:/data \
  "$DIGEST"
```

That form uses the image's default command, `sf mcp`. Add `sf ui` as the command when you need the console. Send the same token as `Authorization: Bearer` on `/mcp` and `/api/*`. `/livez` stays open. The user must keep the token. Do not echo it.

`GITHUB_TOKEN` or `GH_TOKEN` is what the Host uses for git clone and fetch, including public repositories. Pass one of them when stages fetch from GitHub. An empty `GITHUB_TOKEN` does not blank `GITHUB_TOKEN_FILE`. Setting both a non-empty value and `_FILE` is an error.

Deleting the `stageflow-data` volume deletes runs and credentials. Run `sf backup` first (`setup.md`).

## Compose against the published image

This is the standing Host without a Stageflow checkout. Save it where the user wants to run compose. Do not commit the env file that holds keys.

```yaml
services:
  stageflow:
    image: ghcr.io/tejasghutukade/stageflow:0.54.0
    command: ["sf", "ui"]
    ports:
      - "127.0.0.1:3847:3847"
    environment:
      STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND: "1"
      STAGEFLOW_PROVIDER_OPENROUTER_API_KEY: ${STAGEFLOW_PROVIDER_OPENROUTER_API_KEY:-}
      STAGEFLOW_PROVIDER_ANTHROPIC_API_KEY: ${STAGEFLOW_PROVIDER_ANTHROPIC_API_KEY:-}
      GITHUB_TOKEN: ${GITHUB_TOKEN:-}
      GH_TOKEN: ${GH_TOKEN:-${GITHUB_TOKEN:-}}
    volumes:
      - stageflow-data:/data
    restart: unless-stopped

volumes:
  stageflow-data:
```

Shell environment overrides the env file. That is compose interpolation, a different mechanism from `GITHUB_TOKEN_FILE`: an empty exported `GITHUB_TOKEN` or `GH_TOKEN` blanks the container value. Start with those removed from the shell when the env file should win:

```bash
env -u GITHUB_TOKEN -u GH_TOKEN docker compose up -d
```

Do not pass `--build`. There is nothing to build. Remove `STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND` and set `STAGEFLOW_CONTROL_TOKEN` before you change the port mapping away from `127.0.0.1`.

After `curl -fsS http://127.0.0.1:3847/livez` returns 200, connect the harness as in `host-and-mcp.md`. With the allow flag and a localhost publish, no bearer is required.

## Checkout compose

The Stageflow repository ships a `docker-compose.yml` that builds the image from the checkout and also builds a `stageflow-bash` sandbox. That file sets `image: ghcr.io/tejasghutukade/stageflow:local`, `command: ["sf", "ui"]`, the same localhost publish, `STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND=1`, and a Docker socket mount so stage shell tools can start sandbox containers. Use it only when the user has a checkout and asked for that sandbox. It is not the path for a customer who installed this skill into their own project.

To point that file at a published image instead of a local build, set the service `image` to `ghcr.io/tejasghutukade/stageflow:0.54.0` (or a digest) and remove the `build` key. Keep the socket mount only if you still want the sandbox.

A browser stage needs a second image. The published image has no Chromium. Build the recipe `docker/Dockerfile.browser` from a checkout with `BASE_IMAGE` set to the published digest, and mount a Host config file at `/data/config.yaml` that sets `browser.executable_path`. Do not put browser paths in pipeline YAML.

## Commands inside the container

`STAGEFLOW_NO_AUTOSTART=1` means `docker exec` CLI verbs that need a Host will fail with `autostart_disabled` unless the entrypoint is already serving. Start the container first. Then:

```bash
docker exec -it stageflow sf providers status
docker exec -it stageflow sf doctor
docker exec -it stageflow sf validate --strict --json
```

OAuth login needs a TTY: `docker exec -it stageflow sf providers login <id> --type oauth`. Prefer boot env for API keys so nobody has to exec a secret in.

These stay CLI-only, so they are `docker exec` (or a laptop CLI), not MCP tools: `sf init`, `sf graph`, `sf migrate-yaml`, `sf doctor`, `sf providers login`, `sf skills install`, `sf browser`, `sf eval engine install`, `sf restore` while the Host is down, `sf a2a validate`, `sf a2a list`, `sf a2a add-caller`. The image already contains the eval engine, so `sf eval engine install` is for a volume that hid the baked copy.

`sf restore` still requires `/livez` to be down. Stop the container, or use `POST /api/restore` while it is up.

Unknown `STAGEFLOW_*` variables are rejected at boot unless `STAGEFLOW_ALLOW_UNKNOWN_CONFIG` is set. Do not invent names. The families that are accepted include `STAGEFLOW_PROVIDER_*` and `STAGEFLOW_CONTROL_TOKEN_*`.

## Hosted library

Hosted mode is a library call inside another application. It is not `sf ui`, not Docker, and not MCP. There is no CLI verb for it.

```ts
import {
  configurePiProviderApiKey,
  createHostedRuntime,
  createPiStagePort,
  createRunStore,
} from "stageflow";
```

`createHostedRuntime` takes `agent` (a `createPiStagePort()`), `localStore` (`createRunStore`), `eventSink`, and an optional `eventDeliveryTimeoutMs` (default 10 seconds). `runtime.run` takes `packageRoot`, `pipeline`, `taskYaml`, `context` (`externalRunId`, `externalAttemptId`, `packageRevision`), an optional `signal`, `timeoutMs`, and `maxActiveStagesPerRun`.

The call runs the pipeline in this process. The receipt's `executionMode` is `"inline"`. `coreVersion` is the installed package version. Pin the dependency to the release you tested.

Returned `status` is `succeeded`, `failed`, or `cancelled`. A human gate does not park. The result is `failed` with `code` `hitl_unsupported`. Do not destroy a sandbox and expect to resume that approval. Other returned failure codes are `agent_failed` and `timed_out`.

These are thrown as `HostedRuntimeError` and may have no local run id: `invalid_input` (bad task YAML, a store placed inside the package, credentials stuffed into `attributes`), `package_invalid` (missing package, or a pipeline path that escapes it), and `event_sink_failed`.

Store the provider key with `configurePiProviderApiKey` into an auth file, then set `STAGEFLOW_AGENT_AUTH_PATH` to that file before `run`. The key does not belong in the task YAML, the events, or `attributes`. Hosted runs do not create `~/.stageflow`. The caller owns the queue, the sandbox, and artifact storage. Skills shipped for the run live in the package at `.pi/skills/<name>/SKILL.md`, not in the operator home.
