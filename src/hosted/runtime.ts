import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, realpath } from "node:fs/promises";
import type { StageLogLine } from "../agent/activity.js";
import type { StagePort, StageHandle, StageHandleEvent } from "../agent/port.js";
import { loadPipelineValidated } from "../config/validateCatalog.js";
import { loadTaskFromYaml } from "../config/loadTask.js";
import { redactString } from "../logging/redact.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import type { RunStore } from "../runstore/port.js";
import {
  PipelinePreflightError,
  PipelineValidationError,
  startPipeline,
  type PipelineRunResult,
} from "../runtime/pipelineRunner.js";
import { runWithExplicitAuthPath } from "../runtime/credentialBinding.js";
import type { OperatorCatalog } from "../runtime/stageAttemptBootstrap.js";
import type { SkillsPayload } from "../runtime/runSkills.js";
import { loadPackageSkills } from "./packageSkills.js";
import {
  containedRealPath,
  isContained,
  resolveDirectory,
} from "./containment.js";
import { HostedRuntimeError, type HostedErrorCode } from "./errors.js";
import { HostedEventSequencer } from "./sequencer.js";
import { translateStageEvent } from "./translate.js";
import {
  DEFAULT_EVENT_DELIVERY_TIMEOUT_MS,
  HOSTED_CANCEL_GRACE_MS,
  HOSTED_DELIVERY_ATTEMPTS,
  HOSTED_EVENT_SCHEMA_VERSION,
  type HostedEventSink,
  type HostedExecutionReceipt,
  type HostedPipelineInput,
  type HostedPipelineResult,
  type HostedRunContext,
} from "./types.js";

const HOSTED_EXECUTION_MODE = "inprocess" as const;

type Decision =
  | { status: "succeeded" }
  | { status: "failed"; code: HostedErrorCode; reason?: string }
  | { status: "cancelled"; reason?: string }
  | { status: "waiting"; code: "hitl_unsupported"; reason: string };

export type HostedRuntime = {
  run(input: HostedPipelineInput): Promise<HostedPipelineResult>;
};

