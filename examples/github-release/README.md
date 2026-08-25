# github-release

Dogfood release automation: draft operator-facing GitHub release notes, then publish with `gh`. This is an **ops / release example** — not SDLC planning.

Stageflow uses this catalog in `.github/workflows/publish.yml` when publishing new npm versions.

## Layout

| Path | Role |
|------|------|
| `pipelines/github-release.yaml` | Two-stage linear pipeline |
| `stages/draft-release-notes.yaml` | Collect changelog, write `RELEASE_NOTES.md` artifact |
| `stages/publish-github-release.yaml` | `gh release create` from prior artifact |
| `tasks/github-release.yaml` | Task bound at run time |

## Prerequisites

- Node.js ≥ 20, Stageflow installed
- **OpenAI** provider (stages use `openai/gpt-5.3-codex`) — set `OPENAI_API_KEY`
- **`gh` CLI** and `GH_TOKEN` or `GITHUB_TOKEN` for publish stage
- Git checkout of the Stageflow repo (stages read version/tags from the bound checkout)

Optional env vars (set by publish workflow): `RELEASE_VERSION`, `RELEASE_TAG`, `RELEASE_PREVIOUS`, `GITHUB_SHA`, `DRY_RUN=1` to skip actual release creation.

## Commands

From this directory:

```bash
sf validate --strict
export OPENAI_API_KEY=…
export GH_TOKEN=…
sf run --task tasks/github-release.yaml --pipeline github-release
```

For a dry run (no GitHub release created):

```bash
DRY_RUN=1 sf run --task tasks/github-release.yaml --pipeline github-release
```

## Workflow integration

The repo's **Publish** workflow installs `stageflow@<version>` from npm, runs this pipeline from `examples/github-release/`, and uploads run artifacts. See `.github/workflows/publish.yml`.
