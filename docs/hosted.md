# Hosted runtime

Added in Stageflow **0.33.0**. Pin `stageflow@0.33.0`. The execution receipt reports that version as `coreVersion`.

Stageflow can run one repository-free pipeline inside another application. The caller supplies the agent, the local run store, and an event sink. Stageflow runs the pipeline inline, in this process, and reports ordered progress through the sink.

This is the public contract for a private host such as Stageflow Cloud. The host supplies queueing, the sandbox, and durable storage. Model calls go through the existing Pi agent, not a second adapter.

## Start a run

```ts
import {
  configurePiProviderApiKey,
  createHostedRuntime,
  createPiStagePort,
  createRunStore,
} from "stageflow";
import path from "node:path";

const authPath = path.join(sandboxWorkspace, "hosted-agent-auth.json");
await configurePiProviderApiKey({
  authPath,
  providerId: "openrouter",
  apiKey, // sandbox secret; never put this in task YAML or events
});
process.env.STAGEFLOW_AGENT_AUTH_PATH = authPath;

const runtime = createHostedRuntime({
  agent: createPiStagePort(),
  localStore: createRunStore({ rootDir: sandboxWorkspace }),
  eventSink,
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

Aborting `signal` stops new stages, closes stage handles Core opened, and returns `cancelled` unless a terminal outcome was already chosen. An abort during package, store, or skill validation is the same outcome: one `run.cancelled` event, no local run, and no stage start. `timeoutMs` uses the same stop path and returns `failed` / `timed_out`.

After the stop signal, Core waits up to `HOSTED_CANCEL_GRACE_MS` (5 seconds) for the local run to finish. `close()` on a stage handle must stop that agent’s work. Returning from the hosted call does not by itself cancel an agent that ignores `close()`.

## Credentials and package files

`createPiStagePort()` returns the existing Pi `StagePort` (`PiAgentAdapter`). Hosted runs do not define another agent interface. Call `configurePiProviderApiKey` first to store a managed OpenRouter key in a Pi auth file, then set `STAGEFLOW_AGENT_AUTH_PATH` to that file before `runtime.run`. The key stays out of task YAML, pipeline YAML, events, and `attributes`. Event text still passes through Stageflow’s existing secret redaction.

Core does not create `~/.stageflow` for a hosted run. Without `STAGEFLOW_AGENT_AUTH_PATH`, stage roots point at `hosted-agent-auth.json` next to the local store. Tests can pass any other `StagePort`; production hosted runs use the Pi one.

The package directory is read-only input. The local store and run workspace must be outside that directory. Cloud downloads the package, checks its integrity, and passes `packageRevision`. Stageflow does not.

Custom skills ship inside the package at `.pi/skills/<name>/SKILL.md`. Core copies those files into the run workspace and passes that copy to the existing Pi skill resolver. The catalog for the run is an empty directory next to the local store, so skills installed in the operator home are not visible. A skill symlink whose real path leaves the package is `package_invalid`.

## Inline execution only

The hosted API always runs stages inline (`executionMode: "inline"`). It ignores `STAGEFLOW_STAGE_EXECUTION`. Hosted child-process workers are not part of this contract. Local process mode outside `createHostedRuntime` is unchanged.

## What the host still owns

Queueing, leases, the sandbox, model credentials, durable storage, artifact upload, and shutdown stay in the host. This package only runs the pipeline and reports what happened.
