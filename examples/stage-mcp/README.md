# stage-mcp

Dummy catalog for **manual operator-console testing** of stage MCP. Project
`.mcp.json` at the git root declares `echo`, `unused`, `needs-token`, and
`dead`. The happy path passes only `echo`. The agent calls the local echo
fixture, then `emit_stage_envelope` so you can inspect the payload.

MCP elicitation is unsupported — the fixture does not ask the operator a
question.

Three pipelines:

| Pipeline | What it exercises |
|----------|-------------------|
| `stage-mcp` | Allowlist `echo` only — unused stays unavailable |
| `stage-mcp-missing-var` | Passes `needs-token` (`${STAGE_MCP_REQUIRED_TOKEN}`, no default) |
| `stage-mcp-dead` | Passes `dead` — command will not connect |

## Prerequisites

Use this repo's CLI (`npm run build` / `npm run dev`) or a Stageflow release
that includes stage MCP. A globally installed `sf` from npm may lag.

- Node.js ≥ 20
- From repo root: `npm run build` and `npm run ui:build`
- Provider auth connected (`sf ui` → Settings → Providers) for `sf run`. `sf validate` does not need auth. Stages use `cursor/auto`.

Run state lives in `<repo>/.stageflow` even if you start the console from a subdirectory.

## Terminal 1 — operator console (optional)

From the **repository git root**:

```bash
npm run build
npm run ui:build
PI_CURSOR_SETTING_SOURCES=all STAGEFLOW_ACTIVITY_VERBOSE=1 node dist/cli.js ui
```

`npm run dev -- ui` runs the TypeScript CLI via tsx; use `node dist/cli.js ui` after `ui:build` so the console is served from `dist/ui`. Do not use a globally installed `sf` — Homebrew `sf` is an older build that cannot load this catalog.

Open `http://127.0.0.1:3847`. Browse should list **stage-mcp**, **stage-mcp-missing-var**, and **stage-mcp-dead**.

## Terminal 2 — start a run (repo root)

```bash
node dist/cli.js validate --pipeline examples/stage-mcp/stage-mcp.pipeline.yaml --strict
node dist/cli.js run \
  --pipeline examples/stage-mcp/stage-mcp.pipeline.yaml \
  --task examples/stage-mcp/stage-mcp.task.yaml
```

`sf` works the same if that binary is this repo's build. Start a **new run** for each scenario below. Do not reuse a finished run.

Validate does not require `STAGE_MCP_REQUIRED_TOKEN` or a live connect.

---

## Scenario A — allowlist

Happy pipeline. `.mcp.json` defines `echo` and `unused`. The stage passes only `echo`.

### What to verify

1. The agent can call the echo fixture and cannot use `unused`.
2. Ambient Cursor MCP is not inherited. Only the names on the stage list are passed.
3. The handoff envelope payload includes `echoed` from the fixture.

```bash
node dist/cli.js envelope get --run <runId> --stage use-echo --json
```

---

## Scenario B — missing required var

New run **without** `STAGE_MCP_REQUIRED_TOKEN` in the environment:

```bash
node dist/cli.js run \
  --pipeline examples/stage-mcp/stage-mcp-missing-var.pipeline.yaml \
  --task examples/stage-mcp/stage-mcp-missing-var.task.yaml
```

### What to verify

1. The stage fails before the agent is treated as having those tools.
2. `sf validate` on this pipeline still passes — unset required vars fail at **run**, not validate.

---

## Scenario C — dead server

New run:

```bash
node dist/cli.js run \
  --pipeline examples/stage-mcp/stage-mcp-dead.pipeline.yaml \
  --task examples/stage-mcp/stage-mcp-dead.task.yaml
```

### What to verify

1. The passed `dead` server will not connect.
2. The stage fails.

---

## Scenario D — both backends

Same `mcp` list and `.mcp.json` allowlist, first on Pi, then on Claude. Change only the stage `model` between runs.

### What to verify

1. Both backends receive the servers named on the stage.
2. Transports and protocol features may differ. Do not change `mcp` or `.mcp.json` to switch backends.

---

## Scenario E — Stageflow tools stay

Happy path again (or reuse Scenario A if the envelope already landed).

### What to verify

1. `emit_stage_envelope` still works. `write_stage_artifact` remains available.
2. MCP tool calls do not park for a new MCP-specific approval.

---

## Scenario F — activity log

After the agent calls the echo fixture, inspect the run in the console or CLI.

### What to verify

1. The echo tool call is visible in the existing stage activity.
2. There is no dedicated MCP console.

## Envelope inspector (any successful happy-path run)

On a completed `use-echo` stage, the first Files row is **Handoff envelope**. It opens the inspector (`#/runs/<runId>/stages/use-echo/envelope`) with `summary`, `payload`, and artifact paths.

CLI equivalent: `node dist/cli.js envelope get --run <runId> --stage use-echo --json`.
