# Stageflow

CLI pipeline runtime for configurable SDLC stages on [Pi](https://github.com/badlogic/pi-mono), plus a local operator console.

Author YAML pipelines, stages, and tasks in a project directory. Stageflow runs each stage in a fresh Pi agent session, writes a structured handoff envelope, and keeps run state under `.stageflow/`. Bins: **`sf`** and **`stageflow`**.

Requires **Node.js ≥ 20**.

## Install

```bash
npm i -g stageflow
# or
npx stageflow
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
