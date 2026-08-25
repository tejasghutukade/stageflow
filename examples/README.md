# Examples

Runnable Stageflow catalogs. Each directory is self-contained — copy it into a new project or `cd` into it and run commands from there.

Stages are **author-defined** in YAML; these walkthroughs show domain-neutral flows, release automation, and an SDLC-style plan review — not built-in product types.

| Example | Description | Commands |
|---------|-------------|----------|
| [hello-world](hello-world/) | Single stage, no HITL (domain-neutral) | `sf validate --strict`, `sf run` |
| [plan-review](plan-review/) | Multi-stage with operator gate (SDLC-style **example**) | `sf ui`, then `sf run` |
| [github-release](github-release/) | Dogfood: draft + publish GitHub Release (ops **example**) | Used in `.github/workflows/publish.yml` |
| [ci-validate](ci-validate/) | Strict catalog validate in CI | `./validate.sh` or GitHub Actions snippet |

## Prerequisites (all examples)

- **Node.js ≥ 20**
- Stageflow CLI: `npm i -g stageflow`
- **Provider auth** for `sf run` (not required for `sf validate`): connect in `sf ui` → Settings → Providers, or `sf providers login …`

See [docs/quickstart.md](../docs/quickstart.md) and [docs/providers.md](../docs/providers.md).
