# archify-on-pr

PR-triggered Archify diagrams: detect relevant diff changes, choose one or more
diagram types (architecture, workflow, sequence, dataflow, lifecycle), and author
JSON specs for GHA to deliver as HTML.

## Layout

| Path | Role |
|------|------|
| `archify-on-pr.pipeline.yaml` | detect-changes fork → author-diagrams |
| `detect-changes.yaml` | Diagram-type selection from `ci-context.json`, `fork_choice` routing |
| `author-diagrams.yaml` | Writes `{type}.spec.json` per selected type (skill: archify on pipeline entry) |
| `archify-on-pr.task.yaml` | Task bound at run time |
| `../../scripts/prepare-ci-context.sh` | Deterministic PR/git context before `sf run` (GHA + local) |

## Diagram types

| Type | Typical triggers |
|------|------------------|
| `architecture` | Modules, services, boundaries, layout |
| `workflow` | Pipelines, stages, CI, orchestration, runbooks |
| `sequence` | API routes, middleware chains, request lifecycles |
| `dataflow` | Persistence, migrations, ETL, envelope/artifact flow |
| `lifecycle` | State machines, run status, HITL, retry/recovery |

detect-changes selects 1–5 types based on the PR diff; author-diagrams writes one
spec artifact per type.

## Prerequisites

- Node.js ≥ 20, Stageflow built (`npm run build`)
- **OpenAI** provider (`openai/gpt-5.3-codex`) — set `OPENAI_API_KEY`
- **Archify skill** at `.pi/skills/archify/` (see below)
- Git checkout at the PR head; run `prepare-ci-context.sh` before `sf run` (GHA does
  this automatically)

## CI context (`ci-context.json`)

Before Stageflow runs, GHA executes `scripts/prepare-ci-context.sh`. It resolves
`head_sha`, `repo_url`, the PR diff file list, and `verified_paths` (whether each
changed path exists at `head_sha`). Both pipeline stages read this file — agents
do not use `GITHUB_SHA` or run their own git diff.

Local dry-run:

```bash
PR_HEAD_SHA="$(git rev-parse HEAD)" \
GITHUB_REPOSITORY="$(git remote get-url origin | sed -E 's#.*github.com[:/]([^/]+/[^/.]+).*#\1#')" \
GITHUB_BASE_REF=main \
./scripts/prepare-ci-context.sh ci-context.json
```

## Install Archify skill

From the repository git root (after `npm run build`):

```bash
node dist/cli.js skills install \
  --from-zip "https://github.com/tt-a1i/archify/releases/download/v2.15.0/archify.zip" \
  --skill-name archify
```

For local development, install from an existing skill tree:

```bash
node dist/cli.js skills install --from-path ~/.agents/skills/archify --skill-name archify
```

Install runs `archify doctor` after copying to `.pi/skills/archify/`.

## Commands

Local dry-run from repo root:

```bash
sf validate --strict
export OPENAI_API_KEY=…
./scripts/prepare-ci-context.sh ci-context.json
sf run \
  --pipeline examples/archify-on-pr/archify-on-pr.pipeline.yaml \
  --task examples/archify-on-pr/archify-on-pr.task.yaml \
  --checkout "$PWD" \
  --skip-gates \
  --json > sf-run.json
```

When detect-changes finds no diagram-relevant paths, `author-diagrams` is skipped
(`fork_choice: []`). When types are selected, inspect `{type}.spec.json` files in
the run workspace.

### Extract envelope

Mirrors the GHA deliver step — reads the author stage envelope via the CLI:

```bash
node dist/cli.js envelope get --from sf-run.json --stage author-diagrams \
  --detect-stage detect-changes --format handoff --json > envelope.json
```

Outputs `{ "skipped": true }` when detect skipped downstream, or
`{ "skipped": false, "diagrams": [{ diagram_type, spec_path, summary }, …] }`.
Deliver manually:

```bash
node dist/cli.js envelope get --from sf-run.json --stage author-diagrams \
  --detect-stage detect-changes --format handoff --json > envelope.json
./scripts/deliver-diagrams.sh envelope.json diagrams
```

Or per diagram:

```bash
mkdir -p diagrams
while IFS= read -r d; do
  TYPE=$(jq -r .diagram_type <<<"$d")
  SPEC=$(jq -r .spec_path <<<"$d")
  node .pi/skills/archify/bin/archify.mjs deliver \
    "$TYPE" "$SPEC" "diagrams/${TYPE}.html" --quality showcase
done < <(jq -c '.diagrams[]' envelope.json)
```

## Environment variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | `sf run` | Provider auth (required) |
| `PR_HEAD_SHA` | prepare-ci-context | PR head commit SHA |
| `GITHUB_REPOSITORY` | prepare-ci-context | `owner/repo` |
| `GITHUB_BASE_REF` | prepare-ci-context | PR base branch (default: `main`) |
| `GITHUB_HEAD_REF` | prepare-ci-context | PR head branch name |
| `CI_CONTEXT_FILE` | deliver-diagrams.sh | Path to context JSON (default: `ci-context.json`) |
| `ARCHIFY_SOURCE_DIR` | GHA secret | Local Archify skill path (`sf skills install --from-path`) |
| `ARCHIFY_ZIP_URL` | GHA variable | Release zip URL (`sf skills install --from-zip`; defaults to Archify v2.15.0) |

## Fork PR limitation

The workflow posts a sticky PR comment with `pull-requests: write`. On **fork
PRs**, GitHub downgrades `GITHUB_TOKEN` — the job may succeed but cannot post
or update the comment. Same-repo branch PRs are supported; fork comment posting
is deferred.

## GitHub Actions

See [`.github/workflows/archify-pr-diagrams.yml`](../../.github/workflows/archify-pr-diagrams.yml).

The workflow uses the [`.github/actions/sf-run`](../../.github/actions/sf-run)
composite to run the pipeline and extract a handoff envelope via
`sf envelope get --format handoff`. `prepare-ci-context.sh` runs before the
pipeline; agents author JSON only; GHA runs
`deliver-diagrams.sh` (Archify `deliver` per type), uploads each `{type}.html`
unzipped (`upload-artifact@v7`, `archive: false`) for in-browser viewing, also
uploads a zipped `diagrams/` bundle, and updates the sticky comment. Debug
artifacts include `ci-context.json`, `sf-run.json`, `envelope.json`, and `run-export.json`.
