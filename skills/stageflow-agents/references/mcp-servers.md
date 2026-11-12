# Project MCP servers

How an agent gets a tool from a server that is not Stageflow. Granting the tool in YAML is [tools-and-approvals.md](tools-and-approvals.md). This page is how the server gets onto the Host.

## Contents

- [Where a server lives](#where-a-server-lives)
- [There is no CLI and no MCP write](#there-is-no-cli-and-no-mcp-write)
- [Console](#console)
- [REST](#rest)
- [Secrets](#secrets)
- [OAuth](#oauth)
- [After it is saved](#after-it-is-saved)

## Where a server lives

Two sources, merged by name. A console-saved server wins when the name clashes.

| Source | File | Who edits it |
|---|---|---|
| The project | `<project root>/.mcp.json` | You, with the file tools. The project is the folder with `stageflow.yaml` |
| The console | `$STAGEFLOW_HOME/mcp/.mcp.json` | Settings → Project MCP, or the REST routes below |

`list_project_mcp` (MCP) and `GET /api/project-mcp` list both, with `origin: project` or `origin: console`. They return names and transport only. They do not connect. `probe_project_mcp` and `POST /api/project-mcp/<name>/probe` connect and exit; that is an external call, so confirm with the user first.

MCP tools on the Host act on the Host's own project (the directory `sf ui` or `sf mcp` was started in). A server saved from the console is host-level and is visible to agents in the projects that Host serves. A `.mcp.json` edit is the file in the project you have open.

An agent session attaches its granted servers with lifecycle `lazy`. Probe and pipeline stages attach with `eager`. A URL server gets the Host OAuth credential store when that store can be prepared (`$STAGEFLOW_HOME/secrets/mcp-oauth.key`). Sign-in itself is the REST or console flow below.

## There is no CLI and no MCP write

Nothing in `sf` and nothing in the MCP tool list can add, replace, or remove a project MCP server, set an MCP secret, or run MCP OAuth. The MCP tools stop at `list_project_mcp` and `probe_project_mcp`.

Use the console, or the REST routes below. Prefer the console when a secret or a browser sign-in is involved: the user types the secret there, and it never enters the chat.

## Console

Settings → Project MCP is `#/settings?section=project-mcp`.

The user can paste a server, set a secret, start OAuth (open the link, paste the browser address back), and remove a console-saved server. A server that exists only in `.mcp.json` is removed by editing that file. `DELETE` of a project-defined name returns `409` with code `project_defined`.

## REST

Base URL: `http://127.0.0.1:${STAGEFLOW_SERVICE_PORT:-3847}`.

These routes do not require an `Origin` header. A Host always has a control token (generated into `$STAGEFLOW_HOME/control-token` on first start unless the operator sets one). Send `Authorization: Bearer` with that token on every call (GET needs `read`, writes need `drive`). The `sf` CLI attaches it for `sf agents`. Do not print the token. Register the project first when a call returns `unknown_project_root`; the curl is in [control-surface.md](control-surface.md#http).

A server entry has exactly one of `command` (stdio) or `url` (`http://` or `https://`). Optional: `args` (array of strings), `env` (stdio only), `headers` (url only), `cwd`, and `httpTransport: sse` (streamable HTTP is the default and is omitted).

| Action | Call |
|---|---|
| List | `GET /api/project-mcp` |
| Read one console server (404 for a `.mcp.json` server) | `GET /api/project-mcp/<name>` |
| Add or replace a console server | `PUT /api/project-mcp/<name>` with body `{ "config": { …entry… } }` |
| Remove a console server | `DELETE /api/project-mcp/<name>` |
| Import several | `POST /api/project-mcp/import` with a `.mcp.json` object, `{ "mcpServers": { … } }`, or `{ "json": <that object> }` |
| Cached tool names | `GET /api/project-mcp/<name>/tools` (`tools: null` when nothing is cached) |
| Probe | `POST /api/project-mcp/<name>/probe` |

`PUT` returns `{ name, secretsStored }`. `secretsStored` is the list of secret names created from literal tokens in the config. The response does not contain the values.

Name rules: `^[A-Za-z0-9_.-]{1,64}$`. `stageflow` is reserved. A bad entry is `400` with `invalid_server`, `invalid_secret`, or `reserved_name`. A corrupt host file is `409` `host_state_corrupt`: fix or remove the file; the Host will not overwrite it.

Example, stdio, no secret in the file you write (the user exports `GITHUB_TOKEN`, and the placeholder is filled as in [Secrets](#secrets)):

```bash
export STAGEFLOW_CONTROL_TOKEN="$(cat ~/.stageflow/control-token)"
curl -s -X PUT "http://127.0.0.1:${STAGEFLOW_SERVICE_PORT:-3847}/api/project-mcp/github" \
  -H "Authorization: Bearer $STAGEFLOW_CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"config":{"command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"${GITHUB_TOKEN}"}}}'
```

A literal token pasted into `env`, `headers`, `url`, or `args` is moved into the secret store and replaced with `${NAME}` before the catalog is written. You still must not paste a secret into chat or into a file you commit. Send the user to the console, or have them export the variable and use a `${NAME}` placeholder.

## Secrets

Values live in `$STAGEFLOW_HOME/secrets/mcp-secrets.json` (mode `0600`). The catalog file holds `${NAME}` placeholders. `${NAME:-default}` is accepted; the name is the part before `:-`.

What may fill a placeholder when an agent or a probe starts:

- A secret stored by the console or by `PUT /api/mcp-secrets/<name>`.
- A Host environment variable whose name is listed in `STAGEFLOW_MCP_ENV_ALLOW` (comma-separated) and is set.

Arbitrary Host environment is not consulted. Provider and cloud credential names are refused unless they are on that allow-list. Control-token names are never provided to a server.

| Action | Call |
|---|---|
| List names, which servers use them, and whether each needed name is set | `GET /api/mcp-secrets` |
| Store a value | `PUT /api/mcp-secrets/<name>` with body `{ "value": "…" }` |
| Delete a stored value | `DELETE /api/mcp-secrets/<name>` |

`GET` returns names only. `PUT` returns `{ name }`. The value is never in a response, a log, or an error. Do not put the value in YAML, a file, a log, or your reply. Prefer the console. If you must call `PUT`, take the value from the user's secret prompt and do not echo it. A value is 1 byte to 16 KB.

There is no MCP tool for any of these routes.

## OAuth

For a remote server that signs in with OAuth. Console: Settings → Project MCP, sign in, then paste the browser address. REST, still no CLI and no MCP tool:

| Action | Call |
|---|---|
| Status | `GET /api/project-mcp/<name>/oauth` |
| Begin | `POST /api/project-mcp/<name>/oauth/start` → `{ authorizationUrl }` |
| Finish | `POST /api/project-mcp/<name>/oauth/complete` with `{ "input": "<full address from the browser, or the code>" }` |
| Sign out | `DELETE /api/project-mcp/<name>/oauth` |

Give the user `authorizationUrl` and ask them to paste the resulting address into the console, or into the `input` field of `complete` if they hand it to you. Do not invent a token. A bad paste is `invalid_input` or `invalid_body`.

## After it is saved

1. `list_project_mcp` shows the name.
2. Probe only with the user's go-ahead.
3. Grant the tools the job needs in `tools.mcp`, by the tool names from `GET /api/project-mcp/<name>/tools` or from the probe. Do not invent tool names. `["*"]` is acceptable when they asked for the whole server; still list each side-effecting tool in `ask_first`.
4. `sf agents validate` warns `agent.mcp_server_unknown` until the Host can see the server. Re-validate after the server is saved.
