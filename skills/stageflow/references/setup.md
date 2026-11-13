# Setup

Detail for the checklist in `SKILL.md`. Run the steps in order. Skip a step only when its check already passes. Confirm a flag with `sf <command> --help` before you rely on it. This file was checked against Stageflow 0.57.0. In this release `npm run dev -- --version` prints `0.58.0` (`npm view stageflow version` is the same once it is published).

## Contents

- Probe
- Install or upgrade the CLI
- Provider, then init
- The manifest
- Data directory
- Doctor
- Backup and restore
- Report

## Probe

1. `node --version`. The package requires Node 20 or newer (`engines.node` is `>=20`). If Node is missing or older, stop and tell the user to install Node 20+. Do not install or switch Node versions yourself.
2. `sf --version`, or `sf --version --json` when you need a machine-readable line (`{"version":"…","build_sha":"…"}`). A missing `sf` means step 2 has not been done.
3. `node <this skill's folder>/scripts/detect-host.mjs`. It prints `up <url>` or `down <url>`, and appends `bearer` when a control token is set in the environment. See `host-and-mcp.md`.

Done when you can name which of the CLI, a configured provider, a project manifest, and a Host are missing.

## Install or upgrade the CLI

`npm i -g stageflow` installs two binaries, `sf` and `stageflow`, both pointing at the same CLI.

Compare `sf --version` with `npm view stageflow version`. Upgrade with the same install command when the global CLI is behind. The global `sf` on a machine is often older than the release this skill describes. Do not trust it for flags you have not checked.

If the install fails with `EACCES` or another permissions error, do not use `sudo`. Use `npx stageflow` in place of `sf` for the rest of this session and tell the user. A later session should try the global install again. Any other install error (network, registry) stops the checklist. Do not invent a fallback.

Done when `sf --version` prints the latest published version.

Upgrading the CLI is separate from updating this skill suite. The suite is installed with `npx skills add tejasghutukade/stageflow`. `sf skills` installs Pi project skills into `.pi/skills`. It does not install these harness skills.

## Provider, then init

Log in before `sf init`. The hello pipeline's model is chosen from providers that are already configured. With none, or with more than one, the file gets the placeholder `CHANGE_ME/<provider-model>`. With exactly one, init writes a real id: `anthropic/claude-sonnet-4-5`, `openrouter/auto`, or `cursor/auto`. Any other single provider id becomes `CHANGE_ME/<id>-model`.

Commands and where the key is stored are in `providers-and-models.md`. Done when `sf providers status` shows `configured` for the provider you will use. `sf providers` has no `--json`. Rows are tab-separated.

## The manifest

From the project root, run `sf init`. There are no flags (`sf init --help` prints `sf init`). The root is the git top-level when the directory is inside a repo, otherwise the current directory. Init does not run `git init`.

It writes three files and skips any path that already exists:

| Path | Role |
|---|---|
| `stageflow.yaml` | Catalog manifest. `version` must be `1`. `catalog.pipelines` and `catalog.tasks` are required directory lists. |
| `pipelines/hello.pipeline.yaml` | One stage, id `hello`, with a `model` and an object input and output schema. |
| `tasks/hello.task.yaml` | Task id `hello`. |

The starter manifest also lists a `workshop` directory and these filename patterns: `*.pipeline.yaml`, `*.task.yaml`. You do not have to create `workshop/`. Optional manifest keys, when you add them later, are `catalog.exclude`, `catalog.triggers`, `catalog.evals`, `catalog.datasets`, `catalog.patterns` (`trigger` defaults to `*.trigger.yaml`, `eval` to `*.eval.yaml`, `dataset` to `*.dataset.jsonl`, `*.dataset.json`, and `*.dataset.csv`), plus top-level `model` and `agent` (`pi` or `claude`).

If the hello model still contains `CHANGE_ME`, replace it with a real `provider/model` id before a run. `sf validate` does not reject that placeholder.

Then:

```bash
sf validate --strict --json
```

