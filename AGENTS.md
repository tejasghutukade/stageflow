# AGENTS.md

Guidance for contributors and AI coding agents working on the Stageflow repository.

## What Stageflow is

Stageflow is a CLI pipeline runtime for **configurable stages** on [Pi](https://github.com/badlogic/pi-mono), with a local operator console.

- Users author YAML catalogs (`pipelines/`, `stages/`, `tasks/`) in their project
- Each stage runs in a fresh Pi agent session
- Stages hand off via typed envelopes and artifacts
- HITL gates pause for operator input; the same pipeline runs locally, in CI (`sf run --json`), and via MCP when `sf ui` is running

**Stages are domain-agnostic.** Release automation, research flows, content review, SDLC, and ops runbooks are all valid patterns. Stageflow validates shape and wiring; it does not ship domain-specific stage types.

## Repository layout

| Path | Purpose |
|------|---------|
| `src/` | CLI, runtime, config loader, MCP, HTTP server |
| `ui/` | Operator console (Vite + React workspace) |
| `tests/` | Vitest suite; **`tests/fixtures/`** is canonical YAML |
| `examples/` | Runnable walkthroughs with READMEs |
| `docs/` | Public reference (YAML, CLI, CI, MCP, etc.) |

### `src/` map (high level)

| Directory | Responsibility |
|-----------|----------------|
| `cli/` | `sf run`, `sf validate`, `sf ui`, `sf providers` |
| `config/` | YAML load/validate, pipeline DAG resolution |
| `runtime/` | Pipeline runner, stage worker, HITL, scheduling |
| `runstore/` | SQLite run state under `.stageflow/` |
| `agent/` | Pi coding agent adapter |
| `mcp/` | MCP server and tools |
| `server/` | HTTP routes for the operator console API |
| `tools/` | Pi tools (`ask_operator`, `emit_stage_envelope`, …) |
| `envelope/` | Envelope schema and validation |

Entry point: `src/cli.ts`. Library exports: `src/index.ts`.

## Commands

From repo root after `npm i`:

```bash
npm run build          # compile CLI to dist/
npm test               # vitest (src + integration)
npm run typecheck      # tsc --noEmit
npm run ui:build       # build console + copy assets into dist/ui
npm run ui:test        # vitest in ui workspace
sf ui                  # operator console (requires build + ui:build)
```

Dev entrypoint without a global install:

```bash
npm run dev -- ui
npm run dev -- run --task tests/fixtures/tasks/sample.yaml --pipeline single
```

Optional: `npm run ui:dev` for Vite hot reload against a running `sf ui` backend.

## YAML authoring

When changing pipeline/stage/task schema, validation, or doc examples:

- Read **[docs/yaml-catalog.md](docs/yaml-catalog.md)** — authoritative schema reference
- Treat **`tests/fixtures/`** as canonical YAML; keep `examples/` in sync when behavior changes
- Runnable walkthroughs: **[examples/README.md](examples/README.md)**

Related docs: [envelopes.md](docs/envelopes.md), [hitl.md](docs/hitl.md), [cli-reference.md](docs/cli-reference.md), [ci.md](docs/ci.md), [mcp.md](docs/mcp.md).

## Making changes

1. Match existing patterns in the area you touch — minimal, focused diffs
2. Run `npm test`, `npm run ui:test`, and `npm run typecheck` before finishing
3. No comments unless logic is non-obvious
4. Do not commit secrets or `.env` files

### CLI / runtime work

- JSON output and exit codes are part of the public contract — see `docs/ci.md` and `tests/cli.*.test.ts`
- Stage worker protocol: `src/runtime/stageWorkerProtocol.ts`
- Provider auth: `src/agent/providerAuth.ts`, `docs/providers.md`

### Tests

- Tests live in `tests/*.test.ts`
- Fixtures: `tests/fixtures/pipelines/`, `stages/`, `tasks/`
- Prefer extending fixtures over inline YAML when behavior is catalog-driven

## UI work

Operator console code lives in **`ui/`**. Read **[ui/AGENTS.md](ui/AGENTS.md)** for UI-specific rules (Astryx workflow, chrome exception, UX docs, component map). Do not duplicate that file here.

## Documentation

- Public docs index: [docs/README.md](docs/README.md)
- Human contributor flow: [CONTRIBUTING.md](CONTRIBUTING.md)
- Planning artifacts under `docs/plans/` and `docs/ideation/` are local-only (gitignored)

## Positioning (public copy)

When writing user-facing text, avoid framing Stageflow as an SDLC-only tool. Lead with **configurable stages / pipelines**; cite SDLC as one example among others (releases, research, ops, etc.).
