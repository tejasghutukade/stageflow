# Providers and models

Log in before `sf init`, and before any command that calls a model. A real run and an eval cost money. Confirm with the user first. Never print, log, or write a key.

`sf providers` has no `--json`. Read the tab-separated lines. `sf providers --help` prints the verbs below and nothing else.

## Contents

- See what is configured
- Log in on a machine with a person
- Log in without a prompt
- Where the secret is stored
- Keys the Host reads at boot
- Choose a model
- Judge providers
- Cursor
- What is not checked

## See what is configured

```bash
sf providers list
sf providers status
sf providers status --provider <id>
sf providers detect
sf providers source get
```

`list` columns are id, display name, and capabilities (`api_key`, `oauth`, or `none`). A trailing column is the OAuth label when the provider has one.

`status` columns are id, then `configured` or `disconnected`. A configured row adds `kind=<api_key|oauth>` and `source=sf_owned`. The checklist is done when the provider you will use says `configured`.

`detect` prints `authConfigured`, `credentialSource` (or `credentialSource=(unset)`), `provisional`, and `bindingSource`, tab-separated. Until the first successful login, the source is often unset and the binding is provisional. That is not a failure.

`sf providers source set` accepts only `sf_owned`. Anything else exits 1 with `source set requires sf_owned`. A `pi_home` value in settings is ignored. Do not tell the user to set `pi_home`.

```bash
sf providers source set sf_owned
```

## Log in on a machine with a person

```bash
sf providers login <id>
sf providers login <id> --type api_key
sf providers login <id> --type oauth
sf providers logout <id>
```

A provider that supports only one of `api_key` or `oauth` does not need `--type`. A provider that supports both exits with an error unless you pass `--type`. OAuth needs a terminal. It is a browser or device-code flow. Do not start it from a session with no terminal, and do not paste the key or the device code into chat. Tell the user the command and stop.

An API-key login with no `--api-key-env` prompts on the terminal. A raw `--api-key` flag is rejected: `Raw --api-key is not supported; use a prompt or --api-key-env <VAR>`.

`logout` clears the stored credential for that id. The Host will write it back on the next boot if `STAGEFLOW_PROVIDER_<ID>_API_KEY` is still set.

There is no MCP tool for login or logout. The console Settings page can connect a provider. REST can too (`POST /api/providers/<id>/login`). Do not call that route with a key from chat. The person types the key, or it is already in an environment variable.

## Log in without a prompt

Use this in CI and in an agent shell. The key must already be in the environment. Test that the variable is non-empty without reading or printing it.

```bash
sf providers login anthropic --type api_key --api-key-env ANTHROPIC_API_KEY
```

Then run `sf providers status --provider anthropic` and check for `configured`.

A bare `<ID>_API_KEY` (for example `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`) is only an input to `--api-key-env`. It does not configure the Host at boot. See the next section.

## Where the secret is stored

CLI login writes `<credential-root>/agent/auth.json`.

`STAGEFLOW_CREDENTIAL_HOME` sets that root. When it is unset, the root is `~/.stageflow`, so the file is `~/.stageflow/agent/auth.json`. `models.json` is in the same directory. This root is not the project, and it is not `STAGEFLOW_HOME` unless you point them at the same directory. Docker images set both to `/data` so the named volume keeps the login.

Stage processes do not receive provider API keys in their environment. The Host passes the auth file path as `STAGEFLOW_AGENT_AUTH_PATH`.

`sf doctor`'s `credentials` check does not read this file. It only looks for `STAGEFLOW_PROVIDER_*_API_KEY` in the environment. A stored login can still produce `[warn] credentials`. That warning is explained in `troubleshooting.md`. Trust `sf providers status` for whether a login exists.

## Keys the Host reads at boot

`sf ui` and `sf mcp` configure providers from the environment when they start:

- `STAGEFLOW_PROVIDER_<ID>_API_KEY`
- `STAGEFLOW_PROVIDER_<ID>_API_KEY_FILE` (one trailing newline is trimmed)

