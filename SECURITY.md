# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.59.x  | Yes       |
| < 0.59  | No        |

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

- **In scope:** the `sf` / `stageflow` CLI, bundled operator UI, MCP endpoint served by `sf ui`, and SQLite state under `~/.stageflow/`
- **Out of scope:** third-party model providers (Anthropic, OpenAI, etc.), Pi runtime behavior, and project YAML you author locally

Stageflow does not collect telemetry or phone home. Credentials are stored locally at `~/.stageflow/agent/auth.json`.

A stage does not receive the control token. Its cache, temporary and working directories are inside the data directory (`~/.stageflow` by default, `/data` in Docker), and an unsandboxed stage runs as your user, so it can find and read the token file. Use the stage container sandbox (`STAGEFLOW_STAGE_CONTAINER_IMAGE`) when a stage runs untrusted code.

## Reverse proxy

If you put the console or `/mcp` behind a reverse proxy, the proxy must pass the `Host` header through unchanged (nginx: `proxy_set_header Host $host;`), and the public hostname must be in `STAGEFLOW_ALLOWED_HOSTS`. The Host checks `Host` and `Origin` against that list. Keep the control token required.
