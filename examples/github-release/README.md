# github-release

Dogfood release automation: draft operator-facing GitHub release notes, then publish with `gh`. This is an **ops / release example** — not SDLC planning.

Stageflow uses this catalog in `.github/workflows/publish.yml` and `release.yml` when publishing new npm versions.

One GitHub Release is created for the current tag. The notes body includes **every CHANGELOG version since the last GitHub Release**, not only the latest `package.json` bump. A publish that jumps from `0.3.0` to `0.8.0` therefore includes headings for `0.4.0` through `0.8.0`. Intermediate versions are not tagged or published as extra GitHub Releases.

## Layout

| Path | Role |
|------|------|
| `github-release.pipeline.yaml` | Two-stage linear pipeline |
| `draft-release-notes.yaml` | Collect changelog, write `RELEASE_NOTES.md` artifact |
| `publish-github-release.yaml` | `gh release create` from prior artifact |
| `github-release.task.yaml` | Task bound at run time |

CI helpers: `scripts/release-range.mjs` resolves previous from published GitHub Releases (git tags if `gh` is unavailable) and extracts the CHANGELOG slice.

## Prerequisites

- Node.js ≥ 20, Stageflow installed
- **OpenAI** provider (stages use `openai/gpt-5.3-codex`) — set `OPENAI_API_KEY`
- **`gh` CLI** and `GH_TOKEN` or `GITHUB_TOKEN` for publish stage
- Git checkout of the Stageflow repo (stages read version/tags from the bound checkout)

Optional env vars (set by publish workflow): `RELEASE_VERSION`, `RELEASE_TAG`, `RELEASE_PREVIOUS`, `RELEASE_CHANGELOG_SLICE`, `GITHUB_SHA`, `DRY_RUN=1` to skip actual release creation.

`RELEASE_PREVIOUS` is the last published GitHub Release version, not `HEAD^` `package.json`. `RELEASE_CHANGELOG_SLICE` is a markdown file of CHANGELOG sections in that range (workflows write `changelog-slice.md` before `sf run`).

## Commands

From the **repository git root**:

```bash
sf validate --strict
export OPENAI_API_KEY=…
export GH_TOKEN=…
CURRENT="$(node -p "require('./package.json').version")"
PREVIOUS="$(node scripts/release-range.mjs previous --current "$CURRENT")"
if [ -n "$PREVIOUS" ]; then
  node scripts/release-range.mjs changelog --after "$PREVIOUS" --through "$CURRENT" > changelog-slice.md
else
  node scripts/release-range.mjs changelog --through "$CURRENT" > changelog-slice.md
fi
export RELEASE_VERSION="$CURRENT" RELEASE_TAG="v${CURRENT}" RELEASE_PREVIOUS="$PREVIOUS" RELEASE_CHANGELOG_SLICE="$PWD/changelog-slice.md"
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
