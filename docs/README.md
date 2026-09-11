---
layout: default
title: Documentation
permalink: /
---

# Stageflow documentation

Stageflow is an open-source runtime for **configurable multi-stage agent workflows**. You author **pipeline-owned YAML** — `*.pipeline.yaml`, separate `*.task.yaml` files, optional repo-root `stageflow.yaml` manifest — and Stageflow schedules fresh agent sessions with explicit envelopes and artifacts between stages. [Pi](https://github.com/badlogic/pi-mono) is the current agent execution backend.

Stages are **author-defined and domain-agnostic**. Release automation, research flows, content review, SDLC, and ops runbooks are all valid patterns; nothing in Stageflow hard-codes a domain.

## Getting started

| Doc | What you'll learn |
|-----|-------------------|
| [Quick start](quickstart.md) | Install, `sf init`, path-based run |
| [YAML catalog](yaml-catalog.md) | Author dialect `io` / `verify` / `on_verify_fail` ([upgrading older catalogs](yaml-catalog.md#upgrading-older-catalogs)) |
| [CLI reference](cli-reference.md) | `sf init`, `sf run`, `sf validate`, `sf envelope`, `sf ui`, `sf mcp`, `sf providers` |
| [Harness skills suite](skills-suite.md) | `npx skills add tejasghutukade/stageflow` — router + five job skills for Cursor, Claude Code, Codex, Pi, and OpenCode |

## Core concepts

| Doc | What you'll learn |
|-----|-------------------|
| [Architecture](architecture.md) | Runtime boundaries, execution flow, persistence, recovery, and design tradeoffs |
| [Envelopes](envelopes.md) | Stage handoff contract (`emit_stage_envelope`, artifacts) |
| [Verified Stage Execution](verified-stage-execution.md) | After-phase `verify`, evidence, and `on_verify_fail` repair / manual recovery |
| [Human-in-the-loop](hitl.md) | Gate kinds, operator replies, `--skip-gates`, exit code `2` |
| [Providers](providers.md) | Pi model auth — `pi_home` vs `sf_owned` |

## Operating Stageflow

| Doc | What you'll learn |
|-----|-------------------|
| [Operator console](operator-console.md) | Spatial stage map, gated workspace, navigation, settings |
| [MCP](mcp.md) | Streamable HTTP tools when `sf ui` or `sf mcp` is running |
| [CI / headless](ci.md) | `--json`, exit codes, GitHub Actions, PR diagram dogfood |

## Featured example

**[Archify on PR](../examples/archify-on-pr/)** — pull-request diagram automation dogfooding Stageflow in GitHub Actions: conditional fork skip, pipeline skill binding, `sf envelope get --format handoff`, and deterministic Archify deliver outside the agent. See [CI: PR diagrams (Archify)](ci.md#pr-diagrams-archify) and [examples/archify-on-pr/README.md](../examples/archify-on-pr/README.md).

For clonable fan-out (clone one successor N times at completion), see [`examples/clonable-fanout/`](../examples/clonable-fanout/) and [YAML catalog — Clonable successors](yaml-catalog.md#clonable-successors). For a diamond join (two named parents into one child, inspect keyed envelopes), see [`examples/generic-fan-in/`](../examples/generic-fan-in/) and [YAML catalog — Generic fan-in](yaml-catalog.md#generic-fan-in).

For source-owned feedback loops (`continue` / `send_back`), see [`examples/feedback-loop/`](../examples/feedback-loop/) and [YAML catalog — Feedback loops](yaml-catalog.md#feedback-loops). For stage agents consuming project MCP servers, see [YAML catalog — Stage MCP](yaml-catalog.md#stage-mcp), [`examples/stage-mcp/`](../examples/stage-mcp/), [`examples/playwright-mcp/`](../examples/playwright-mcp/), and [`examples/context7-mcp/`](../examples/context7-mcp/).

## Canonical YAML examples

Test fixtures under [`tests/fixtures/`](../tests/fixtures/) are the source of truth for valid catalog shapes:

- [`tests/fixtures/pipelines/`](../tests/fixtures/pipelines/) — linear, parallel fan-out, diamond fan-in, HITL, fork routing, clonable fan-out, feedback loops, validation edge cases (`*.pipeline.yaml`)
- [`tests/fixtures/stages/`](../tests/fixtures/stages/) — gate kinds, `io` / `verify` shapes (referenced via `uses:`)
- [`tests/fixtures/tasks/`](../tests/fixtures/tasks/) — task file shapes (`*.task.yaml`)

Runnable walkthroughs live in [`examples/`](../examples/) (see [`examples/README.md`](../examples/README.md)).

## See also

- [README](../README.md) — product landing page and installation
- [GitHub Issues](https://github.com/tejasghutukade/stageflow/issues) — support and bug reports