export function createHostedRuntime(dependencies: {
  agent: StagePort;
  localStore: RunStore;
  eventSink: HostedEventSink;
  eventDeliveryTimeoutMs?: number;
}): HostedRuntime {
  const timeoutMs =
    dependencies.eventDeliveryTimeoutMs ?? DEFAULT_EVENT_DELIVERY_TIMEOUT_MS;

  return {
    run(input) {
      return runWithExplicitAuthPath(hostedAuthPath(dependencies.localStore), async () => {
      const context = readContext(input);
      readLimits(input);
      if (input.signal?.aborted) {
        return cancelledBeforeStart(dependencies.eventSink, context, timeoutMs);
      }

      let preflightAborted = false;
      const onPreflightAbort = () => {
        preflightAborted = true;
      };
      input.signal?.addEventListener("abort", onPreflightAbort, { once: true });
      const disarmPreflight = () => {
        input.signal?.removeEventListener("abort", onPreflightAbort);
      };

      let packageRoot: string;
      let skills: SkillsPayload | undefined;
      let operatorCatalog: OperatorCatalog;
      try {
        packageRoot = await readPackageRoot(input.packageRoot, context);
        validateTask(input.taskYaml, context);
        await validatePackage(packageRoot, input.pipeline, context);
        await assertStoreOutsidePackage(dependencies.localStore, packageRoot, context);
        try {
          skills = await loadPackageSkills(packageRoot);
        } catch (error) {
          throw hostedError(
            errorMessage(error),
            "package_invalid",
            context.externalRunId,
            context.externalAttemptId,
          );
        }
        operatorCatalog = await hostedOperatorCatalog(
          dependencies.localStore,
          packageRoot,
        );
        if (preflightAborted || input.signal?.aborted) {
          disarmPreflight();
          return cancelledBeforeStart(dependencies.eventSink, context, timeoutMs);
        }
        disarmPreflight();
        if (input.signal?.aborted) {
          return cancelledBeforeStart(dependencies.eventSink, context, timeoutMs);
        }
      } catch (error) {
        disarmPreflight();
        throw error;
      }

      const sequencer = new HostedEventSequencer(
        dependencies.eventSink,
        context,
        timeoutMs,
        HOSTED_DELIVERY_ATTEMPTS,
      );
      const halt = { halted: false };
      const handles = new ActiveHandles();
      const store = observeStore(dependencies.localStore, (stageId, event, attempt) => {
        const body = translateStageEvent(stageId, event, attempt);
        if (body === undefined) return Promise.resolve();
        return sequencer.emit(body);
      });
      const agent = wrapAgent(dependencies.agent, handles);

      let decision: Decision | undefined;
      let released = false;
      const claim = (next: Decision): boolean => {
        if (decision !== undefined) return false;
        decision = next;
        return true;
      };

      let runId = "";
      let workspaceDir: string | undefined;
      const startedAt = new Date().toISOString();
      let removeAbort: (() => void) | undefined;
      let timer: NodeJS.Timeout | undefined;

      const stop = () => {
        halt.halted = true;
        if (runId !== "") {
          void dependencies.localStore
            .updateRunStatus(runId, "cancelled")
            .catch(() => undefined);
        }
        void handles.stop();
      };

      if (input.signal !== undefined) {
        const onAbort = () => {
          if (!claim({ status: "cancelled", reason: "hosted run cancelled" })) return;
          stop();
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => input.signal?.removeEventListener("abort", onAbort);
      }
      if (input.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (
            !claim({
              status: "failed",
              code: "timed_out",
              reason: "hosted run timed out",
            })
          ) {
            return;
          }
          halt.halted = true;
          void handles.stop();
        }, input.timeoutMs);
      }

      try {
        if (input.signal?.aborted) {
          return cancelledBeforeStart(dependencies.eventSink, context, timeoutMs);
        }
        const started = await startPipeline({
          agent,
          store,
          taskYaml: input.taskYaml,
          pipeline: input.pipeline,
          cwd: packageRoot,
          projectRoot: packageRoot,
          executionMode: HOSTED_EXECUTION_MODE,
          maxActiveStagesPerRun: input.maxActiveStagesPerRun,
          schedulingHalt: halt,
          operatorCatalog,
          ...(skills !== undefined ? { skills } : {}),
        });
        runId = started.runId;
        workspaceDir = started.runDir;
        sequencer.setRunId(runId);
        await assertWorkspaceOutside(packageRoot, started.runDir, context, runId);

        try {
          await sequencer.emitNow({ type: "run.created" });
          await sequencer.emitNow({ type: "run.started" });
        } catch (error) {
          halt.halted = true;
          sequencer.rejectHeld(error);
          await handles.stop();
          const local = await settle(started.done, started.runId, started.runDir);
          throw sinkFailure(sequencer, context, local, startedAt);
        }
        sequencer.release();
        released = true;

        const local = await waitForRun(
          started.done,
          () => decision !== undefined,
          started.runId,
          started.runDir,
        );
        if (sequencer.failed) {
          throw sinkFailure(sequencer, context, local, startedAt, workspaceDir);
        }

        claim(decisionFromPipeline(local));
        const chosen = decision as Decision;
        if (chosen.status === "cancelled" && runId !== "") {
          await dependencies.localStore
            .updateRunStatus(runId, "cancelled")
            .catch(() => undefined);
        }
        const receipt = receiptFor(context, startedAt);
        try {
          await sequencer.emitNow(terminalBody(chosen, receipt));
        } catch (error) {
          throw sinkFailure(
            sequencer,
            context,
            local,
            startedAt,
            workspaceDir,
            resultFrom(chosen, context, runId, workspaceDir, receipt),
          );
        }
        return resultFrom(chosen, context, runId, workspaceDir, receipt);
      } catch (error) {
        if (error instanceof HostedRuntimeError) throw error;
        throw mapStartError(error, context, runId);
      } finally {
        if (!released) {
          sequencer.rejectHeld(
            new Error("hosted run ended before stage events were released"),
          );
        }
        if (timer !== undefined) clearTimeout(timer);
        removeAbort?.();
        await handles.stop();
      }
    });
  },
};
}

