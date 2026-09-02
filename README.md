# <img src="ui/public/stageflow-icon.svg" alt="" width="44" height="44" valign="middle"> Stageflow

Open-source runtime for **configurable multi-stage agent workflows** with typed handoffs, DAG execution, human gates, MCP, CI, and a local operator console.

[![npm version](https://img.shields.io/npm/v/stageflow)](https://www.npmjs.com/package/stageflow)
[![npm downloads](https://img.shields.io/npm/dm/stageflow)](https://www.npmjs.com/package/stageflow)
![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/tejasghutukade/stageflow)](https://github.com/tejasghutukade/stageflow/issues)
[![CI](https://img.shields.io/github/actions/workflow/status/tejasghutukade/stageflow/ci.yml?branch=main)](https://github.com/tejasghutukade/stageflow/actions/workflows/ci.yml)

Author pipeline-owned YAML in your project. Stageflow schedules each stage in a fresh agent session, moves context through explicit envelopes and artifacts, and persists run state under `.stageflow/`. [Pi](https://github.com/badlogic/pi-mono) is the current agent execution backend. Bins: **`sf`** and **`stageflow`**.

## Why Stageflow?

Multi-step agent work breaks down when every handoff is ad hoc — a shell script here, a chat transcript there, no shared contract between steps. You end up re-explaining context, losing artifacts, and unable to run the same flow locally and in CI.

Stageflow treats **stages as the unit of composition**. You author pipeline-owned YAML — `*.pipeline.yaml`, `*.task.yaml`, optional `stageflow.yaml` manifest — and define whatever workflow fits your domain: release automation, research pipelines, content review, SDLC, ops runbooks, or something entirely custom. Each stage runs in a **fresh Pi session**, emits a typed **envelope** for the next stage, and can pause on **human-in-the-loop (HITL)** gates when you need an operator in the loop.

The same pipeline runs three ways without rewriting anything:

- **Locally** — `sf ui` for triage, provider setup, and gate replies
- **Headless / CI** — `sf validate` and `sf run --json` with predictable exit codes
- **Via MCP** — Streamable HTTP tools when `sf ui` or `sf mcp` is running

**Stageflow is not an SDLC tool.** Software delivery is a popular pattern in fixtures and dogfood flows, but stages are user-authored and domain-agnostic. If you can express a multi-step workflow in YAML, Stageflow can run it on Pi.

## Features

- **Pipeline-owned YAML** — `*.pipeline.yaml` with inline stages or `uses:` refs; separate `*.task.yaml` files; optional repo-root `stageflow.yaml` manifest
- **Path-based CLI** — `--pipeline` and `--task` take filesystem paths (no bare-id lookup)
- **Pi-native** — runs on `@earendil-works/pi-coding-agent`; reuse an existing Pi login (`pi_home`) or store credentials in `~/.stageflow/agent/auth.json` (`sf_owned`)
- **Envelope handoffs** — typed stage payloads and artifacts via `write_stage_artifact` / `emit_stage_envelope`
- **HITL gates** — operator questions in the console; CI exits `2` when a run is waiting
- **Operator console** — triage runs, connect providers, answer gates, inspect transcripts at `http://127.0.0.1:3847`
- **MCP endpoint** — Streamable HTTP at `/mcp` when `sf ui` or `sf mcp` is running
- **CI / headless** — `sf validate --strict --json`, `sf run --json` with exit codes `0` / `1` / `2`
- **Parallel stages** — pipeline DAG with fan-out and join (see [YAML catalog](docs/yaml-catalog.md))
- **Clonable fan-out** — clone one successor N times at completion, then join (see [YAML catalog](docs/yaml-catalog.md#clonable-successors))
- **SQLite run store** — `<git-root>/.stageflow/` state plus per-run workspaces under `.stageflow/runs/`

## Architecture at a glance

![Stageflow architecture: pipeline definitions and operator interfaces drive the orchestration runtime, which coordinates agent execution and persisted state](docs/img/stageflow-architecture.svg)

The scheduler owns orchestration semantics: DAG readiness, bounded parallelism, fan-out/join, conditional routing, retries, skipped branches, and resumable human gates. Agent execution sits behind `AgentPort`; Pi supplies the current coding-agent session, while Stageflow owns pipeline state, stage workspaces, handoff validation, and the interfaces used by the CLI, console, MCP, and CI.

See [Architecture](docs/architecture.md) for component boundaries, execution flow, persistence, recovery behavior, and the tradeoffs behind fresh sessions and explicit handoffs.

## Installation

Requires **Node.js ≥ 20**.

**Quick install (macOS / Linux):**

```bash
curl -fsSL https://raw.githubusercontent.com/tejasghutukade/stageflow/main/install.sh | bash
```

**npm:**

```bash
npm i -g stageflow
# or
npx stageflow
# or, from a packed tarball
npm i -g ./stageflow-*.tgz
```

`better-sqlite3` ships prebuilds for common platforms. `--ignore-scripts` is fine when a prebuild exists. Benign `node-gyp` warnings during install can be ignored if `require("better-sqlite3")` works.

**Harness skills** (Cursor, Claude Code, Codex, Pi, OpenCode) — from a consumer project:

```bash
npx skills add tejasghutukade/stageflow
```

Then ask the agent to set up Stageflow. Details: [docs/skills-suite.md](docs/skills-suite.md).

## Quick start

In a project directory (preferably a git repo):

```bash
sf init
```

This scaffolds `stageflow.yaml`, `pipelines/hello.pipeline.yaml` (inline stage), and `tasks/hello.task.yaml`.

Run (after connecting a provider — see below):

```bash
sf ui                          # operator console at http://127.0.0.1:3847
sf run --pipeline pipelines/hello.pipeline.yaml --task tasks/hello.task.yaml
```

Expanded walkthrough: [docs/quickstart.md](docs/quickstart.md)

## Connect a model provider

Each stage sets a **`model`** id in YAML (e.g. `anthropic/claude-sonnet-4-5`). The matching provider must be authenticated before runs succeed — `sf validate` does not check auth.

**Operator console** (easiest for local setup):

```bash
sf ui
```

Open **Settings → Providers** (or **Connect** from the rail when nothing is configured) and sign in with API key or OAuth.

**CLI** (works headless and in CI):

```bash
sf providers list
sf providers login anthropic --type api_key
sf providers login anthropic --type api_key --api-key-env ANTHROPIC_API_KEY
```

Use `sf providers list` to see provider ids and supported auth types (`api_key`, `oauth`).

**Credential storage:** reuse Pi's shared auth file (`pi_home`) or keep credentials in Stageflow's global store (`sf_owned`):

```bash
sf providers detect
sf providers source set pi_home    # or sf_owned
```

Pi is Stageflow's current agent execution backend. Stageflow owns the workflow layer around it, and you do not need Pi CLI `/login` as a prerequisite when providers are configured through the console or `sf providers`.

Full reference: [docs/providers.md](docs/providers.md)

## Operator console

Start the console with `sf ui` (default `http://127.0.0.1:3847`).

- **Runs** — active and recent pipeline runs, capacity, and status at a glance
- **Run detail** — spatial stage map; select a stage for the gated workspace (logs, files, envelopes, HITL). Created runs show **not started** with a **Start run** action until history exists
- **HITL reply** — answer operator gates (`ask_operator`) without leaving the browser
- **Pipelines** — browse manifest-declared pipeline definitions
- **Settings → Providers** — connect model providers (`pi_home` or `sf_owned` credential storage)

Brand assets live under `docs/img/` (`stageflow-og.svg`, `stageflow-icon.svg`).

## Headless / CI

The guest actor is the CLI (`sf` / `stageflow`). `sf ui` and MCP are not required in the job.

```bash
sf validate --strict --json
```

Validate exits `0` or `1` only (no waiting / `2`). With no flags, `sf validate` checks pipelines and tasks in the manifest (plus stages). `--pipeline` validates that pipeline and its stages only; `--task` validates that task file. It never proves provider auth or checkout paths.

```bash
sf providers login <providerId> --api-key-env <VAR>
```

If the provider also supports OAuth, pass `--type api_key`.

```bash
sf run --pipeline pipelines/hello.pipeline.yaml --task tasks/hello.task.yaml --json
```

The process exits `0` when the Run succeeded, `1` when it failed (including a busy start), and `2` when waiting. `sf run --json` prints one stdout document. `ok` is true only for `succeeded`. Busy has no `runId`.

| outcome | ok | runId | exit |
|---|---|---|---|
| `succeeded` | true | present | `0` |
| `failed` | false | present after start; omit when start never created a run | `1` |
| `waiting` | false | present | `2` |
| `busy` | false | omit | `1` |

On a mixed Pipeline, default wait parks the Run (exit `2`). `--skip-gates` fails the Stage (exit `1`). A Pipeline with no HITL does not need the flag.

Post-run extraction (dogfooded in [Archify PR diagrams](examples/archify-on-pr/)):

```bash
sf run ... --json --include stages > sf-run.json
sf envelope get --from sf-run.json --stage author-diagrams --format handoff --json
sf skills install --from-zip <url> --skill-name archify
```

See [docs/ci.md](docs/ci.md) for the full CI recipe and [`.github/actions/sf-run`](.github/actions/sf-run) composite action.

## State

Runtime state lives in **`<git-root>/.stageflow/`** when inside a git repository (SQLite + per-run workspaces under `.stageflow/runs/`). Global config and `sf_owned` auth live under **`~/.stageflow/`**. If `.stageflow` is missing and `.software-factory` exists from an older install, the next store open renames it to `.stageflow` once.

## MCP

Host MCP via `sf ui` or `sf mcp` at `http://127.0.0.1:3847/mcp` (URL printed on boot). Sessions are the default. Point a Cursor (or other) MCP client at that URL. Do not run both hosts against the same store.

HITL-aware tools include `wait_run`, `answer_gate`, and `list_waiting`. Full tool list: [docs/mcp.md](docs/mcp.md).

## Stageflow vs Conductor

Both projects address multi-step agent workflows. They differ in orchestration model and runtime.

| | **Stageflow** | **Conductor** |
|---|---------------|---------------|
| **Model** | Configurable **stages** on Pi; pipeline-owned YAML (any domain) | Multi-**agent** workflow graph |
| **Orchestration** | Pipeline DAG + stage worker | Jinja routing, no LLM in router |
| **Unit of work** | Task → Pipeline → Stage attempts | Workflow → Agents |
| **Handoff** | Typed **envelope** + artifacts | Agent output → context |
| **Human gates** | Console + MCP + harness native question UI | Dashboard + TUI fleet |
| **Runtime** | Node.js, Pi coding agent | Python, Copilot/Claude SDKs |
| **Best for** | Personal/team **multi-stage Pi workflows** you define (releases, research, SDLC, …) | Enterprise multi-agent workflows |

If you want deterministic YAML routing across many agents, look at [Conductor](https://github.com/microsoft/conductor). If you want stage-bound Pi runs with reviewable envelopes and an operator console for **workflows you author**, use Stageflow.

## Examples

| Example | Description |
|---------|-------------|
| **[archify-on-pr](examples/archify-on-pr/)** | **Featured** — PR diagram automation: conditional fork, skill binding, envelope handoff, GHA deliver |
| [hello-world](examples/hello-world/) | Single stage, domain-neutral |
| [plan-review](examples/plan-review/) | Multi-stage with operator gate — SDLC-style **example** |
| [conditional-fork](examples/conditional-fork/) | Exclusive fork routing with operator branch choice |
| [clonable-fanout](examples/clonable-fanout/) | Clone one successor N times, then join |
| [github-release](examples/github-release/) | Dogfood: draft + publish GitHub Release |
| [ci-validate](examples/ci-validate/) | Strict validate in CI |

Index: [examples/README.md](examples/README.md)

## Documentation

Full docs: **[tejasghutukade.github.io/stageflow](https://tejasghutukade.github.io/stageflow/)** (GitHub Pages — live after merge to `main` and Pages enabled). Source in [`docs/`](docs/).

| Doc | Description |
|-----|-------------|
| [docs/README.md](docs/README.md) | Documentation index |
| [docs/architecture.md](docs/architecture.md) | Runtime components, execution flow, persistence, and design decisions |
| [docs/quickstart.md](docs/quickstart.md) | Expanded quick start |
| [docs/yaml-catalog.md](docs/yaml-catalog.md) | Pipelines, stages, tasks schema |
| [docs/cli-reference.md](docs/cli-reference.md) | `sf init`, `sf run`, `sf validate`, `sf ui`, `sf mcp`, `sf envelope`, `sf export-run`, `sf artifact`, `sf skills`, `sf providers` |
| [docs/envelopes.md](docs/envelopes.md) | Handoff envelope contract |
| [docs/hitl.md](docs/hitl.md) | Gate kinds, `--skip-gates`, exit code `2` |
| [docs/ci.md](docs/ci.md) | `--json`, env vars, GitHub Actions |
| [docs/mcp.md](docs/mcp.md) | MCP tool reference |
| [docs/providers.md](docs/providers.md) | Pi providers, `sf providers` |
| [docs/operator-console.md](docs/operator-console.md) | Console IA and settings |
| [docs/skills-suite.md](docs/skills-suite.md) | Harness skills — router + jobs for Cursor, Claude Code, Codex, Pi, OpenCode |
| [docs/compare-conductor.md](docs/compare-conductor.md) | Positioning deep dive |

## Develop from source

```bash
git clone https://github.com/tejasghutukade/stageflow.git
cd stageflow
npm i
npm run build && npm run ui:build   # ui:build builds the UI and copies assets into dist/ui
sf ui
```

Run tests: `npm test` and `npm run ui:test`. Typecheck: `npm run typecheck`.

## License

MIT © Tejas G

**Support:** [GitHub Issues](https://github.com/tejasghutukade/stageflow/issues) · [SUPPORT.md](SUPPORT.md)

**Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)
