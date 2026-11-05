# Troubleshooting

Match the symptom, then run the one command that distinguishes a false alarm from a real failure. Do not retry a model run, an eval, or a send to see if it clears. Read the `code` or `reason` first.

Autostart `reason` values and which commands start a Host are in `control-surface.md`. Ports, tokens, and `/livez` versus `/api/health` are in `host-and-mcp.md`. Provider login is in `providers-and-models.md`.

## Contents

- Doctor
- The credentials warning
- Autostart
- Port, bind, and token
- Validate
- Provider and model errors
- Runs that did not start
- Docker

## Doctor

```bash
sf doctor
sf doctor --json
```

Human output is `[status] <id>: <message>`. Status is `pass`, `warn`, `fail`, or `skipped`. Exit 0 means no `fail`. Warnings are still worth reading. `--json` is `{ "ok", "checks" }` and each check may include `code`.

Doctor opens `$STAGEFLOW_HOME` itself and can apply schema migrations. It does not HTTP-call a running Host. A passing doctor does not mean `/mcp` is connected, and a failing doctor is not what a container health check should run. Use `GET /livez` for that.

| id | fail means | what to do |
|---|---|---|
| `store_openable` | `state.db` could not be opened. Code `store_not_openable`. | Check `$STAGEFLOW_HOME` is the store you think it is. Another process may hold it (`restore_store_busy` on restore). |
| `home_writable` | The home is not writable. Code `home_not_writable`. The message names uid and gid. | Fix ownership of that directory for the user who runs `sf`. Do not `sudo` the npm install. |
| `migrations_complete` | Schema migrations did not finish. Code `migrations_incomplete`. | Run doctor again after a backup. If it still fails, stop the Host and restore a backup. |
| `store_integrity` | `PRAGMA integrity_check` failed. Code `store_integrity_failed`. | Do not keep serving. `sf restore` a backup. Doctor prints that. |
| `git` | `git` is not on PATH. Code `git_not_present`. | Install git. This is not "the catalog is not a git repo". Init still works without a repo. It uses the current directory. |
| `bash` | `bash` is not on PATH. Code `bash_not_found`. | Install bash. Stages that run shell need it. |
| `pipeline_load` | `--pipeline` could not load the file. | Read the message. Shape problems are for the `stageflow-pipelines` skill. |

These are warnings or skips, not failures, unless noted:

| id | meaning |
|---|---|
| `node` | Warns when Node is older than 20. The package requires Node 20+. Doctor still exits 0. Install a current Node before you trust the CLI. |
| `credentials` | See the next section. A warn here does not fail doctor. |
| `tls_ca_paths` | `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, or `SSL_CERT_DIR` points at a missing file. Code `ca_path_missing`. Skipped when none of those are set. |
| `free_disk` | Free space under the home is below the floor. Code `insufficient_disk`. Runs can refuse to start for the same reason. |
| `mcp_commands` | No `.mcp.json` in the directory (skipped), or a server's `command` is not on PATH. Code `command_not_on_path`. This is project MCP for stages, not the Host's `/mcp`. |
| `eval_engine` | Skipped when promptfoo is not installed. Warns with `EVAL_NODE_TOO_OLD` when the engine is installed but Node is below 22.22.0. Evals need that Node. The image bakes the engine in. A laptop does not, until `sf eval engine install`. |

`--pipeline` adds toolchain, secret, channel, and stage MCP checks. `--strict` turns toolchain `unknown_version` into a failure. Without `--strict` it stays a warning.

## The credentials warning

This warning is real, and it is often the wrong signal.

Doctor's `credentials` check only scans the environment of the process that ran `sf doctor` for `STAGEFLOW_PROVIDER_<ID>_API_KEY` or `STAGEFLOW_PROVIDER_<ID>_API_KEY_FILE`. It does not read `agent/auth.json`.

A normal CLI login (`sf providers login`, a key typed at the prompt, or `--api-key-env`) stores the secret in the auth file and does not set `STAGEFLOW_PROVIDER_*`. Doctor then prints:

```text
[warn] credentials: No STAGEFLOW_PROVIDER_*_API_KEY set; credentialSource=sf_owned
```

The `credentialSource` suffix is omitted if project settings could not be read. Treat this as a false alarm when `sf providers status` shows `configured` for the provider you will use. Tell the user that. Do not create a `STAGEFLOW_PROVIDER_*` variable just to silence it, and do not log in a second time.

Treat it as a real gap when the Host is supposed to boot from the environment (Docker, CI, a fresh volume) and `sf providers status` inside that same environment is `disconnected`. Set `STAGEFLOW_PROVIDER_<ID>_API_KEY` on the Host process, or log in with `--api-key-env`. A bare `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` does not satisfy this check and does not configure Host boot.

`GET /api/health` splits the two views: `boot_providers` is the boot env, `providers_live` is the auth file. Empty boot providers with a live login is the false-alarm case.

## Autostart

Commands that need a Host probe `GET http://127.0.0.1:<port>/livez` (port from `STAGEFLOW_SERVICE_PORT`, default 3847) for 1.5 seconds. A 200 with a JSON body means the Host is already up and nothing is spawned. Otherwise the CLI may spawn a detached `sf mcp` and wait up to `STAGEFLOW_AUTOSTART_TIMEOUT_MS` (default 10000). The log is `$STAGEFLOW_HOME/service.log`.

