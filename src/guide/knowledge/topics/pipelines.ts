import type { GuideKnowledgeTopic } from "../index.js";

export const pipelinesTopic: GuideKnowledgeTopic = {
  id: "pipelines",
  title: "Pipelines: wiring, contracts, checks, gates and envelopes",
  summary:
    "Pipeline YAML, route/entry wiring and DAG rules, io schemas between stages, verify and on_verify_fail, feedback loops, clone chains, HITL gates, envelopes and artifacts, and validation.",
  body: `# Pipelines

A pipeline file is \`<id>.pipeline.yaml\`. Required: \`id\` (should match the file name) and \`stages\` (a non-empty list of objects). Optional top level: \`model\` (default model for stages), \`agent\` (backend: \`pi\` or Claude), \`schemas\` (named JSON Schemas for \`$ref\`), \`browser\`, \`requires\` (tools on PATH), \`channels\` (default channel inherited by every stage), \`memories\` (memory ids every stage gets), \`include\` (merge stage lists from fragment files).

## Where Guide saves them

Every pipeline the Guide creates is \`pipelines/<id>/<id>.pipeline.yaml\`. Stage files for that pipeline (\`uses: ./<stage>.yaml\`) go in the same \`pipelines/<id>/\` folder. A folder the person names is input for a stage to read, not a place to write these files. The host writes them under \`pipelines/<id>\` even when a tool call passes another directory. Leave \`project_root\` unset. An existing pipeline is edited at the path already on disk.

## Stage entries

Each entry is either inline (\`system_prompt\`, \`io\`, …) or \`uses: ./stage.yaml\` (path relative to the pipeline file). On a \`uses:\` wrapper you may add only wiring (\`route\`, \`entry\`, \`on_verify_fail\`, \`replay_safe\`, and for a clone emitter \`clone_cap\`/\`clone_mode\`) plus \`mcp\`, \`secrets\`, \`requires\`, \`browser\`. Any other body key beside \`uses:\` fails (\`pipeline.stage_uses_inline_conflict\`). \`skill\` and \`channels\` are body-only.

## Wiring: \`route\` and \`entry\`

Wiring lives on the **source** stage. \`needs\`, \`fork\`, \`feedback_loop\` (top level), \`route_select\` and \`allow_none\` are rejected with a hard error. Do not write them.

\`\`\`yaml
stages:
  - id: clarify
    uses: ./clarify.yaml
    entry: true
    route:
      - to: research
      - to: validation
  - id: research
    uses: ./research.yaml
    route:
      - to: synthesize
  - id: validation
    uses: ./validation.yaml
    route:
      - to: synthesize
  - id: synthesize
    uses: ./synthesize.yaml
\`\`\`

- Mark at least one root \`entry: true\`.
- Several \`to:\` entries fan out; every listed target stays on the graph and runs after the source succeeds. The agent does not pick which ones run.
- \`if\` on a route entry skips that target unless a condition on the source's output payload holds. Leaf: \`{ field, op, value }\`; composition: \`all\`, \`any\`, \`not\`. Operators: \`eq\`, \`ne\`, \`gt\`, \`gte\`, \`lt\`, \`lte\`, \`in\`, \`not_in\`. The \`field\` path must be a **required** property in the source \`io.output.schema\` (no arrays, no optional fields). There is no \`exists\` operator and no else branch. Bad \`if\` is \`pipeline.route_if_invalid\`.
- \`on:\` (\`succeeded\`, \`failed\`, \`skipped\`) only stops skip-cascade. Write \`succeeded\`, not \`success\` (envelope status). It does **not** launch a stage after a failure. A child always needs a succeeded parent. For branching, use \`if\` on a succeeded payload.
- A stage with two or more parents is a **join**. It waits until every parent is finished, runs if at least one succeeded, stays pending (run fails) if any parent failed, and is skipped if all parents skipped. It receives every succeeded parent's envelope.
- Cycles and backward edges are \`pipeline.dag_error\`. Going back is only possible with a loop entry.

## Contracts: \`io\`

Every stage body must have \`io.input.schema\` and \`io.output.schema\` (both required; missing is \`stage.invalid_io\`). The root must be \`type: object\`. Supported: \`object\`, \`string\`, \`number\`, \`integer\`, \`boolean\`, \`array\`, with \`properties\`, \`required\`, \`items\`, \`additionalProperties\` (boolean), \`minItems\`, \`maxItems\`, \`enum\`, \`minimum\`, \`maximum\`, \`pattern\`, \`minLength\`, \`maxLength\`, \`nullable\` on nested nodes. On each edge the child's input schema must be a structural subset of the parent's output schema, or load fails with \`pipeline.io_incompatible\`. The entry stage's input is matched against the task's \`input\` (missing \`input\` counts as \`{}\`).

## Checks: \`verify\` and \`on_verify_fail\`

\`verify\` is one list on the stage body. Each item has \`id\`, \`type\`, and \`when\` (\`[emit]\`, \`[after]\` or both).
- Emit-phase (soft, in the same session; the agent can fix and retry): \`gate\` (the last \`ask_operator\` exchange of that kind this attempt must be accepted), \`artifact\` with \`basename\` (the name must be in the envelope's artifacts list).
- After-phase (Stageflow checks after the agent claims success): \`command\` (runs \`bash -c\`, needs exit 0), \`artifact\` with \`path\` and optional \`nonempty\`, \`checklist\` (agent attestation, not proof), \`payload_schema\`, \`checkout_changes\` (the checkout really changed), \`browser_login\`.
- Defaults: \`gate\` is emit; \`command\`, \`checklist\`, \`payload_schema\`, \`checkout_changes\` are after; \`artifact\` must set \`when\`.

\`on_verify_fail\` sits on the pipeline entry and needs at least one after-phase check:
- \`mode: repair\` with \`max_attempts\`, \`retry_safety: idempotent\`, \`include_failed_checks\` starts fresh attempts automatically.
- \`mode: manual\` with \`retry_safety\` leaves the stage failed until a person chooses Retry with guidance or Stop recovery. Use manual for anything with side effects (publishing, payments, sending).

## Feedback loops

A \`route\` entry \`{ type: loop, to, max_replays, on_max_replays, replay_session }\` lets a later stage send work back to an earlier ancestor. \`on_max_replays\` is \`require_continue\` or \`wait_for_human\` (a person decides extend / continue / abandon). \`replay_session\` is \`resume\` or \`new_session\`. One loop entry per stage, no \`if\` on it. Mark one-shot stages \`replay_safe: false\`; a loop whose path crosses one fails validation. The source must emit \`feedback_loop: { action: continue }\` or \`{ action: send_back, target }\` on success.

## Clone chain (one run per list item)

Emitter → clone child → join. The emitter's output has exactly one array property whose items are \`{ $ref: "#/schemas/<Name>" }\`; the child's whole input schema is that same \`$ref\`. The emitter entry needs \`clone_cap\` (≥ 1) and \`clone_mode\` (\`parallel\` or \`sequential\`). An empty array or more items than the cap fails the emitter's emit; gate the zero-item case earlier. Every clone must succeed for the join to run. \`clonable\`, \`clone_actions\` and \`clone_forks\` are rejected.

## Questions to a person (HITL)

A stage with a non-empty \`gate_kinds\` list (\`free_text\`, \`confirm\`, \`multi_question\`, \`artifact_backed\`) gets the \`ask_operator\` tool. Omitted or \`[]\` means no tool. The run waits until a person answers in the Inbox or the run page. To make the approval binding, add a \`verify\` item \`{ type: gate, kind: ... }\`; otherwise the agent could emit success without waiting.

## Envelopes and artifacts

A stage ends only when the agent calls \`emit_stage_envelope\` with \`status\` (\`success\`/\`failure\`), a non-empty \`summary\`, \`artifacts\` (list, may be empty) and \`payload\` (validated against \`io.output.schema\` on success). Files are written with \`write_stage_artifact\` under the attempt's artifacts folder. If the agent stops without emitting, Stageflow sends up to two reminders, then fails the stage (\`missing emit_stage_envelope\`). A \`failure\` envelope skip-cascades single-parent children.

## Validation

\`validate\` (tool) or \`sf validate\` checks shape, \`uses:\` paths, wiring, \`io\` compatibility, verify rules, model resolution, MCP names, channels and memories. It does not check provider keys, env vars or a live MCP connection; those fail at run start.
`,
};
