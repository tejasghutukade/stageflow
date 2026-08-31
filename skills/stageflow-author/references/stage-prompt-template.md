# Stage prompt template

Every external stage file has `id`, `system_prompt`, and `model`. Filename stem matches `id`. Default `model` is `anthropic/claude-sonnet-4-5`. When the human names a different model, write that string verbatim.

## Base

Use for every stage that is not a review point and does not decide a branch.

```yaml
id: <id>
system_prompt: |
  <one-line goal for this step>

  Write any output this step produces via write_stage_artifact.

  When finished, call emit_stage_envelope exactly once with status, summary,
  artifacts, and a payload the next stage can use.
model: anthropic/claude-sonnet-4-5
```

The prompt has no `ask_operator` line. It ends on the `emit_stage_envelope` instruction. Call `emit_stage_envelope` once per attempt.

## Gated

When the step is a review, approval, or sign-off, add `gate_kinds` and resolve the gate before emit. Match this sequence: `write_stage_artifact` → `ask_operator` → `emit_stage_envelope` on accept.

```yaml
id: <id>
gate_kinds:
  - artifact_backed
system_prompt: |
  <one-line goal>. Get operator acceptance before completing this stage.

  1. Write the reviewable output via write_stage_artifact.
  2. Call ask_operator with kind artifact_backed referencing that artifact path.
  3. On reject or change text: revise the artifact and call ask_operator again
     with artifact_backed in this same stage. Do not complete yet.
  4. Call emit_stage_envelope with an advancing success status only after the
     operator accepts. Never emit before accept.
model: anthropic/claude-sonnet-4-5
```

Use the `gate_kinds` value that matches the human's review: `artifact_backed` for a file to accept, `confirm` for yes/no, `free_text` for an open reply, `multi_question` for a batch. `ask_operator` does not complete the stage.

## Fork

When the pipeline entry has `fork`, the success emit names immediate successors in `fork_choice`. Add this block to the base (or gated) prompt:

```
On a success emit, include fork_choice naming immediate successor id(s) that
should run. Name only ids listed as this stage's children. select: one →
exactly one id. select: subset → one or more of those ids.
```

`fork_choice` on a failure emit is ignored. Leave `clone_forks` unset.
