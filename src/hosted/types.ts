import type { StageActivityEvent } from "../agent/activity.js";
import type { HostedErrorCode } from "./errors.js";

export const HOSTED_EVENT_SCHEMA_VERSION = 1 as const;

/** One sink call is attempted this many times. Delivery is at least once, not exactly once. */
export const HOSTED_DELIVERY_ATTEMPTS = 2;

/** Bound for a single sink call. The private sink and Cloud worker own further retries. */
export const DEFAULT_EVENT_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * After cancellation or timeout, Core waits at most this long for in-flight
 * stage work to stop. `StagePort` handles must stop inside `close()`.
 */
export const HOSTED_CANCEL_GRACE_MS = 5_000;

export type HostedRunContext = {
  /** Opaque Cloud run id. Core copies it and does not interpret it. */
  externalRunId: string;
  /** Opaque Cloud attempt id. Core copies it and does not interpret it. */
  externalAttemptId: string;
  /** Revision of the package Cloud already materialized. */
  packageRevision: string;
  /** Extra non-secret correlation strings. */
  attributes?: Readonly<Record<string, string>>;
};

export type HostedPipelineInput = {
  packageRoot: string;
  pipeline: string;
  taskYaml: string;
  context: HostedRunContext;
  signal?: AbortSignal;
  maxActiveStagesPerRun?: number;
  /** Wall-clock limit for the hosted run. Omit for no hosted-level limit. */
  timeoutMs?: number;
};

export type HostedExecutionReceipt = {
  coreVersion: string;
  eventSchemaVersion: typeof HOSTED_EVENT_SCHEMA_VERSION;
  packageRevision: string;
  executionMode: "inline";
  startedAt: string;
  finishedAt: string;
};

export type HostedPipelineResult = {
  /** Null when the run failed before Core created a local run. */
  runId: string | null;
  externalRunId: string;
  externalAttemptId: string;
  status: "succeeded" | "failed" | "cancelled" | "waiting";
  code?: HostedErrorCode;
  reason?: string;
  /** Present once a local run exists. Caller exports artifacts from here. */
  workspaceDir?: string;
  receipt: HostedExecutionReceipt;
};

export type HostedEventEnvelope = {
  schemaVersion: typeof HOSTED_EVENT_SCHEMA_VERSION;
  eventId: string;
  sequence: number;
  occurredAt: string;
  runId: string;
  externalRunId: string;
  externalAttemptId: string;
  packageRevision: string;
  attributes?: Readonly<Record<string, string>>;
};

export type HostedRunEvent = HostedEventEnvelope &
  (
    | { type: "run.created" }
    | { type: "run.started" }
    | { type: "stage.started"; stageId: string; attempt: number }
    | {
        type: "stage.activity";
        stageId: string;
        attempt: number;
        activity: StageActivityEvent;
      }
    | { type: "stage.waiting"; stageId: string; attempt: number }
    | { type: "stage.succeeded"; stageId: string; attempt: number }
    | {
        type: "stage.failed";
        stageId: string;
        attempt: number;
        reason?: string;
      }
    | { type: "run.succeeded"; receipt: HostedExecutionReceipt }
    | {
        type: "run.failed";
        code?: HostedErrorCode;
        reason?: string;
        receipt: HostedExecutionReceipt;
      }
    | {
        type: "run.cancelled";
        reason?: string;
        receipt: HostedExecutionReceipt;
      }
  );

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type HostedEventBody = DistributiveOmit<
  HostedRunEvent,
  keyof HostedEventEnvelope
>;

export interface HostedEventSink {
  onEvent(event: HostedRunEvent): Promise<void>;
}
