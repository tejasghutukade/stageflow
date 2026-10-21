# compliance-review-demo

A demo of a Stageflow pipeline built for unattended, scheduled compliance
checking. A SOC2-style bucket public-access check is the working example —
the point is the *pattern*: connect, poll, check, map to a control, log
evidence, publish a report, safe to run on a cron schedule with nobody
watching. It runs against a real AWS S3 bucket, a real GCS bucket, or a
simulated fixture, whichever `poll-bucket-config` finds available.

Verified end to end against a real GCS bucket — see [Verified against real
infra](#verified-against-real-infra) below for the actual run data.

## What this demonstrates

- **Never blocks, still tells the difference.** `review-verdict.yaml` reads
  the checked-in evidence log and compares this run's verdict to the last
  one recorded for the same check. A first-time failure or a repeat result
  gets `reviewer: "auto"`. A flip (FAIL → PASS or back) gets
  `reviewer: "unreviewed-flip"` instead — same non-blocking success either
  way, so nothing about a schedule or a CI runner can get this stage stuck
  waiting on a person. The distinction lives in the evidence, not in a gate.
- **State that persists across runs.** `store-evidence.yaml` appends to a
  checkout file (`data/evidence-log.json`, gitignored — see below) instead
  of a per-attempt artifact, so `review-verdict` can compare "this run"
  against "last run" days or weeks apart. `store-evidence.yaml` carries an
  after-phase `verify` check (`type: checkout_changes`,
  `path_fields: [changed_files]`) so the stage can't succeed without a real
  edit to that file.
- **One report stage, swappable target.** `publish-report.yaml` writes a
  markdown timeline as a stage artifact today. Point that same stage at a
  Confluence or Notion API instead and nothing upstream of it changes —
  the other six stages don't know or care where the report ends up.

Full design writeup (why this exists instead of just running Prowler in a
GitHub Action, or self-hosting an existing open-source tool like Comp AI):
see the project conversation this came from.

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
```

Use the `stageflow-run` job to build a task with a payload like
`{ "bucket": "customer-uploads", "scenario": "fail" }`, or point `sf run`
at it directly:

```bash
sf run \
  --pipeline examples/compliance-review-demo/compliance-review-demo.pipeline.yaml \
  --task <path> \
  --json
```

Never pauses, so it's safe to call from a non-interactive runner — a
nightly GitHub Action, a Cloud Scheduler → Cloud Run job, an EventBridge
Scheduler → Fargate task, or any cron.

## Verified against real infra

This pipeline has actually been run, twice, against a live GCS bucket, via
a Stageflow MCP host on a different checkout than the pipeline files
themselves (`task.checkout` pointed it at this worktree). Real, unrounded
per-stage cost from that first run:

| Stage | Cost (USD) |
|---|---|
| connect-account | $0.0213894 |
| poll-bucket-config | $0.0505455 |
| run-compliance-check | $0.0361527 |
| review-verdict | $0.0325805 |
| map-to-control | $0.0246600 |
| store-evidence | $0.0451638 |
| publish-report | $0.0480890 |
| **Total** | **$0.2585808** |

Run 1: bucket had `public_access_prevention: inherited`,
`uniform_bucket_level_access: false` → verdict `FAIL`, `reviewer: "auto"`
(first observation, nothing to flip against). The bucket was then actually
hardened (`gcloud storage buckets update --uniform-bucket-level-access`,
`--pap`) and reverted afterward. Run 2 against the hardened bucket: verdict
`PASS`, `reviewer: "unreviewed-flip"` — logged as a flip worth a human's
attention, without the run ever pausing to ask for one.

## Data directory is gitignored

`data/evidence-log.json` is runtime output written by `store-evidence`, not
source, and in practice ends up referencing whatever real bucket and
project someone tested against. It's gitignored on purpose — don't remove
that `.gitignore` to "fix" an empty `data/` directory after a fresh clone;
the file is created on first run.
