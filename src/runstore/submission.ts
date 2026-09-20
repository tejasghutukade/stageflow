export type RunSubmission = { key: string; requestHash: string };
export type RunSubmissionRecord = RunSubmission & { runId: string };

export class RunSubmissionExistsError extends Error {
  constructor(readonly submission: RunSubmissionRecord) {
    super("Run submission already exists");
  }
}
