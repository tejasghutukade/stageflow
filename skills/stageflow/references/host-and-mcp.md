# Host and MCP

The Host is the process that stores runs, executes them, and serves HTTP. Two commands start it in the foreground. Autostart starts the headless one for you. The CLI can only talk to loopback. A container or another machine is reached through MCP or HTTP, not through `sf` aimed at a URL.

Confirm with the user before you start `sf ui` or `sf mcp` in a terminal you do not already own. Never run either in the foreground of your own shell. They do not exit until the process is stopped.

## Contents

- Which command
- Port and bind
- Tokens
- Health
- Connect a harness
- Register the project
- When the CLI cannot see the Host

## Which command

| Command | What you get |
|---|---|
| `sf ui [--host <addr>] [--port 3847] [--no-open] [--mcp-stateless]` | Operator console, REST, and `/mcp`. Opens a browser unless `--no-open` or `STAGEFLOW_NO_OPEN` is set (anything other than empty, `0`, or `false`). |
| `sf mcp [--host <addr>] [--port 3847] [--mcp-stateless]` | REST and `/mcp`, no console. This is what autostart spawns, and the image's default command. `--no-open` is an error on this command. |

Both listen on `STAGEFLOW_BIND` when `--host` is omitted. The default bind is `127.0.0.1`. On startup `sf ui` prints `Operator console: <url>` and `MCP endpoint: <url>/mcp`. `sf mcp` prints the MCP endpoint only. `sf ui` also registers the current project on the local store.

They share one port. If autostart already spawned `sf mcp` on 3847, a later `sf ui` fails to bind. Stop the headless Host or point both at another port with the same `STAGEFLOW_SERVICE_PORT`.

SIGTERM and SIGINT drain in-flight work for `STAGEFLOW_SHUTDOWN_GRACE_MS` milliseconds (default 8000) and then exit.

MCP is Streamable HTTP at `/mcp` only. There is no stdio server. Sessions are on by default. `--mcp-stateless` or `STAGEFLOW_MCP_STATELESS=1` turns them off for a client that cannot send session headers. Leave sessions on for Cursor, Claude Code, Codex, and OpenCode.

Which CLI verbs start a Host, and the autostart error `reason` values, are in `control-surface.md`.

## Port and bind

The well-known port is 3847 (`DEFAULT_PORT`). Override it with `--port` on `sf ui` or `sf mcp`.

`STAGEFLOW_SERVICE_PORT` is how every other CLI command finds that Host. The CLI always calls `http://127.0.0.1:<port>`. There is no `--host` URL on `sf run` or `sf runs`. If the Host is on a non-default port and this variable is unset, the CLI probes 3847, finds nothing, and can autostart a second Host on 3847 against the same store. Export the variable in the same shell as the CLI, with the same value the Host was started with.

`STAGEFLOW_BIND` and `--host` take an IP literal (`127.0.0.1`, `0.0.0.0`, `::`, or another address). A hostname, a URL, or `host:port` is rejected. Binding `0.0.0.0` or `::` advertises `127.0.0.1` or `[::1]` in the printed URL. The process is still reachable on the other interfaces.

If `STAGEFLOW_CONTROL_TOKEN` and `_FILE` are unset, `sf ui` and `sf mcp` write `$STAGEFLOW_HOME/control-token` (mode 0600) and print `Control token: <token>` on first start. Later starts reuse it and print the file path. A non-loopback bind then has that token. `STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND=1` is an explicit opt-in to start with no token. The shipped compose file publishes `127.0.0.1:3847` and does not set the flag. The process inside the container binds `0.0.0.0`. The container logs print `Control token: <token>` on first start. If the logs don't show it (for example after a restart, when the token is reused), run `docker exec <container> cat /data/control-token`.

Every request also passes a Host allow-list. Loopback (`localhost`, `127.0.0.1`, `::1`) is always allowed as the Host. An `Origin` header must match that Host header's host and port. A localhost page on another port is rejected. Requests with no Origin stay allowed. Add other names with `STAGEFLOW_ALLOWED_HOSTS` as a comma-separated list (`console.example.com` or `console.example.com:3847`). `*` is rejected.

The probe and the CLI do not use `STAGEFLOW_BIND`. They use `STAGEFLOW_SERVICE_PORT` and `127.0.0.1`.

