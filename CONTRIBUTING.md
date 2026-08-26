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
npm run validate:examples   # sf validate --strict on each examples/* catalog
```

Run the operator console locally:

```bash
sf ui
```

Or use the dev entrypoint:

```bash
npm run dev -- ui
```

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
