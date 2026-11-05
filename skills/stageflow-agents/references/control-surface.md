# Control surface

CLI, MCP, and REST for every agent operation. The workflow that decides when to call them is in `../SKILL.md`. Field rules are in [agent-definition.md](agent-definition.md).

## Contents

- [Which surface](#which-surface)
- [HTTP](#http)
- [Operations](#operations)
- [Observe sessions and cost](#observe-sessions-and-cost)
- [Revisions](#revisions)

## Which surface

| You have | Use |
|---|---|
| A shell in the project (the default) | Write `agents/<id>.agent.yaml`, then `sf agents …` from that directory |
| No shell, or the Host is remote or in a container | MCP tools on the Host's `/mcp` endpoint. They take no project argument and act on the directory `sf ui` or `sf mcp` was started in. If that is not the user's project, use the CLI from the project directory |
| Neither CLI nor MCP (MCP server setup, identity, delivery resend, OTLP export, the Stageflow tool registry, a saved-connection check) | REST, or the console page named in the other references |

`sf agents` always talks to a running Host. It starts a headless one (`sf mcp` on port 3847, or `STAGEFLOW_SERVICE_PORT`) when nothing answers, unless `STAGEFLOW_NO_AUTOSTART` is set. There is no offline mode, including for `validate`. The CLI sends the project of the current directory.

There is no `sf agents create`, `save`, or `archive`. Create by writing the file (or MCP `create_agent`). Save by editing the file (or MCP `save_agent`). Archive by deleting the file (or MCP `archive_agent`).

A global `sf` on `PATH` may be older than this repo. From the Stageflow repo, `npm run dev -- agents …` runs the current CLI. In a customer project, `sf` is the installed CLI.

## HTTP

Base URL: `http://127.0.0.1:${STAGEFLOW_SERVICE_PORT:-3847}`.

If `STAGEFLOW_CONTROL_TOKEN` is set, every `/api` call needs `Authorization: Bearer` with that token. GET needs scope `read`. POST, PUT, PATCH, and DELETE need `drive`. With no token configured, a loopback Host accepts the call without one. Do not print the token. `sf agents` attaches it itself. These paths do not use the token: `POST /api/agent-inbound/<id>`, and `/api/public/chat/…`.

Non-GET calls to `/api/memories`, `/api/connections`, and `/api/identity/setup` also need `Origin` set to the same host, for example `Origin: http://127.0.0.1:3847`. Other `/api/identity/…` writes, agent routes, and project MCP routes do not.

The CLI adds `?project_root=` for you. A raw REST call to an agent route uses the Host's own project unless you pass `project_root`. An unknown root is `unknown_project_root`. Register once, then retry:

```bash
curl -s -X POST "http://127.0.0.1:${STAGEFLOW_SERVICE_PORT:-3847}/api/projects" \
  -H 'Content-Type: application/json' \
  -d "{\"project_root\":\"$(pwd)\"}"
```

Agent error bodies are `{ "code", "message"?, "issues"? }`. `agent.invalid` is HTTP 422. Not found is 404. `agent.conflict`, `agent.exists`, `agent.archived`, `agent.disabled`, `agent.session_busy`, and `agent.limit_reached` are 409. `agent.approval_forbidden` and `agent.session_eval_readonly` are 403. `agent.model_timeout` is 504.

## Operations

`<id>` is the agent id. `<sid>` is the session id. `<rev>` is a revision number starting at 1. MCP `save_agent` and `restore_agent_revision` take `baseRevision` as the current revision; a stale one is `agent.conflict`.

| Operation | CLI | MCP | REST |
|---|---|---|---|
| List | `sf agents list --json` | `list_agents` | `GET /api/agents` |
| Get (definition, yaml, warnings) | `sf agents get <id> --json` | `get_agent { id }` | `GET /api/agents/<id>` |
| Validate a file | `sf agents validate <file.agent.yaml> --json` | | `POST /api/agents/validate` with `{ "definition": { … } }` |
| Validate a definition | | `validate_agent { definition }` | same POST |
| Create | write the file | `create_agent { definition }` (starts disabled; omitted `web_chat` turns public chat on) | `POST /api/agents` with `{ "definition" }` → 201 |
| Save | edit the file | `save_agent { id, baseRevision, definition, summary? }` | `POST /api/agents/<id>/save` with `{ baseRevision, definition, summary? }` |
| Enable | `sf agents enable <id> --json` | `enable_agent { id }` | `POST /api/agents/<id>/enable` |
| Disable | `sf agents disable <id> --json` | `disable_agent { id }` | `POST /api/agents/<id>/disable` |
| History | `sf agents history <id> --json` | `list_agent_revisions { id }` | `GET /api/agents/<id>/revisions` |
| One revision | none | `get_agent_revision { id, revision }` | `GET /api/agents/<id>/revisions/<rev>` |
| Diff | `git diff` on the file | `diff_agent_revisions { id, from, to }` returns the line array | `GET /api/agents/<id>/revisions/<from>/diff/<to>` returns `{ "lines": [ ... ] }` |
| Restore | `sf agents restore <id> <rev> --base <current>` | `restore_agent_revision { id, revision, baseRevision }` | `POST /api/agents/<id>/revisions/<rev>/restore` with `{ baseRevision }` |
| Archive | delete the file | `archive_agent { id }` | `POST /api/agents/<id>/archive` |
| Chat | `sf agents chat <id> --message "…" [--session <sid>] [--json]` | `agent_chat { id, message, sessionId? }` | `POST /api/agents/<id>/chat` with `{ message, sessionId? }` |
| Stop a running turn | none | `stop_agent_session { id, sessionId }` | `POST /api/agents/<id>/chat/stop` with `{ sessionId }` |
| List sessions | `sf agents sessions <id> [--status <status>] --json` | `list_agent_sessions { id, status?, search?, limit?, cursor? }` | `GET /api/agents/<id>/sessions` |
| One session | `sf agents session <id> <sid> --json` | `get_agent_session { id, sessionId }` | `GET /api/agents/<id>/sessions/<sid>` |
| Approve | `sf agents approve <id> <sid> --json` | `approve_agent_action { id, sessionId }` | `POST /api/agents/<id>/sessions/<sid>/approval/approve` |
| Deny | `sf agents deny <id> <sid> --json` | `deny_agent_action { id, sessionId }` | `POST /api/agents/<id>/sessions/<sid>/approval/deny` |

`sf agents validate` reads the YAML file, posts the parsed object, and exits 0 when `issues` is empty, 1 otherwise. `--json` prints `{ definition, issues, warnings, yaml }`. Each issue and warning has `path`, `code`, and `message`. Human output prints `error` and `warning` lines and the word `valid`.

`sf agents restore` without `--base` does not restore. It prints the current revision so you can pass `--base`. Restore keeps the current enabled state.

`sf agents chat` streams NDJSON. Without `--json` it writes reply deltas to stdout and `session <sid>` to stderr. With `--json` it prints the final session object. A stream that ends early is `agent.stream_closed`. MCP `agent_chat` waits for the whole turn and returns the session. Each message spends money on the user's provider account. Confirm first.

Only enable is refused while the file has issues or a memory is missing (`agent.invalid`). Disable still rewrites the file with `enabled: false`. Any save through the Host rewrites the file in canonical form. Re-read it before the next edit. A hand edit that drops `enabled: true` disables the agent.

Session `status` for `--status` and the MCP filter is `open`, `running`, `waiting`, `held`, or `closed`.

## Observe sessions and cost

```bash
sf agents sessions <id> --json
sf agents session <id> <sid> --json
```

The session object carries the transcript, turns, and approvals. A `waiting` session has a pending approval: the tool name and the arguments. Show that to the user before `approve` or `deny`.

Cost and token counts are on the session list (`list_agent_sessions` includes them; the CLI `--json` list is the same payload as `GET /api/agents/<id>/sessions`). Copy the numbers the API returns. Do not compute a provider bill from them.

All agents' sessions, across ids: `GET /api/agents/sessions` (optional `agent` and `status` query). Pending approvals across agents: `GET /api/agents/approvals`. Neither has a CLI or an MCP tool.

One session as OTLP JSON: `GET /api/agents/<id>/sessions/<sid>/otlp`. REST only. Spans exist when `observability.capture` is `metadata` or `full`. See [design-playbook.md](design-playbook.md#capture).

Channel listener and the last undelivered reply: `GET /api/agents/<id>/channel`. Resend is in [channels-and-identity.md](channels-and-identity.md#replies).

A session stays on the revision it started with. After an edit, omit `--session` so the test opens a new one.

## Revisions

Numbered from 1. Sources: `file` (a hand edit), `console` (REST, which includes the CLI), `api` (MCP, author `mcp`), `restore`, `author`. A formatting-only hand edit does not create a revision. An unparsable edit keeps the last good revision running and shows the issues. A brand-new unparsable file appears at revision 0 with issues.

An identical save is a no-op. `agent.conflict` means re-read, reapply, retry with the new `baseRevision`. `agent.id_immutable` means the id cannot change. `agent.exists` means create hit an id that is already there. Archive keeps history and sessions readable, refuses new sessions, and frees the id for later.