function readContext(input: HostedPipelineInput): HostedRunContext {
  const context = input.context;
  const externalRunId =
    typeof context?.externalRunId === "string" ? context.externalRunId.trim() : "";
  const externalAttemptId =
    typeof context?.externalAttemptId === "string"
      ? context.externalAttemptId.trim()
      : "";
  const packageRevision =
    typeof context?.packageRevision === "string"
      ? context.packageRevision.trim()
      : "";
  if (externalRunId === "" || externalAttemptId === "" || packageRevision === "") {
    throw hostedError(
      "hosted context requires externalRunId, externalAttemptId, and packageRevision",
      "invalid_input",
      externalRunId,
      externalAttemptId,
    );
  }
  const attributes = readAttributes(context.attributes, externalRunId, externalAttemptId);
  return {
    externalRunId,
    externalAttemptId,
    packageRevision,
    ...(attributes !== undefined ? { attributes } : {}),
  };
}

function readAttributes(
  attributes: HostedRunContext["attributes"] | undefined,
  externalRunId: string,
  externalAttemptId: string,
): Readonly<Record<string, string>> | undefined {
  if (attributes === undefined) return undefined;
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw hostedError(
      "hosted context attributes must be a string record",
      "invalid_input",
      externalRunId,
      externalAttemptId,
    );
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== "string") {
      throw hostedError(
        "hosted context attributes must be strings",
        "invalid_input",
        externalRunId,
        externalAttemptId,
      );
    }
    if (redactString(`${key}=${value}`) !== `${key}=${value}`) {
      throw hostedError(
        "hosted context attributes must not contain credentials",
        "invalid_input",
        externalRunId,
        externalAttemptId,
      );
    }
  }
  return attributes;
}

function readLimits(input: HostedPipelineInput): void {
  if (
    input.timeoutMs !== undefined &&
    (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)
  ) {
    const context = input.context;
    throw hostedError(
      "timeoutMs must be a positive number",
      "invalid_input",
      context?.externalRunId ?? "",
      context?.externalAttemptId ?? "",
    );
  }
  if (
    input.maxActiveStagesPerRun !== undefined &&
    (!Number.isInteger(input.maxActiveStagesPerRun) ||
      input.maxActiveStagesPerRun < 1)
  ) {
    const context = input.context;
    throw hostedError(
      "maxActiveStagesPerRun must be a positive integer",
      "invalid_input",
      context?.externalRunId ?? "",
      context?.externalAttemptId ?? "",
    );
  }
}

async function readPackageRoot(
  packageRoot: string,
  context: HostedRunContext,
): Promise<string> {
  if (typeof packageRoot !== "string" || packageRoot.trim() === "") {
    throw hostedError(
      "packageRoot is required",
      "invalid_input",
      context.externalRunId,
      context.externalAttemptId,
    );
  }
  try {
    return await resolveDirectory(packageRoot);
  } catch (error) {
    throw hostedError(
      errorMessage(error),
      "package_invalid",
      context.externalRunId,
      context.externalAttemptId,
    );
  }
}

function validateTask(taskYaml: string, context: HostedRunContext): void {
  if (typeof taskYaml !== "string" || taskYaml.trim() === "") {
    throw hostedError(
      "taskYaml is required",
      "invalid_input",
      context.externalRunId,
      context.externalAttemptId,
    );
  }
  let task;
  try {
    task = loadTaskFromYaml(taskYaml, "hosted task yaml");
  } catch (error) {
    throw hostedError(
      redactString(errorMessage(error)),
      "invalid_input",
      context.externalRunId,
      context.externalAttemptId,
    );
  }
  if (task.repository !== undefined || task.checkout !== undefined || task.ref !== undefined) {
    throw hostedError(
      "hosted runs do not accept a repository or checkout binding",
      "invalid_input",
      context.externalRunId,
      context.externalAttemptId,
    );
  }
}

