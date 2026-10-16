# MCP servers (Settings → Project MCP)

MCP servers give [agents](agents.md) and pipeline stages extra tools (a web fetcher, Linear, Notion, Playwright). You add them in the console; no `.mcp.json` file or container shell is needed. This page is about **servers your agents and stages use**. The MCP endpoint Stageflow itself exposes to harnesses is a different thing: see [MCP](mcp.md).

| Term | Meaning |
|------|---------|
| **Project MCP** | Servers an agent or stage can attach: the project `.mcp.json` plus servers saved from the console. Settings → Project MCP |
| **Stageflow MCP endpoint** | What `sf mcp` / `sf ui` serve at `/mcp` for harnesses. Settings → MCP. See [MCP](mcp.md) |
| **Check** | A real connect-and-list-tools probe of one server, run by the Host without starting a run |

## Quick start (works in Docker)

1. Open **Settings → Project MCP** and choose **Add server**, or **Paste JSON**.
2. Paste a config copied from the server's own docs, for example:

   ```json
   { "mcpServers": { "linear": { "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer lin_api_xxxxxxxx" } } } }
   ```

3. Save. The token is moved out of the config into the secret store and the saved entry shows `${LINEAR_TOKEN}` (see [Secrets](#secrets)).
4. Choose **Check**. A green result lists the server's tools.
5. Grant it: in an agent's editor, **Tools → MCP servers**, tick the server and the tools (`tools.mcp.linear: ["*"]` in YAML); in a pipeline, list it under the stage's `mcp:` ([Stage MCP](yaml-catalog.md#stage-mcp)).

Everything is written under `$STAGEFLOW_HOME` (`/data` in the container), so it survives restarts and image rebuilds. See [Docker — MCP servers in the container](docker.md#mcp-servers-in-the-container) and [Data directory](data-directory.md).

## Adding servers

Two shapes are accepted, one per server:

| Transport | Required | Optional |
|-----------|----------|----------|
| stdio | `command` | `args` (strings), `env` (name → string), `cwd` |
| http | `url` (`http://` or `https://`, or a `${VAR}` placeholder) | `httpTransport` (`"sse"` or `"streamable-http"`; streamable HTTP is the default), `headers` (name → string) |

Exactly one of `command` and `url`. `env` is stdio-only, `headers` and `httpTransport` are http-only. Other tools' spellings are mapped for you: `serverUrl` / `httpUrl` become `url`, and `type` / `transport` of `sse`, `http`, `streamable-http` or `stdio` set the transport.

Paste JSON accepts a full `.mcp.json` (`{ "mcpServers": { … } }`), a bare map of `{ "name": { … } }`, or several servers at once. A single unnamed server (a bare `{ "command": … }`) is refused: wrap it so it has a name. Servers that fail validation are listed with their reason; the rest are still saved.

**Names:** 1 to 64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. `stageflow` is reserved. A console server with the same name as a project `.mcp.json` server **wins**.

**Never allowed:**

- A `url` pointing at a link-local or cloud-metadata address (for example `169.254.169.254`).
- A `${NAME}` placeholder that names a Stageflow control token (`STAGEFLOW_CONTROL_TOKEN*`, `STAGEFLOW_READ_TOKEN*` and `PI_MCP_ADAPTER_OAUTH_FILE_KEY`).
- A `${NAME}` placeholder that names a provider or cloud credential (a fixed list such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and cloud keys; the full list is `PROVIDER_AND_CLOUD_NAMES` in `src/runtime/stageEnvironment.ts`). Use a different variable name, or list the exact name in `STAGEFLOW_MCP_ENV_ALLOW` (below).

To remove a server use **Remove**. A server defined in the project's `.mcp.json` cannot be removed from the console (409 `project_defined`); edit that file.

## Secrets

Tokens never stay in the saved config. On save, Stageflow looks at `env`, `headers`, `args` and the `url` (query string and user info). A literal that looks like a secret (a key name containing token, secret, password, api key, auth, credential, bearer or private key; a known token prefix such as `ghp_`, `sk-`, `xoxb-`, `AKIA`; or a long mixed letters-and-digits string) is moved into `secrets/mcp-secrets.json` and replaced with `${NAME}`. A `Bearer ` / `Basic ` / `Token ` prefix stays in the config; only the token moves.

Naming: an `Authorization` header becomes `<SERVER>_TOKEN`; any other key becomes its upper-cased name (`API_KEY`), prefixed with the server name (`LINEAR_API_KEY`) if that name is taken by a different value. A name that is denied or a provider credential name is skipped for the prefixed form.

Values are write-only. The API, the console and logs show names and "set / not set", never values; error text and probe output are scrubbed of known values. Limits: names `[A-Za-z_][A-Za-z0-9_]*` up to 128 characters, values 1 byte to 16 KB. Set, replace or delete a secret by name in the Project MCP panel (a placeholder a server needs but nobody set shows as "needed").

Placeholders: `${NAME}` is required; `${NAME:-default}` falls back to `default` when no value is available.

### Who fills `${NAME}`

| Caller | Console secret | Host environment | Notes |
|--------|:--------------:|:----------------:|-------|
| **Agent** (a session of an [agent](agents.md)) | yes | only names in `STAGEFLOW_MCP_ENV_ALLOW` | Same rule as Check, so a server that checks green resolves the same way in a session |
| **Check** (probe) | yes | only names in `STAGEFLOW_MCP_ENV_ALLOW` | |
| **Pipeline stage** | only names the stage lists in `secrets:` | no (the stage's curated environment only) | A listed console secret fills MCP servers only and is **not** put in the stage environment |
| **`sf validate`** | placeholders checked, no value read | | A name declared in `secrets:` is accepted when a console secret of that name exists |
| **Workspace-sourced catalog** (repository-bound stage) | never | never | Such stages never see console servers or secrets |

A console secret **wins** over a Host environment variable of the same name.

`STAGEFLOW_MCP_ENV_ALLOW` is a comma-separated list of exact variable names (`-e STAGEFLOW_MCP_ENV_ALLOW=NOTION_KEY,GITHUB_PAT`). It is the only way the Host's own environment reaches an agent's or probe's MCP servers. Control tokens can never be listed. It is also what lets a provider or cloud credential name be used as a placeholder.

## OAuth sign-in

For remote (`url`) servers that use OAuth, choose **Sign in** on the server. Stageflow starts the server's own flow and shows the authorize address; approve it in a browser. The redirect lands on `localhost`, which a remote or containerised Host cannot receive, so **copy the full address from the browser's address bar and paste it back** into the dialog. Status is `authenticated`, `expired` or `not_authenticated`; **Sign out** removes the tokens.

- Tokens are stored encrypted (AES-256-GCM) in `agent/mcp-oauth-encrypted`, keyed by `secrets/mcp-oauth.key` (generated on first use). `PI_MCP_ADAPTER_OAUTH_FILE_KEY` overrides the key. Back up the store and the key **together**.
- Signed-in servers work for **agents and Check only**. Pipeline stages run with a sealed per-attempt agent directory and cannot use them; give a stage a bearer-token secret instead.

## Using servers

### From an agent

In the agent editor pick the server and the tools; in YAML:

```yaml
tools:
  mcp:
    linear: ["*"]            # every tool of the server
    notion: [search, fetch]  # only these
```

A tool is granted as `<server>.<tool>` (for example `notion.search`), which is also the name to use in `approvals.ask_first`. Servers attach lazily when a session first needs them, in an isolated process per agent runtime. A warning (`agent.mcp_server_unknown`) appears in the editor when a granted server is in neither the project `.mcp.json` nor the console list. Idle runtimes are released after 30 minutes (`STAGEFLOW_AGENT_SESSION_IDLE_MINUTES`; `0` keeps them). See [Agents](agents.md).

### From a pipeline stage

```yaml
# stageflow.yaml, on the stage entry
mcp: [linear]
secrets: [LINEAR_TOKEN]   # a console secret, or a registered Host secret
```

- `mcp:` is an allowlist of server names. Console servers merge in over the project `.mcp.json`; **a project `.mcp.json` is no longer required** when the listed servers exist in the console. If neither source defines a listed name, `sf validate` fails with `Unknown MCP server`.
- `secrets: [NAME]` may now name a console secret. It fills `${NAME}` in the stage's MCP servers and is never exported to the stage's environment (a warning says so; `as: env` has no effect for it).
- **Repository-bound stages** read `.mcp.json` from the checked-out repository, which is untrusted workspace content: they never see console servers or console secrets, and the workspace-config trust rules apply ([yaml-catalog — Stage MCP](yaml-catalog.md#stage-mcp)).
- OAuth-signed-in servers are not available to stages (above).

## Security policy in one place

| Rule | Where enforced |
|------|----------------|
| Tokens extracted from configs into a `0600` store; configs hold `${NAME}` only | save |
| Secret values write-only; masked on read; scrubbed from errors and probe output | API, probe |
| No link-local / metadata URLs | save, probe, OAuth, resolve |
| No control-token or (unless allow-listed) provider/cloud credential placeholders | save |
| Host env reaches MCP only through `STAGEFLOW_MCP_ENV_ALLOW` | agent, probe |
| Stages see only the secrets they declare | stage |
| Repository-bound stages never see console servers or secrets | stage |
| A corrupt state file is never read as empty or overwritten | every read and write (409 `host_state_corrupt`) |
| Files are atomic (tmp + rename), mode `0600`, directory `0700` | writes |

Secrets are plaintext at rest at the same trust level as `channel-secrets.json`; protect the data volume.

## Routes

All routes take the same control token as the rest of `/api`. Names in paths are URL-encoded; malformed encoding is 400 `invalid_name`. A corrupt host-state file is 409 `host_state_corrupt` on every route.

| Method and path | Purpose | Statuses |
|-----------------|---------|----------|
| `GET /api/project-mcp` | List servers: `{ status: ok \| missing_catalog \| invalid_config, servers: [{ name, transport: stdio \| http, origin: project \| console }] }` | 200 |
| `POST /api/project-mcp/import` | Paste JSON: body `{ json }` (or the map itself). Returns `{ added, secretsStored, errors: [{ name, error }] }` | 200; 400 `invalid_body`, `invalid_server`, `reserved_name` |
| `GET /api/project-mcp/:name` | Read one console server, secrets masked (`••••`) | 200; 404 `not_found` (project-defined servers cannot be read back) |
| `PUT /api/project-mcp/:name` | Create or replace: body `{ config }`. Returns `{ name, secretsStored }` | 200; 400 `invalid_body`, `invalid_server`, `reserved_name`, `invalid_secret` |
| `DELETE /api/project-mcp/:name` | Remove a console server | 200; 404 `not_found`; 409 `project_defined` |
| `GET /api/project-mcp/:name/tools` | Tools cached from the last successful connect: `{ name, tools, cachedAt }`, or `tools: null` | 200 |
| `POST /api/project-mcp/:name/probe` | Check: `{ name, status, error?, tools? }` where status is `connected`, `needs_auth`, `connect_failed`, `unresolved_var`, `invalid_config`, `missing_catalog` or `cancelled`. Times out after 30 s; aborts if the request is dropped | 200 |
| `GET /api/mcp-secrets` | `{ secrets: [{ name, usedBy }], needed: [{ name, usedBy, set }] }`; `set` is true for a stored secret or a present allow-listed Host variable. Never values | 200 |
| `PUT /api/mcp-secrets/:name` | Body `{ value }` (string) | 200; 400 `invalid_secret`, `invalid_body` |
| `DELETE /api/mcp-secrets/:name` | Remove a secret | 200; 404 `not_found` |
| `GET /api/project-mcp/:name/oauth` | `{ name, status }` | 200; 400 `not_http`, `invalid_server`; 404 `not_found` |
| `DELETE /api/project-mcp/:name/oauth` | Sign out | 200; as above |
| `POST /api/project-mcp/:name/oauth/start` | `{ name, … }` with the address to open | 200; 400 `not_http`, `blocked_url`, `flow_failed`; 404; 409; 500 `store_unavailable` |
| `POST /api/project-mcp/:name/oauth/complete` | Body `{ input }`: the full redirected address | 200; 400 `invalid_body`, `invalid_input`, `flow_failed`; 404; 409; 500 |

OAuth error codes map to HTTP as: `not_found` 404, `not_http` / `flow_failed` / `invalid_input` / `blocked_url` 400, `host_state_corrupt` 409, `store_unavailable` 500.

## Troubleshooting

| You see | Cause and fix |
|---------|---------------|
| Check says `unresolved_var` | A `${NAME}` has no value for an agent/probe. Set the secret in the panel, or list a Host variable in `STAGEFLOW_MCP_ENV_ALLOW` |
| Check says `needs_auth` | The server wants OAuth. Use **Sign in** |
| Check says `connect_failed` | Server unreachable or command failed. For stdio the `command` must exist **inside the container** |
| Save fails: "provider or cloud credential name" | Rename the variable, or allow-list it |
| Save fails: "link-local or cloud-metadata address" | Blocked on purpose; use a normal host name |
| Works in an agent, fails in a stage | The stage must list the server under `mcp:` and each console secret it needs under `secrets:`; signed-in (OAuth) servers are not available to stages; repository-bound stages never see console servers |
| `sf validate`: `stage.unknown_secret` | The name is neither a console secret nor a registered Host secret ([Stage secrets](yaml-catalog.md#stage-secrets)) |
| 409 `host_state_corrupt` | `mcp/.mcp.json`, `secrets/mcp-secrets.json` or the OAuth store is unreadable or the wrong shape. Fix or remove the named file; nothing was changed |
| Server was saved but an agent warns `agent.mcp_server_unknown` | The name in the agent's `tools.mcp` differs from the saved name (names are case-sensitive) |
