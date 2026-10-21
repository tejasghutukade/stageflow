---
layout: default
title: Console - Overview
---

# Overview

`#/overview` is the console's control center: what needs you, what is running, whether the system is healthy, and how runs have gone lately. It sits above the [Inbox](console-inbox.md) in the rail. The Inbox stays the home page and the place you answer things; Overview gives you the whole picture first.

Like Runs and the Inbox, it covers **every project** on the machine, because the run store is global. See [Data directory](data-directory.md).

## What it shows

| Section | What it shows | Source |
|---------|---------------|--------|
| **Headline** | "N things need you", plus runs in flight and runs that failed in the last hour | Run catalog |
| **Needs you** | Pipeline gates and agent approvals, longest waiting first, then failed runs. **Accept** / **Reject** answer an agent approval in place; **Retry** retries a failed run's stage. A gate opens its run, because answering needs the evidence. | `GET /api/runs`, `GET /api/agents/approvals` |
| **System health** | Agent slots (running, held by a gate, free), providers, connections that need attention, triggers armed, run store size and free disk | `GET /api/health`, `GET /api/connections`, `GET /api/triggers` |
| **KPIs** | Runs, success rate, longest waiting on you, pipeline spend. Runs, success rate and spend compare with the previous window of the same length | `GET /api/overview` |
| **Live now** | Runs in flight with their stage track and elapsed time, then running or waiting agent sessions with their 7-day turn stats | Run catalog, `GET /api/agents/sessions` |
| **Activity** | Recent finished runs and trigger fires | Run catalog, `GET /api/triggers` |
| **Runs by outcome** | Succeeded, failed and cancelled runs per bucket | `GET /api/overview` |
| **Pipelines** | Per pipeline in the window: runs, success rate, median time of finished runs, cost, last run. Pipelines under 70% success (two or more finished runs) are tagged **flaky** | `GET /api/overview` |
| **Triggers**, **Connections** | Next fire or last fire per trigger; channels and email accounts with their last check | `GET /api/triggers`, `GET /api/connections` |

The **24h / 7d / 30d** control changes the KPIs, chart and pipeline table. It is remembered for the browser session. The page refreshes about every 15 seconds while the tab is visible; the run catalog refreshes more often.

A section whose API fails shows what it can and the rest stays live.

## Definitions

- **Success rate** = succeeded / (succeeded + failed). Cancelled runs count as neither. It is "—" until a run has finished.
- **Window**: runs counted by the time they were created. Buckets are rolling segments ending now: 24h is 8 buckets of 3 hours, 7d is 7 days, 30d is 10 buckets of 3 days.
- **Spend** is the sum of each stage attempt's `cost_usd`. A run whose provider reports no cost adds nothing.
- **Longest waiting on you** is the oldest gate or agent approval in Needs you.

## `GET /api/overview`

Query: `range` is `24h`, `7d` (default) or `30d`; anything else is `400` with `code: "invalid_range"`.

```json
{
  "range": "7d",
  "generated_at": "2026-10-17T12:00:00.000Z",
  "since": "2026-10-10T12:00:00.000Z",
  "totals":   { "runs": 48, "succeeded": 39, "failed": 4, "cancelled": 1, "in_flight": 4, "finished": 43, "success_rate": 0.907, "cost_usd": 18.4 },
  "previous": { "runs": 40, "succeeded": 31, "failed": 6, "cancelled": 0, "in_flight": 3, "finished": 37, "success_rate": 0.838, "cost_usd": 16.3 },
  "buckets":  [{ "start": "2026-10-10T12:00:00.000Z", "succeeded": 3, "failed": 0, "cancelled": 0 }],
  "pipelines": [{ "pipeline_id": "feature-ship", "runs": 19, "succeeded": 18, "failed": 1, "cancelled": 0, "success_rate": 0.947, "median_duration_ms": 860000, "cost_usd": 6.8, "last_run_at": "2026-10-17T11:54:00.000Z" }]
}
```

It reads one light row per run (id, pipeline, status, timestamps, summed cost) and aggregates in memory; it does not load stages. It needs the same access as `GET /api/runs`.

## Not on the page

Median gate wait time, a global event feed and mailbox sign-in health are not shown: the run store does not keep them in a form the page can read cheaply.
