# Design playbook

How to get from a person's description to a good pipeline: what to ask, what to default, where to cut stages, and the mistakes that cost hours at run time.

## Contents

- [Interview](#interview)
- [Defaults](#defaults)
- [Stage boundaries](#stage-boundaries)
- [Choosing gates](#choosing-gates)
- [Choosing proof and recovery](#choosing-proof-and-recovery)
- [Models, independence and time](#models-independence-and-time)
- [Anti-patterns](#anti-patterns)

## Interview

Ask only what changes the draft, one question per turn. Add a second question only when both block the next edit and do not depend on each other. Mirror the person's words, refer back to what was decided, and drop an assumption the moment they correct it.

Good: "A release that waits for review, or one that publishes as soon as checks pass?"
Bad: a paragraph of pipeline theory, a numbered plan and three questions at once.

Question bank, by what the answer changes:

| Group | Ask when unclear |
|---|---|
| Steps | "Is finding the problem and fixing it one step, or should someone see the findings first?" "Does drafting include research, or is research its own step?" |
| Wiring | "Do these two happen at the same time or one after the other?" "What decides whether it ships or goes to hotfix?" "If review finds problems, does it go back to the writer or to a separate fix step?" |
| Goal and input | "What changes from one run to the next: a topic, a ticket, a repository?" That becomes the task `input` and the entry stage's `io.input.schema`. |
| Gates | "Who signs off, and should nothing go out until they do?" "Is it a yes or no, a file to accept, or an open answer?" |
| Side effects | "Does the last step send, publish, push or pay for anything?" Those stages get manual recovery and often a gate. |
| Capabilities | "Does a step need a logged-in website, a messaging channel, an MCP server, or a credential?" |

When the request is already specific, skip the interview and edit. When the person asks for a plan first, give a short one, then build.

## Defaults

Default these and say what you assumed in the same message as the edit:

| Decision | Default |
|---|---|
| Ids | Kebab case from the person's step names. |
| Order | Linear, in the order described. |
| Model | The pipeline or manifest model already set; otherwise a configured provider's model; otherwise `CHANGE_ME/<provider-model>`. |
| Directory | Beside the person's existing pipelines, or `pipelines/<pipeline-id>/` under a catalog root. |
| Contracts | Child input `{ type: object }` unless the child needs named fields. |
| Gates | None unless the person mentioned a sign-off or the stage has irreversible side effects. |
| Recovery | `repair` with `max_attempts: 2` for stages with an idempotent after check; `manual` with `side_effecting` for publish, push, send. |
| Independence | Unset (persistent). |
| Timeout | Unset (one hour), raised for long builds or suites. |

## Stage boundaries

A stage is one fresh agent session that ends with one emit. Cut a new stage when:

- The work has two separately checkable outcomes.
- A later part needs a different gate, model, skill, credential set, browser profile or channel.
- A `verify` applies to only part of the work (`checkout_changes` on implement but not on plan).
- A person reviews in between.
- Exploration and implementation would otherwise share a session. An exploration-only stage emits findings; an implementation stage must change something.
- Review and fixing would otherwise share a session. Review reports `verdict` and `blocking_findings`; a fix stage or a loop handles them.

Do not split when the parts share all context and are checked together; every split adds a handoff that has to be typed.

## Choosing gates

- No gate: the step is reversible and nobody asked to see it.
- Advisory (`gate_kinds` only): the stage may need a clarification but can proceed without one. Typical: `free_text` for clarifying questions.
- Load-bearing (`gate_kinds` plus `verify` `type: gate`): nothing should advance without a person. Typical: `artifact_backed` to accept a plan or draft, `confirm` before an irreversible action.
- Put the gate in the stage that produces what is reviewed, so revisions happen in the same session.

## Choosing proof and recovery

| Stage produces | Proof |
|---|---|
| A document or report the next stage needs | Name it in the prompt; add `artifact` `when: [after]` only when the file must exist for the pipeline to make sense. |
| Code or file edits | `checkout_changes` with a required `changed_files` string array. |
| Something tests or linters can check | `command`, cheap checks first, slow suites last or in their own stage. |
| A process with required steps | `checklist`. |
| A sign-off | `gate`. |

Recovery: `repair` re-runs the stage with the failed checks in context; use it for idempotent work. `manual` waits for a person; use it with `retry_safety: side_effecting` for anything that may already have had an effect.

## Models, independence and time

- One model on the pipeline. Override per stage only for a reason (a cheaper model for collection, a stronger one for review or publishing).
- Siblings after a fan-out use the same model family unless the person asks otherwise.
- Leave `independence` unset unless the person wants stages to give up quickly (`strict`) or to try alternative approaches when one fails (`open`).
- Set `timeout_ms` above the slowest expected attempt for builds, test suites and long browsing.

## Anti-patterns

Each row comes from runs that failed after hours of real work.

| Always | How |
|---|---|
| End every attempt on a tool call | The prompt's last instruction: call `emit_stage_envelope`, or `ask_operator` while waiting. |
| Never emit before a person accepts | Load-bearing gate plus the write, ask, revise, emit sequence. |
| Hand files over through artifacts | `write_stage_artifact`, list the returned path in `artifacts`; never pass `stages/<id>/attempts/...` host paths or `/workspace/work` files. |
| Make implementation stages change the checkout | `checkout_changes` plus required `changed_files`. |
| Hand the next stage clean envelopes | `summary` and `payload` carry outcomes and pointers only; name required output fields in the prompt. |
| Give review blockers somewhere to land | review, address-feedback, approve; or a loop. |
| Bind success to the whole checklist | If a plan lists N commands, success needs all N. Use `command` or `checklist` checks, not prompt promises. |
| Finish side effects in the accepting attempt | After accept: push, open the pull request, write the record, emit. |
| Declare credentials | `secrets:` on the stage; stages never see the Host environment. |
| Keep one browser profile per site | Check, login and work stages share `profile` and the same `check`. |
| Build per-item work as a Clone Chain | Never `clonable` or `clone_forks`. |
| Add after-phase artifact checks only where needed | Not on every stage. |
| Use kebab-case ids | `sf validate` does not check. The console create APIs and MCP `create_stage_file` and `create_task_file` reject other ids. `create_pipeline`, `create_stage` and `create_task` do not. |