async function validatePackage(
  packageRoot: string,
  pipeline: string,
  context: HostedRunContext,
): Promise<void> {
  if (typeof pipeline !== "string" || pipeline.trim() === "") {
    throw hostedError(
      "pipeline is required",
      "invalid_input",
      context.externalRunId,
      context.externalAttemptId,
    );
  }
  const pipelinePath = path.resolve(packageRoot, pipeline);
  try {
    await containedRealPath(packageRoot, pipelinePath);
  } catch (error) {
    throw hostedError(
      errorMessage(error),
      "package_invalid",
      context.externalRunId,
      context.externalAttemptId,
    );
  }
  const loaded = await loadPipelineValidated(pipeline, {
    cwd: packageRoot,
    projectRoot: packageRoot,
    validateStages: true,
  });
  if (!loaded.ok) {
    throw hostedError(
      redactString(loaded.findings[0]?.message ?? "pipeline failed validation"),
      "package_invalid",
      context.externalRunId,
      context.externalAttemptId,
    );
  }
  try {
    await containedRealPath(packageRoot, loaded.loaded.pipelinePath);
    for (const source of Object.values(loaded.loaded.stageSources ?? {})) {
      if (source.kind !== "file") continue;
      await containedRealPath(packageRoot, source.path);
    }
  } catch (error) {
    throw hostedError(
      errorMessage(error),
      "package_invalid",
      context.externalRunId,
      context.externalAttemptId,
    );
  }
}

async function assertStoreOutsidePackage(
  store: RunStore,
  packageRoot: string,
  context: HostedRunContext,
): Promise<void> {
  const dbPath = sqlitePath(store);
  if (dbPath === undefined) return;
  let real = path.resolve(dbPath);
  try {
    real = await realpath(dbPath);
  } catch {
    real = path.resolve(dbPath);
  }
  if (isContained(packageRoot, real)) {
    throw hostedError(
      "local run store must stay outside the package root",
      "invalid_input",
      context.externalRunId,
      context.externalAttemptId,
    );
  }
}

async function assertWorkspaceOutside(
  packageRoot: string,
  workspaceDir: string,
  context: HostedRunContext,
  runId: string,
): Promise<void> {
  let real: string;
  try {
    real = await realpath(workspaceDir);
  } catch {
    return;
  }
  if (isContained(packageRoot, real)) {
    throw hostedError(
      "run workspace must stay outside the package root",
      "invalid_input",
      context.externalRunId,
      context.externalAttemptId,
      runId,
    );
  }
}

async function hostedOperatorCatalog(
  store: RunStore,
  packageRoot: string,
): Promise<OperatorCatalog> {
  const dbPath = sqlitePath(store);
  const agentDir =
    dbPath !== undefined
      ? path.join(path.dirname(dbPath), "hosted-skill-catalog")
      : path.join(tmpdir(), "stageflow-hosted-skill-catalog");
  await mkdir(agentDir, { recursive: true });
  return { cwd: packageRoot, agentDir };
}

function hostedAuthPath(store: RunStore): string {
  const fromEnv = process.env.STAGEFLOW_AGENT_AUTH_PATH?.trim();
  if (fromEnv) return fromEnv;
  const dbPath = sqlitePath(store);
  if (dbPath !== undefined) return path.join(path.dirname(dbPath), "hosted-agent-auth.json");
  return path.join(tmpdir(), "stageflow-hosted-agent-auth.json");
}

function sqlitePath(store: RunStore): string | undefined {
  const connection = (store as { connection?: { name?: unknown } }).connection;
  if (typeof connection?.name !== "string" || connection.name === "" || connection.name === ":memory:") {
    return undefined;
  }
  return connection.name;
}

function observeStore(
  store: RunStore,
  onStageEvent: (
    stageId: string,
    event: StageLogLine,
    attempt: number,
  ) => Promise<void>,
): RunStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "appendStageEvent") {
        return async (
          runId: string,
          stageId: string,
          event: StageLogLine,
          options?: { attempt?: number },
        ) => {
          await target.appendStageEvent(runId, stageId, event, options);
          await onStageEvent(stageId, event, options?.attempt ?? 1);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });
}

