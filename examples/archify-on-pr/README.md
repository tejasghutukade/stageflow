# archify-on-pr

Manually triggered Archify diagrams: prepare deterministic PR context (paths +
diagram types), copy that into a detect-changes handoff, and author JSON specs
for GHA to deliver as HTML.

## Layout

| Path | Role |
|------|------|
| `archify-on-pr.pipeline.yaml` | detect-changes Route `if` → author-diagrams; `verify` + `on_verify_fail` on detect |
| `detect-changes.yaml` | Thin copy/emit from `ci-context.json` → `changes.json` + envelope |
| `author-diagrams.yaml` | Writes `{type}.spec.json` per selected type (skill: archify on pipeline entry) |
| `archify-on-pr.task.yaml` | Task bound at run time |
| `../../scripts/prepare-ci-context.sh` | Deterministic PR/git context + diagram type selection before `sf run` |
| `../../scripts/validate-detect-envelope.mjs` | Verify helper: `changes.json` / envelope match `ci-context.json` |

## Diagram types

Selection is **deterministic** in `prepare-ci-context.sh` from path rules on
`relevant_files` (not the detect agent). The table documents those rules:

| Type | Path rules (typical) |
|------|----------------------|
| `architecture` | `src/agent`, `src/server`, `src/mcp`, `src/runstore`, `ui/`, `skills/`, `stageflow.yaml`, `package.json` |
| `workflow` | `*.pipeline.yaml`, `examples/`, `.github/workflows/`, `scripts/`, `src/runtime`, `src/config` |
| `sequence` | `src/server`, `src/mcp`, `src/cli/runs*`, `ui/` |
| `dataflow` | `src/envelope`, `src/runstore`, `src/projection`, `src/config` |
| `lifecycle` | `src/runtime`, `src/tools` |

A path may map to more than one type. If `relevant_files` is non-empty but no
rule matches, the script defaults to `architecture`. Empty `relevant_files`
yields empty `diagram_types` / `author_diagrams: false` (and empty
`expected_fork_choice` as a CI-side signal).

detect-changes copies those types into `changes.json` and the envelope and
sets `author_diagrams` true iff `diagram_types` is non-empty. The pipeline
gates a single author-diagrams session with Route `if` (not a Clone Chain):

```yaml
route:
  - to: author-diagrams
    if:
      field: author_diagrams
      op: eq
      value: true
```

## Prerequisites

- Node.js ≥ 20, Stageflow built (`npm run build`)
- **OpenRouter** provider
  (`openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`) — set
  `OPENROUTER_API_KEY`, then:
  `sf providers login openrouter --type api_key --api-key-env OPENROUTER_API_KEY`
- **Archify skill** at `.pi/skills/archify/` (see below)
- Git checkout at the target head; run `prepare-ci-context.sh` before `sf run`
  (GHA does this automatically)

## CI context (`ci-context.json`)

Before Stageflow runs, GHA executes `scripts/prepare-ci-context.sh`. It resolves
`head_sha`, `repo_url`, file lists, and diagram selection:

| Field | Meaning |
|-------|---------|
| `changed_files` | Full three-dot diff vs base |
| `relevant_files` | Filtered subset for diagram decisions |
| `content_hash` | Hash of `relevant_files` only (empty string when none) |
| `verified_paths` | Whether each changed path exists at `head_sha` |
| `diagram_types` | Deterministic types from path rules on `relevant_files` |
| `change_summary` | Short summary derived from the relevant set |
| `expected_fork_choice` | CI-side list: `["author-diagrams"]` when types non-empty, else `[]` |

`relevant_files` excludes `docs/**`, `*.md` (except `skills/**`), lockfiles,
`tests/**` except `tests/fixtures/**/*.{yaml,yml}`, pitch-deck / pitch-assets,
and editor noise (`.editorconfig`, `.vscode/`, `.idea/`). When that list is
empty, `diagram_types` and `expected_fork_choice` are empty and GHA early-skips
the `sf-run` step. detect-changes copies `relevant_files` into
`changes.json` as `changed_files` and emits `author_diagrams` true iff
`diagram_types` is non-empty. Catalog routing uses that boolean, not
`fork_choice`.

