import type { PipelineRunResult } from "../runtime/pipelineRunner.js";
import type { StartRunResult } from "../runtime/runManager.js";
import { STAGE_WORKER_EXIT } from "../runtime/stageWorkerProtocol.js";

export type RunCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: RunCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export function exitForPipelineRunResult(
  result: PipelineRunResult,
  io: RunCommandIo = defaultIo,
): number {
  switch (result.outcome) {
    case "waiting":
      io.error(
        `Pipeline waiting. Run folder: ${result.runDir} (${result.runId})`,
      );
      return STAGE_WORKER_EXIT.WAITING;
    case "failed":
      io.error(`Pipeline failed: ${result.reason}`);
      io.error(`Run folder: ${result.runDir}`);
      return STAGE_WORKER_EXIT.FAILED;
    case "succeeded":
      io.log(`Pipeline succeeded. Run folder: ${result.runDir}`);
      return STAGE_WORKER_EXIT.SUCCEEDED;
  }
}

export async function completeCliRun(
  started: Extract<StartRunResult, { ok: true }>,
  io: RunCommandIo = defaultIo,
): Promise<number> {
  const result = await started.done;
  return exitForPipelineRunResult(result, io);
}
