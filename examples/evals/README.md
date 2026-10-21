# Critique sample eval

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
