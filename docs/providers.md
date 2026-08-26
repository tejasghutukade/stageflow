---
layout: default
title: Providers
---

# Providers

Stageflow runs stages on **Pi** (`@earendil-works/pi-coding-agent`). Model provider authentication is Pi-compatible — reuse an existing Pi login or store credentials in a Stageflow-owned file.

Provider management is via `sf providers` and the console **Settings → Providers** page.

## Credential storage: `pi_home` vs `sf_owned`

| Mode | Where credentials live |
|------|------------------------|
| `pi_home` | Pi's standard auth file under your Pi home directory (`~/.pi/agent/auth.json`) |
| `sf_owned` | Stageflow global auth at `~/.stageflow/agent/auth.json` |

Check current binding:

```bash
sf providers source get
sf providers detect
```

`detect` prints `piHomeUsable`, `credentialSource`, `provisional`, and `bindingSource`.

Set explicitly:

```bash
sf providers source set pi_home
sf providers source set sf_owned
```

**When to use which:**

- **`pi_home`** — you already use Pi CLI elsewhere; one login for Pi and Stageflow
- **`sf_owned`** — isolate Stageflow credentials in `~/.stageflow/` without touching Pi home

Project run state and settings live under **`<git-root>/.stageflow/`** — separate from global auth.

The console **Connect** flow (`#/connect`) mirrors CLI login for browser-based setup.

## CLI commands

```bash
sf providers list
sf providers status [--provider <id>]
sf providers detect
sf providers source [get | set <pi_home|sf_owned>]
sf providers login <providerId> [--type api_key|oauth] [--api-key-env <VAR>]
sf providers logout <providerId>
```

### `list`

Tab-separated: `id`, display name, supported auth types (`api_key`, `oauth`).

### `status`

Per provider: `configured` or `disconnected`, plus `kind` and `source` when configured.

### `login`

- **API key:** interactive prompt or `--api-key-env VAR` (reads from environment)
- **OAuth:** browser/device flow via terminal interaction
- If a provider supports both methods, pass `--type api_key` or `--type oauth`

Raw `--api-key` on the command line is rejected.

Example for CI:

```bash
sf providers login anthropic --type api_key --api-key-env ANTHROPIC_API_KEY
```

### `logout`

Clears stored credentials for one provider id.

## Stage `model` field

Each stage YAML sets the model id:

```yaml
model: anthropic/claude-sonnet-4-5
```

The provider must be configured before runs succeed. Validation does **not** check provider auth.

## Pi shell, not a separate runtime

Stageflow is a thin orchestration layer on Pi. You do **not** need Pi CLI `/login` as a hard prerequisite if you configure providers via `sf providers` or the console.

Optional: Cursor provider extension via `STAGEFLOW_CURSOR_EXTENSION` env var — see `src/agent/cursorProvider.ts`.

## Console

**Settings → Providers** — list providers, connection status, login/logout actions.

**Connect** (`#/connect`) — guided provider setup from the rail footer link when disconnected.

## See also

- [CLI reference](cli-reference.md) — full `sf providers` usage
- [Quick start](quickstart.md) — first provider connection
- [CI / headless](ci.md) — `--api-key-env` in GitHub Actions
- [Operator console](operator-console.md) — Settings and Connect pages
