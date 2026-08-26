# github-release

Dogfood release automation: draft operator-facing GitHub release notes, then publish with `gh`. This is an **ops / release example** — not SDLC planning.

Stageflow uses this catalog in `.github/workflows/publish.yml` and `release.yml` when publishing new npm versions.

## Layout

| Path | Role |
|------|------|
| `github-release.pipeline.yaml` | Two-stage linear pipeline |
| `draft-release-notes.yaml` | Collect changelog, write `RELEASE_NOTES.md` artifact |
| `publish-github-release.yaml` | `gh release create` from prior artifact |
| `github-release.task.yaml` | Task bound at run time |

## Prerequisites

- Node.js ≥ 20, Stageflow installed
- **OpenAI** provider (stages use `openai/gpt-5.3-codex`) — set `OPENAI_API_KEY`
- **`gh` CLI** and `GH_TOKEN` or `GITHUB_TOKEN` for publish stage
- Git checkout of the Stageflow repo (stages read version/tags from the bound checkout)

Optional env vars (set by publish workflow): `RELEASE_VERSION`, `RELEASE_TAG`, `RELEASE_PREVIOUS`, `GITHUB_SHA`, `DRY_RUN=1` to skip actual release creation.

## Commands

From the **repository git root**:

```bash
sf validate --strict
export OPENAI_API_KEY=…
export GH_TOKEN=…
sf run \
  --pipeline examples/github-release/github-release.pipeline.yaml \
  --task examples/github-release/github-release.task.yaml \
  --checkout "$PWD"
```

For a dry run (no GitHub release created):

```bash
DRY_RUN=1 sf run \
  --pipeline examples/github-release/github-release.pipeline.yaml \
  --task examples/github-release/github-release.task.yaml \
  --checkout "$PWD"
```
