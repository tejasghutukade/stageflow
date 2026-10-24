---
layout: default
title: Providers
---

# Providers

Stageflow runs stages on **Pi** (`@earendil-works/pi-coding-agent`). Model provider authentication is Pi-compatible — reuse an existing Pi login or store credentials in a Stageflow-owned file.

Provider management is via `sf providers` and the console **Settings → Providers** page.

## Credential storage

Provider credentials live in the operator auth file:

`<credential-root>/agent/auth.json`

`STAGEFLOW_CREDENTIAL_HOME` sets that root to a directory. When it is unset, the root is the host user's `~/.stageflow`, and the file is `~/.stageflow/agent/auth.json`. `models.json` sits beside the auth file. The Cursor key file is `<credential-root>/agent/cursor-api-key`.

A job-local or Docker data directory is its own operator when `STAGEFLOW_CREDENTIAL_HOME` is set to that directory. The image, Compose, `scripts/docker-smoke.sh`, and the release and publish workflows already set the override. [`scripts/start-ui-local.sh`](../scripts/start-ui-local.sh) sets `STAGEFLOW_HOME` to the repo's `.stageflow-dev` and leaves the override unset, so that server shares the machine operator store.

When an existing login lives under a non-default data directory, set `STAGEFLOW_CREDENTIAL_HOME` to that directory.

**Cursor models** use the **`pi-cursor-sdk`** npm package shipped as a Stageflow dependency (`npm i stageflow` / `npm ci` in the repo). You can still install a copy under `$STAGEFLOW_HOME/agent/npm/` via `pi install npm:pi-cursor-sdk` if you override the default. Stage workers receive the auth path through `STAGEFLOW_AGENT_AUTH_PATH` (Host passes the operator auth file).

Check binding:

```bash
sf providers source get
sf providers detect
```

`detect` prints `authConfigured`, `credentialSource`, `provisional`, and `bindingSource`. Until you connect at least one provider (console **Connect** or `sf providers login`), `credentialSource` may be unset and binding is **provisional**.

Persist the store choice (always Stageflow-owned):

```bash
sf providers source set sf_owned
```

Legacy `pi_home` in `settings.json` is treated as `sf_owned` on read.

## Non-interactive Host boot credentials

At Host boot (`sf ui` / `sf mcp`), Stageflow configures providers from:

- `STAGEFLOW_PROVIDER_<ID>_API_KEY`
- `STAGEFLOW_PROVIDER_<ID>_API_KEY_FILE` (trims one trailing newline)

Do not set both. The Host re-reads these variables **at every boot** and writes the key into the auth file again, so a key supplied this way comes back after a restart even if you replaced it or disconnected the provider in the console; remove the variable to stop that. Unreadable files soft-fail by default (Host still starts). `STAGEFLOW_REQUIRE_PROVIDERS=id1,id2` makes missing providers fatal. OAuth remains interactive via `sf providers login … --type oauth`.

The run store and Host Pi agent directory live under the **global durable root** (`$STAGEFLOW_HOME`, default `~/.stageflow/`). Project settings (`<git-root>/.stageflow/settings.json`) are separate from global auth and are not the run store. See [Data directory](data-directory.md).

Provider API keys are **not** passed into stage process environments. Model auth continues via `authPath` (file binding). Claude backend refuses to start as root (`euid=0`) because the SDK requires `bypassPermissions`. See [migration-stage-environment.md](migration-stage-environment.md).

