# playwright-mcp

One-stage walkthrough: **open a page and screenshot it**, using Microsoft Playwright MCP (`npx @playwright/mcp@latest`) from git-root `.mcp.json`.

Playwright's `--output-dir` is interpolated to `STAGEFLOW_STAGE_ARTIFACTS_DIR` (this attempt's artifacts folder). Auto-named snapshots use that directory. A named `browser_take_screenshot` `filename` does **not** — Playwright MCP resolves it against the MCP client workspace (the project checkout). The stage prompt therefore passes `${STAGEFLOW_STAGE_ARTIFACTS_DIR}/page.png` (stamped to an absolute artifacts path at attach) so the PNG lands in the run Files pane instead of the git root.

| Stage | MCP | What it does |
|-------|-----|----------------|
| `screenshot` | `playwright` | `browser_navigate` → `browser_take_screenshot` (`page.png`) |

Completion requires `page.png` on disk. Settings Check (no stage) falls back to `examples/playwright-mcp/.playwright-mcp/` (gitignored).

## Prerequisites

- Node.js ≥ 20 and this repo's CLI (`npm run build`), not an older global `sf`
- Provider auth (`sf ui` → Settings → Providers)
- First run may download Chromium via Playwright (needs network)

Git-root `.mcp.json` already names `playwright`. The stage still passes `mcp: [playwright]` — listing it in the catalog is not attach.

Optional: Settings → **Project MCP servers** → Check `playwright` before the run.

## Run (repo root)

```bash
npm run build
node dist/cli.js validate --pipeline examples/playwright-mcp/playwright-mcp.pipeline.yaml --strict
node dist/cli.js run \
  --pipeline examples/playwright-mcp/playwright-mcp.pipeline.yaml \
  --task examples/playwright-mcp/playwright-mcp.task.yaml
```

Inspect:

```bash
node dist/cli.js envelope get --run <runId> --stage screenshot --json
```

The Files row is `page.png`.
