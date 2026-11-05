# Stage prompt template

How to write a stage's `system_prompt` so the stage does its one job and ends cleanly. Stageflow already tells every stage how its tools work and what its output schema is; the prompt carries the goal, the inputs to use, the output fields by name, any gate sequence, and the closing instruction.

## Contents

- [What every prompt contains](#what-every-prompt-contains)
- [Base stage](#base-stage)
- [Add-on blocks](#add-on-blocks)
- [Gated stage](#gated-stage)
- [Branch source](#branch-source)
- [Loop source](#loop-source)
- [Clone Chain stages](#clone-chain-stages)
- [Capability notes](#capability-notes)

## What every prompt contains

1. One or two sentences on the goal of this step, in the person's domain words.
2. Where the inputs are: the previous stage's payload fields by name, the task goal and input, granted artifacts.
3. What success requires, and what to do instead when it cannot be reached (emit `failure` with the blocker in `summary`).
4. The required `io.output.schema` fields by name, so the emit matches.
5. The closing instruction: call `emit_stage_envelope` once with `status`, `summary`, `artifacts` and `payload`; the last tool call of the attempt must be `emit_stage_envelope`, or `ask_operator` while waiting for a person.

Do not repeat this stage's prohibitions in instructions about `summary`: the next stage reads `summary` and `payload` verbatim and will obey them literally.

## Base stage

```yaml
id: summarize
system_prompt: |
  Summarize the sources in payload.sources into a short digest for the topic in
  the task input. Keep only claims a source supports.

  Write the digest with write_stage_artifact as digest.md.

  summary and payload are handed to the next stage verbatim. State outcomes and
  artifact pointers only.

  When finished, call emit_stage_envelope once with status, summary, artifacts
  (listing digest.md), and a payload with headline (one sentence). Your last
  tool call in this attempt must be emit_stage_envelope.
io:
  input:
    schema:
      type: object
      required: [sources]
      properties:
        sources:
          type: array
          items: { type: string }
  output:
    schema:
      type: object
      required: [headline]
      properties:
        headline: { type: string }
```

Omit `model` when the pipeline or `stageflow.yaml` sets one.

## Add-on blocks

Append the block that matches the stage's `verify` or deliverable.

**Required file** (after-phase `artifact` check):

```
Create the required files with write_stage_artifact. Editing files in the
checkout does not satisfy this stage's file check.
```

**Implementation** (`checkout_changes` check with `path_fields: [changed_files]`):

```
Success requires real edits in the checkout. Put every checkout-relative path
you changed in payload.changed_files. Do not put stages/.../artifacts paths
there. A report or plan alone is a failure emit, not success.
```

**Command check** (`type: command`): Stageflow runs the command after the emit. Tell the stage what will be checked so it can prepare, and not to claim it ran the check:

```
After you emit, Stageflow runs the project's test command. Make the change pass
it. Do not report test results you did not observe.
```

**Checklist** (`type: checklist`): name the exact item strings and ask for `checklist_attestations: [{ check_id: <verify id>, items: [...] }]` in the envelope.

**Throwaway checkout deliverable** (a scratch file meant to stay in the checkout):

```
Write the deliverable with the write tool at <checkout-relative path>. Emit
with artifacts: [] and put that path in payload.<field>.
```

**Side effects after approval** (publish, push, open a pull request):

```
After the operator accepts, finish the side effects in this same attempt
(commit, push, open the pull request), write the final record with
write_stage_artifact, then emit. Do not pause after accept. Fix emit or schema
errors by emitting again; do not ask the operator about them.
```

## Gated stage

For a review, approval or sign-off. Pair `gate_kinds` with a `gate` check so the gate is load-bearing.

```yaml
id: review
gate_kinds:
  - artifact_backed
system_prompt: |
  Prepare the draft in the prior payload for publication and get the
  operator's acceptance before completing this stage.

  1. Write the reviewable draft with write_stage_artifact as review.md.
  2. Call ask_operator with kind artifact_backed and the run-relative path
     write_stage_artifact returned.
  3. On reject or requested changes, revise review.md and call ask_operator
     again in this same stage. Do not complete yet.
  4. Only after the operator accepts, call emit_stage_envelope with status
     success and artifacts listing review.md. Never emit before accept.
io:
  input: { schema: { type: object } }
  output: { schema: { type: object } }
verify:
  - id: accepted
    type: gate
    kind: artifact_backed
```

Pick the kind that matches the person's review: `artifact_backed` for a file to accept, `confirm` for yes or no, `free_text` for an open reply, `multi_question` for several questions at once.

## Branch source

When the stage's `route` uses `if`, it must emit the discriminator.

```
On success, set payload.<field> to one of <values>. Stageflow uses it to pick
the next stage; do not name the next stage yourself.
```

The field must be `required` in `io.output.schema`, ideally an `enum` or `boolean`.

## Loop source

When the stage's `route` has a `{ type: loop }` entry:

```
On success, include feedback_loop: { action: continue } to move on, or
feedback_loop: { action: send_back, target: <ancestor id> } with each blocking
finding listed in payload.blocking_findings to send the work back.
```

The replayed stage sees the feedback in a Feedback Loop Context block; its prompt should say to fix every blocking finding there first.

## Clone Chain stages

Emitter:

```
On success, put the list in payload.<array field>, 1 to <clone_cap> entries.
Stageflow starts one run of the next stage per entry.
```

Clone child:

```
Your input is one list entry. Do the work for that entry only, and emit a
payload that matches the output schema.
```

Join:

```
You receive every item's success envelope in list order. Combine them.
```

## Capability notes

- **Sandbox.** When the Host runs stages in containers, earlier stages' files are granted read-only at `/workspace/grants/<stage-id>/...`, the checkout is `/workspace/checkout`, and `/workspace/work` is scratch. Tell consumers to read granted paths or payload fields, never `stages/<id>/attempts/...` host paths. The stage assignment lists the grants, so a prompt can say "read the plan granted from the plan stage".
- **Browser work stage.** Say what to do on a login page or a blocked page: stop and emit `failure`; for a blocked page the `summary` must begin with `site blocked this browser:`. Never try to get around a bot check. Keep work read-only unless a gate precedes an irreversible click. See [capabilities.md](capabilities.md#browser-stages).
- **Channel stage.** Tell the stage to call `send_message` once with the message body, after any gate. It cannot choose recipients; they are fixed in YAML. See [capabilities.md](capabilities.md#channels).
- **Memories.** Name the memory and what to read or record: `read_memory`, `search_memory_cards`, `read_memory_card` to read; `add_memory_card`, `update_memory_card`, `replace_memory` to write. See [capabilities.md](capabilities.md#memories).
- **Stage MCP.** Name the server's tools the stage should use and for what. Large tool results are saved as stage artifacts automatically; tell the stage to read or grep that file rather than copy it.
- **Independence.** Do not add "an empty reply fails the stage" lines. With the default `persistent` independence a quiet turn gets a reminder to keep working; the closing emit instruction is enough.
