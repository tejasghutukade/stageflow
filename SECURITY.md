# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | Yes       |
| < 0.2   | No        |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report security issues through [GitHub Security Advisories](https://github.com/tejasghutukade/stageflow/security/advisories/new) (preferred) or by opening a private security advisory on this repository.

Include:

- A description of the issue and its impact
- Steps to reproduce
- Affected versions
- Any suggested fix, if you have one

You should receive an acknowledgment within a reasonable timeframe. Fixes are released as patch versions when available.

## Scope

Stageflow is a local CLI and operator console:

- **In scope:** the `sf` / `stageflow` CLI, bundled operator UI, MCP endpoint served by `sf ui`, and SQLite state under `.stageflow/`
- **Out of scope:** third-party model providers (Anthropic, OpenAI, etc.), Pi runtime behavior, and project YAML you author locally

Stageflow does not collect telemetry or phone home. Credentials are stored locally (Pi home or SF-owned credential files) as configured by the operator.
