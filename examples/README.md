# Examples

Runnable Stageflow catalogs. Each directory is **pipeline-owned** (co-located `*.pipeline.yaml`, stage YAML, `*.task.yaml`). Run commands use **paths from the repository git root**.

Stages are **author-defined** in YAML; these walkthroughs show domain-neutral flows, release automation, and an SDLC-style plan review — not built-in product types.

## Featured example: Archify on PR

**[`archify-on-pr/`](archify-on-pr/)** is the flagship CI dogfood walkthrough. It shows what configurable stages look like in production:

- **Conditional fork** — `detect-changes` skips downstream work when the PR diff has no diagram-relevant paths
- **Multi-type output** — one pipeline authors 1–5 Archify diagram specs (`architecture`, `workflow`, `sequence`, `dataflow`, `lifecycle`)
- **Skill binding** — `skill: archify` on the pipeline stage entry; GHA provisions the skill via `sf skills install`
- **Deterministic handoff** — agents emit JSON specs; GHA runs `sf envelope get --format handoff` and Archify `deliver` outside the agent
- **Real automation** — [`.github/workflows/archify-pr-diagrams.yml`](../.github/workflows/archify-pr-diagrams.yml) posts sticky PR comments with browser-viewable HTML artifacts

Start here: [archify-on-pr/README.md](archify-on-pr/README.md) · CI overview: [docs/ci.md#pr-diagrams-archify](../docs/ci.md#pr-diagrams-archify)

More CI-focused examples will follow this pattern (prepare context → run pipeline → consume envelope in shell).

| Example | Description | Commands |
|---------|-------------|----------|
| [hello-world](hello-world/) | Single stage, no HITL | `sf validate --strict`, `sf run` with paths below |
| [plan-review](plan-review/) | Multi-stage with operator gate | `sf ui`, then `sf run` |
| [conditional-fork](conditional-fork/) | Exclusive fork; operator chooses branch | `sf ui`, then `sf run` |
| [clonable-fanout](clonable-fanout/) | Dummy clonable skip / once / parallel / sequential / mix | `sf ui`, then `sf run` |
| [oss-issue-contribution](oss-issue-contribution/) | Real upstream issue: reproduce, parallel investigation, gated fix, verification, parallel review | [README](oss-issue-contribution/README.md), then `sf run` |
| [github-release](github-release/) | Dogfood: draft + publish GitHub Release | Used in publish/release workflows |
| [archify-on-pr](archify-on-pr/) | **Featured** — PR diagrams via conditional fork + Archify handoff | [README](archify-on-pr/README.md), archify-pr-diagrams workflow |
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

Archify-on-PR local dry-run (requires `OPENAI_API_KEY` + Archify skill — see example README):

```bash
./scripts/prepare-ci-context.sh ci-context.json
sf run \
  --pipeline examples/archify-on-pr/archify-on-pr.pipeline.yaml \
  --task examples/archify-on-pr/archify-on-pr.task.yaml \
  --skip-gates --json > sf-run.json
```

Terminal 1 (optional console, from any subdirectory):

```bash
cd examples/conditional-fork && sf ui
```

See [docs/quickstart.md](../docs/quickstart.md) and [docs/providers.md](../docs/providers.md).