The check for `STAGEFLOW_NO_AUTOSTART` happens after the probe. A Host that is already up still works when that variable is set. The variable disables spawn only. It is set (and should stay set) in the Docker image.

Under `--json`, a failure to start the Host exits 1. The document depends on the command:

| Command | Autostart-failure document |
|---|---|
| `sf run` | `{ "ok": false, "outcome": "failed", "reason": "<message>", "code"?: "<id>" }`. `reason` is the human message, not the reason id. `code` is present only for `autostart_disabled`. `port_occupied`, `bind_refused`, `spawn_failed`, and `timed_out` have no `code`. Branch on the message, or re-read the failure. Do not branch on `code` for those four. |
| `sf trigger list`, `show`, `fire` | `{ "error": "<message>", "reason": "<reason id>" }` on stdout. Same shape as a mutating `sf runs` verb. |
| `sf trigger fire` after the Host is up and then refuses | Not an autostart failure. Same start-failure JSON as `sf run`. Non-busy refusals use the start-failed document (`ok: false`, `outcome: "failed"`, `reason` is the message, `code` only when set). `busy_capacity` and `busy_checkout` use `outcome: "busy"`. |
| `sf run-stage` | `{ "error": "<message>" }` on stdout. No reason id. |
| `sf agents` | `{ "code": "host.unavailable", "message": "<message>", "issues": [] }` on stdout. |
| `sf a2a` status, enable, reload, caller, publication | The message on stderr. `--json` does not wrap it. |
| Mutating `sf runs` (`answer`, `feedback-decide`, `retry`, `resume`, `recover`, `abandon`, `cancel`, `delete`, `gc`, `rerun`) | `{ "error": "<message>", "reason": "<reason id>" }` on stdout. |

`sf eval` verbs that autostart print `{ "error": "<message>", "reason": "<reason id>" }` on stdout, the same shape as mutating `sf runs`.

