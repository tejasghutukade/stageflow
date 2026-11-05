---
name: stageflow-pipelines
description: >-
  Designs, writes, edits and repairs Stageflow pipelines, stages and tasks
  (*.pipeline.yaml, stage YAML, *.task.yaml), plus the trigger files and A2A
  publications that start them. Interviews the user one question at a time,
  picks stage boundaries, wires route, entry, if and loops, places human
  approval gates, and writes io, verify, on_verify_fail, stage prompts, models,
  skills, stage MCP, browser stages, channels, memories and secrets, then
  validates and fixes every finding. Also captures a pipeline from this chat or
  a past session transcript, and turns a repeating request into a reusable
  pipeline or reuses an existing one. Use when the user wants to build, change,
  fix, review or capture a multi-stage workflow (release, research, content
  review, ops runbook, SDLC). Edits YAML to fix a cause. Not for run state
  (retry, resume, rerun) or diagnosing a failed run (stageflow-operate):
  diagnose there, then edit YAML here. Not for project agents
  (stageflow-agents) or evals (stageflow-evals).
compatibility: Requires the Stageflow sf CLI. The bundled scripts need Node.js 20 or later.
---

# Stageflow pipelines

A Stageflow pipeline is a set of stages. Each stage is one fresh agent session that ends with one `emit_stage_envelope` call; stages hand off through typed payloads and artifacts, and human gates pause for an operator. This skill produces the YAML files on disk: one `<id>.pipeline.yaml`, one `<id>.yaml` per stage beside it, and optionally a `<id>.task.yaml`. It does the same job as the in-app Workshop Author.

Other work belongs to sibling skills. Name them; do not do their job here:

- Run state (start, retry, resume, rerun, cancel), answering gates, reading run results, firing triggers, creating connections, saved browser logins and A2A callers: `stageflow-operate`. This skill edits YAML to fix a cause. "My run failed, fix the pipeline": diagnose the run in `stageflow-operate`, then edit YAML here.
- Measuring whether a stage or prompt is good: `stageflow-evals`.
- Conversational project agents: `stageflow-agents`.
- Installing `sf`, `sf init`, provider login, `sf doctor` troubleshooting: `stageflow`.

## Hard rules

1. Write the author dialect only: wiring with `route`, `entry: true` and `{ type: loop }`; contracts with `io`, `verify` and `on_verify_fail`. Never write `needs`, `fork`, a `feedback_loop` key, `route_select`, `allow_none`, `clonable`, `clone_actions`, or the legacy keys `payload_schema`, `pre_emit_checks`, `completion`, `recovery`, `clone_input_schema`.
2. Every stage has `system_prompt`, `io.input.schema` and `io.output.schema`, both with `type: object` at the root.
3. A model must resolve at some tier (stage, then pipeline, then `stageflow.yaml`). Never invent a model id. Take one from MCP `list_models` or `sf providers status`, or write the placeholder `CHANGE_ME/<provider-model>` and tell the user.
4. Never put a secret value in YAML, a file, a log, a commit or the chat. Stages get credentials only through `secrets:` names that the Host resolves.
5. Ask before anything that costs money, is visible outside the project, or destroys work: running a pipeline or a stage, enabling or firing a trigger, publishing over A2A, overwriting or deleting a file the user wrote. Writing and validating new YAML is free and needs no confirmation once the user asked for it.
6. Never report a pipeline as done while validation shows an error.
7. Stages are domain-agnostic. Release automation, research, content review, ops runbooks and SDLC are all valid; do not assume software unless the user's workflow is software.

## Pick the path

