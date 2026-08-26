# archify-on-pr

PR-triggered Archify diagrams: detect relevant diff changes, choose one or more
diagram types (architecture, workflow, sequence, dataflow, lifecycle), and author
JSON specs for GHA to deliver as HTML.

## Layout

| Path | Role |
|------|------|
| `archify-on-pr.pipeline.yaml` | detect-changes fork → author-diagrams |
| `detect-changes.yaml` | Git diff heuristics, per-type selection, `fork_choice` routing |
| `author-diagrams.yaml` | Writes `{type}.spec.json` per selected type (skill: archify on pipeline entry) |
| `archify-on-pr.task.yaml` | Task bound at run time |

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
- Git checkout at the PR head; optional CI env: `GITHUB_BASE_REF`, `GITHUB_HEAD_REF`,
  `GITHUB_SHA`, `gh` on PATH

## Install Archify skill

From the repository git root:

```bash
./scripts/install-archify-skill.sh --version 2.15.0
```

With no source flags, the script downloads Archify v2.15.0 from the public
[GitHub release](https://github.com/tt-a1i/archify/releases/tag/v2.15.0). For
local development you can point at an existing tree:

```bash
./scripts/install-archify-skill.sh --source-dir ~/.agents/skills/archify
```

Override with `ARCHIFY_SOURCE_DIR`, `--zip-url`, or `ARCHIFY_ZIP_URL` when needed.
The script copies the runtime tree to `.pi/skills/archify/` and runs `archify doctor`.

## Commands

Local dry-run from repo root:

```bash
sf validate --strict
export OPENAI_API_KEY=…
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
GITHUB_SHA="$(git rev-parse HEAD)" GITHUB_REPOSITORY="<owner>/<repo>" \
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
| `GITHUB_BASE_REF` | detect-changes | PR base branch (default: `main`) |
| `GITHUB_HEAD_REF` | detect-changes | PR head branch |
| `GITHUB_SHA` | detect-changes | Head commit SHA |
| `ARCHIFY_SOURCE_DIR` | install script | Local Archify skill path (optional override) |
| `ARCHIFY_ZIP_URL` | install script | Release zip URL (optional override; defaults to Archify v2.15.0 GitHub release) |

## Fork PR limitation

The workflow posts a sticky PR comment with `pull-requests: write`. On **fork
PRs**, GitHub downgrades `GITHUB_TOKEN` — the job may succeed but cannot post
or update the comment. Same-repo branch PRs are supported; fork comment posting
is deferred.

## GitHub Actions

See [`.github/workflows/archify-pr-diagrams.yml`](../../.github/workflows/archify-pr-diagrams.yml).
Agents author JSON only; GHA runs `archify deliver` for each type, uploads each
`{type}.html` unzipped (`upload-artifact@v7`, `archive: false`) for in-browser
viewing, also uploads a zipped `diagrams/` bundle, and updates the sticky comment.