`sf validate --help` also accepts `--project-root`, `--pipeline`, `--task`, and `--trigger`. With no path flags it validates every pipeline and task the manifest declares. Exit 0 and `"ok": true` means the shape passed. Exit 1 means at least one error finding, or a warning that `--strict` promoted. Exit 2 is not used.

`--strict` turns `catalog.manifest_missing`, `catalog.empty_catalog`, and eval warnings into errors. It does not promote `pipeline.model_applies` or `pipeline.route_all_gated`. It does not check provider credentials, that a model id exists, or that a task `input` matches the entry stage's `io.input`.

Done when validate exits 0.

## Data directory

Runtime state is global, not inside the project.

| Path | What it is |
|---|---|
| `$STAGEFLOW_HOME` | Default `~/.stageflow`. Relative values resolve from the current directory. Holds `state.db` (runs), `service.log` (autostart Host), and `backups/`. |
| `$STAGEFLOW_CREDENTIAL_HOME` | Default `~/.stageflow`, even when `STAGEFLOW_HOME` is set to something else. Provider auth is `<root>/agent/auth.json`. `models.json` sits beside it. |
| `<project>/.stageflow/settings.json` | Project settings only: `maxConcurrent`, `credentialSource`, `workshopModel`. This is not the run store. |

`sf init` creates the global home (`agent/` mode `0700`) as well as the three project files. A non-writable home fails with `stageflow_home_not_writable`.

Set `STAGEFLOW_HOME` before the first command that opens the store if this project should not share the machine's default home. The same variable must be set for the Host and for every CLI command that should see that store.

## Doctor

```bash
sf doctor
sf doctor --json
sf doctor --pipeline <path> [--strict]
```

Human lines look like `[pass] node: Node v22.x.x`. Status is `pass`, `warn`, `fail`, or `skipped`. Exit 0 when nothing is `fail`. Warnings do not fail the command. `--json` prints `{ "ok", "checks" }`.

Doctor opens `$STAGEFLOW_HOME` in migrate mode and can apply schema migrations in this process. It does not call a running Host. It is not a container health check. Use `GET /livez` for that (`host-and-mcp.md`).

`--pipeline` adds toolchain, secret, channel, and stage MCP checks for that file. `--strict` makes an `unknown_version` toolchain result a failure. The default leaves it as a warning.

The checklist is done when no line is `[fail]`. Read every `[warn]` to the user. The `credentials` warning is often a false alarm for a login stored in `auth.json`. How to tell is in `troubleshooting.md`.

## Backup and restore

Back up before an upgrade when the store already has runs you need, and before `sf restore`.

```bash
sf backup [--out <file>] [--db-only] [--no-credentials] [--include-a2a-artifacts] [--json]
sf restore <file> [--force] [--json]
```

The default archive includes provider credentials, mode `0600`, and is a secret. Default `--out` is under `$STAGEFLOW_HOME/backups/`. `--no-credentials` leaves them out. `--db-only` is the database without the rest of the home.

`sf export --all` is a run dump, not a backup.

`sf restore` refuses while a Host answers `/livez` (`restore_host_live`). It never starts a Host. It moves the previous `state.db` aside. Stop `sf ui` or `sf mcp` first, including a Host that autostart left behind. Confirm with the user before restore. It is destructive.

A Host that is up can take `POST /api/restore` with `{"backup":"<file name under $STAGEFLOW_HOME/backups/>"}` (drive scope). That route stages the restore, returns 202, and drains the Host. The next boot applies it. Prefer that when you cannot stop the Host yourself. The name is a file already in `backups/`, not an arbitrary path.

Backup and the host-down read commands start a Host only when the store needs a migration. See `control-surface.md`.

## Report

Tell the user, in one place:

- CLI version, and whether it matches `npm view stageflow version`
- which provider is `configured`
- project root and whether `sf validate --strict --json` exited 0
- Host URL from the probe (`up` or `down`), and whether MCP is connected
- every `[warn]` from doctor, and anything they must do themselves (type a key, start Docker, approve a token)

Then offer the next skill from the router in `SKILL.md`. Do not start a real run, an eval, or a container unless they ask and confirm.
