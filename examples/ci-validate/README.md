# ci-validate

Validate-only CI demo. Checks pipeline and stage YAML with `sf validate --strict` — no provider auth or agent run required.

## Prerequisites

- Node.js ≥ 20
- Stageflow CLI (`npm i -g stageflow` or `npx stageflow`)

## Commands

From this directory:

```bash
chmod +x validate.sh
./validate.sh
```

Or directly:

```bash
sf validate --strict --json
```

## GitHub Actions snippet

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: "24"

- run: npm i -g stageflow@latest

- name: Validate Stageflow catalog
  working-directory: examples/ci-validate
  run: sf validate --strict --json
```

See [docs/ci.md](../../docs/ci.md) for exit codes and JSON output shape.