## Tokens

Set a token when the Host is reachable beyond this machine. Generate it with `openssl rand -hex 32`. It must be at least 32 characters and contain no whitespace. Do not invent one, and do not paste it into chat, YAML, or a command line that is logged. Ask the user to export it, or use the harness secret prompt if it has one.

| Variable | Scope | Who uses it |
|---|---|---|
| `STAGEFLOW_CONTROL_TOKEN` | drive | CLI, MCP, mutating `/api/*`, and `GET /api/backup*` |
| `STAGEFLOW_CONTROL_TOKEN_FILE` | drive | Same secret, read from a file |
| `STAGEFLOW_READ_TOKEN` | read | `GET` and `HEAD` under `/api/*` when no drive token is sent |
| `STAGEFLOW_READ_TOKEN_FILE` | read | Same, from a file |
| `STAGEFLOW_CONTROL_TOKEN_<NAME>` | drive, attributed | Named caller. The CLI does not send these. MCP and HTTP do, and the run is stamped with that caller id. |

The CLI sends `Authorization: Bearer <token>`. It prefers the drive token. When `STAGEFLOW_CONTROL_TOKEN` is unset, it reads `$STAGEFLOW_HOME/control-token`. For GET and HEAD only, it uses the read token when no drive token is set. A Host with no token and no allow-flag opt-in generates one, so API calls need that bearer. `/livez` and `/readyz` stay open.

When any token is configured, a request without a matching bearer is rejected. `/mcp` always requires drive scope. Mutating `/api/*` requires drive. `GET` and `HEAD` under `/api/*` require read (a drive token also satisfies read).

Two routes that look like health checks are not the same:

| Route | Bearer when a token is configured |
|---|---|
| `GET /livez`, `GET /readyz` (HEAD works too) | None. Host and Origin allow-list only. |
| `GET /api/health` | Read scope. A missing bearer is 401. |

Autostart, `scripts/detect-host.mjs`, and the image health check all use `/livez` for that reason. Do not probe `/api/health` to decide if the Host is up.

The probe prints `bearer` when `STAGEFLOW_CONTROL_TOKEN` or `STAGEFLOW_CONTROL_TOKEN_FILE` is set in your environment. It does not send the token, and it does not look at the read token or named tokens.

## Health

`GET /livez` returns 200 and `{"ok":true,"status":"live"}` when the process is accepting connections. It does not mean the store is ready, providers are logged in, or MCP is connected to your harness.

`GET /readyz` returns 200 only when the store opens, the home is writable, migrations are complete, and `git` is on PATH. Otherwise 503 with `ready: false` and a `checks` object. A live process can still be unready. Doctor runs these checks in its own process. It does not HTTP-call `/readyz`.

`GET /api/health` is the rich view: version, `build_sha`, capacity, `stageflow_home`, `boot_providers`, `providers_live`, disk, and an `activity` block. It needs a read bearer when tokens are on. The MCP tool `get_health` is the same family and omits that `activity` block. `get_started` is the orientation tool: version, providers, toolchain, catalog roots, and `next_steps`. The MCP checklist in `SKILL.md` is done when `get_started` returns the Host version.

`sf doctor` is not a health check for containers. A 200 from `/livez` is not an authenticated MCP session.

## Connect a harness

Do this when the user needs tools the CLI does not have (connections, memories, live inspection, agent and eval authoring), or the Host is in a container or on another machine. The URL is `http://127.0.0.1:3847/mcp` on this machine. From another machine, use the Host's reachable URL and a drive token. Add the Host's public name to `STAGEFLOW_ALLOWED_HOSTS`.

Omit the Authorization header when no token is configured. When a token is configured, the header is `Authorization: Bearer <token>`. Prefer an environment substitution over a literal token in a file that will be committed.

There is no MCP OAuth on this Host. A client that starts an OAuth login against `/mcp` will fail. Send the bearer, or run without tokens on loopback.

### Cursor

Project file `.cursor/mcp.json`, or user file `~/.cursor/mcp.json`. A remote server is a `url` entry (Streamable HTTP). Cursor expands `${env:NAME}` in `url` and `headers`.

```json
{
  "mcpServers": {
    "stageflow": {
      "url": "http://127.0.0.1:3847/mcp",
      "headers": {
        "Authorization": "Bearer ${env:STAGEFLOW_CONTROL_TOKEN}"
      }
    }
  }
}
```

