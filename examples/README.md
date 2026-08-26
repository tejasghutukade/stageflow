# Examples

Runnable Stageflow catalogs. Each directory is **pipeline-owned** (co-located `*.pipeline.yaml`, stage YAML, `*.task.yaml`). Run commands use **paths from the repository git root**.

Stages are **author-defined** in YAML; these walkthroughs show domain-neutral flows, release automation, and an SDLC-style plan review — not built-in product types.

| Example | Description | Commands |
|---------|-------------|----------|
| [hello-world](hello-world/) | Single stage, no HITL | `sf validate --strict`, `sf run` with paths below |
| [plan-review](plan-review/) | Multi-stage with operator gate | `sf ui`, then `sf run` |
| [conditional-fork](conditional-fork/) | Exclusive fork; operator chooses branch | `sf ui`, then `sf run` |
| [github-release](github-release/) | Dogfood: draft + publish GitHub Release | Used in publish/release workflows |
| [archify-on-pr](archify-on-pr/) | PR diagrams (architecture, workflow, sequence, dataflow, lifecycle) | Used in archify-pr-diagrams workflow |
| [ci-validate](ci-validate/) | Strict manifest validate in CI | `./validate.sh` |

Browse scope is declared in repo-root [`stageflow.yaml`](../stageflow.yaml). **`sf ui` started from any subdirectory** still uses `<repo>/.stageflow` for run state.

## Prerequisites (all examples)

- **Node.js ≥ 20**
- Stageflow CLI: `npm i -g stageflow` (or `npm run build` in this repo)
- **Provider auth** for `sf run` (not required for `sf validate`)

## Validate all examples

From repo root after `npm run build`:

```bash
npm run validate:examples
```

## Run an example (repo root)

```bash
sf validate --strict
sf run \
  --pipeline examples/hello-world/hello.pipeline.yaml \
  --task examples/hello-world/my-task.task.yaml
```

North-star fork demo:

```bash
sf run \
  --pipeline examples/conditional-fork/fork-demo.pipeline.yaml \
  --task examples/conditional-fork/fork-demo.task.yaml
```

Terminal 1 (optional console, from any subdirectory):

```bash
cd examples/conditional-fork && sf ui
```

See [docs/quickstart.md](../docs/quickstart.md) and [docs/providers.md](../docs/providers.md).
