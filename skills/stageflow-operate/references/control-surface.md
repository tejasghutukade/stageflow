# Control surface

How this skill reaches a Stageflow Host: the local CLI, MCP, and REST. Install and provider login belong to the `stageflow` skill.

## Contents

- [The Host](#the-host)
- [How the CLI reaches the Host](#how-the-cli-reaches-the-host)
- [Autostart](#autostart)
- [Which commands start a Host](#which-commands-start-a-host)
- [Tokens](#tokens)
- [A remote Host](#a-remote-host)
- [Host down](#host-down)

## The Host

A Host is `sf ui` (console, REST, and MCP) or `sf mcp` (REST and MCP, no console). Both listen on port `3847` unless `--port` is set. Runs execute inside the Host. `sf run` is a client: it registers the project, starts the run, and then polls. Stopping the CLI process does not stop the run.

Autostart, when it happens, spawns a detached headless `sf mcp` and leaves it running after the CLI exits. The child writes to `$STAGEFLOW_HOME/service.log` (default home `~/.stageflow/`).

## How the CLI reaches the Host

The CLI talks only to `http://127.0.0.1:<port>`. The port is `STAGEFLOW_SERVICE_PORT`, default `3847`. There is no `--host` or URL flag on `sf run`, `sf runs`, or the other client verbs. `sf ui` and `sf mcp` are the processes that bind; they take `--host` and `--port`.

Probe with `GET /livez` on that base URL. A live Host returns HTTP 200 and a JSON body. The probe times out after 1500 ms. `node scripts/mcp-call.mjs --probe` uses the same path and the same port variable. `/livez` and `/readyz` do not require a bearer. `GET /api/health` does, when tokens are configured: it needs the read scope. Do not probe `/api/health` to decide whether the Host is up.

Set `STAGEFLOW_SERVICE_PORT` to the Host's port in the same environment as the CLI. A Host on another port is invisible: the CLI probes 3847, finds nothing, and can spawn a second Host on 3847 against the same `$STAGEFLOW_HOME`. `sf ui` and `sf mcp` also share that port. If a CLI verb already started a headless Host, a later `sf ui` fails to bind. Use the Host that is up, or stop it before starting the console.

## Autostart

Autostart follows how the command talks to Stageflow. It is independent of whether the command changes state.

1. Probe `GET /livez`. A 200 with JSON means the Host is already up. Nothing is spawned. `STAGEFLOW_NO_AUTOSTART` does not hide a Host that is already up.
2. Anything else answering on that port (non-200 or a non-JSON body) is `port_occupied`. The CLI does not spawn.
3. Nothing listening, and `STAGEFLOW_NO_AUTOSTART` is set to a value other than empty, `0`, or `false`: `autostart_disabled`. This is the mode for a container whose entrypoint already runs the Host.
4. A non-loopback `STAGEFLOW_BIND` with no control token: `bind_refused`. The spawned child inherits the CLI environment.
5. Otherwise spawn detached `sf mcp` on that port, then poll `/livez` every 200 ms until `STAGEFLOW_AUTOSTART_TIMEOUT_MS` (default 10000). Timeout is `timed_out`. A spawn or log-open failure is `spawn_failed`.

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

`STAGEFLOW_NO_AUTOSTART=1` is the usual setting. Unset, empty, `0`, and `false` leave autostart on.

## Which commands start a Host

Three groups. Mutating commands appear in more than one group. `sf browser login`, `sf restore`, `sf init`, `sf providers login`, and `sf migrate-yaml --write` change state and never start a Host. `sf runs list` changes nothing and starts a Host when the store needs a migration.

| Group | Commands |
|---|---|
| Always (HTTP client of the Host) | `sf run`, `sf run-stage`, `sf trigger list`, `sf trigger show`, `sf trigger fire`, every `sf agents` subcommand, `sf eval` except `validate` and `engine status` / `engine install`, `sf a2a status`, `enable`, `reload`, `caller`, and `publication`, and the mutating `sf runs` verbs: `answer`, `feedback-decide`, `retry`, `resume`, `recover`, `abandon`, `cancel`, `delete`, `gc`, `rerun`. |
| Only when `$STAGEFLOW_HOME` has no `state.db`, or the schema is older than this binary | `sf runs list`, `show`, `verify`, `waiting`, `wait`; `sf artifact read`; `sf envelope get`; `sf export-run`; `sf debug-run`; `sf export --all`; `sf backup`. |
| Never | `sf validate`, `sf graph`, `sf migrate-yaml`, `sf doctor`, `sf init`, `sf skills`, `sf providers`, `sf browser`, `sf eval validate`, `sf eval engine status`, `sf eval engine install`, `sf a2a validate`, `sf a2a list`, `sf a2a add-caller`, `sf restore`, `sf --version`, `sf --help`. |

`sf ui` and `sf mcp` start a Host in the foreground. They are not autostart.

`sf doctor` opens the store in the CLI process and can apply migrations there. It does not call a running Host. `sf browser` never starts one. When the schema needs a migration, a profile lock is treated as still held, and the browser command exits `2`. `sf restore` probes `/livez` and refuses with `restore_host_live` when a Host answers. It never spawns one. With the Host up, stage a restore with `POST /api/restore` instead (see [backup-export-cost.md](backup-export-cost.md)).

## Tokens

Loopback with no token needs no `Authorization` header.

When tokens are set: `GET /api/backup` is drive, not read. Other `/api/` GET and HEAD are read. POST, PUT, PATCH, DELETE, and `/mcp` are drive. Webhook, agent-inbound, and `/api/public/chat/` take no control token. `/livez` and `/readyz` take none.

The CLI sends the drive token when `STAGEFLOW_CONTROL_TOKEN` or `STAGEFLOW_CONTROL_TOKEN_FILE` is set. For `GET` and `HEAD` only, it falls back to `STAGEFLOW_READ_TOKEN` when no drive token is set. Named tokens `STAGEFLOW_CONTROL_TOKEN_<NAME>` are for callers, not for the CLI. A token is at least 32 characters. Never print it.

`/mcp` is Streamable HTTP only. There is no stdio MCP server. Sessions are stateful unless the Host was started with `--mcp-stateless` or `STAGEFLOW_MCP_STATELESS=1`. A non-loopback bind refuses to start without a drive token, unless `STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND=1`.

## A remote Host

The CLI cannot target a Host on another machine, another interface, or a published container port that is not `127.0.0.1` on this host's port. Use MCP at `http://<host>:<port>/mcp` or REST on the same origin, with a drive-scope bearer. `node scripts/mcp-call.mjs --base-url <url>` is the bridge when this harness has no native Stageflow tools. See [mcp-call.md](mcp-call.md).

In Docker, a shell inside the container can run `sf` against the Host in that container. From outside, use MCP or REST. Set `STAGEFLOW_NO_AUTOSTART=1` in an image whose entrypoint already runs the Host, so a CLI command does not spawn a second one.

## Host down

These reads open `$STAGEFLOW_HOME` SQLite directly and work with the Host down, until the schema needs a migration: `sf runs list`, `show`, `verify`, `waiting`, `wait`, `sf artifact read`, `sf envelope get`, `sf export-run`, `sf debug-run`, and `sf export --all`.

Answering a gate, cancelling, retrying, and every other change in the "always" group need a Host. The CLI starts one unless autostart is disabled. `sf agents` has no offline mode: it uses the Host's agent service for the project in the current directory.