Both pipeline stages read this file — agents do not use `GITHUB_SHA` or run
their own git diff. detect-changes does not re-derive types; it only copies and
emits. The pipeline enforces that with body `verify` (`type: artifact` on
`changes.json` at emit and after, plus after-phase payload and command checks)
and wiring `on_verify_fail: repair`.

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
export OPENROUTER_API_KEY=…
sf providers login openrouter --type api_key --api-key-env OPENROUTER_API_KEY
./scripts/prepare-ci-context.sh ci-context.json
sf run \
  --pipeline examples/archify-on-pr/archify-on-pr.pipeline.yaml \
  --task examples/archify-on-pr/archify-on-pr.task.yaml \
  --checkout "$PWD" \
  --skip-gates \
  --json > sf-run.json
```

When prepare-ci-context selects no types (`author_diagrams: false`),
Route `if` skips `author-diagrams`. When types are selected, inspect
`{type}.spec.json` files in the run workspace.

### Extract envelope

Mirrors the GHA deliver step — reads the author stage envelope via the CLI:

```bash
node dist/cli.js envelope get --from sf-run.json --stage author-diagrams \
  --detect-stage detect-changes --format handoff --json > envelope.json
```

When author-diagrams ran, output is
`{ "skipped": false, "diagrams": [{ diagram_type, spec_path, summary }, …] }`.
When `author_diagrams` is false, Route `if` skips that stage; GHA usually
early-skips the whole `sf-run` step when `relevant_files` is empty.
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
| `OPENROUTER_API_KEY` | `sf run` | OpenRouter provider auth (required) |
| `PR_NUMBER` | prepare-ci-context | PR number override (enables sticky comment in GHA when set) |
| `PR_HEAD_SHA` | prepare-ci-context | PR head commit SHA |
| `GITHUB_REPOSITORY` | prepare-ci-context | `owner/repo` |
| `GITHUB_BASE_REF` | prepare-ci-context | PR base branch (default: `main`) |
| `GITHUB_HEAD_REF` | prepare-ci-context | PR head branch name |
| `CI_CONTEXT_FILE` | deliver-diagrams.sh / validate-detect-envelope.mjs | Path to context JSON (default: `ci-context.json`) |
| `ARCHIFY_SOURCE_DIR` | GHA secret | Local Archify skill path (`sf skills install --from-path`) |
| `ARCHIFY_ZIP_URL` | GHA variable | Release zip URL (`sf skills install --from-zip`; defaults to Archify v2.15.0) |

## Fork PR limitation

The workflow posts a sticky PR comment with `pull-requests: write` only when
`pr_number` is provided. On **fork PRs**, GitHub downgrades `GITHUB_TOKEN` — the
job may succeed but cannot post or update the comment. Same-repo branch PRs are
supported; fork comment posting is deferred.

## GitHub Actions

See [`.github/workflows/archify-pr-diagrams.yml`](../../.github/workflows/archify-pr-diagrams.yml).

**Manual trigger only** (`workflow_dispatch` — not automatic on every PR).

1. Open **Actions** → **Archify PR diagrams** → **Run workflow**
2. Provide **one of**:
   - `pr_number` — resolves head/base from the PR; enables the sticky PR comment
   - `head_ref` — branch or commit SHA when not targeting a PR
3. Optionally set `base_ref` (default: `main`) for the three-dot diff

The workflow uses the [`.github/actions/sf-run`](../../.github/actions/sf-run)
composite to run the pipeline and extract a handoff envelope via
`sf envelope get --format handoff`. `prepare-ci-context.sh` runs before the
pipeline; if `relevant_files` is empty, GHA skips `sf-run`, deliver, upload, and
comment. detect-changes only copies/validates against that context; agents
author JSON only in author-diagrams. GHA runs `deliver-diagrams.sh` (Archify
`deliver` per type), uploads each `{type}.html` unzipped (`upload-artifact@v7`,
`archive: false`) for in-browser viewing, also uploads a zipped `diagrams/`
bundle, and updates the sticky comment when `pr_number` is set. Debug artifacts
include `ci-context.json`, `sf-run.json`, `envelope.json`, and `run-export.json`.
