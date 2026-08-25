# <img src="ui/public/stageflow-icon.svg" alt="" width="44" height="44" valign="middle"> Stageflow

CLI pipeline runtime for **configurable stages** on [Pi](https://github.com/badlogic/pi-mono), with a local operator console.

[![npm version](https://img.shields.io/npm/v/stageflow)](https://www.npmjs.com/package/stageflow)
![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/tejasghutukade/stageflow)](https://github.com/tejasghutukade/stageflow/issues)
[![CI](https://img.shields.io/github/actions/workflow/status/tejasghutukade/stageflow/ci.yml?branch=main)](https://github.com/tejasghutukade/stageflow/actions/workflows/ci.yml)

Author YAML pipelines, stages, and tasks in a project directory. Stageflow runs each stage in a fresh Pi agent session, writes a structured handoff envelope, and keeps run state under `.stageflow/`. Bins: **`sf`** and **`stageflow`**.

## Why Stageflow?

Multi-step agent work breaks down when every handoff is ad hoc — a shell script here, a chat transcript there, no shared contract between steps. You end up re-explaining context, losing artifacts, and unable to run the same flow locally and in CI.

Stageflow treats **stages as the unit of composition**. You author a YAML catalog — pipelines, stages, tasks — and define whatever workflow fits your domain: release automation, research pipelines, content review, SDLC, ops runbooks, or something entirely custom. Each stage runs in a **fresh Pi session**, emits a typed **envelope** for the next stage, and can pause on **human-in-the-loop (HITL)** gates when you need an operator in the loop.

The same pipeline runs three ways without rewriting anything:

- **Locally** — `sf ui` for triage, provider setup, and gate replies
- **Headless / CI** — `sf validate` and `sf run --json` with predictable exit codes
- **Via MCP** — Streamable HTTP tools when the console is running

**Stageflow is not an SDLC tool.** Software delivery is a popular pattern in fixtures and dogfood flows, but stages are user-authored and domain-agnostic. If you can express a multi-step workflow in YAML, Stageflow can run it on Pi.

## Features

- **YAML catalog** — `pipelines/`, `stages/`, `tasks/` live in your project; no hosted config service
- **Pi-native** — runs on `@earendil-works/pi-coding-agent`; reuse an existing Pi login (`pi_home`) or store credentials in an SF-owned file (`sf_owned`)
- **Envelope handoffs** — typed stage payloads and artifacts via `write_stage_artifact` / `emit_stage_envelope`
- **HITL gates** — operator questions in the console; CI exits `2` when a run is waiting
- **Operator console** — triage runs, connect providers, answer gates, inspect transcripts at `http://127.0.0.1:3847`
- **MCP endpoint** — Streamable HTTP at `/mcp` when `sf ui` is running
- **CI / headless** — `sf validate --strict --json`, `sf run --json` with exit codes `0` / `1` / `2`
- **Parallel stages** — pipeline DAG with fan-out and join (see [YAML catalog](docs/yaml-catalog.md))
- **SQLite run store** — `.stageflow/` state plus per-run workspaces under `.stageflow/runs/`

## Installation

Requires **Node.js ≥ 20**.

```bash
npm i -g stageflow
# or
npx stageflow
# or, from a packed tarball
npm i -g ./stageflow-*.tgz
```

`better-sqlite3` ships prebuilds for common platforms. `--ignore-scripts` is fine when a prebuild exists. Benign `node-gyp` warnings during install can be ignored if `require("better-sqlite3")` works.

## Quick start

In a project directory, create three files:

**`pipelines/hello.yaml`**

```yaml
id: hello
stages:
  - research
```

**`stages/research.yaml`**

```yaml
id: research
system_prompt: Summarize the task goal and list open questions.
model: anthropic/claude-sonnet-4-5
```

**`tasks/my-task.yaml`**

```yaml
id: my-task
goal: Draft a one-page brief on a topic of your choice
context: Domain-neutral hello-world run
constraints: Docs only; no implementation code
```

Run:

```bash
sf ui                          # operator console at http://127.0.0.1:3847
sf run --task tasks/my-task.yaml --pipeline hello
```

Connect model providers in the console (**Settings → Providers**) or via `sf providers …`. Stageflow is a thin Pi shell: reuse an existing Pi login or store credentials in an SF-owned file. You do not need Pi CLI `/login` as a hard prerequisite.

## Operator console

Start the console with `sf ui` (default `http://127.0.0.1:3847`).

- **Runs** — active and recent pipeline runs, capacity, and status at a glance
- **Run detail** — stage timeline, transcripts, envelope payloads, and artifact paths
- **HITL reply** — answer operator gates (`ask_operator`) without leaving the browser
- **Pipelines** — browse authored pipeline and stage definitions
- **Settings → Providers** — connect model providers (`pi_home` or `sf_owned` credential storage)

*Screenshot coming soon — capture after console polish lands (see `docs/img/`).*

## Headless / CI

The guest actor is the CLI (`sf` / `stageflow`). `sf ui` and MCP are not required in the job.

```bash
sf validate --strict --json
```

Validate exits `0` or `1` only (no waiting / `2`). It checks pipeline and stage YAML only; it does not prove provider auth, Task, or checkout.

```bash
sf providers login <providerId> --api-key-env <VAR>
```

If the provider also supports OAuth, pass `--type api_key`.

```bash
sf run --task tasks/my-task.yaml --pipeline hello --json
```

The process exits `0` when the Run succeeded, `1` when it failed (including a busy start), and `2` when waiting. `sf run --json` prints one stdout document. `ok` is true only for `succeeded`. Busy has no `runId`.

| outcome | ok | runId | exit |
|---|---|---|---|
| `succeeded` | true | present | `0` |
| `failed` | false | present after start; omit when start never created a run | `1` |
| `waiting` | false | present | `2` |
| `busy` | false | omit | `1` |

On a mixed Pipeline, default wait parks the Run (exit `2`). `--skip-gates` fails the Stage (exit `1`). A Pipeline with no HITL does not need the flag.

## State

Runtime state lives in **`.stageflow/`** (SQLite + per-run workspaces under `.stageflow/runs/`). If `.stageflow` is missing and `.software-factory` exists from an older install, the next store open renames it to `.stageflow` once.

## MCP

`sf ui` also serves a Streamable HTTP MCP endpoint at `http://127.0.0.1:3847/mcp` (URL printed on boot). Point a Cursor (or other) MCP client at that URL.

Available tools: `list_pipelines`, `list_runs`, `get_health`, `start_run`, `get_run`, `read_artifact`.

Full reference: [docs/mcp.md](docs/mcp.md)

## Stageflow vs Conductor

Both projects address multi-step agent workflows. They differ in orchestration model and runtime.

| | **Stageflow** | **Conductor** |
|---|---------------|---------------|
| **Model** | Configurable **stages** on Pi; YAML catalog (any domain) | Multi-**agent** workflow graph |
| **Orchestration** | Pipeline DAG + stage worker | Jinja routing, no LLM in router |
| **Unit of work** | Task → Pipeline → Stage attempts | Workflow → Agents |
| **Handoff** | Typed **envelope** + artifacts | Agent output → context |
| **Human gates** | Operator console + MCP | Dashboard + TUI fleet |
| **Runtime** | Node.js, Pi coding agent | Python, Copilot/Claude SDKs |
| **Best for** | Personal/team **multi-stage Pi workflows** you define (releases, research, SDLC, …) | Enterprise multi-agent workflows |

If you want deterministic YAML routing across many agents, look at [Conductor](https://github.com/microsoft/conductor). If you want stage-bound Pi runs with reviewable envelopes and an operator console for **workflows you author**, use Stageflow.

## Examples

| Example | Description |
|---------|-------------|
| [hello-world](examples/hello-world/) | Single stage, domain-neutral |
| [plan-review](examples/plan-review/) | Multi-stage with operator gate — SDLC-style **example** |
| [github-release](examples/github-release/) | Dogfood: draft + publish GitHub Release |
| [ci-validate](examples/ci-validate/) | Strict validate in CI |

Index: [examples/README.md](examples/README.md)

## Documentation

| Doc | Description |
|-----|-------------|
| [docs/README.md](docs/README.md) | Documentation index |
| [docs/quickstart.md](docs/quickstart.md) | Expanded quick start |
| [docs/yaml-catalog.md](docs/yaml-catalog.md) | Pipelines, stages, tasks schema |
| [docs/cli-reference.md](docs/cli-reference.md) | `sf run`, `sf validate`, `sf ui`, `sf providers` |
| [docs/envelopes.md](docs/envelopes.md) | Handoff envelope contract |
| [docs/hitl.md](docs/hitl.md) | Gate kinds, `--skip-gates`, exit code `2` |
| [docs/ci.md](docs/ci.md) | `--json`, env vars, GitHub Actions |
| [docs/mcp.md](docs/mcp.md) | MCP tool reference |
| [docs/providers.md](docs/providers.md) | Pi providers, `sf providers` |
| [docs/operator-console.md](docs/operator-console.md) | Console IA and settings |
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
