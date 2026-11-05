# Graders

How to decide what to measure, which grader checks it, and how each grader behaves. Read this before writing the `graders:` list.

## Contents

- Choose what to measure
- Which graders apply to which target
- Scoring in one paragraph
- `schema`
- `field`
- `reference`
- `code`
- `rubric`
- `tool_calls`
- `conversation_check`
- `goal_reached`
- Traps that make a grader pass or fail for the wrong reason

## Choose what to measure

Ask the user these before writing anything, and write down the answers as the eval's `description`:

1. What does a good output look like, in one sentence? What does a bad one look like?
2. What is the worst failure that must never happen? (This becomes a `must_pass` grader.)
3. Is there a right answer you can write down per case (a label, a list of facts, a number)? Use `reference`.
4. Is the shape or content checkable by a rule (required fields, ranges, forbidden words, a tool that must not be called)? Use `field`, `code`, `tool_calls` or `conversation_check`.
5. Is the quality a matter of judgment (tone, faithfulness, completeness)? Use `rubric`, or `goal_reached` for agents.

Order of preference: rules first (free, repeatable, no judge), judged graders second (cost money, add noise, need a key). Use one `must_pass` guard for the worst failure, two to four scored graders for the rest, and stay well under the limit of 20. A grader that cannot fail on any case measures nothing; a grader that fails on every case is probably wrong.

Quick map:

| You want to check | Grader |
|---|---|
| The stage returned a valid, successful envelope | `schema` (stage only) |
| A field exists, is in a set or range, matches a pattern | `field` |
| The output matches a per-case label or mentions per-case facts | `reference` |
| A rule that needs logic across fields or cases | `code` |
| Tone, faithfulness, completeness, helpfulness | `rubric` |
| The agent called, or did not call, specific tools; arguments; asked before acting | `tool_calls` (agent only) |
| Conversation length, one question at a time, shape of the last reply | `conversation_check` (agent only) |
| The agent achieved the scenario's goal | `goal_reached` (agent only) |

## Which graders apply to which target

| Type | Stage | Agent |
|---|---|---|
| `schema` | yes | no |
| `field`, `reference`, `code`, `rubric` | yes | yes |
| `tool_calls`, `conversation_check`, `goal_reached` | no | yes |

A grader on the wrong kind is `eval.grader_not_applicable`. There are no `command` or `groundedness` graders. A stage grader reads the envelope `{ status, summary, artifacts, payload }`. An agent grader reads the conversation: `messages`, `tool_calls`, `final_reply`, `turns`, `stop_reason`, `usage`.

Every grader has `id` (same pattern as the eval id, unique), `type`, optional `description` (up to 200 characters), `weight` (above 0, default 1) and `must_pass` (default false).

## Scoring in one paragraph

A result's score is the weighted mean of its graders' scores, leaving out `must_pass` graders and graders that errored. A result passes when no `must_pass` grader failed and the score is at least `pass_threshold`. A stage that failed, timed out or asked for input counts as a failed result. A grader that errors (`EVAL_JUDGE_ERROR`, `EVAL_GRADER_CODE_ERROR`, `EVAL_CASE_MISSING_EXPECTED`) is left out of the score rather than failing the result, so a run full of grader errors can look better than it is. Check `errored` in the run summary.

## `schema`

Passes when the envelope `status` is `success` and the payload validates against the stage's `io.output.schema`. The stage must declare one (`eval.schema_grader_without_output_schema`).

```yaml
- { id: output-schema, type: schema, must_pass: true }
```

## `field`

All checks must hold. Paths use dots, `[n]` and `[*]`. Operators: `exists`, `not_empty`, `equals`, `not_equals`, `contains`, `matches` (JavaScript regex), `gte`, `lte`, `between` (`[min, max]`), `in`, `length_gte`, `length_lte`.

```yaml
- id: severity-valid
  type: field
  checks:
    - { path: "payload.issues[*].severity", op: in, value: [high, medium, low] }
    - { path: payload.summary, op: length_lte, value: 300 }
```

With `[*]`, every matched node must pass. If `[*]` matches nothing (an empty array), `exists`, `not_empty` and every comparison fail; only `length_gte` and `length_lte` still run, on the empty array. So `payload.issues[*].severity in [...]` fails on a clean case whose `issues` is empty. Use a `code` grader or a tag-aware check for such cases.

On an agent target the paths start at the conversation: `final_reply`, `turns`, `stop_reason`, `messages[*].text`, `tool_calls[*].name`, `tool_calls[0].args.invoice_id`, `usage.cost_usd`.

## `reference`

Compares the output with the case's `expected`. `expected` is a path into the case (`expected.category`, `expected.mentions`). `path` is where to read in the output (default `payload` for stages, `final_reply` for agents).

```yaml
- id: category-matches
  type: reference
  weight: 3
  mode: equals
  path: payload.category
  expected: expected.category
- id: mentions-the-fact
  type: reference
  mode: each_mentioned
  expected: expected.mentions
```

