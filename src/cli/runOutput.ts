import type { PipelineRunResult } from "../runtime/pipelineRunner.js";
import type { BusyCode, StartRunResult } from "../runtime/runManager.js";

export type CliRunReportIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type CliRunReportEvent =
  | { kind: "start-failure"; started: Extract<StartRunResult, { ok: false }> }
  | { kind: "completion"; result: PipelineRunResult };

function stringify(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

function isBusyCode(code: string | undefined): code is BusyCode {
  return code === "busy_capacity" || code === "busy_checkout";
}

function formatRunBusyJson(
  started: Extract<StartRunResult, { ok: false }>,
): string {
  const payload: Record<string, unknown> = {
    ok: false,
    outcome: "busy",
  };
  if (started.code !== undefined) payload.code = started.code;
  payload.reason = started.reason;
  if (started.activeCount !== undefined) payload.activeCount = started.activeCount;
  if (started.maxConcurrent !== undefined) {
    payload.maxConcurrent = started.maxConcurrent;
  }
  if (started.activeRunIds !== undefined) {
    payload.activeRunIds = started.activeRunIds;
  }
  if (started.conflictingRunId !== undefined) {
    payload.conflictingRunId = started.conflictingRunId;
  }
  if (started.conflictingCheckout !== undefined) {
    payload.conflictingCheckout = started.conflictingCheckout;
  }
  return stringify(payload);
}

function formatRunStartFailedJson(
  started: Extract<StartRunResult, { ok: false }>,
): string {
  const payload: Record<string, unknown> = {
    ok: false,
    outcome: "failed",
    reason: started.reason,
  };
  if (started.code !== undefined) payload.code = started.code;
  return stringify(payload);
}

function formatStartFailureJson(
  started: Extract<StartRunResult, { ok: false }>,
): string {
  if (isBusyCode(started.code)) {
    return formatRunBusyJson(started);
  }
  return formatRunStartFailedJson(started);
}

function formatRunCompletionJson(result: PipelineRunResult): string {
  if (result.outcome === "succeeded") {
    return stringify({
      ok: true,
      outcome: "succeeded",
      runId: result.runId,
      runDir: result.runDir,
    });
  }
  if (result.outcome === "waiting") {
    return stringify({
      ok: false,
      outcome: "waiting",
      runId: result.runId,
      runDir: result.runDir,
    });
  }
  const payload: Record<string, unknown> = {
    ok: false,
    outcome: "failed",
    runId: result.runId,
    runDir: result.runDir,
  };
  if (result.reason !== undefined) payload.reason = result.reason;
  return stringify(payload);
}

function writeStartFailureHuman(
  started: Extract<StartRunResult, { ok: false }>,
  io: CliRunReportIo,
): void {
  const code = started.code ?? "error";
  io.error(`${code}: ${started.reason}`);
  if (started.conflictingRunId !== undefined) {
    io.error(`conflictingRunId: ${started.conflictingRunId}`);
  }
  if (started.conflictingCheckout !== undefined) {
    io.error(`conflictingCheckout: ${started.conflictingCheckout}`);
  }
}

function writeCompletionHuman(
  result: PipelineRunResult,
  io: CliRunReportIo,
): void {
  switch (result.outcome) {
    case "waiting":
      io.error(
        `Pipeline waiting. Run folder: ${result.runDir} (${result.runId})`,
      );
      return;
    case "failed":
      io.error(`Pipeline failed: ${result.reason}`);
      io.error(`Run folder: ${result.runDir}`);
      return;
    case "succeeded":
      io.log(`Pipeline succeeded. Run folder: ${result.runDir}`);
      return;
  }
}

function exitCodeForRunOutcome(outcome: PipelineRunResult["outcome"]): number {
  switch (outcome) {
    case "succeeded":
      return 0;
    case "waiting":
      return 2;
    case "failed":
      return 1;
  }
}

export function reportCliRun(
  event: CliRunReportEvent,
  options: { json?: boolean; io: CliRunReportIo },
): number {
  if (event.kind === "start-failure") {
    if (options.json) {
      options.io.log(formatStartFailureJson(event.started));
    } else {
      writeStartFailureHuman(event.started, options.io);
    }
    return 1;
  }
  if (options.json) {
    options.io.log(formatRunCompletionJson(event.result));
  } else {
    writeCompletionHuman(event.result, options.io);
  }
  return exitCodeForRunOutcome(event.result.outcome);
}