**Docker Compose:** set `STAGEFLOW_PROVIDER_OPENROUTER_API_KEY` / `STAGEFLOW_PROVIDER_ANTHROPIC_API_KEY` (or `_FILE`) in `.env` — bare `OPENROUTER_API_KEY` alone does not configure Host boot. See [Docker — Local try](docker.md#local-try-compose) and [`.env.example`](../.env.example).

**Health fields:** `GET /api/health` and MCP `get_health` expose `boot_providers` (Host boot env snapshot) and `providers_live` (live summary + note). The legacy `providers` key matches `boot_providers`. Empty boot configured does **not** imply CLI is unconfigured — compare `stageflow_home` and use `list_providers` / `sf providers status` for live auth. See [MCP — get_health](mcp.md#get_health).

The console **Connect** flow (`#/connect`) mirrors CLI login for browser-based setup.

## CLI commands

```bash
sf providers list
sf providers status [--provider <id>]
sf providers detect
sf providers source [get | set sf_owned]
sf providers login <providerId> [--type api_key|oauth] [--api-key-env <VAR>]
sf providers logout <providerId>
```

### `list`

Tab-separated: `id`, display name, supported auth types (`api_key`, `oauth`).

### `status`

Per provider: `configured` or `disconnected`, plus `kind` and `source` when configured.

### `login`

- **API key:** interactive prompt or `--api-key-env VAR` (reads from environment)
- **OAuth:** browser/device flow via terminal interaction
- If a provider supports both methods, pass `--type api_key` or `--type oauth`

Raw `--api-key` on the command line is rejected.

Example for CI:

```bash
sf providers login anthropic --type api_key --api-key-env ANTHROPIC_API_KEY
```

### `logout`

Clears stored credentials for one provider id.

## Model resolution

`model` is the LLM/provider id passed to the active agent backend. It is resolved per stage as:

```text
stage.model ?? pipeline.model ?? stageflow.yaml model
```

If still unset after that chain, load/run fails with a clear error — Stageflow never invents a silent hardcoded model string. `agent` (Pi vs Claude SDK) is a separate field with its own hierarchy; see [Architecture](architecture.md) and [YAML catalog — Model defaults and precedence](yaml-catalog.md#model-defaults-and-precedence).

Stages may still set an explicit model:

```yaml
model: anthropic/claude-sonnet-4-5
```

Or omit it when a pipeline or manifest default fills the value. The provider must be configured before runs succeed. Validation does **not** check provider auth — that is checked at run time.

## Pi shell, not a separate runtime

Stageflow is a thin orchestration layer on Pi. You do **not** need Pi CLI `/login` as a hard prerequisite if you configure providers via `sf providers` or the console.

**Cursor API key:** set `CURSOR_API_KEY` on the Host before `sf ui` / `sf mcp` starts, or put the key in `<credential-root>/agent/cursor-api-key` (mode `0600`, no trailing newline). You can also use `CURSOR_API_KEY_FILE`. A key in `.zshrc` alone does not reach the Host if you start Stageflow from the IDE or another environment that never loads your shell profile.

## Models

One catalog supplies every model list and the default model: the stage, pipeline, Workshop, Settings and agent pickers, `GET /api/models` and MCP `list_models`.

- **Connected providers only.** A provider appears once it has credentials (stored, or from `STAGEFLOW_PROVIDER_<ID>_API_KEY` at boot). Cursor models appear only when Cursor is connected.
- **Live, with a fallback.** The Host asks each connected provider for its current model list through Pi's model registry (OpenRouter's free models, for example), caches it for 30 seconds and in Pi's `models-store.json`, and falls back to Pi's built-in list when a provider is unreachable (that provider shows "built-in list"). `POST /api/models/refresh`, or the refresh button in a picker, forces Pi to refetch.
- **Ids are `provider/model`**, the form Pi resolves and stage, pipeline and agent files store.
- **Custom ids still work.** A picker accepts any `provider/model` you type. An id no connected provider lists is saved and runs as written; the picker and agent validation warn "not in connected providers". Hand-written YAML with such ids still loads.
- **Default model.** `stageflow.yaml` `model`, then the Settings Workshop model, then the catalog's pick: `openrouter/nvidia/nemotron-3.5-lightning:free` when connected, else the first free model, else the first model, never a Cursor model while another exists. Hosts resolve it at boot.

`GET /api/models` returns `models` (catalog plus ids pipelines use), `providers` (grouped, with `source`, `free`, `contextWindow`, `nativeTools`), `default`, `fetchedAt` and `unlisted`.

## Console

**Settings → Providers** lists providers and their connection status. A connected provider has a **Provider actions** menu (the vertical dots):

- **Replace API key** (providers that take a key) opens the key field.
- **Sign in again** (providers that use OAuth) restarts the browser sign-in.
- **Disconnect** asks first ("Disconnect <provider>? Agents and evals that use it will stop working.") and removes the stored credential only after you confirm.

A provider whose key comes from `STAGEFLOW_PROVIDER_<ID>_API_KEY` is configured again at the next Host boot (see above). The TypeSafe row holds the key that [failure sorting](evals.md#sort-failures) uses.

**Connect** (`#/connect`) — guided provider setup from the rail footer link when disconnected.

## See also

- [CLI reference](cli-reference.md) — full `sf providers` usage
- [Quick start](quickstart.md) — first provider connection
- [CI / headless](ci.md) — `--api-key-env` in GitHub Actions
- [Operator console](operator-console.md) — Settings and Connect pages

## OpenRouter routing

OpenRouter serves one model from several providers and load-balances between them, weighted by price. Providers differ in quantization and in how well they return tool calls, so the same model id can behave differently from one request to the next. Two things are worth knowing:

- **Stageflow asks OpenRouter to skip providers that cannot honour the request's tools** (`require_parameters`) on every stage and agent request that carries tools. Routing you set yourself wins.
- **OpenRouter's own Auto Exacto** reorders providers by tool-call reliability on tool requests for models it covers. Setting `order` or `sort` turns that off.

If a model returns its tool call as plain text, the stage fails with `provider error: the model wrote its tool call out as plain text…` instead of a generic missing-envelope error. Run again, choose another model, or pin the providers for that model in `$STAGEFLOW_HOME/agent/models.json`:

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "deepseek/deepseek-chat-v3.1": {
          "compat": { "openRouterRouting": { "order": ["SiliconFlow", "CoreWeave"], "allow_fallbacks": false } }
        }
      }
    }
  }
}
```

Pinning gives up fallback: if the pinned providers are down, requests fail. Provider routing is a Host setting, not part of pipeline YAML.
