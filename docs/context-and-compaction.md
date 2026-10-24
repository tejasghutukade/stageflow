---
layout: default
title: Context and compaction
---

# Context and compaction

A long stage or agent conversation can fill the model's context window. Stageflow keeps long Pi sessions working by controlling what enters the window, saving the model's own working state, and compacting old history when the window fills. Compaction is always on for Pi stages, project agents and the operator agent. There is no setting to turn it off.

The Claude backend (`agent: claude`) uses the Claude SDK's own auto-compaction, which Stageflow pins on.

## What keeps a session small

| Mechanism | What it does |
|-----------|--------------|
| Assignment in the system prompt | The task, prior envelopes and the envelope contract are in the system prompt, which compaction never rewrites. |
| Spilled tool output | A large result from any tool except `read` and `bash` is written to a stage artifact; the model sees a path and a preview. See [Large results](yaml-catalog.md). |
| Per-turn cap | `read` and `bash` results share a per-turn token cap. The first result of a turn always returns. Later ones in the same turn are replaced by a short notice, and the model repeats the call in a later turn. |
| `working_state` tool | The model keeps keyed entries (facts, decisions, progress, to-dos, blockers). They are saved with the session, survive resume, and are re-injected after every compaction. |
| Compaction | When the window fills, old messages become a structured summary. |

## What a compaction produces

The summary is written by the same model the stage or agent uses, with a prompt that asks for exact values, failures and dead ends, in-flight state and the next step. Stageflow then adds four deterministic sections:

- **Operator and user directives**: operator answers, rejected emits and user messages, copied verbatim (long filler prose ranks below instructions and short messages). They accumulate across compactions.
- **Pinned facts**: identifiers, numbers, timestamps, URLs, paths and error lines copied verbatim from tool results and operator messages. They accumulate across compactions and are bounded.
- **Cleared tool results**: an index of results replaced by placeholders, each with how to fetch it again.
- **Working state**: the current `working_state` entries.

If building the summary fails, Pi's default compaction runs instead.

## Cost and visibility

- The summarizer call counts toward the stage's usage and cost and toward an agent's `limits.cost_usd`, like any other model call. When a budget is spent, the same thing happens as for other work.
- The stage inspector shows a **Context** row (tokens used of the window). It falls after a compaction.
- The raw events list shows **Context compacted** with tokens before and after, summary size and cost.

## Privacy

The summarizer reads the same transcript the stage's model already read, through the same provider and credentials. Pinned facts, directives, cleared-result placeholders and `working_state` values are scrubbed of secrets before they are stored, and the whole summary is scrubbed again at the end. The scrubber can also remove harmless text that looks like a secret (for example `token_count=5`); when it changes a `working_state` value the tool says so. The full history stays in the session file on the Host.

## Writing stages that compact well

- Put rules that must hold exactly in `system_prompt`, not in a single early message.
- For long inputs, say how to read them: one large file per turn, and record what each one contributed with `working_state`.
- Ask for exact values from sources, not from memory.

## Not built

- No per-stage or per-agent switch for compaction.
- A project agent session that restarts from its transcript starts with an empty `working_state`.
- The Claude backend does not report context usage and has no `working_state` tool.

Contributors: see the "Context and compaction" rules in [AGENTS.md](../AGENTS.md) and the `examples/compaction-stress` pipeline, which exercises compaction end to end.
