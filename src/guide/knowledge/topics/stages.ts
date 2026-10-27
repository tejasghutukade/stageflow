import type { GuideKnowledgeTopic } from "../index.js";

export const stagesTopic: GuideKnowledgeTopic = {
  id: "stages",
  title: "Stage fields, what each one costs and risks",
  summary:
    "Every stage field (system_prompt, model, io, verify, gate_kinds, skill, mcp, browser, channels, secrets, requires, timeout_ms) with what it does, where it goes, and its cost or risk.",
  body: `# Stages

A stage is one step. Each attempt runs in a fresh agent session on the Host. A stage body lives inline in the pipeline or in its own YAML file (\`uses: ./name.yaml\`). An external stage file must have \`id\` equal to the file name stem and must not contain wiring (\`route\`, \`entry\`, \`on_verify_fail\`, \`clone_cap\`, \`clone_mode\`). The Guide stores that file in the same \`pipelines/<id>/\` folder as its pipeline. A path the person names does not change that folder.

## Body fields

| Field | Required | What it does | Cost / risk |
|---|---|---|---|
| \`system_prompt\` | yes | The stage's instructions. | Vague prompts cause wrong envelopes and repair loops. Say exactly what to put in \`payload\`. |
| \`model\` | no if a default exists | \`provider/model\` id. Resolved as stage, then pipeline \`model\`, then \`stageflow.yaml\` \`model\`. None at all fails load. | Bigger models cost more per attempt. Cheap models fail structured output more often. |
| \`io\` | yes | \`io.input.schema\` and \`io.output.schema\`, both required. Output is checked on every success emit. | A strict output schema rejects bad envelopes early. Over-strict schemas make the agent retry. |
| \`verify\` | no | Checks at emit time or after the agent claims success. | \`command\` runs a shell command on the Host with the stage's environment: same trust level as running the command yourself. |
| \`gate_kinds\` | no | Non-empty list turns on \`ask_operator\` (\`free_text\`, \`confirm\`, \`multi_question\`, \`artifact_backed\`). | The run stops until a person answers. Evals cannot answer gates. \`sf run --skip-gates\` fails the stage at the first wait. |
| \`skill\` | no | Binds one installed skill; its instructions are added to the prompt. Body only (not on a \`uses:\` wrapper). | A skill that is not installed fails the stage before the agent starts. |
| \`mcp\` | no | List of MCP server names the stage may use. | Each server is a process or remote service; tools can act outside Stageflow. Connect failures or unset variables fail the stage at run time. |
| \`secrets\` | no | Host secret names the stage may receive (for example \`GITHUB_TOKEN\`, or \`{ name: NPM_TOKEN, as: env }\`), or console MCP secrets used only to fill MCP placeholders. | Every secret granted widens what the agent can do. Grant only what the step needs. |
| \`requires\` | no | \`[{ tool, version? }]\` binaries that must be on PATH. Checked before the run starts. | Stageflow never installs tools. |
| \`browser\` | no | A real browser session (\`profile\`, \`headed\`, \`allow_domains\`, \`login_url\`, \`check\`). Adds an \`agent-browser\` requirement. | The agent drives a logged-in browser. \`allow_domains\` is not enforced for profile stages. Sites may forbid automation. |
| \`channels\` | no | One send channel: \`connection\`, pinned \`to\`, \`operations: [send]\`. Gives the \`send_message\` tool. Body only. | Sends real messages. Only one channel per stage. Pi backend only. |
| \`timeout_ms\` | no | Wall-clock budget per attempt. Default 3600000 (60 minutes). | On timeout the attempt fails but the session is kept so a person can Resume. |

Pipeline-entry wiring (not body): \`route\`, \`entry\`, \`on_verify_fail\`, \`replay_safe\`, \`clone_cap\`, \`clone_mode\`. \`memories\` is pipeline-level only; a stage cannot list its own.

## Tools every stage has

\`emit_stage_envelope\` (ends the stage), \`write_stage_artifact\` (writes files to the attempt folder) and, when \`gate_kinds\` is non-empty, \`ask_operator\`. On Pi, stages also have the Pi coding agent's own file and shell tools (for example \`read\` and \`bash\`). With memories attached, Pi stages get \`read_memory\`, \`replace_memory\`, \`add_memory_card\`, \`update_memory_card\`, \`read_memory_card\`, \`search_memory_cards\`. With a channel, Pi stages get \`send_message\`.

## Stage environment

A stage never gets the Host's raw environment. It gets an allowlist (PATH, locale, proxy, \`STAGEFLOW_HOME\`, …) plus the secrets it declares. Provider API keys are never put in the stage environment; model auth goes through the Host's credential file.

## Backends

The default backend is Pi. The Claude backend (pipeline or manifest \`agent\`) does not provide \`send_message\` or the memory tools, so a stage with \`channels:\` or a pipeline with \`memories:\` fails at stage start there.

## Creating stages with tools

- \`create_stage\` adds a file-backed stage (\`uses: ./<id>.yaml\`) to a pipeline. If you pass no \`model\`, it writes the Host's current default model into the stage file. If you pass no \`io\`, it writes a minimal object/object \`io\`.
- \`edit_stage\` changes body fields (via \`patch\`, \`body\`, \`system_prompt\`, \`model\`, \`io\`) and/or the pipeline entry (\`route\`, \`entry\`, \`uses\`, \`pipeline_entry\`).
- \`create_stage_file\` writes a standalone stage file that is not wired into any pipeline (\`id\`, \`system_prompt\`, optional \`model\`, \`gate_kinds\`, \`skill\`).
- \`write_catalog_file\` overwrites an existing stage file; an invalid write is restored.
- Each pipeline tool validates and writes nothing when invalid, unless \`allow_invalid\` is set to build up step by step.

## Recovering a stage in a run

Retry (new attempt), Resume (same session, for interrupted or timed-out attempts), Abandon (stop a running stage), and for manual recovery Retry with guidance or Stop recovery. Tools: \`retry_stage\`, \`resume_stage\`, \`abandon_stage\`, \`recover_manual_stage\`, \`stop_manual_recovery\`.
`,
};
