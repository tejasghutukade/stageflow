# Stageflow documentation

Stageflow is a CLI pipeline runtime for **configurable stages** on [Pi](https://github.com/badlogic/pi-mono). You author YAML in your project — pipelines, stages, and tasks — and Stageflow runs each stage in a fresh Pi agent session with structured handoffs between steps.

Stages are **author-defined and domain-agnostic**. Release automation, research flows, content review, SDLC, and ops runbooks are all valid patterns; nothing in Stageflow hard-codes a domain.

## Getting started

| Doc | What you'll learn |
|-----|-------------------|
| [Quick start](quickstart.md) | Install, create a minimal catalog, run locally |
| [YAML catalog](yaml-catalog.md) | Pipeline, stage, and task file schema |
| [CLI reference](cli-reference.md) | `sf run`, `sf validate`, `sf ui`, `sf providers` |

## Core concepts

| Doc | What you'll learn |
|-----|-------------------|
| [Envelopes](envelopes.md) | Stage handoff contract (`emit_stage_envelope`, artifacts) |
| [Human-in-the-loop](hitl.md) | Gate kinds, operator replies, `--skip-gates`, exit code `2` |
| [Providers](providers.md) | Pi model auth — `pi_home` vs `sf_owned` |

## Operating Stageflow

| Doc | What you'll learn |
|-----|-------------------|
| [Operator console](operator-console.md) | Console pages, navigation, settings |
| [MCP](mcp.md) | Streamable HTTP tools when `sf ui` is running |
| [CI / headless](ci.md) | `--json`, exit codes, GitHub Actions |

## Positioning

| Doc | What you'll learn |
|-----|-------------------|
| [Stageflow vs Conductor](compare-conductor.md) | How Stageflow differs from multi-agent workflow runners |

## Canonical YAML examples

Test fixtures under [`tests/fixtures/`](../tests/fixtures/) are the source of truth for valid catalog shapes:

- [`pipelines/`](../tests/fixtures/pipelines/) — linear, parallel fan-out, HITL, validation edge cases
- [`stages/`](../tests/fixtures/stages/) — gate kinds, payload schemas, multi-stage handoffs
- [`tasks/`](../tests/fixtures/tasks/) — task file shapes

Runnable walkthroughs live in [`examples/`](../examples/) (see `examples/README.md` when present).

## See also

- [README](../README.md) — product landing page and installation
- [GitHub Issues](https://github.com/tejasghutukade/stageflow/issues) — support and bug reports
