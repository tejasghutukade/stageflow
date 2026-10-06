# Contributing

Thanks for your interest in Stageflow. This is a solo-maintainer MIT project — focused contributions are welcome.

## Prerequisites

- **Node.js ≥ 20**
- Git

## Getting Started

```bash
git clone https://github.com/tejasghutukade/stageflow.git
cd stageflow
npm i
npm run build && npm run ui:build
npm run validate:examples   # sf validate --strict (manifest-all from repo root)
```

Run the operator console locally:

```bash
sf ui
```

Or use the dev entrypoint:

```bash
npm run dev -- ui
```

### Live reload while developing

`sf ui`/`npm run dev -- ui` still serves the UI's last **built** bundle
(`dist/ui`) — editing `ui/src/**` won't do anything until you rebuild. For a
loop that actually reflects changes as you make them, run these two in
separate terminals instead of rebuilding by hand:

```bash
npm run dev:watch    # backend: tsx watch, restarts on any src/ change
npm run ui:dev        # frontend: vite dev server with HMR, on :5173
```

Then open **http://localhost:5173** (not the backend's own `:3847`) — Vite
proxies `/api` calls to the backend for you (see `ui/vite.config.ts`), so
frontend edits hot-reload and backend edits auto-restart, with no build step
in between. `dev:watch` also sets `PI_CURSOR_SETTING_SOURCES=all` and
`STAGEFLOW_ACTIVITY_VERBOSE=1`, so you don't need to set them by hand.

## Running Tests

CI runs the same checks on every push and pull request:

```bash
npm test              # unit/integration tests (vitest)
npm run ui:test       # operator UI tests
npm run typecheck     # TypeScript
```

Optional: `npm run test:watch` for iterative test runs.

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your change with a clear commit message
3. Run `npm test`, `npm run ui:test`, and `npm run typecheck`
4. Open a pull request against `main` with a short description of what changed and why

No contributor license agreement (CLA) is required.

## YAML and Examples

- Canonical fixture YAML lives in `tests/fixtures/`
- Runnable walkthroughs live in `examples/` — see [examples/README.md](examples/README.md)
- Schema reference: [docs/yaml-catalog.md](docs/yaml-catalog.md)

## UI Work

Operator console code is in `ui/`. See [ui/AGENTS.md](ui/AGENTS.md) for UI-specific guidance.

## Code of Conduct

By participating, you agree to abide by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Questions

Open a [GitHub Issue](https://github.com/tejasghutukade/stageflow/issues) or read [SUPPORT.md](SUPPORT.md).