| reason | meaning | fix |
|---|---|---|
| `autostart_disabled` | Nothing answered, and `STAGEFLOW_NO_AUTOSTART` is set to something other than empty, `0`, or `false`. | Start `sf mcp` or `sf ui`, or unset the variable. In Docker, the container entrypoint should already be the Host. `docker exec` against a stopped container cannot spawn one. |
| `port_occupied` | Something is listening but `/livez` was not 200 JSON. | Free the port, or set the same `STAGEFLOW_SERVICE_PORT` on both the Host and the CLI. Do not start a second copy. |
| `bind_refused` | `STAGEFLOW_BIND` is not loopback and no drive token is set. | Set `STAGEFLOW_CONTROL_TOKEN` (32 or more characters, no whitespace), or bind `127.0.0.1`, or set `STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND=1` only when the published port stays on this machine. |
| `spawn_failed` | The detached process or its log file could not be opened. | Read the message. It names `service.log` or the spawn error. |
| `timed_out` | `/livez` did not succeed before the timeout. | Read `$STAGEFLOW_HOME/service.log`. Raise `STAGEFLOW_AUTOSTART_TIMEOUT_MS` on a slow disk. |

These are final. Do not loop the same command hoping the timeout was unlucky until you have read the log.

`sf restore` is the opposite: it refuses when `/livez` answers (`restore_host_live`). Stop the Host, including one autostart left running.

## Port, bind, and token

`detect-host.mjs` prints `down` when nothing listens, the status is not 200, the body is not JSON, or the probe hangs past 1.5 seconds. `up` means a Stageflow-shaped `/livez`. It does not mean your MCP client is attached, and it does not send a bearer.

A 401 on `/api/health` or `/mcp` with `up` from the probe means the Host is fine and the client omitted the drive token. `/livez` and `/readyz` never need a bearer. `/api/health` needs read scope when any token is configured. `/mcp` needs drive scope. The CLI does not send `STAGEFLOW_CONTROL_TOKEN_<NAME>` named tokens. Export `STAGEFLOW_CONTROL_TOKEN` for CLI calls.

`sf ui` and `sf mcp` both default to 3847. If a headless Host is already on that port, `sf ui` fails to listen. Use the existing Host, or stop it and start the console.

A Host started with `--port` other than 3847 is invisible to the CLI until `STAGEFLOW_SERVICE_PORT` is the same number. Symptom: a second Host appears on 3847, or autostart times out against the wrong port. Export the variable. Do not guess a URL. The CLI has no remote host flag.

A non-loopback client also has to pass the Host and Origin allow-list. Loopback is always allowed. Other names go in `STAGEFLOW_ALLOWED_HOSTS`. A star is rejected.

## Validate

`sf validate --strict --json` exits 0 when `ok` is true and 1 when any finding is an error. It never exits 2.

Setup findings you can hit immediately:

| code | meaning |
|---|---|
| `catalog.manifest_missing` | No `stageflow.yaml`. Warning by default. `--strict` makes it an error. Run `sf init`. |
| `catalog.manifest_invalid` | The manifest is not version 1, or `catalog` is missing, or a field is the wrong type. |
| `catalog.empty_catalog` | The manifest lists no usable files. Warning unless `--strict`. |
| `stage.missing_model` | No `model` on the stage, the pipeline, or the manifest. |
| `stage.invalid_model` | `model` is present but empty or not a string the loader accepts. |

`CHANGE_ME/<provider-model>` is a legal string. Validate accepts it. A run fails later, at the model call. Replace it before you offer to run.

`--strict` does not promote `pipeline.model_applies` or `pipeline.route_all_gated`. Those stay warnings. Eval-category warnings do become errors under `--strict`.

Validate does not check provider credentials, that the model id exists, that a task `input` matches the entry stage's `io.input`, or that a stage file is free of unknown keys (stage files accept unknown keys). The `stageflow-pipelines` skill is the repair loop for wiring and finding codes. Do not start a run to discover a shape error.

## Provider and model errors

