# Stage prompt template

Every external stage file has `id` and `system_prompt`. Filename stem matches `id`. `model` is optional when the pipeline or `stageflow.yaml` supplies it — otherwise set it on the stage. Default when writing a concrete string is `anthropic/claude-sonnet-4-5`. When the human names a different model, write that string verbatim. Before writing models, confirm at least one provider is `configured` (see the skill Provider gate). Sibling stages after a fork should use the same configured model family unless the human asks otherwise.

## Base

Use for every stage that is not a review point and does not decide a branch.

```yaml
id: <id>
system_prompt: |
  <one-line goal for this step>

  Write any output this step produces via write_stage_artifact.

  When finished, call emit_stage_envelope exactly once with status, summary,
  artifacts, and a payload the next stage can use. Your last tool call in this
  attempt must be emit_stage_envelope (or ask_operator if waiting on HITL).
  An empty final message is a stage failure.
model: anthropic/claude-sonnet-4-5
```

The prompt has no `ask_operator` line. It ends on the `emit_stage_envelope` instruction. Call `emit_stage_envelope` once per attempt.

When the pipeline entry will carry after-phase `verify` with `type: artifact`, add this line after the goal:

```
Required files must be created with write_stage_artifact. Checkout write/edit
does not satisfy after-phase verify.
```

When the stage must change the project checkout (implement, patch, edit source), add:

```
Success requires real checkout edits. Put checkout-relative paths in
payload.changed_files. Do not put stages/.../artifacts paths there. A report
or map alone is a failure emit, not success.
```

When the deliverable is throwaway checkout content instead of a stage artifact:

```
Write the deliverable with builtin write at <checkout-relative path>.
Set artifacts: [] on emit. Put that path in payload.<field>.
```

## Summary and payload

Add to every stage (base, gated, or fork):

```
summary and payload are handed to the next stage verbatim. State outcomes and
artifact pointers only. Do not repeat this stage's prohibitions in summary —
downstream will obey them literally.
```

When `io.output.schema` is on the stage file, name the required fields in the prompt so the emit matches.

## Gated

When the step is a review, approval, or sign-off, add `gate_kinds` and resolve the gate before emit. Match this sequence: `write_stage_artifact` → `ask_operator` → `emit_stage_envelope` on accept.

```yaml
id: <id>
gate_kinds:
  - artifact_backed
system_prompt: |
  <one-line goal>. Get operator acceptance before completing this stage.

  1. Write the reviewable output via write_stage_artifact.
  2. Call ask_operator with kind artifact_backed referencing that artifact path
     (stage artifact path, not a checkout path).
  3. On reject or change text: revise the artifact and call ask_operator again
     with artifact_backed in this same stage. Do not complete yet.
  4. Call emit_stage_envelope with an advancing success status only after the
     operator accepts. Never emit before accept.
model: anthropic/claude-sonnet-4-5
```

Use the `gate_kinds` value that matches the human's review: `artifact_backed` for a file to accept, `confirm` for yes/no, `free_text` for an open reply, `multi_question` for a batch. `ask_operator` does not complete the stage.

When the gated stage also publishes or opens a PR after accept, append:

```
After the operator accepts, immediately finish publish side effects in this
same attempt (commit, push, open PR as required), write any final artifact,
then emit. Do not pause after accept. Do not ask_operator for emit/schema errors.
```

## Fork

When the pipeline entry has `fork`, the success emit names immediate successors in `fork_choice`. Add this block to the base (or gated) prompt:

```
On a success emit, include fork_choice naming immediate successor id(s) that
should run. Name only ids listed as this stage's children. select: one →
exactly one id. select: subset → one or more of those ids.
Normalize free_text answers before mapping (trim, lowercase, collapse spaces
and hyphens). If unmapped, ask_operator again; do not emit.
```

`fork_choice` on a failure emit is ignored. Leave `clone_forks` unset unless the human explicitly asked for clonable fan-out (see [`catalog-mapping.md`](catalog-mapping.md)).

## Clonable parent

When a successor is `clonable: true`, the parent success emit uses `clone_forks` (not `fork_choice`) for that successor. Add:

```
On success, include clone_forks covering every clonable successor exactly once.
Each clone entry is a full envelope with status, summary, artifacts, and payload
matching that successor's io.input.schema — not a stub object.
```

Clonable child stages use the base (or gated) prompt. Remind them they are one clone among others and must emit independently.
