import type { StageExecutionMode } from "./stageConcurrency.js";
import type { DeliverAnswerResult } from "./stageHitl.js";

export const WAIT_WITHOUT_WORKER_DISPATCH =
  "stage entered wait without worker dispatch";

export type AnswerResumeAdapterResult = {
  ok: boolean;
  reason?: string;
};

export async function orchestrateAnswerResume(options: {
  prefixMode: "live" | "restart";
  executionMode: StageExecutionMode;
  insertedForResume: boolean;
  removeInsertedResume: () => void;
  registerResumeUntrack: (done: Promise<AnswerResumeAdapterResult>) => void;
  resumeViaSubprocess: () => Promise<AnswerResumeAdapterResult>;
  reconstructAndContinue: () => Promise<AnswerResumeAdapterResult>;
}): Promise<DeliverAnswerResult> {
  if (options.prefixMode === "live" && options.executionMode !== "process") {
    if (options.insertedForResume) {
      options.removeInsertedResume();
    }
    return { ok: true };
  }

  const done =
    options.executionMode === "process"
      ? options.resumeViaSubprocess()
      : options.reconstructAndContinue();
  options.registerResumeUntrack(done);
  const outcome = await done;
  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason ?? "resume failed",
      status: 500,
    };
  }
  return { ok: true };
}