class ActiveHandles {
  private readonly handles = new Set<StageHandle>();
  private stopping = false;

  get isStopping(): boolean {
    return this.stopping;
  }

  track(handle: StageHandle): void {
    this.handles.add(handle);
  }

  untrack(handle: StageHandle): void {
    this.handles.delete(handle);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const open = [...this.handles];
    await Promise.all(
      open.map((handle) =>
        Promise.race([
          handle.close().catch(() => undefined),
          sleep(HOSTED_CANCEL_GRACE_MS),
        ]),
      ),
    );
  }
}

function wrapAgent(agent: StagePort, handles: ActiveHandles): StagePort {
  return {
    openStage(input) {
      const inner = agent.openStage(input);
      let closed = false;
      const wrapped: StageHandle = {
        stageId: inner.stageId,
        next(): Promise<StageHandleEvent> {
          if (handles.isStopping || closed) {
            return Promise.resolve(stoppedEvent());
          }
          return inner.next();
        },
        deliverAnswer(answer) {
          inner.deliverAnswer(answer);
        },
        async close(options) {
          if (closed) return;
          closed = true;
          handles.untrack(wrapped);
          await inner.close(options);
        },
      };
      handles.track(wrapped);
      return wrapped;
    },
    runStage(input) {
      return agent.runStage(input);
    },
  };
}

function stoppedEvent(): StageHandleEvent {
  return {
    status: "completed",
    result: { ok: false, reason: "cancelled" },
  };
}

async function cancelledBeforeStart(
  sink: HostedEventSink,
  context: HostedRunContext,
  timeoutMs: number,
): Promise<HostedPipelineResult> {
  const startedAt = new Date().toISOString();
  const sequencer = new HostedEventSequencer(
    sink,
    context,
    timeoutMs,
    HOSTED_DELIVERY_ATTEMPTS,
  );
  sequencer.release();
  const decision: Decision = {
    status: "cancelled",
    reason: "hosted run cancelled before start",
  };
  const receipt = receiptFor(context, startedAt);
  try {
    await sequencer.emitNow(terminalBody(decision, receipt));
  } catch (error) {
    if (error instanceof HostedRuntimeError) throw error;
    throw sinkFailure(sequencer, context, undefined, startedAt);
  }
  return resultFrom(decision, context, "", undefined, receipt);
}

function decisionFromPipeline(result: PipelineRunResult): Decision {
  if (result.outcome === "cancelled") {
    return { status: "cancelled", reason: result.reason ?? "hosted run cancelled" };
  }
  if (result.outcome === "waiting") {
    return {
      status: "failed",
      code: "hitl_unsupported",
      reason:
        result.reason ??
        "hosted run stopped for approval; destroying the sandbox does not leave a resumable attempt",
    };
  }
  if (result.ok && result.outcome === "succeeded") {
    return { status: "succeeded" };
  }
  const reason = redactString(result.reason ?? "hosted run failed");
  if (/requested wait|no HITL controller/i.test(reason)) {
    return { status: "failed", code: "hitl_unsupported", reason };
  }
  if (/timed out|timeout/i.test(reason)) {
    return { status: "failed", code: "timed_out", reason };
  }
  return { status: "failed", code: "agent_failed", reason };
}

function terminalBody(
  decision: Decision,
  receipt: HostedExecutionReceipt,
): Parameters<HostedEventSequencer["emitNow"]>[0] {
  if (decision.status === "succeeded") {
    return { type: "run.succeeded", receipt };
  }
  if (decision.status === "cancelled") {
    return {
      type: "run.cancelled",
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      receipt,
    };
  }
  if (decision.status === "waiting") {
    return {
      type: "run.failed",
      code: decision.code,
      reason: decision.reason,
      receipt,
    };
  }
  return {
    type: "run.failed",
    code: decision.code,
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    receipt,
  };
}