| symptom | cause | fix |
|---|---|---|
| `status` says `disconnected` | No stored credential for that id. | `sf providers login`. A person types the key or completes OAuth. See `providers-and-models.md`. |
| `source set` rejects the value | Only `sf_owned` is accepted. | `sf providers source set sf_owned`. |
| `Raw --api-key is not supported` | The flag is refused on purpose. | Prompt, or `--api-key-env <VAR>` with the key already in the environment. |
| Provider supports both and login exits 1 | `--type` was omitted. | Pass `--type api_key` or `--type oauth`. |
| OAuth cannot start | No terminal, or this is CI. | Stop. Print the command for a person. Do not paste a device code into chat. |
| Host boot logs `provider <id> boot failed` | `STAGEFLOW_PROVIDER_<ID>_API_KEY` and `_FILE` are both set, or the file is unreadable, or the key was rejected. | Fix that one variable. The Host still starts unless the id is listed in `STAGEFLOW_REQUIRE_PROVIDERS`. |
| Run fails with no API key | The stage's provider is not in the auth file the Host passes down. | `sf providers status` on the same `STAGEFLOW_CREDENTIAL_HOME` as the Host. A login in your laptop home does not exist inside a container volume. |
| `stage.missing_model` | Nothing in the stage, pipeline, or manifest set `model`. | Set one. Init writes one only when exactly one provider was configured at init time. |
| Provider error about a tool call written as plain text | The model did not return a tool call. | Run again only if the user agrees to spend again, or pick another model. Pinning OpenRouter upstreams is a Host `models.json` edit, not a pipeline key. |
| Judge rejected | Judge providers are only `anthropic`, `openai`, and `openrouter`. | The `stageflow-evals` skill covers judge setup. |

`list_models` and `GET /api/models` show connected providers. An id absent from that list can still be written into YAML. The failure, if any, is at run time.

## Runs that did not start

These are not setup bugs. Hand them to `stageflow-operate` after you have confirmed the Host is up.

| code or exit | meaning |
|---|---|
| `sf run` exit 0 | The run succeeded. |
| `sf run` exit 1 | The run failed, validation failed, or the Host could not be reached. Read `outcome` and `reason`. `code` is present only for some failures. |
| `sf run` exit 2 | Waiting on a person. Not a failure. Do not retry. |
| `busy_capacity`, `busy_checkout` | The Host's queue or that checkout is full. |
| `insufficient_disk` | Free space is under the floor. Same signal as doctor's `free_disk` warning. |
| `unknown_project_root` | The Host has not registered that project. From loopback, `sf run` or `sf ui` registers it. A remote client cannot. |
| `absolute_path_not_allowed` | MCP was given an absolute path. Use a catalog-relative path. |

A waiting run is success of the start. Exit 2 is the handoff.

## Docker

| symptom | cause | fix |
|---|---|---|
| Container exits immediately with the bind refusal text | `STAGEFLOW_BIND=0.0.0.0` and no token and no allow flag. | Set `STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND=1` only with a `127.0.0.1` publish, or set `STAGEFLOW_CONTROL_TOKEN`. |
| `autostart_disabled` inside `docker exec` | The image sets `STAGEFLOW_NO_AUTOSTART=1` and the entrypoint is not running. | Start the container (`sf mcp` or `sf ui`). Exec does not boot the Host. |
| `/livez` connection refused on the laptop | Port not published, or published on a different interface. | `-p 127.0.0.1:3847:3847`. Curl that URL, not a container-internal hostname, from the laptop. |
| Login exists on the laptop, not in the container | Different credential homes. | The volume's `/data/agent/auth.json` is the container store. Set `STAGEFLOW_PROVIDER_*` on the container or log in with `docker exec -it`. |
| `sf ui` inside a container that already runs `sf mcp` | One port. | Use the running command, or change the container command. Do not start both. |
| Empty `GITHUB_TOKEN` inside the container | The shell exported an empty value and it overrode the env file. | `env -u GITHUB_TOKEN -u GH_TOKEN docker compose up -d`. |
| Health check failing | The check is `/livez`. Doctor will not pass it. | Read the container logs. A 503 from `/readyz` can be git missing or a store that is not migrated yet. `/livez` should still be 200 once the process listens. |

Confirm with the user before you delete the volume. That deletes runs and credentials. Back up first.
