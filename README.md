# Stageflow

CLI pipeline runtime for configurable SDLC stages on [Pi](https://github.com/badlogic/pi-mono), plus a local operator console.

Author YAML pipelines, stages, and tasks in a project directory. Stageflow runs each stage in a fresh Pi agent session, writes a structured handoff envelope, and keeps run state under `.stageflow/`. Bins: **`sf`** and **`stageflow`**.

Requires **Node.js ≥ 20**.

## Install

```bash
npm i -g stageflow
# or
npx stageflow
# or, from a packed tarball
npm i -g ./stageflow-*.tgz
```

`better-sqlite3` ships prebuilds for common platforms. `--ignore-scripts` is fine when a prebuild exists. Benign `node-gyp` warnings during install can be ignored if `require("better-sqlite3")` works.

## Quick start

In a project directory, author:

- `pipelines/` — ordered stage lists
- `stages/` — stage definitions (instructions, model, optional human gates)
- `tasks/` — work items (goal, pipeline, optional checkout)

```bash
sf ui                          # operator console at http://127.0.0.1:3847
sf run --task tasks/foo.yaml --pipeline <pipeline-id>
```

Connect model providers in the console (Settings → Providers) or via `sf providers …`. Stageflow is a thin Pi shell: reuse an existing Pi login (`pi_home`) or store credentials in an SF-owned file (`sf_owned`). You do not need Pi CLI `/login` as a hard prerequisite.

## Headless / CI

The guest actor is the CLI (`sf` / `stageflow`). `sf ui` and MCP are not required in the job.

```bash
sf validate --strict --json
```

Validate exits `0` or `1` only (no waiting / `2`). It checks pipeline and stage YAML only; it does not prove provider auth, Task, or checkout.

```bash
sf providers login <providerId> --api-key-env <VAR>
```

If the provider also supports OAuth, pass `--type api_key`.

```bash
sf run --task tasks/foo.yaml --pipeline <pipeline-id> --json
```

The process exits `0` when the Run succeeded, `1` when it failed (including a busy start), and `2` when waiting. `sf run --json` prints one stdout document. `ok` is true only for `succeeded`. Busy has no `runId`.

| outcome | ok | runId | exit |
|---|---|---|---|
| `succeeded` | true | present | `0` |
| `failed` | false | present after start; omit when start never created a run | `1` |
| `waiting` | false | present | `2` |
| `busy` | false | omit | `1` |

On a mixed Pipeline, default wait parks the Run (exit `2`). `--skip-gates` fails the Stage (exit `1`). A Pipeline with no HITL does not need the flag.

## State

Runtime state lives in **`.stageflow/`** (SQLite + per-run workspaces under `.stageflow/runs/`). If `.stageflow` is missing and `.software-factory` exists from an older install, the next store open renames it to `.stageflow` once.

## MCP

`sf ui` also serves a Streamable HTTP MCP endpoint at `http://127.0.0.1:3847/mcp` (URL printed on boot). Point a Cursor (or other) MCP client at that URL for tools like `list_pipelines`, `start_run`, and `get_run`.

## Develop from source

```bash
git clone https://github.com/tejasghutukade/stageflow.git
cd stageflow
npm i
npm run build && npm run ui:build   # ui:build builds the UI and copies assets into dist/ui
sf ui
```

## License

MIT © Tejas G

Issues: https://github.com/tejasghutukade/stageflow/issues