- `equals`: deep equality.
- `each_mentioned`: the expected value is an array of strings; the score is the share found as substrings in the output text, ignoring case and extra whitespace. An empty array scores 1. `pass_at` (0 to 1, default 1) is the share needed to pass.
- A case with no value at the `expected` path yields an error grade (`EVAL_CASE_MISSING_EXPECTED`) that is excluded from the grader's statistics, and validation warns (`eval.cases_missing_expected`). Fix the dataset, not the grader.
- `each_mentioned` is literal. A correct answer worded differently fails (`expir` will not match "never ends"). Choose short, stable stems, or use a `rubric` for meaning.

## `code`

The body of a JavaScript function `(output, testCase, context)`. `output` is the envelope (or the conversation for agents), `testCase` is the case (`id`, `input`, `expected`, `tags`, ...; `tags` is always an array), `context` is `{ evalId, runId, repeat }`. Return a boolean, a number from 0 to 1 (passes at `pass_threshold`), or `{ pass, score?, reason? }`. An error, a bad return value or more than 5 seconds is an error grade (`EVAL_GRADER_CODE_ERROR`), not a failure.

```yaml
- id: urgent-flagged
  type: code
  weight: 2
  code: |
    return !testCase.tags.includes("urgent") || output.payload.urgency === "high";
- id: asks-before-refunding
  type: code
  code: |
    if (!testCase.tags.includes("refund")) return true;
    return output.tool_calls.every((c) => c.name !== "billing.refund" || c.policy_outcome === "would_ask_first");
```

- Use `code` to branch per case by tag, which no other grader can do. Guard the branch with a `return true` for cases it does not apply to, otherwise it fails them.
- Guard against missing fields (`output.payload?.issues ?? []`); a thrown TypeError becomes an error grade, which silently drops the grader from the score.
- `code` runs JavaScript on the user's machine with their permissions, the same trust level as `verify: command`. Do not copy code from untrusted places, and tell the user that is what they are approving when they run the eval.

## `rubric`

