# ci-validate

Validate-only CI demo. Checks the repo manifest and example catalogs with `sf validate --strict` — no provider auth or agent run required.

## Prerequisites

- Node.js ≥ 20
- Stageflow CLI (`npm i -g stageflow` or built from this repo)

## Commands

From the **repository git root**:

```bash
chmod +x examples/ci-validate/validate.sh
./examples/ci-validate/validate.sh
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
- run: npm i -g stageflow
- run: sf validate --strict --json
```

Run from the workspace root where `stageflow.yaml` lives.
