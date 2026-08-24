import type { StageRunResult } from "../agent/port.js";
import type { RunStageOutcome } from "./stageRunner.js";
import type { OperatorCatalog } from "./stageAttemptBootstrap.js";

export const SF_STAGE_WORKER = "SF_STAGE_WORKER";

export const STAGE_WORKER_EXIT = {
  SUCCEEDED: 0,
  FAILED: 1,
  WAITING: 2,
} as const;

export type StageWorkerInput = {
  runId: string;
  stageId: string;
  rootDir: string;
  mode?: "run" | "resume";
  resumeAnswer?: unknown;
  attempt?: number;
  sessionFilePath?: string;
  operatorCatalog?: OperatorCatalog;
};

export type StageWorkerResult =
  | { type: "succeeded" }
  | { type: "failed"; reason: string }
  | { type: "waiting" };

export function outcomeToWorkerResult(
  outcome: RunStageOutcome,
): StageWorkerResult {
  if ("waiting" in outcome && outcome.waiting) {
    return { type: "waiting" };
  }
  const result = outcome as StageRunResult;
  if (result.ok) {
    return { type: "succeeded" };
  }
  return { type: "failed", reason: result.reason };
}