| The user says | Path |
|---|---|
| "Build a pipeline / workflow for ...", describes steps | [New pipeline](#new-pipeline) |
| "Change / fix / add a stage to ...", or validation of an existing pipeline fails | [Edit or repair](#edit-or-repair) |
| "Capture what we just did", "turn that session into a pipeline" | [Capture a session](#capture-a-session) |
| "I keep doing X, make it repeatable", "do the weekly X" | [Reuse or codify](#reuse-or-codify) |
| "Run it every night / on each PR / on a webhook" | Trigger, see [capabilities.md](references/capabilities.md#triggers) |
| "Let another agent or service call this pipeline" | A2A publication, see [capabilities.md](references/capabilities.md#a2a-publication) |
| "Run it", "answer the gate", "retry / resume / rerun", "why did the run fail" | `stageflow-operate` (diagnose). Edit YAML here only after the cause is a catalog change. |
| "Is this stage any good", "did my prompt change help" | `stageflow-evals` |

## Step 0: Orient (every path)

1. **Project root.** `git rev-parse --show-toplevel`, else the current directory. Run every `sf` command from there: `sf validate` resolves `stageflow.yaml`, `.mcp.json` and secrets from the current directory.
2. **Manifest.** Read `stageflow.yaml`. Its `catalog.pipelines` and `catalog.tasks` lists are the scan roots (recursive); files outside them still validate by path but do not show in the console or in `list_pipelines`. If there is no manifest, ask the user before running `sf init` (it writes `stageflow.yaml`, `pipelines/hello.pipeline.yaml` and `tasks/hello.task.yaml`), or hand off to the `stageflow` skill.
3. **Surface.** If your harness exposes the Stageflow MCP tools, call `get_started`. The seven authoring tools write under the Host's project and take no project argument. Use them only when a `catalog_roots` entry with `kind: "registered"` has `project_root` equal to this project's absolute path and `read_pipeline` can see a file in this project. A `kind: "workspace"` root is `$STAGEFLOW_HOME/workspace`, not this project. Otherwise write files directly and use the CLI. Both paths are complete; see [authoring-tools.md](references/authoring-tools.md).
4. **Models.** MCP `list_models`, or `sf providers status` (no `--json`; a provider is usable when the second column is `configured`). `node scripts/check-provider-gate.mjs` wraps that check and prints `{"ok":true}` or a reason. With no provider you can still draft and validate with the placeholder model; running needs a provider, which is the `stageflow` skill's job.
5. **Existing work.** List what is already there (MCP `list_pipelines` and `list_tasks`, or glob `**/*.pipeline.yaml` under the roots). Do not create a second pipeline for something that exists; offer to edit it.

## New pipeline

Work like the Workshop: short turns, one decision at a time, edits instead of essays.

### 1. Talk

- Keep each message to one to four sentences. No headings, outlines or catalog recitation unless the user asks for a plan.
- Make one move per turn: reflect what you heard, ask the single question that changes the draft, or make an edit and state what you assumed.
- Ask only when a missing fact would change the stages, the wiring, the goal or a gate. Make the question specific ("Should review block shipping until someone accepts?"), not open ("Tell me more").
- Default the rest and say so in the same breath as the edit: ids, ordinary linear order, the model when one is already configured.
- When the request is already specific, edit. Do not ask permission to do what was just asked.
- Do not narrate tools or paste YAML unless asked. Say what changed in plain words.

The questions that matter fall in four groups: the steps (is one step really two?), the wiring (linear, parallel, a decision point, anything that loops back), the goal and input of a run, and the gates (who signs off, and does sign-off block). [design-playbook.md](references/design-playbook.md) has the question bank and the defaults.

### 2. Design

Settle these before writing; each links to the reference that has the rules.

- **Stage boundaries.** One checkable outcome per stage. Split when a step needs a different gate, model, skill, credentials or verify. Keep exploration apart from implementation, and review apart from fixing. [design-playbook.md](references/design-playbook.md#stage-boundaries)
- **Wiring.** Map what the user said to `route` shapes: sequence, fan-out, join, an exclusive branch (two or more `if`s whose conditions cannot be true together; every matching `if` starts its target), loop back with `{ type: loop }`, one run per list item with a Clone Chain. [catalog-mapping.md](references/catalog-mapping.md#sequencing)
- **Gates.** Advisory (`gate_kinds` only) or load-bearing (`gate_kinds` plus `verify: [{ type: gate, kind }]`). [catalog-mapping.md](references/catalog-mapping.md#human-gates)
- **Proof and recovery.** What must be true after a stage (`verify`) and what happens when it is not (`on_verify_fail`: `repair` for idempotent work, `manual` for side effects). [catalog-mapping.md](references/catalog-mapping.md#verify-and-on_verify_fail)
- **Handoff contracts.** `io.output.schema` of each parent must satisfy every child's `io.input.schema`. That check is skipped for a Clone Chain emitter parent. Share shapes with pipeline `schemas:` and `$ref`. [yaml-reference.md](references/yaml-reference.md#io-schemas)
- **Capabilities** when the workflow needs them: a skill, stage MCP servers, a logged-in browser, a channel to send messages, memories, secrets and tools, a checkout, sandbox grants. [capabilities.md](references/capabilities.md)

### 3. Write

- Lay files out as `<dir>/<pipeline-id>.pipeline.yaml` plus `<dir>/<stage-id>.yaml` per stage, wired with `uses: ./<stage-id>.yaml`. Put `<dir>` under a `catalog.pipelines` root; if it is not under one, add it to `catalog.pipelines` (and `catalog.tasks` when you write a task).
- Ids are lowercase kebab case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), and the stage file's `id` equals its filename stem and its pipeline entry `id`. `sf validate` does not enforce the pattern. The console create APIs and MCP `create_stage_file` and `create_task_file` reject anything else. `create_pipeline`, `create_stage` and `create_task` do not, so still write kebab case.
- Before writing a file, check the path is free. Never overwrite a file you did not create in this session without asking. `node scripts/resolve-catalog-id.mjs --text "<phrase>" --dir <dir> --kind pipeline|stage` prints a free id.
- Write each `system_prompt` from [stage-prompt-template.md](references/stage-prompt-template.md): goal, inputs, the required output fields by name, gate sequence if any, and the closing `emit_stage_envelope` instruction.
- Add a task file when the user wants to start runs from the console or a trigger: `id`, `goal`, and an `input` that satisfies the entry stage's `io.input.schema`. [yaml-reference.md](references/yaml-reference.md#task-file)
- Start from the closest example in `assets/examples/` (see the list below) rather than from a blank file.

### 4. Check, validate, repair

Run this loop until there are no errors, then once more after any later edit.

1. **Self-check the blind spots.** The validator silently ignores unknown keys in stage files, pipeline top level and tasks (a typo like `gate_kind:` or `verfy:` drops a gate or a check without any finding), does not check task `input` against the entry stage, and does not check id format. Run:

   ```
   node scripts/check-catalog-keys.mjs --pipeline <pipeline-path> [--task <task-path>]
   ```

   Exit 1 is a lint error with `{ ok, summary, findings }`. Fix every `lint.*` error. Exit 2 with `reason: yaml_parser_unavailable` means compare keys by hand against [yaml-reference.md](references/yaml-reference.md).
2. **Validate.** MCP `validate { pipeline: <path>, strict: true }`, or:

   ```
   sf validate --pipeline <pipeline-path> --strict --json
   sf validate --task <task-path> --json
   ```

   Exit 0 means no errors. `pipeline.model_applies` always appears when the pipeline sets a model and is informational; `pipeline.route_all_gated` is expected when every forward `if` is written so the conditions cannot be true together.
3. **Repair.** Look each code up in [finding-codes.md](references/finding-codes.md), fix the file, and go back to step 1. Fix `stage.*` findings before the `pipeline.missing_stage` that accompanies them.
4. **Show the wiring.** `sf graph --pipeline <pipeline-path>` prints the resolved DAG; use it to confirm the shape with the user in one or two sentences. MCP `describe_pipeline` does the same but labels edges with the legacy words needs, fork and feedback_loop; translate them, never copy them into YAML.
5. **Readiness.** When the pipeline uses `requires`, `secrets`, `mcp` or `channels`, run `sf doctor --pipeline <pipeline-path> --json` or MCP `preflight { pipeline }`. A saved login and `browser.check` are not covered by `sf doctor` or `preflight`. `sf validate` checks names and shapes only, not whether a tool is installed, a secret has a value or a server starts.

Validation never calls a model and never starts the Host; repeat it freely.

### 5. Report

In a few sentences: the pipeline id and path, each stage file written, the task path if any, assumptions you made (model placeholder, defaulted ids), any warnings left on purpose, and readiness gaps from `sf doctor`. Then offer the next step by name: running it is `stageflow-operate` (ask first; a run calls models), measuring a stage is `stageflow-evals`.

## Edit or repair

1. Read the whole package: the pipeline, every `uses:` file, any `include:` fragment and the task. MCP `read_pipeline { path, task_path? }` returns the parsed draft plus its validation in one call.
2. Validate before changing anything, so you know which findings were already there.
3. Make the smallest edit that does what the user asked. Keep their ids, prompts, comments and file layout. Prefer editing files directly: the MCP `edit_*` tools re-serialize files (comments are lost) and merge objects, so they cannot delete a key.
4. When you add a stage, write its file and add the pipeline entry together, and re-check the `io` of its parent and children. When you remove one, remove every `route` entry that targets it.
5. When the file uses legacy keys (`catalog.legacy_yaml` warning) and the user agrees, convert with `sf migrate-yaml <path> --json` (dry run), then `--write`. Never mix legacy and author keys in one file (`catalog.mixed_yaml_dialect`).
6. Run the full check-validate-repair loop, then report what changed as a short diff summary (`git diff --stat` if the project is a git repo).

## Capture a session

Turn work that already happened into a pipeline. Follow [session-capture.md](references/session-capture.md). In short:

1. Pick the source: this conversation (default), a file or paste the user gives, or the newest transcript found by `node scripts/locate-session-transcript.mjs` (show the path to the user before reading it). [transcript-sources.md](references/transcript-sources.md) lists the stores.
2. Extract the phases that worked, the decision points, and the moments a human approved or redirected. Drop one-off paths, secrets and chat noise.
3. Map phases to stages, human approvals to gates, and retries to `verify` plus `on_verify_fail` or a loop, then continue at New pipeline step 3. The worked example is `assets/examples/session-capture/`.

## Reuse or codify

When the user describes a request they repeat, find out whether a pipeline already covers it. Follow [reuse-and-codify.md](references/reuse-and-codify.md):

- **Match:** re-validate the existing pipeline (it may have drifted), run the readiness check, then hand off to `stageflow-operate` to run it after the user confirms.
- **Close match:** offer to edit it (Edit or repair) rather than writing a near-duplicate.
- **No match, and this session already did the work:** Capture a session.
- **No match and no history:** New pipeline.

## Examples

All examples validate. Each pipeline sets `model: CHANGE_ME/<provider-model>`; replace it before running.

| Folder | Shows |
|---|---|
| `assets/examples/linear-review/` | Linear draft, gated review (`artifact_backed`, load-bearing), side-effecting publish with manual recovery |
| `assets/examples/branch-decision/` | Two `if`s on a required boolean that cannot both be true; each match starts its target |
| `assets/examples/non-sdlc-digest/` | Non-software gather, summarize, send |
| `assets/examples/implement-review/` | Gated plan, implement proven by `checkout_changes` and a `command` check with repair, review loop, ship with `secrets` and `requires`, plus a task whose `input` matches the entry stage |
| `assets/examples/session-capture/` | A captured two-phase session: research, then implement with `checkout_changes` |

## References

| File | Read when |
|---|---|
| [design-playbook.md](references/design-playbook.md) | Interviewing, choosing stage boundaries, gates, models, anti-patterns |
| [catalog-mapping.md](references/catalog-mapping.md) | Turning a described structure into wiring, gates, verify and recovery, with worked YAML |
| [yaml-reference.md](references/yaml-reference.md) | Exact keys and placement for pipeline, stage, task and manifest files |
| [stage-prompt-template.md](references/stage-prompt-template.md) | Writing a `system_prompt` |
| [capabilities.md](references/capabilities.md) | Skills, stage MCP, browser, channels, memories, secrets, sandbox, checkout context, triggers, A2A publication |
| [finding-codes.md](references/finding-codes.md) | A validation or self-check finding needs a fix |
| [authoring-tools.md](references/authoring-tools.md) | Choosing MCP tools or files and CLI; tool parameters and their traps |
| [session-capture.md](references/session-capture.md) | Capturing a pipeline from a session |
| [transcript-sources.md](references/transcript-sources.md) | Finding a past session transcript |
| [reuse-and-codify.md](references/reuse-and-codify.md) | Matching a repeating request to the catalog |

## Scripts

| Script | Purpose |
|---|---|
| `scripts/check-catalog-keys.mjs` | Flags unknown keys, bad ids, missing task goals and task `input` that does not satisfy the entry stage. Run before `sf validate`. |
| `scripts/check-provider-gate.mjs` | Prints whether any model provider is configured. |
| `scripts/resolve-catalog-id.mjs` | Derives a kebab-case id from a phrase that is free in a directory. |
| `scripts/locate-session-transcript.mjs` | Finds the newest Claude Code, Codex or Pi transcript for the current directory, or checks a given path. |

All scripts print JSON on stdout. Run them from this skill's folder or pass absolute paths.
