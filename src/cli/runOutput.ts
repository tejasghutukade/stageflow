import { projectRun } from "../projection/projectRun.js";
import type { RunStore } from "../runstore/port.js";
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

function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

/** Best-effort total cost for a run; undefined (not thrown) on any read failure or when no stage reported usage. */
async function tryReadTotalCostUsd(
  store: RunStore | undefined,
  runId: string,
): Promise<number | undefined> {
  if (!store) return undefined;
  try {
    const detail = await store.readRun(runId);
    return detail.total_cost_usd;
  } catch {
    return undefined;
  }
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

function baseRunCompletionPayload(
  result: PipelineRunResult,
): Record<string, unknown> {
  const payload: Record<string, unknown> =
    result.outcome === "succeeded"
      ? {
          ok: true,
          outcome: "succeeded",
          runId: result.runId,
          runDir: result.runDir,
        }
      : result.outcome === "waiting"
        ? {
            ok: false,
            outcome: "waiting",
            runId: result.runId,
            runDir: result.runDir,
          }
        : {
            ok: false,
            outcome: "failed",
            runId: result.runId,
            runDir: result.runDir,
          };
  if (result.outcome === "failed" && result.reason !== undefined) {
    payload.reason = result.reason;
  }
  if (Array.isArray(result.findings) && result.findings.length > 0) {
    payload.findings = result.findings.map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      file: finding.path,
      message: finding.message,
      category: finding.category,
    }));
  }
  return payload;
}

async function formatRunCompletionJsonWithCost(
  result: PipelineRunResult,
  store: RunStore | undefined,
): Promise<string> {
  const totalCostUsd = await tryReadTotalCostUsd(store, result.runId);
  return stringify({
    ...baseRunCompletionPayload(result),
    ...(totalCostUsd !== undefined ? { total_cost_usd: totalCostUsd } : {}),
  });
}

async function formatRunCompletionJsonWithStages(
  result: PipelineRunResult,
  store: RunStore,
): Promise<string> {
  const detail = await store.readRun(result.runId);
  const projection = projectRun(detail);
  return stringify({
    ...baseRunCompletionPayload(result),
    ...(detail.total_cost_usd !== undefined ? { total_cost_usd: detail.total_cost_usd } : {}),
    stages: projection.stages,
  });
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
  totalCostUsd: number | undefined,
): void {
  switch (result.outcome) {
    case "waiting":
      io.error(
        `Pipeline waiting. Run folder: ${result.runDir} (${result.runId})`,
      );
      break;
    case "failed":
      io.error(`Pipeline failed: ${result.reason}`);
      io.error(`Run folder: ${result.runDir}`);
      break;
    case "succeeded":
      io.log(`Pipeline succeeded. Run folder: ${result.runDir}`);
      break;
  }
  if (totalCostUsd !== undefined) {
    io.error(`Cost: ${formatUsd(totalCostUsd)}`);
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

export async function reportCliRun(
  event: CliRunReportEvent,
  options: {
    json?: boolean;
    io: CliRunReportIo;
    store?: RunStore;
    includeStages?: boolean;
  },
): Promise<number> {
  if (event.kind === "start-failure") {
    if (options.json) {
      options.io.log(formatStartFailureJson(event.started));
    } else {
      writeStartFailureHuman(event.started, options.io);
    }
    return 1;
  }
  if (options.json) {
    if (options.includeStages) {
      if (!options.store) {
        options.io.error(
          "error: --include stages requires an internal run store (report bug)",
        );
        return 1;
      }
      try {
        options.io.log(
          await formatRunCompletionJsonWithStages(event.result, options.store),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.io.error(
          `failed to read run for --include stages: ${message}`,
        );
        return 1;
      }
    } else {
      options.io.log(await formatRunCompletionJsonWithCost(event.result, options.store));
    }
  } else {
    const totalCostUsd = await tryReadTotalCostUsd(options.store, event.result.runId);
    writeCompletionHuman(event.result, options.io, totalCostUsd);
  }
  return exitCodeForRunOutcome(event.result.outcome);
}
