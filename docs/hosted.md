# Hosted runtime

Added in Stageflow **0.33.0**. Pin `stageflow@0.33.0`. The execution receipt reports that version as `coreVersion`.

Stageflow can run one repository-free pipeline inside another application. The caller supplies the agent, the local run store, and an event sink. Stageflow runs the pipeline inline, in this process, and reports ordered progress through the sink.

This is the public contract for a private host such as Stageflow Cloud. Stageflow does not talk to Supabase, Modal, OpenRouter, or a job queue. The host builds those adapters and passes them in.

## Start a run

```ts
import { createHostedRuntime, createRunStore } from "stageflow";

const runtime = createHostedRuntime({
  agent, // host-built AgentPort; Stageflow does not read API keys
  localStore: createRunStore({ rootDir: sandboxWorkspace }),
  eventSink, // host-built HostedEventSink
  eventDeliveryTimeoutMs: 10_000, // optional; default is 10 seconds
});

const result = await runtime.run({
  packageRoot, // directory Cloud already materialized
  pipeline: "smoke.pipeline.yaml",
  taskYaml,
  context: {
    externalRunId,
    externalAttemptId,
    packageRevision,
    attributes: { workspace_id: workspaceId },
  },
  signal,
  timeoutMs, // optional wall-clock limit for this run
  maxActiveStagesPerRun, // optional
});
```

`result.status` is `succeeded`, `failed`, or `cancelled`. `result.workspaceDir` is the local run directory. The host copies artifacts out of it and then deletes the sandbox. Stageflow does not delete that directory and does not close the agent, store, or sink.

`result.receipt` records the Stageflow version, event schema version (`1`), package revision, `executionMode: "inline"`, and start and finish times.

## What is returned and what is thrown

Pipeline outcomes are returned:

| Situation | `status` | `code` |
|---|---|---|
| Pipeline finished | `succeeded` | omitted |
| Agent or stage failed | `failed` | `agent_failed` |
| `timeoutMs` elapsed | `failed` | `timed_out` |
| Host aborted `signal` | `cancelled` | `cancelled` |
| Stage asked for human approval | `failed` | `hitl_unsupported` |

`hitl_unsupported` means this hosted entry point will not park the run. A `waiting` status is reserved and is not returned. Do not destroy the sandbox and expect to resume an approval later. Existing local HITL behavior outside this API is unchanged.

These failures are thrown as `HostedRuntimeError` and have no local `runId`:

- `invalid_input` — task YAML, context, limits, a repository or checkout binding, credentials in `attributes`, or a store placed inside the package directory
- `package_invalid` — missing package directory, bad pipeline, or a pipeline/stage path whose real path leaves the package (symlinks included)

`event_sink_failed` is also thrown. `error.localResult` is present when a local run exists, including when the pipeline itself succeeded but the final event was rejected. Core does not emit a second terminal event after that rejection.

If validation fails before a local run is created, `error.runId` is omitted and `localResult` is absent.

## Events

`HostedEventSink.onEvent` receives one event at a time. Core waits for each call before it sends the next event, including when stages run concurrently. Each event has `schemaVersion`, `eventId`, `sequence`, `occurredAt`, the local `runId` (empty if the run was cancelled before it was created), the external ids, and `packageRevision`.

`eventId` is `${externalAttemptId}:${sequence}`. A retry of the same delivery uses the same id. The host should upsert on `eventId`. This is at-least-once delivery.

Core tries each delivery twice (`HOSTED_DELIVERY_ATTEMPTS`). Each try is bounded by `eventDeliveryTimeoutMs` (default `DEFAULT_EVENT_DELIVERY_TIMEOUT_MS`, 10 seconds). A sink that never returns fails the run with `event_sink_failed` instead of blocking cancellation. Further retries belong to the host.

Terminal events are `run.succeeded`, `run.failed`, and `run.cancelled`. There is one of them per attempt.

## Cancellation

Aborting `signal` stops new stages, closes stage handles Core opened, and returns `cancelled` unless a terminal outcome was already chosen. `timeoutMs` uses the same stop path and returns `failed` / `timed_out`.

After the stop signal, Core waits up to `HOSTED_CANCEL_GRACE_MS` (5 seconds) for the local run to finish. `close()` on a stage handle must stop that agent’s work. Returning from the hosted call does not by itself cancel an agent that ignores `close()`.

## Credentials and package files

Pass an already constructed `AgentPort`. Do not put API keys in task YAML, pipeline YAML, events, or `attributes`. Event text is passed through Stageflow’s existing secret redaction before it reaches the sink.

Core does not create `~/.stageflow` for a hosted run. It binds stage roots at `STAGEFLOW_AGENT_AUTH_PATH` when that variable is set, and otherwise at `hosted-agent-auth.json` next to the local store. A custom agent can ignore that path. An adapter that reads a Pi auth file must be pointed at a file the host already created.

The package directory is read-only input. The local store and run workspace must be outside that directory. Cloud downloads the package, checks its integrity, and passes `packageRevision`. Stageflow does not.

## Inline execution only

The hosted API always runs stages inline (`executionMode: "inline"`). It ignores `STAGEFLOW_STAGE_EXECUTION`. Hosted child-process workers are not part of this contract. Local process mode outside `createHostedRuntime` is unchanged.

## What the host still owns

Queueing, leases, the sandbox, model credentials, durable storage, artifact upload, and shutdown stay in the host. This package only runs the pipeline and reports what happened.