function resultFrom(
  decision: Decision,
  context: HostedRunContext,
  runId: string,
  workspaceDir: string | undefined,
  receipt: HostedExecutionReceipt,
): HostedPipelineResult {
  return {
    runId: runId === "" ? null : runId,
    externalRunId: context.externalRunId,
    externalAttemptId: context.externalAttemptId,
    status: decision.status,
    ...(decision.status === "succeeded"
      ? {}
      : {
          code: decision.status === "cancelled" ? ("cancelled" as const) : decision.code,
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        }),
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    receipt,
  };
}

function receiptFor(
  context: HostedRunContext,
  startedAt: string,
): HostedExecutionReceipt {
  return {
    coreVersion: PACKAGE_VERSION,
    eventSchemaVersion: HOSTED_EVENT_SCHEMA_VERSION,
    packageRevision: context.packageRevision,
    executionMode: "inline",
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function sinkFailure(
  sequencer: HostedEventSequencer,
  context: HostedRunContext,
  local: PipelineRunResult | undefined,
  startedAt: string,
  workspaceDir?: string,
  localResult?: HostedPipelineResult,
): HostedRuntimeError {
  const base = sequencer.failure;
  const result =
    localResult ??
    (local !== undefined
      ? resultFrom(
          decisionFromPipeline(local),
          context,
          local.runId,
          workspaceDir ?? local.runDir,
          receiptFor(context, startedAt),
        )
      : undefined);
  return new HostedRuntimeError(base?.message ?? "hosted event sink failed", {
    code: "event_sink_failed",
    externalRunId: context.externalRunId,
    externalAttemptId: context.externalAttemptId,
    ...(local?.runId !== undefined && local.runId !== ""
      ? { runId: local.runId }
      : {}),
    ...(base !== undefined
      ? { eventType: base.eventType, sequence: base.sequence }
      : {}),
    ...(result !== undefined ? { localResult: result } : {}),
  });
}

async function waitForRun(
  done: Promise<PipelineRunResult>,
  stopped: () => boolean,
  runId: string,
  runDir: string,
): Promise<PipelineRunResult> {
  let timer: NodeJS.Timeout | undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    if (stopped()) {
      resolve();
      return;
    }
    timer = setInterval(() => {
      if (!stopped()) return;
      if (timer !== undefined) clearInterval(timer);
      resolve();
    }, 15);
  });
  try {
    const winner = await Promise.race([
      done.then((result) => ({ kind: "done" as const, result })),
      stoppedPromise.then(() => ({ kind: "stopped" as const })),
    ]);
    if (winner.kind === "done") return winner.result;
    return settle(done, runId, runDir);
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}

async function settle(
  done: Promise<PipelineRunResult>,
  runId: string,
  runDir: string,
): Promise<PipelineRunResult> {
  return Promise.race([
    done,
    sleep(HOSTED_CANCEL_GRACE_MS).then(() => ({
      ok: false as const,
      outcome: "cancelled" as const,
      runId,
      runDir,
      reason: "hosted run cancelled",
    })),
  ]);
}

function mapStartError(
  error: unknown,
  context: HostedRunContext,
  runId: string,
): HostedRuntimeError {
  if (error instanceof PipelineValidationError || error instanceof PipelinePreflightError) {
    return hostedError(
      redactString(errorMessage(error)),
      "package_invalid",
      context.externalRunId,
      context.externalAttemptId,
      runId === "" ? undefined : runId,
    );
  }
  return hostedError(
    redactString(errorMessage(error)),
    "internal",
    context.externalRunId,
    context.externalAttemptId,
    runId === "" ? undefined : runId,
  );
}

function hostedError(
  message: string,
  code: HostedErrorCode,
  externalRunId: string,
  externalAttemptId: string,
  runId?: string,
): HostedRuntimeError {
  return new HostedRuntimeError(message, {
    code,
    externalRunId,
    externalAttemptId,
    ...(runId !== undefined ? { runId } : {}),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