Drop `headers` when the Host has no token. Restart Cursor or reload MCP after saving. The tools are present when `get_started` answers.

### Claude Code

`.mcp.json` in the project (shared) or `claude mcp add`. An entry with `url` and no `type` is ignored. The type is `http` (`streamable-http` is accepted as an alias). Claude Code expands `${VAR}` in `url` and `headers`.

```json
{
  "mcpServers": {
    "stageflow": {
      "type": "http",
      "url": "http://127.0.0.1:3847/mcp",
      "headers": {
        "Authorization": "Bearer ${STAGEFLOW_CONTROL_TOKEN}"
      }
    }
  }
}
```

Put that in `.mcp.json` (project) or the user mcp config. Claude Code expands `${STAGEFLOW_CONTROL_TOKEN}` when it reads the file. Do not pass the token to `claude mcp add --header`: the shell expands it into the process arguments. Approve the project server when Claude Code asks. A 401 means the header was empty or the token does not match.

### Codex

User file `~/.codex/config.toml`. A project file `.codex/config.toml` is loaded only when the project is trusted. Codex reads the token from an environment variable and sends `Authorization: Bearer`. Do not put the token in the file.

```toml
[mcp_servers.stageflow]
url = "http://127.0.0.1:3847/mcp"
bearer_token_env_var = "STAGEFLOW_CONTROL_TOKEN"
```

Omit `bearer_token_env_var` when the Host has no token. Codex's default `auth` is `oauth`, which it tries after bearer tokens. This Host does not implement that login. If Codex opens an OAuth flow, set the bearer variable (or run loopback with no tokens) instead of completing OAuth.

### OpenCode

`opencode.json` in the project, or the user config. Remote servers use `type` `remote`. OpenCode expands `{env:NAME}` in header values. Set `oauth` to `false` when you use a static bearer so it does not start a login this Host cannot finish.

```json
{
  "mcp": {
    "stageflow": {
      "type": "remote",
      "url": "http://127.0.0.1:3847/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:STAGEFLOW_CONTROL_TOKEN}"
      }
    }
  }
}
```

Drop `headers` and `oauth` when no token is configured. The default request timeout is 30 seconds, which is shorter than a long `wait_run`. Raise `timeout` on this entry if a wait dies at 30 seconds, or pass a shorter `timeout_ms` to the tool.

### After it connects

Call `get_started`. The result includes the Host version. If the tool is missing, the client is pointed at the wrong URL, the Host is down, or the bearer was rejected. Fix that before inventing a tool name. The control-surface rule in `control-surface.md` says to prefer these tools over the CLI once they answer.

## Register the project

The Host only lists catalogs it knows. `sf ui` registers the project it was started in. `sf run` from a checkout registers that project over `POST /api/projects`, which is allowed only from trusted loopback. A remote MCP client cannot register an arbitrary path (`ensure_project_not_allowed`).

On MCP, pass catalog-relative paths (`pipelines/hello.pipeline.yaml`). An absolute path from a network caller returns `absolute_path_not_allowed`. `project_root` is the registered id, not a free-form path. The seeded examples catalog uses `project_root` `examples` when that catalog is present.

`STAGEFLOW_ENSURE_PROJECT_ROOTS` is a comma-separated list of roots the Host should register at boot (the compose file uses it for catalogs baked into the image). `STAGEFLOW_OPERATOR_CWD` is the directory for operator skills. It is not `project_root`.

## When the CLI cannot see the Host

Use MCP or HTTP, with a drive token, when any of these is true:

- The agent has no shell on the Host's machine.
- The Host is in Docker. `sf` on the laptop talks to the laptop's port 3847, which is the right process only if that port is published. Inside the container, `docker exec` is the CLI. See `docker-and-hosted.md`.
- The Host binds a non-default port and `STAGEFLOW_SERVICE_PORT` is not exported in this shell.
- You need a tool with no `sf` verb: connections, memories, creating an agent, writing eval files, checkout diffs.

CLI-only work still needs a shell or `docker exec`: `sf init`, `sf doctor`, `sf providers login`, `sf graph`, `sf migrate-yaml`, `sf backup`, `sf restore`, `sf browser`, `sf eval engine install`.
