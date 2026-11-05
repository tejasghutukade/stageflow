# Failure sorting

After a run, a classifier can suggest why each failed result failed. The suggestion is a proposal. Accepting it is what writes tags. Nothing sorts when a run finishes, and nothing is tagged because a sort happened.

Sorting calls a model and costs money. That cost is `triage_cost_usd` on the sort result. It is not part of the run's `max_cost_usd`. Confirm the spend with the user before `sf eval sort`. Reading suggestions is free.

## Contents

- What gets sorted
- Buckets and failure types
- Classifiers
- Credentials
- What is sent
- Accepting and dismissing
- Commands

## What gets sorted

`sf eval sort <evalRunId>` sorts executed results that did not pass (`completed` failures, `stage_failed`, `needs_input`, and `error`). Skipped and cancelled results are not sorted. A run that is still `queued` or `running` fails `EVAL_RUN_ACTIVE`.

Each suggestion has:

| Field | Meaning |
|---|---|
| `bucket` | `agent_wrong`, `grader_wrong`, `case_wrong`, or `unclear` |
| `failure_type` | One of the fixed types below, or null |
| `confidence` | 0 to 1, for the bucket |
| `bucket_probabilities` | The classifier's distribution over the four buckets |
| `grader_false_alarms` | For each failing `code` or `rubric` grader, the probability that its failure is a false alarm |
| `source` | `jev` or `judge` |
| `model` | The model id that answered, stored on the suggestion |
| `status` | `pending`, `accepted`, or `dismissed` |

`sf eval suggestions <evalRunId> --json` returns `items` and a `summary`. The summary's counts (`by_bucket`, `by_type`, `pending`, `accepted`, `dismissed`, `low_confidence`) are computed by the server. Quote `summary`. Do not tally the items yourself. `low_confidence` is a bucket of `unclear` or a confidence below 0.7, and it counts suggestions that are not dismissed.

| Bucket | Meaning | What to tell the user |
|---|---|---|
| `agent_wrong` | A careful person would say the stage or agent did something wrong | Change the stage or the agent |
| `grader_wrong` | The output was fine and a grader failed it | Change the grader |
| `case_wrong` | The case or its expected values are wrong or ambiguous | Change the dataset |
| `unclear` | Not enough to choose | Read that result |

`agent_wrong` is the bucket name for both stage and agent targets. For a stage eval it means the stage.

## Buckets and failure types

Failure types are fixed. They are not YAML.

Agent targets: `missing_tool_call`, `unneeded_tool_call`, `wrong_or_missing_fact`, `policy_violation`, `tone`, `ungrounded_claim`, `off_topic`, `no_handoff`, `other`.

Stage targets: `wrong_value`, `missing_field`, `schema_invalid`, `policy_violation`, `ungrounded_claim`, `tone`, `other`.

A type is a label for people. It does not change the score.

## Classifiers

`--classifier` is `auto` (the default), `jev`, or `judge`.

| Classifier | What it calls | When `auto` picks it |
|---|---|---|
| `jev` | TypeSafe Jev, model `jev-1.13.0` (never `jev-latest`), at $0.042 per million input tokens. The model id is stored on every suggestion | A TypeSafe key is available |
| `judge` | The run's judge model, one call per result, through the same one-shot path as the agent simulator. Needs a judge on the run and a Host that can make a model call | No TypeSafe key, and the run has a judge |

If the chosen classifier cannot run, the command fails `EVAL_CLASSIFIER_UNAVAILABLE` with `missing` of `typesafe_key` or `judge_model`. `auto` fails that way when neither is available. Do not fall through to a third option.

Jev does not explain itself and always picks an answer, which is why `unclear` is a real choice and why confidence decides what to trust.

By default, results that already have a suggestion from that classifier are skipped. `--resort` re-sorts pending suggestions only. Accepted and dismissed suggestions are never replaced. `--limit` caps how many results are sent (default 200, max 1000).

## Credentials

The TypeSafe key is resolved in this order. The first one set is the one that is used:

1. The stored provider credential `typesafe` (Settings, Providers, TypeSafe).
2. `STAGEFLOW_PROVIDER_TYPESAFE_API_KEY`
3. `TYPESAFE_API_KEY`
4. `JEV_API_KEY`

The key is never logged, never returned, never put in an error, and never written into a suggestion. `GET /api/eval-runs/:id/failures/status` (and the sort status the tools return) lists only the **names** of the sources that hold a key, for example `stored:typesafe` or `JEV_API_KEY`. If the user needs a key, tell them where to set one. Do not ask them to paste it into the chat, and do not echo a value you happen to see in the environment.

## What is sent

Each result is sent as one JSON document of at most 24,000 characters. Secrets are redacted before it is capped, and truncation is recorded on the suggestion. The document contains the case title, tags, input, and expected value; the output (for an agent, the transcript and tool calls with policy outcomes); each failed grader with its reason and definition; and the ids of the graders that passed. Say this to the user before the first sort: the case and the output go to Jev (`https://api.typesafe.ai`) or to the judge's provider.

## Accepting and dismissing

Accepting a pending suggestion writes tags onto that result through the same review path as a hand review:

- the failure type, when it has one
- `bucket:<bucket>` (for example `bucket:grader_wrong`)

Tags already on the result are kept. Tags are only stored on results that failed. A suggestion for a result that no longer counts as failed is not tagged (`EVAL_TAGS_ON_PASSED_RESULT`); that suggestion stays pending.

There is no `sf eval accept`. Accepting and dismissing are MCP or HTTP, and they do not call a model. Do not call them until the user has named the suggestions, or has asked for a bulk accept.

| Action | How |
|---|---|
| Accept specific rows | MCP `accept_eval_failure_suggestions` with `ids`, or `POST /api/eval-runs/:id/failures/suggestions/accept` with `{ "ids": [...] }` |
| Bulk accept | Omit `ids`. Pending suggestions at or above `min_confidence` (default 0.7) are accepted. `unclear` is excluded. Optional `bucket` limits the bulk to one bucket |
| Dismiss | MCP `dismiss_eval_failure_suggestions` with `ids` (required), or `POST .../failures/suggestions/dismiss` |

Passing `ids` can accept an `unclear` or low-confidence row, because the confidence filter applies only to the bulk path. Do not bulk-accept, and do not pass ids the user did not choose.

Dismissing hides the suggestion and writes no tags. Sorting again will not replace an accepted or dismissed row.

After an accept, the failure-type card on the run counts the new tags. Those tags are the user's review. They are not fed back into the judge.

## Commands

```bash
sf eval sort <evalRunId> --json
sf eval sort <evalRunId> --classifier judge --limit 50 --json
sf eval sort <evalRunId> --resort --json
sf eval suggestions <evalRunId> --json
sf eval suggestions <evalRunId> --status pending --json
```

`--status` is `pending`, `accepted`, or `dismissed`. The human sort output ends by telling you to review before accepting. Do that. Show the user the bucket counts from `summary`, name the low-confidence rows, and wait.
