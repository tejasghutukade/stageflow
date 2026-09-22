# compliance-review-demo

A demo of Stageflow's human-in-the-loop orchestration. A SOC2-style bucket
public-access check is the working example — the point is the *pattern*, not
compliance coverage: automated checks that only interrupt a person when
something actually needs their judgment. It runs against a real AWS S3
bucket, a real GCS bucket, or a simulated fixture, whichever `poll-bucket-config`
finds available.

## What this demonstrates

- **A gate that skips itself.** `review-verdict.yaml` carries
  `gate_kinds: [confirm]`, but it only calls `ask_operator` when this run's
  verdict differs from the last one recorded for the same check — a
  first-time failure or a repeat result is auto-approved with no human
  involved. A flip (especially FAIL → PASS) pauses for a real yes/no.
- **State that persists across runs.** `store-evidence.yaml` appends to a
  checkout file (`data/evidence-log.json`) instead of a per-attempt
  artifact, so `review-verdict` can compare "this run" against "last run"
  days or weeks apart. `store-evidence.yaml` carries an after-phase `verify`
  check (`type: checkout_changes`, `path_fields: [changed_files]`) so the
  stage can't succeed without a real edit to that file.
- **A reject with nowhere to loop back to.** If the operator rejects a
  flip, `review-verdict` emits a failure instead of re-asking — there's no
  address-feedback stage, because the "fix" happens in AWS itself, outside
  the pipeline, not in another LLM stage.

Full design writeup (why this exists instead of just running Prowler in a
GitHub Action, or self-hosting an existing open-source tool like Comp AI):
see the project conversation this came from.

## Two pipelines, one stage swapped

| | `compliance-review-demo.pipeline.yaml` | `compliance-review-ci.pipeline.yaml` |
|---|---|---|
| Stage 4 | `review-verdict.yaml` | `review-verdict-ci.yaml` |
| On a flip | pauses, calls `ask_operator` | never calls it — records the flip and keeps going |
| `gate_kinds` | `[confirm]` | none |
| `reviewer` on a flip | whoever answers the gate | `"ci-unreviewed-flip"` |
| Can hang waiting on a person | yes, by design | never |

Everything else — `connect-account`, `poll-bucket-config`,
`run-compliance-check`, `map-to-control`, `store-evidence`,
`publish-report` — is the literal same file, `uses:`-referenced from both
pipelines. Only the review stage changes; the CI variant still writes the
same evidence log, so a flip that happened unattended is visible in that
log's `reviewer` field even though nobody was asked at the time.

Use the interactive pipeline when a person should be in the loop. Use the
CI pipeline in an unattended runner (GitHub Actions, a cron job) where
there's no one to answer a gate — a run that hit a flip and needs a human's
eyes lands in the evidence log, not in a stuck pipeline.

## Prerequisites

- Node.js ≥ 20, Stageflow installed (`npm i -g stageflow`)
- A configured provider (`sf providers status`; at least one row
  `configured`)
- No cloud account needed — without a working `gcloud` or `aws` CLI on
  PATH, `poll-bucket-config` simulates the check instead, clearly labeled
  as simulated.

### Testing against a real bucket

`poll-bucket-config` tries `gcloud` first, then `aws`, then falls back to
simulated. To point it at a real bucket:

- **GCS**: have `gcloud` authenticated (`gcloud auth list` shows an active
  account) and pass that bucket's bare name (no `gs://`) as `bucket` in the
  task input. It reads `public_access_prevention` and
  `uniform_bucket_level_access` from `gcloud storage buckets describe`, and
  checks `gcloud storage buckets get-iam-policy` for any `allUsers` /
  `allAuthenticatedUsers` binding. `scenario` is ignored in this path — the
  bucket's real state decides the verdict, so to see a flip you need to
  actually change the bucket's settings between runs (e.g. toggle uniform
  bucket-level access), not just change `scenario`.
- **AWS S3**: have `aws` authenticated and pass the bucket name; it calls
  `aws s3api get-public-access-block` directly, same field names.

The four fields it maps to (`block_public_acls`, `ignore_public_acls`,
`block_public_policy`, `restrict_public_buckets`) are cloud-agnostic — for
GCS they're a translation, not a literal setting name, and the stage writes
both the raw `gcloud` fields and the translated ones to its artifact so the
mapping is never hidden.

## Commands

From the **repository git root**:

```bash
sf validate --pipeline examples/compliance-review-demo/compliance-review-demo.pipeline.yaml --strict
sf validate --pipeline examples/compliance-review-demo/compliance-review-ci.pipeline.yaml --strict
```

To run the interactive pipeline, use the `stageflow-run` job to build a task
with a payload like `{ "bucket": "customer-uploads", "scenario": "fail" }`,
run it once, then run it again with `"scenario": "fixed"` — the second run
is the one that should pause for review. Use `sf ui` to watch a run and
answer the `review-verdict` gate when it pauses.

To run the CI pipeline the same way, point `sf run` at
`compliance-review-ci.pipeline.yaml` instead — it takes the same task shape
and never pauses, so it's safe to call from a non-interactive runner
(`sf run --pipeline examples/compliance-review-demo/compliance-review-ci.pipeline.yaml --task <path> --json`).
