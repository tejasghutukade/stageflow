# Capabilities

Optional stage and pipeline features. Key lists and placement rules are in [yaml-reference.md](yaml-reference.md). After writing any of these, `sf validate` checks names and shapes only. Run `sf doctor --pipeline <path> --json` or MCP `preflight` with `{ pipeline }` before calling the pipeline ready.

## Contents

- [Skill binding](#skill-binding)
- [Stage MCP](#stage-mcp)
- [Browser stages](#browser-stages)
- [Channels](#channels)
- [Memories](#memories)
- [Secrets](#secrets)
- [Sandbox](#sandbox)
- [Independence](#independence)
- [Checkout context](#checkout-context)
- [Triggers](#triggers)
- [A2A publication](#a2a-publication)

## Skill binding

`skill` is one non-empty string on the stage body (the stage file or an inline stage). On a `uses:` wrapper it is `pipeline.stage_wrapper_skill_rejected`. An empty value is `stage.invalid_skill`.

```yaml
id: author-diagrams
skill: archify
system_prompt: |
  Follow the archify skill. Emit one success envelope when the diagram spec is written.
```

Lookup order, first match wins: run skills (`$STAGEFLOW_HOME/runs/<runId>/skills/<name>/`), the checkout's `.pi/skills/<name>/`, the host Pi skills directory, then package built-ins. MCP `list_skills` reports `name`, `description` and `origin` (`run`, `checkout`, `host` or `builtin`). A missing skill fails the stage before the session starts. Install a durable host skill with `sf skills install --from-path <dir> --skill-name <name>` or `sf skills install --from-zip <url-or-path> --skill-name <name>`.

## Stage MCP

`mcp` is a list of server names. It may sit on the stage file or on the `uses:` wrapper. A wrapper list replaces the file list, and `mcp: []` clears it. Omit the field for no author-declared servers.

```yaml
stages:
  - id: use-echo
    uses: ./use-echo.yaml
    mcp: [echo]
```

Names resolve from the project `.mcp.json` (`mcpServers`) merged with console-saved servers. A console server wins on a name clash. The name `stageflow` is reserved (`stage.invalid_mcp`). A listed name with no catalog and no console server, or a missing or invalid `.mcp.json` when a stage lists a name, is `catalog.invalid_mcp`. A catalog `command` that is not on `PATH` is `catalog.mcp_command_missing`. `sf validate` does not require env vars to be set and does not connect.

`${VAR}` and `${VAR:-default}` in the server's `command`, `args`, `env`, `url`, `headers` and `cwd` resolve against the stage's curated environment. A console secret named in `secrets:` fills MCP servers only and is not put in the stage environment. The stage still has `emit_stage_envelope`, `write_stage_artifact` and, when allowed, `ask_operator` without listing them.

## Browser stages

`browser` is an object on the stage file or the `uses:` wrapper. A wrapper object replaces the file object. Allowed keys: `profile`, `headed`, `allow_domains`, `login_url`, `check`. `path`, `scope`, `secret` and launch options (`launch_args`, `args`, `executable_path`, `executable`, `display`, `headless`, `xvfb`, `env`) are `stage.invalid_browser`. The Host chooses the profile directory and the owner scope.

| Key | Meaning |
|---|---|
| `profile` | Optional name, 1–64 characters of letters, digits, `-` and `_`. Stages in one run that share a profile share one browser. |
| `headed` | Optional boolean. `true` shows a window. |
| `allow_domains` | Optional non-empty list of bare domains (`example.com`, `*.example.com`). No scheme, port or path. |
| `login_url` | Optional page a human login stage opens. Defaults to `check.url`. |
| `check` | Optional. `url` is required. `logged_in_url` is one glob. `logged_out_url` is a glob or a list of globs. |

A stage with `browser` requires the `agent-browser` binary. `sf validate` reports it as a missing tool; it does not launch a browser.

Login topology: a check stage, a login stage routed only when `logged_in` is false, and a work stage that joins both with no `if` on its incoming edges. The work stage's `io.input` must be a subset of both parents' outputs.

Check stage body:

```yaml
id: check
system_prompt: |
  Report the Host login check. Emit success with payload logged_in and url
  exactly as the Host recorded them.
browser:
  profile: work
  check:
    url: https://example.com/feed
    logged_in_url: "https://example.com/feed*"
    logged_out_url: ["https://example.com/login*"]
io:
  input: { schema: { type: object } }
  output:
    schema:
      type: object
      required: [logged_in, url]
      properties:
        logged_in: { type: boolean }
        url: { type: string }
```

Pipeline wiring for that stage:

```yaml
- id: check
  uses: ./check.yaml
  entry: true
  route:
    - to: login
      if: { field: logged_in, op: eq, value: false }
    - to: work
```

A human login stage has `browser.check`, must not set `headed: false`, and has a `browser_login` verify. `browser_login` is after-phase only and takes no other fields. Put `on_verify_fail` on the pipeline entry.

```yaml
id: login
system_prompt: |
  The Host has opened the login page. Call ask_operator with kind confirm and
  leave the browser open. After accept, emit success.
gate_kinds: [confirm]
browser:
  profile: work
  login_url: https://example.com/login
  check:
    url: https://example.com/feed
    logged_in_url: "https://example.com/feed*"
    logged_out_url: ["https://example.com/login*"]
verify:
  - id: logged-in
    type: browser_login
io:
  input: { schema: { type: object } }
  output: { schema: { type: object } }
```

```yaml
- id: login
  uses: ./login.yaml
  on_verify_fail:
    mode: repair
    max_attempts: 3
    retry_safety: idempotent
  route:
    - to: work
```

Work stages that should stay headless set `headed: false` and the same `profile`. Sites that reject a copied session need a visible window; that is per site.

## Channels

`channels` sends through a connection defined in the console or `connections.yaml`. It is not the `email:` account list. The agent never chooses the recipient.

One channel per stage. A second entry is `stage.invalid_channels`. `channels` is a body key: on a `uses:` wrapper it is `pipeline.stage_uses_inline_conflict`. A pipeline-level `channels` list is the default for every stage. A stage list merges by alias (or by connection id when there is no alias), with the stage entry winning. `channels: []` on a stage drops the inherited default. The merged list must still be one channel. A bad pipeline-level list is `pipeline.invalid_channels`. A missing, disabled or mistargeted connection is `stage.channel_unavailable`.

```yaml
channels:
  - connection: ops-slack
    to: C0123ABCD
    operations: [send]
```

| Field | Required | Rule |
|---|---|---|
| `connection` | yes | Id in `connections.yaml`. Letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 200 characters. |
| `to` | yes | One string, or a list of 1–20 strings. Shape depends on the provider. |
| `operations` | yes | `[send]` only. |
| `alias` | no | Name the agent passes as `send_message`'s `channel`. |
| `cc` | no | List of 1–20 strings. Providers that do not support it reject the stage. |
| `template` | no | Object. WhatsApp uses `name`, `languageCode` and `bodyParams`. |

AgentMail may use a list in `to` and a `cc` list. Other providers take one target string. Pi stages get `send_message`. A Claude backend refuses to start a stage that has `channels`. Creating the connection is `stageflow-operate`. Never put a token in YAML.

## Memories

`memories` is a list of memory ids on the pipeline only. On a stage entry it is `pipeline.invalid_shape`. An empty list is the same as omitting the key. Each id matches `^[a-z][a-z0-9_-]{0,63}$`. A duplicate is `pipeline.invalid_memories`. A missing or unreadable memory is `pipeline.memory_unavailable` at validate and at run start. Create the memory in the console before naming it. Every stage receives the list. Pi stages get `read_memory`, `replace_memory`, `add_memory_card`, `update_memory_card`, `read_memory_card` and `search_memory_cards`. Claude stages do not, and a pipeline that lists memories fails at stage start on Claude. Set `agent: pi` when the pipeline uses memories or channels.

```yaml
id: weekly-digest
model: CHANGE_ME/<provider-model>
agent: pi
memories:
  - candidate-pool
stages:
  - id: gather
    uses: ./gather.yaml
```

## Secrets

`secrets` is a list on the stage file or the `uses:` wrapper. A wrapper list replaces the file list. Each entry is a name or `{ name, as: env }`. `as` may only be `env` (`stage.invalid_secrets`). Duplicate names are `stage.invalid_secrets`.

```yaml
secrets:
  - GITHUB_TOKEN
  - { name: NPM_TOKEN, as: env }
```

A plain `GITHUB_TOKEN` or `GH_TOKEN` sets git askpass and a token file, not a raw environment variable. `{ name: GITHUB_TOKEN, as: env }` adds the variable and keeps askpass. Other names with `as: env` are env-only.

The name must be in the Host secret registry or `stage.unknown_secret`. `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN` and `NODE_AUTH_TOKEN` are always registered. Other names come from `STAGEFLOW_SECRET_REGISTRY`, a file credential, or a console-saved MCP secret. A console MCP secret fills MCP servers only and is not placed in the stage environment. `STAGEFLOW_CONTROL_TOKEN`, `STAGEFLOW_CONTROL_TOKEN_FILE` and any name starting with `STAGEFLOW_CONTROL_TOKEN_` are `stage.denied_secret` and cannot be granted.

Never write a secret value in YAML, a prompt, a log or the chat. Pair a binary the stage shells out to with `requires: [{ tool: gh }]` so `sf doctor` can see it. Stageflow does not install tools. Unknown `requires` sub-keys are `stage.invalid_requires` or `pipeline.invalid_requires`. Conflicting version ranges are `pipeline.requires_conflict`.

## Sandbox

There is no sandbox key in YAML. A stage runs in a container only when the Host has `STAGEFLOW_STAGE_CONTAINER_IMAGE` set. `STAGEFLOW_STAGE_CONTAINER_DOCKER_BIN` selects the docker binary. `STAGEFLOW_STAGE_READONLY_DIR` bind-mounts one host directory read-only at the same path inside the container.

Inside the container the desk is `/workspace`. `read`, `write`, `edit` and `bash` stay there. `grep`, `find` and `ls` search that desk. A checkout is `/workspace/checkout`. Scratch is `/workspace/work`. `/workspace/artifacts` is not durable. Durable files go through `write_stage_artifact`. Prior artifacts are granted at `/workspace/grants/<stage-id>/<relative-path>` (or `.../attempt-<n>/...` when two grants would otherwise share a path). Tell the consumer to read those grant paths or payload fields. Do not tell it to open `stages/<id>/attempts/.../artifacts` host paths.

## Independence

`independence` is `strict`, `persistent` or `open`, on a stage body or the pipeline. An unknown value is `stage.invalid_independence` or `pipeline.invalid_independence`. Precedence is stage, then the root pipeline, then `stageflow.yaml`, then `persistent`. A fragment's top-level value is ignored. It does not change the prompt text the author wrote.

| Value | What a quiet turn does |
|---|---|
| `strict` | Short reminder budget. The reminder may offer a failure envelope. On Pi, two quiet reminders, reset when a reminder uses a tool, hard ceiling of twenty. On Claude, two reminders and no reset. |
| `persistent` | A quiet turn is a continuation. The reminder does not tell the stage to emit failure. Ceiling of twenty. A reminder that uses a tool resets the quiet count. |
| `open` | Same reminder budget as `persistent`. A rejected emit, a failed command or a missing file ends that approach. The stage is told to try another approach with the tools and inputs it already has, and to emit failure only when it can name a blocker none of those can get past. It must not invent a stand-in for an input it could not read. |

Leave it unset unless the user wants stages to give up quickly or to change approach.

## Checkout context

`checkout_context: true` is a boolean on the stage body only. Omitted means off. A non-boolean is `stage.invalid_checkout_context`. It is not inherited from the pipeline or the manifest. It does not follow `independence`: `strict`, `persistent` and `open` load nothing from the checkout unless this flag is true.

When it is true, the task must bind a checkout (`checkout`, or `repository` plus `ref`) or the run must be started with a checkout path. The Stageflow project root is not that checkout. If nothing is bound, run start fails with `stage.checkout_context_unbound`. `sf validate` does not check the pairing. When `<checkout>/AGENTS.md` exists it is extra context; the stage assignment wins on conflict, and the `system_prompt` is not rewritten. A missing file does not fail the stage. `CLAUDE.md` and other instruction files are not loaded.

## Triggers

A trigger is `<id>.trigger.yaml` under a `catalog.triggers` root. It starts an existing pipeline. It is not a pipeline key. Firing it, and flipping `enabled` to true, is `stageflow-operate` and needs the user's yes. Write `enabled: false` until they agree.

| Key | Required | Rule |
|---|---|---|
| `id` | yes | Trigger id. |
| `pipeline` | yes | Catalog pipeline id, not a file path. |
| `task` | no | Catalog task id. Present means catalog mode: every fire uses that task. Absent means dynamic mode: the fire must supply a task. |
| `kind` | yes | `manual`, `schedule` or `event`. |
| `enabled` | yes | Boolean. |
| `schedule` | for `schedule` | `{ cron, timezone? }`. |
| `event` | for `event` | `{ source, match?, config? }`. |

```yaml
id: nightly-digest
pipeline: weekly-digest
task: weekly-digest
kind: schedule
enabled: false
schedule:
  cron: "0 7 * * 1"
  timezone: America/Chicago
```

```yaml
id: on-pr-closed
pipeline: release-gate
task: release-gate
kind: event
enabled: false
event:
  source: github.pulls
  match:
    action: closed
  config:
    repo: owner/repo
    secretRef: GITHUB_TOKEN
```

`github.*` sources require `event.match.action` to be `opened`, `synchronize`, `updated`, `merged` or `closed` (`trigger.github_action_required`, `trigger.invalid_github_action`). A webhook source uses `event.config.secretRef` and `event.config.header` (`scheme` is `hex` or `base64`, default `hex`). An `email.message` source uses `event.config` `host`, `port`, `user` and `secretRef`. `secretRef` is a name, never a value: a plain name reads the environment or `NAME_FILE`, and `store:NAME` reads the console secret store. A malformed `store:` name is `trigger.invalid_secret_ref`.

`sf validate --trigger <path> --json` checks the shape, that `pipeline` and `task` resolve (`trigger.unknown_pipeline`, `trigger.unknown_task`), the GitHub action and a `store:` name. It does not parse `cron` and does not require webhook or email config fields. MCP `create_trigger` does parse `cron` and writes the file. Its parameters are `directory`, `id`, `pipeline`, `kind` (`manual`, `schedule` or `event`), optional `task`, `enabled`, `schedule`, `event` and `project_root`. A `schedule` trigger with no `task` is accepted by the schema and then fails on every automatic tick, because nothing supplies a task. Give a schedule a `task`.

Unknown extra keys are dropped on load with no finding. Keep to the table above.

## A2A publication

Publishing lets another agent call this pipeline. The publication lives in `a2a.yaml`, not in the pipeline file. Creating callers is `stageflow-operate`. Do not run `sf a2a publication create` until the user agrees: it exposes the pipeline.

A publication object (strict keys):

| Key | Rule |
|---|---|
| `id` | Letters, digits, `_` and `-`, first character a letter or digit, at most 80 characters. |
| `name`, `description`, `goal` | Non-empty strings. |
| `project_root` | Project directory. In a file next to `stageflow.yaml` this may be a path relative to that file. |
| `pipeline` | Path to the pipeline file, inside the project. |
| `repository`, `ref` | Both or neither. `repository` without `ref` is rejected, and the reverse. |
| `allowed_callers` | Caller ids that may invoke it. An empty list serves nobody. |
| `input_schema` | Optional path to a JSON object schema. Omit it only when the pipeline has exactly one entry stage; that stage's `io.input.schema` is the contract. Several entry stages need a file. |
| `results.stage` | A terminal stage id. The pipeline must not use a Clone Chain. |
| `results.include_payload` | Boolean, default true. |
| `results.artifacts` | File names only: no slash, no leading dot. Each name needs an emit-phase artifact check on that stage. |
| `caller_answerable_stages` | Stage ids whose `gate_kinds` is exactly `[free_text]`. Any other gate stays with the operator. Default `[]`. |

```yaml
id: weekly-digest
name: Weekly digest
description: Gather sources and send the digest.
project_root: .
pipeline: ./weekly-digest.pipeline.yaml
goal: Produce this week's digest.
allowed_callers: [digest-caller]
results:
  stage: send
  include_payload: true
  artifacts: [digest.md]
caller_answerable_stages: []
```

The result stage's emit check, in that stage file:

```yaml
verify:
  - id: digest-file
    type: artifact
    basename: digest.md
    when: [emit]
```

Write the publication with `sf a2a publication create <file>` after the user agrees (`--json` prints the API body). `sf a2a publication edit <id> <file>` patches the fields in the file. `sf a2a validate` checks a config file locally and does not publish. A later edit to the pipeline changes its digest; new calls fail until `sf a2a reload` or a publication save. Ask before either. `sf a2a enable` and caller create, revoke and list are `stageflow-operate`.
