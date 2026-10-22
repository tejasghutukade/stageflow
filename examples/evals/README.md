# Sample evals

Two samples live here. The critique sample evaluates a stage; the support sample evaluates an agent. Both run without a judge model.

# Critique sample eval (stage)

A small eval that checks whether a `critique` stage finds planted problems in short draft specifications. It uses no rubric graders, so it needs no judge model and runs with any provider.

## What it shows

- `eval-sample.pipeline.yaml`: one inline stage, `critique`, with input and output schemas.
- `critique-sample.dataset.jsonl`: 8 cases. Six have a planted problem; two (tagged `no-issue`) are clean and should produce no issues.
- `critique-sample.eval.yaml`: four graders.
  - `output-schema` (schema, must pass): the output matches the stage's output schema.
  - `valid-verdict` (field): the verdict is `ok` or `needs_work`.
  - `finds-expected-issues` (reference): each expected keyword appears in the reported issues.
  - `no-false-alarms` (code): clean drafts get no issues. Runs JavaScript on your machine with your permissions.
- `critique-sample.task.yaml`: a normal task, so `sf run` works on the pipeline too.

## Run it

From the repository root:

```bash
sf validate --strict
sf eval engine install
sf eval run critique-sample
```

Or open the operator console (`sf ui`) and use "Try the sample eval", which copies the pipeline, eval and dataset into your project.

The sample stage has no `model:`, so set a default `model` in your project's `stageflow.yaml` first, or the pipeline does not load (`eval.target_unresolved`). Running the eval calls your configured model for each case and repeat (8 cases x 2 repeats). `max_cost_usd: 1` caps the spend.

## What to expect

Some failures are normal. The stage prompt is short and the reference grader looks for keywords such as `expir` or `backoff`, so a correct finding worded differently can fail. Read the failing cases, then tighten the prompt or the expected keywords.

## Add a rubric grader

Rubric graders ask a judge model to grade the output against your text. Set a judge and add a grader:

```yaml
defaults:
  judge: anthropic/claude-sonnet-4-5
graders:
  - id: issues-are-concrete
    type: rubric
    weight: 2
    rubric: |
      Pass if every reported issue names a specific missing or conflicting detail in the draft.
      Fail if an issue is generic advice.
```

Pick a judge that is not the stage's model to avoid self-preference bias. Rubric graders send each case's input and the stage output to the judge's provider.

# Support sample eval (agent)

A small eval that checks whether a support agent answers from a few facts in its instructions, asks one question at a time, declines what is out of scope and stays away from tools it should not use. The conversations are scripted (`script` mode), so there is no simulated user and no judge model.

## What it shows

- `support-sample.agent.yaml`: an agent, `support_sample`, with the read-only `read` tool group and four product facts in its instructions. Agents are created disabled, so installing the sample enables it for you (see below to do it by hand).
- `support-sample.dataset.jsonl`: 6 scenarios, each a list of user messages in `input.script`.
  - `s001`, `s002`: fact questions (plan limit, refund window).
  - `s003`: a vague request; the agent should ask one clarifying question.
  - `s004`: tempts the agent to save a file; `write`, `edit` and `bash` are forbidden.
  - `s005`: legal advice, which the agent should decline.
  - `s006`: asks about a project file; the agent should call `read`.
- `support-sample.eval.yaml`: `conversation: { mode: script, max_turns: 4, tools: read_only, approvals: record_only }` and five graders.
  - `no-forbidden-tools` (tool_calls, must pass): none of the case's `expected.forbidden_tools` was called, counting stubbed attempts.
  - `reads-files-when-asked` (tool_calls): the case's `expected.tools` were called.
  - `replies-in-time` (conversation_check): at most 4 user turns.
  - `one-question-per-turn` (conversation_check): no agent reply asks more than one question.
  - `mentions-the-fact` (reference): the final reply mentions each string in `expected.mentions`.

The agent has read-only tools and nothing that asks first, so the sample is safe even if you change the eval to `tools: real`.

## Run it

The agent resolves from the project's `agents/` directory, so the files must be in a project first. Either install it through a running Host with `POST /api/evals/sample` and `{ "kind": "agent" }` (it writes the agent through the agent service, enables it, and copies the eval and dataset into your `evals/` and `datasets/` folders), or copy the three files into your project by hand:

```bash
cp examples/evals/support-sample.agent.yaml  your-project/agents/support_sample.agent.yaml
cp examples/evals/support-sample.dataset.jsonl your-project/datasets/
cp examples/evals/support-sample.eval.yaml   your-project/evals/
```

The eval's `dataset:` path is `./support-sample.dataset.jsonl`; when you copy by hand into different folders, fix it (for example `../datasets/support-sample.dataset.jsonl`). A hand-copied agent starts disabled, which is fine for evals (a warning, `eval.agent_disabled`); enable it with `sf agents enable support_sample` or on its page if you also want to chat with it.

Then, from the project:

```bash
sf validate --strict
sf eval engine install
sf eval run support-sample
```

The install step needs a default `model` in `stageflow.yaml` and fails with `SAMPLE_NO_DEFAULT_MODEL` without one. Running the eval calls that model for every turn: 6 scenarios x 2 repeats, 1 to 2 turns each. `max_cost_usd: 1` caps the spend.

## What to expect

Most conversations should pass. Some failures are normal: the reference grader looks for exact strings (`14 days`, `billing@notely.example`), and a model that says "two weeks" fails `s002`. `s006` expects a `read` call, and the project may not have a `README.md`; the call still counts. Read the failing transcripts in the console before changing the agent or the strings.

## Make it a simulated eval

Scripts are deterministic and cheap. To let a model play the user, set the mode and a user model, give each scenario a persona, a goal and an opening, and add a judged grader:

```yaml
defaults:
  judge: anthropic/claude-sonnet-4-5
  user_model: anthropic/claude-sonnet-4-5
conversation:
  mode: simulated
graders:
  - id: reaches-the-goal
    type: goal_reached
```

```json
{"id":"s101","title":"Refund","input":{"mode":"simulated","persona":"Polite, brief.","goal":"Find out how to get a refund.","opening":"Hi, I want my money back.","facts":["bought Pro last week"]},"expected":{"outcome":"told to email billing within 14 days"}}
```

A simulator model and the judge read the conversation, so the run costs more and varies more between repeats. See [Evals for agents](../../docs/evals.md#evals-for-agents).
