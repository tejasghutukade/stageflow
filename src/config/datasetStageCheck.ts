import { payloadInstanceMismatch } from "../envelope/payloadSchema.js";

export type DatasetStageCheckResult = {
  caseId: string;
  valid: boolean;
  message?: string;
};

export function checkDatasetAgainstStage(
  cases: ReadonlyArray<{ id: string; input: Record<string, unknown> }>,
  inputSchema: unknown,
): DatasetStageCheckResult[] {
  return cases.map((c) => {
    if (inputSchema === undefined) return { caseId: c.id, valid: true };
    let message: string | undefined;
    try {
      message = payloadInstanceMismatch(c.input, inputSchema);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    return message === undefined
      ? { caseId: c.id, valid: true }
      : { caseId: c.id, valid: false, message };
  });
}
