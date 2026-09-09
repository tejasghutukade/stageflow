# context7-mcp

Three-stage walkthrough: **resolve a library**, **fetch docs**, then **write a brief**, using Context7 MCP (`https://mcp.context7.com/mcp`) from git-root `.mcp.json`.

Each MCP stage is a **fresh Pi session**. Stage 1 cannot leave a live Context7 connection for stage 2. The `library_id` travels in the envelope; stage 2 calls `query-docs`. Stage 3 has **no** `mcp:` list — it only turns the excerpt into an artifact.

| Stage | MCP | What it does |
|-------|-----|----------------|
| `resolve-library` | `context7` | `resolve-library-id` → emit `library_id` |
| `fetch-docs` | `context7` | `query-docs` → `docs.md` + `excerpt` |
| `write-brief` | — | `brief.md` from the excerpt (no MCP) |

## Prerequisites

- Node.js ≥ 20 and this repo's CLI (`npm run build`), not an older global `sf`
- Provider auth (`sf ui` → Settings → Providers)
- `CONTEXT7_API_KEY` in the environment of the `sf run` / `sf ui` process (free key at [context7.com/dashboard](https://context7.com/dashboard)). The catalog interpolates `Authorization: Bearer ${CONTEXT7_API_KEY}`. `sf validate` does not require the var; the run does.

Git-root `.mcp.json` already names `context7`. Stages still pass `mcp: [context7]` — listing it in the catalog is not attach.

Optional: Settings → **Project MCP servers** → Check `context7` before the run.

## Run (repo root)

```bash
export CONTEXT7_API_KEY=...   # from context7.com/dashboard
npm run build
node dist/cli.js validate --pipeline examples/context7-mcp/context7-mcp.pipeline.yaml --strict
node dist/cli.js run \
  --pipeline examples/context7-mcp/context7-mcp.pipeline.yaml \
  --task examples/context7-mcp/context7-mcp.task.yaml
```

Inspect:

```bash
node dist/cli.js envelope get --run <runId> --stage resolve-library --json
node dist/cli.js envelope get --run <runId> --stage fetch-docs --json
node dist/cli.js envelope get --run <runId> --stage write-brief --json
```

The operator-facing write-up is the `write-brief` Files row `brief.md`.
