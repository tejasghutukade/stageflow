---
layout: default
title: Documentation
permalink: /
---

# Stageflow documentation

Stageflow is a CLI pipeline runtime for **configurable stages** on [Pi](https://github.com/badlogic/pi-mono). You author **pipeline-owned YAML** — `*.pipeline.yaml`, separate `*.task.yaml` files, optional repo-root `stageflow.yaml` manifest — and Stageflow runs each stage in a fresh Pi agent session with structured handoffs between steps.

Stages are **author-defined and domain-agnostic**. Release automation, research flows, content review, SDLC, and ops runbooks are all valid patterns; nothing in Stageflow hard-codes a domain.

## Getting started

| Doc | What you'll learn |
|-----|-------------------|
| [Quick start](quickstart.md) | Install, `sf init`, path-based run |
| [YAML catalog](yaml-catalog.md) | Pipeline, stage, and task file schema |
| [CLI reference](cli-reference.md) | `sf run`, `sf validate`, `sf envelope`, `sf skills`, `sf ui`, `sf providers` |

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
| [CI / headless](ci.md) | `--json`, exit codes, GitHub Actions, PR diagram dogfood |

## Featured example

**[Archify on PR](../examples/archify-on-pr/)** — pull-request diagram automation dogfooding Stageflow in GitHub Actions: conditional fork skip, pipeline skill binding, `sf envelope get --format handoff`, and deterministic Archify deliver outside the agent. See [CI: PR diagrams (Archify)](ci.md#pr-diagrams-archify) and [examples/archify-on-pr/README.md](../examples/archify-on-pr/README.md).

## Positioning

| Doc | What you'll learn |
|-----|-------------------|
| [Stageflow vs Conductor](compare-conductor.md) | How Stageflow differs from multi-agent workflow runners |

## Canonical YAML examples

Test fixtures under [`tests/fixtures/`](../tests/fixtures/) are the source of truth for valid catalog shapes:

- [`tests/fixtures/pipelines/`](../tests/fixtures/pipelines/) — linear, parallel fan-out, HITL, fork routing, validation edge cases (`*.pipeline.yaml`)
- [`tests/fixtures/stages/`](../tests/fixtures/stages/) — gate kinds, payload schemas (referenced via `uses:`)
- [`tests/fixtures/tasks/`](../tests/fixtures/tasks/) — task file shapes (`*.task.yaml`)

Runnable walkthroughs live in [`examples/`](../examples/) (see `examples/README.md` when present).

## See also

- [README](../README.md) — product landing page and installation
- [GitHub Issues](https://github.com/tejasghutukade/stageflow/issues) — support and bug reports
