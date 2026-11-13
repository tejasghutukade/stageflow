# Control surface: MCP or CLI

Every Stageflow skill follows this rule. Two ways drive the same Host: the MCP tools and the `sf` CLI. Pick one per task, say which you chose when it matters, and do not mix them mid-operation.

## Contents

- The rule
- What the CLI needs from a Host
- Probe the Host
- JSON and exit codes
- Things only one surface can do
- Safety on both surfaces

## The rule

1. If the Stageflow MCP tools are in your tool list and a call such as `get_started` answers, use MCP. Tools return structured data and need no output parsing.
2. Otherwise use the CLI. Add `--json` wherever the command accepts it and read the exit code.
3. If neither works, run the probe below and follow `references/setup.md`. Do not guess a Host URL or invent a tool name.

MCP tools exist only while a Host is running. The MCP server lives inside the Host, so every tool call needs one. The CLI is more forgiving: it starts a Host itself when it needs one, and a few read commands work with no Host at all.

## What the CLI needs from a Host

The CLI talks to `http://127.0.0.1:<port>` only. The port is `STAGEFLOW_SERVICE_PORT` if set, else 3847. A Host on another port, another machine or in a container is invisible to it unless that same port is exported and reachable on loopback. Use MCP for those Hosts.

| Group | Commands | Host behavior |
|---|---|---|
| Autostart a Host | `sf run`, `sf run-stage`, `sf trigger`, every `sf agents` verb, `sf eval` verbs other than `validate` and `engine`, `sf a2a` verbs that call the Host, and these `sf runs` verbs: `answer`, `feedback-decide`, `retry`, `resume`, `recover`, `abandon`, `cancel`, `delete`, `gc`, `rerun` | Probes `/livez`. If nothing is listening, spawns a detached `sf mcp --port <port>` (log: `$STAGEFLOW_HOME/service.log`) and waits up to `STAGEFLOW_AUTOSTART_TIMEOUT_MS` (default 10000) |
| Host-down reads | `sf runs list`, `show`, `verify`, `waiting`, `wait`; `sf artifact`; `sf envelope`; `sf export-run`; `sf debug-run`; `sf export --all`; `sf backup` | Read the SQLite store directly. They start a Host only when a store migration is pending |
| Never use a Host | `sf validate`, `sf graph`, `sf migrate-yaml`, `sf doctor`, `sf init`, `sf skills`, `sf providers`, `sf browser`, `sf eval validate`, `sf eval engine`, `sf a2a validate`, `list` and `add-caller`, `sf restore`, `--version`, `--help` | Run in-process |

Autostart failures are final, not retried. The reason id is one of:

| `reason` | Meaning | Fix |
|---|---|---|
| `autostart_disabled` | `STAGEFLOW_NO_AUTOSTART` is set (anything but empty, `0` or `false`) and nothing answers | Start the Host with `sf mcp` or `sf ui`, or unset the variable. An already-running Host still works |
| `port_occupied` | Something answers on the port but not with Stageflow's `/livez` JSON | Free the port or export a different `STAGEFLOW_SERVICE_PORT` for both the Host and the CLI |
| `bind_refused` | `STAGEFLOW_BIND` is not loopback and no control token is set | Set a token (see `references/host-and-mcp.md`) or bind loopback |
| `spawn_failed` | The detached process did not start | Read `$STAGEFLOW_HOME/service.log` |
| `timed_out` | The Host did not answer within the timeout | Read `service.log`; raise `STAGEFLOW_AUTOSTART_TIMEOUT_MS` on a slow disk |

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

## Probe the Host

Run `node <this skill's folder>/scripts/detect-host.mjs`. It requests `GET /livez` with a 1.5 second timeout and prints one line:

- `up http://127.0.0.1:3847` exit 0: a Stageflow Host answered with 200 and JSON.
- `down http://127.0.0.1:3847` exit 1: nothing, a non-200, non-JSON, or a hang.
- exit 2: bad arguments.

`bearer` is appended when `STAGEFLOW_CONTROL_TOKEN`, `STAGEFLOW_CONTROL_TOKEN_FILE`, or `$STAGEFLOW_HOME/control-token` is available, as a reminder that `/mcp` and `/api/*` need `Authorization: Bearer <token>` (omit only when the Host opted in with `STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND=1`). The probe never sends the token. `--base-url <url>` checks a Host elsewhere.

`/livez` and `/readyz` never need a bearer. `/api/health` does when a token is set, which is why the probe does not use it. The result is advisory: the probe says whether a Host is there, not whether your MCP client is connected to it.

## JSON and exit codes

Use `--json` on `sf run`, `sf run-stage`, `sf runs ...`, `sf validate`, `sf doctor`, `sf graph`, `sf trigger`, `sf eval run` and `sf --version`. `sf providers` has no `--json`: its output is tab-separated lines. Check `sf <command> --help` for any other command. Do not parse human prose when a JSON form exists.

| Command | 0 | 1 | 2 |
|---|---|---|---|
| `sf validate` | passed | any error finding, or a warning promoted by `--strict` | not used |
| `sf doctor` | no check failed (warnings allowed) | at least one `fail` | not used |
| `sf run` | run succeeded | run failed, or the Host could not be reached | run is waiting for an operator (`--json` outcome says so) |
| `sf run-stage` | async: call accepted. Blocking (`--blocking`): stage succeeded | bad input, or blocking stage failed | blocking only: parked on a gate (`needs_input`), or `--timeout-ms` elapsed |
| `sf runs wait` | woke on `waiting`, `terminal`, `already` or `timeout`; read `reason` and `run.status` | error, such as run not found | not used; 130 means the wait was aborted |
| `sf runs retry`, `rerun`, `recover` | succeeded (`recover --stop`: done) | failed, busy or cancelled | waiting after the retry |
| `sf eval run` | `--no-wait`: the Host accepted the run, before any score. Waited: the outcome is `passed` | anything else: below threshold, failed, cancelled, cost limit, invalid eval, missing engine, Host error | never |
| `sf browser check` | logged in | error | 2 profile in use, 3 logged out, 4 unknown |

A waiting run is not a failure. Exit 2 means a human must answer: hand off to `stageflow-operate`. A `sf runs wait` that exits 0 does not mean the run finished; check `reason`.

## Things only one surface can do

- CLI only: `sf init`, `sf graph`, `sf migrate-yaml`, `sf backup`, `sf restore`, `sf doctor`, `sf providers login`, `sf browser login`, `sf eval engine install`.
- MCP or REST (or the console) only: creating and editing connections, memories, and project registration. There is no `sf connections` command.
- Both: starting and answering runs, validating, listing the catalog, agents, evals. MCP is richer for live inspection; the CLI is simpler in CI.

When MCP is the only way (connections, memories), and no Host is up, tell the user to run `sf ui` or `sf mcp`, then connect the harness (`references/host-and-mcp.md`).

## Safety on both surfaces

- MCP tool calls carry no confirmation prompt of their own. You are the gate. Ask the user before calling anything that starts a real run, an eval, a trigger, an agent turn that uses real tools, a send, or a delete.
- Arguments appear in tool logs and chat. Never pass a secret as an argument. For connections, keys are entered in the console or exported by the user; see the skill that owns the task.
- The CLI inherits your shell environment, including provider keys. Do not echo it, and do not run `env` or `printenv` to debug.
