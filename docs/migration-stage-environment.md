# Migration: curated stage environment (Slot 6)

**If your stage needed it, declare it.**

Stages no longer inherit the Host process environment. The child sees an exact-name allowlist (PATH, locale, proxy/CA, `STAGEFLOW_HOME`, computed cache vars, Slot 2 binding vars) plus only secrets you declare on the stage.

## What breaks

- Ambient `$MY_API_BASE`, `$CI`, `$NPM_TOKEN`, authenticated `gh` via operator `$HOME`, or undeclared proxy vars in stage `bash` / `verify`
- `.mcp.json` `${VAR}` interpolation that previously resolved from Host ambient env

## Migration

1. **Credentials** — add `secrets:` on the stage (or pipeline entry). GitHub tokens default to `GIT_ASKPASS` + a materialised file (not raw env). Use `{ name: GITHUB_TOKEN, as: env }` only when a tool requires the env var (emits a WARN).
2. **Non-secret Host vars** — prefer `STAGEFLOW_STAGE_ENV_ALLOW=FOO,BAR` on the Host.
3. **Stopgap** — `STAGEFLOW_STAGE_ENV_PASSTHROUGH=all` restores ambient vars minus the permanent denylist (control/read tokens, provider keys, undeclared registry secrets). It WARN logs every launch and is removed after two minor releases (target stated in the warning).
4. **MCP** — declare secrets with `as: env` when servers need `${TOKEN}` in env, or use `${TOKEN:-}` defaults. Helper-only `GITHUB_TOKEN` grants do **not** put the value in the curated env for MCP interpolation.
5. **Verify** — commands run under `bash -c` (not `/bin/sh`). Install `bash` on PATH.

Provider model auth is unchanged: it still travels by `authPath`, not env vars.

In-process execution (`STAGEFLOW_STAGE_EXECUTION=inprocess` / Vitest default) does **not** provide isolation — use `STAGEFLOW_STAGE_EXECUTION=process` for security proofs.