A judge model grades the output against your words. It needs a judge (`defaults.judge` or the grader's `judge`) from `anthropic`, `openai` or `openrouter`, with an API key (not OAuth).

```yaml
- id: summary-is-faithful
  type: rubric
  weight: 2
  rubric: |
    Pass if the summary is one sentence and every fact in it appears in the message.
    Fail if the summary adds a detail, a cause or a promise that the message does not contain.
  scale: pass_fail
  examples:
    - { verdict: pass, output: "Customer was charged 29 dollars twice on the 3rd and asks for one refund.", reason: "Every fact is in the message." }
    - { verdict: fail, output: "Customer was double charged because of a payment gateway bug.", reason: "The cause is invented." }
```

- `scale`: `pass_fail` (default) or `1_to_5` with `pass_at` (1 to 5, default 4). A 1-to-5 score is normalized to (v-1)/4 for statistics.
- `examples`: up to 6. `{ verdict: pass|fail, output, reason? }` for `pass_fail`; `{ score: 1-5, output, reason? }` for `1_to_5`. Add examples where the judge got a case wrong; they are the cheapest way to tighten a rubric.
- `judge_settings` (`temperature`, `reasoning`, `votes`) tune the call; see `eval-file-reference.md`. Votes multiply cost.
- The judge sees the rubric, the examples, the case input, the case `expected` if present, and the output. For agents it reads a bounded transcript (at most 30 turns, 2,000 characters per message, 500 for tool arguments and 500 for tool results). A reply that is not JSON, or a provider error, is `EVAL_JUDGE_ERROR`, left out of the score.

Writing a rubric that works:

1. State one criterion per rubric. "Accurate and concise and polite" is three graders.
2. Write the pass condition and the fail condition in observable terms ("every file named exists in the diff"), not feelings ("good quality").
3. Prefer `pass_fail` over `1_to_5`. Scores of 3 are noise.
4. Use a judge that is not the model under test. A same-model judge warns (`eval.judge_same_as_stage`) and favors its own style.
5. Pin the judge to a dated model id. Floating ids warn (`eval.judge_unpinned`).
6. A rubric is only as good as its agreement with the user. Offer to check the judge against the user's labels (`../SKILL.md#7-calibrate-the-judge`) once a run has failures worth labeling. Never label results yourself.

Judge providers are checked when a run starts, not by `sf eval validate`: an `eval.judge_unknown_model` warning is the only offline signal that a judge is wrong, and a judge from another provider passes validation then fails at run start with `EVAL_INVALID` ("supported judge providers are ..."). Check the provider prefix yourself.

## `tool_calls`

Agent only. Reads the recorded tool calls. Passes when every rule holds; score is 1 or 0.

```yaml
- id: no-forbidden-tools
  type: tool_calls
  must_pass: true
  must_call: []
- id: looks-up-the-invoice
  type: tool_calls
  must_call: [billing.lookup_invoice]
  max_calls: 3
  args:
    - { tool: billing.lookup_invoice, path: invoice_id, op: matches, value: "^INV-[0-9]+$" }
- id: asks-before-refunding
  type: tool_calls
  must_ask_first: [billing.refund]
```

| Key | Meaning |
|---|---|
| `must_call` | Each tool must be called at least once. |
| `must_not_call` | None of these may be called. |
| `must_ask_first` | Each must appear as `would_ask_first`: the agent tried something that needs approval. |
| `max_calls` | At most this many calls in total (0 to 200). |
| `args` | Up to 20 of `{ tool, path, op, value? }`. Checks the arguments of every call to that tool. A tool never called passes vacuously, so pair `args` with `must_call`. |

- A call counts as called whatever its outcome. A `write` the agent attempted and that was stubbed still breaks `must_not_call: [write]`.
- A trailing `.*` matches a server prefix (`billing.*`).
- When `must_call` or `must_not_call` is absent, the grader falls back to the case's `expected.tools` and `expected.forbidden_tools`. Write `[]` to opt out of the one you do not want. That is why `must_call: []` appears above: the grader enforces only the per-case `forbidden_tools`.
- A grader with no rule at all, on cases with no `expected.tools` or `expected.forbidden_tools`, is an error grade (`EVAL_CASE_MISSING_EXPECTED`) on every case, and validation warns (`eval.cases_missing_expected`).
- `must_ask_first` applies to every case the grader sees, so cases that never touch that tool fail. Use it in an eval whose cases all exercise the approval, or use a tag-branching `code` grader (above) to scope it.
- Naming a tool the agent is not granted in a grader warns (`eval.tool_not_granted`). To assert that an ungranted tool is never attempted, put it in a case's `expected.forbidden_tools` instead.
- Tool ids: built-ins by name (`read`, `write`, `edit`, `bash`), MCP as `server.tool`, Stageflow tools as `stageflow.<tool>`, sub-agents as `agent:<id>`.

## `conversation_check`

Agent only. Deterministic checks of the conversation's shape. At least one key is required.

```yaml
- id: short-conversations
  type: conversation_check
  max_turns: 4
- id: one-question-per-turn
  type: conversation_check
  max_agent_questions_per_turn: 1
- id: reply-names-the-address
  type: conversation_check
  final_reply:
    - { op: contains, value: "it-desk@" }
```

- `max_turns` (1 to 100) counts user turns. Do not confuse it with `conversation.max_turns`, which stops the scenario.
- `max_agent_questions_per_turn` (0 to 10) counts a `?` followed by a space or the end of the text, outside code fences and URLs.
- `final_reply` is up to 10 `{ op, value? }` checks (the `field` operators) applied to the last assistant message.

## `goal_reached`

Agent only. A judge reads the conversation and decides whether the agent achieved the scenario's goal (`input.goal`, else `expected.outcome`). It does not trust the simulator's own "done" signal. Pass or fail only; `scale` is not allowed. Optional `judge`, `judge_settings` and `guidance` (up to 2,000 characters).

```yaml
- id: reaches-the-goal
  type: goal_reached
  weight: 3
  guidance: The agent must give the information the user needs, or decline when the request is out of scope.
```

Cases need a goal or an outcome, otherwise `eval.cases_missing_goal` warns. Use `guidance` to say what counts as success when declining is correct.

## Traps that make a grader pass or fail for the wrong reason

| Trap | Effect | Fix |
|---|---|---|
| Only `schema` and `field` graders on a stage that must be right | Everything well-formed passes | Add a `reference` or `rubric` grader for correctness |
| No negative cases | A stage that always flags problems passes | Add clean inputs with `expected` that says "nothing to flag" |
| `tool_calls` omits `must_call` or `must_not_call` | The omitted key is filled from the case: missing `must_call` requires `expected.tools`; missing `must_not_call` requires `expected.forbidden_tools`. Setting only `must_not_call` still pulls in `expected.tools` | Write `must_call: []` to ignore `expected.tools`, or `must_not_call: []` to ignore `expected.forbidden_tools` |
| `[*]` check on an empty array | Fails clean cases | Branch in a `code` grader |
| `each_mentioned` with long phrases | Fails correct paraphrases | Use short stems or a rubric |
| Code grader that throws on a missing field | Grader silently drops out of the score | Guard with `?.` and defaults; check `errored` |
| Judge equals the model under test | Self-preference bias | Use another provider's model |
| Many errored grades | The pass rate looks fine because errors are excluded | Report `errored` next to the pass rate and fix the cause |
| Vague rubric ("is it good?") | Noisy verdicts, low agreement with the user | Observable pass and fail conditions, examples, calibration |
| One grader dominates by weight | The score moves with one check | Keep weights close; use `must_pass` for hard rules |