`<ID>` is the provider id, uppercased, with `-` written as `_` (`openrouter` → `STAGEFLOW_PROVIDER_OPENROUTER_API_KEY`). Do not set both the value and the `_FILE` form. The Host logs in again on every boot and writes the key back into `auth.json`. Removing the provider in the console does not stick while the variable is set. Unset the variable to stop that.

A missing or unreadable file is a soft failure: the Host still starts, and that provider is absent. `STAGEFLOW_REQUIRE_PROVIDERS=openrouter,anthropic` (comma-separated ids) makes a missing id fatal at boot.

`GET /api/health` and the MCP tool `get_health` expose `boot_providers` (what boot env configured) and `providers_live` (what `auth.json` has now). An empty `boot_providers` does not mean the CLI login is missing. Use `sf providers status` or the MCP tool `list_providers`.

## Choose a model

A model id is `provider/model`, the same string Pi resolves. Examples that init writes: `anthropic/claude-sonnet-4-5`, `openrouter/auto`, `cursor/auto`.

Resolution order is stage, then pipeline, then `model` in `stageflow.yaml`. The first one set wins. If all three are unset, load fails with `stage.missing_model`. Stageflow does not invent a model. An empty or whitespace `model` fails with `stage.invalid_model`.

`agent` is a different field. It is `pi` or `claude` (the executor), not a model id. The default executor is Pi.

`sf validate` does not check that the provider is logged in or that the model id is real. A bad id fails at run time.

To see ids the Host knows about, use the MCP tool `list_models` or `GET /api/models` while a Host is up. There is no `sf models` command. The list is connected providers only, cached for a short time, and falls back to Pi's built-in list when a provider cannot be reached. A hand-written id that is not in the list still loads. The picker warns. The run uses the id as written.

Set the default in `stageflow.yaml`:

```yaml
model: openrouter/auto
```

A stage or pipeline `model` overrides it. The console can also store a `workshopModel` in `<project>/.stageflow/settings.json`. That setting is for the workshop, not a substitute for the manifest `model` on a pipeline stage.

OpenRouter may serve one model from several upstreams. Stageflow sends `require_parameters` on tool-calling requests so upstreams that cannot return tools are skipped. Routing you pin in `models.json` wins over that. If a model prints a tool call as plain text, the stage fails with a provider error that says so, not with a missing-envelope error. Pick another model, or pin upstreams in `$STAGEFLOW_HOME/agent/models.json` under `providers.openrouter.modelOverrides`. Pinning disables fallback: if those upstreams are down, the request fails. Do not put routing in pipeline YAML.

## Judge providers

Eval judges accept only these provider ids: `anthropic`, `openai`, `openrouter`. Any other `provider/model` id is rejected as a judge. The eval engine reads the key from the child process environment under the bare names `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `OPENROUTER_API_KEY`, or from the stored auth entry for that provider. The `stageflow-evals` skill owns how to set a judge on a run. Do not start an eval from this skill.

Failure sorting can also use a TypeSafe key. That key comes from a stored `typesafe` login, then `STAGEFLOW_PROVIDER_TYPESAFE_API_KEY`, then `TYPESAFE_API_KEY`, then `JEV_API_KEY`. The first one set wins. Never print it.

## Cursor

Cursor models (`cursor/…`) need the Cursor provider connected. The CLI package depends on `pi-cursor-sdk`. A key can be supplied in any of these ways:

- `CURSOR_API_KEY` in the environment of the Host process
- `CURSOR_API_KEY_FILE` pointing at a file
- `<credential-root>/agent/cursor-api-key`, mode `0600`, no trailing newline

A key that exists only in a shell profile is invisible to a Host started by the IDE or by autostart, because that process does not load the profile. Put the key where the Host process can see it, or run `sf providers login cursor` in a terminal.

## What is not checked

| Check | Catches a missing login? | Catches `CHANGE_ME`? |
|---|---|---|
| `sf providers status` | Yes. This is the one to trust. | No |
| `sf validate` | No | No |
| `sf doctor` credentials line | Only `STAGEFLOW_PROVIDER_*` in the environment | No |
| A real `sf run` | Yes, at the first model call | Yes, the call fails |

`sf providers` never starts a Host. Login does not need `sf ui` or `sf mcp`.
