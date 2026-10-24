import type { SuggestionStatus, TriageBucket, TriageSource } from "./constants.js";

export type GraderQuestion = { graderId: string; type: string };

export type ClassifyInput = {
  targetKind: "stage" | "agent";
  /** The bounded JSON text both backends read. */
  state: string;
  /** Failing code or rubric graders; each gets a "false alarm" question. */
  graderQuestions: GraderQuestion[];
  signal?: AbortSignal;
};

export type ClassifyOutput = {
  bucket: TriageBucket;
  /** Bucket confidence, 0..1. */
  confidence: number;
  bucketProbabilities: Record<TriageBucket, number>;
  failureType: string | null;
  graderFalseAlarms: Array<{ graderId: string; probability: number }>;
  costUsd: number;
  /** The model id the backend reports it used, when it reports one. */
  answeredModel?: string;
};

export interface FailureClassifier {
  readonly source: TriageSource;
  /** The model id that answers, recorded on every suggestion. */
  readonly model: string;
  classify(input: ClassifyInput): Promise<ClassifyOutput>;
}

export class ClassifierError extends Error {
  constructor(
    readonly code: "CLASSIFIER_RATE_LIMITED" | "CLASSIFIER_REJECTED" | "CLASSIFIER_FAILED" | "CLASSIFIER_BAD_REPLY",
    message: string,
  ) {
    super(message);
    this.name = "ClassifierError";
  }
}

export type SuggestionRow = {
  id: string;
  evalRunId: string;
  caseId: string;
  repeatIndex: number;
  source: TriageSource;
  bucket: TriageBucket;
  failureType: string | null;
  confidence: number;
  bucketProbabilities: Record<TriageBucket, number>;
  graderFalseAlarms: Array<{ graderId: string; probability: number }>;
  model: string;
  promptVersion: number;
  status: SuggestionStatus;
  batchId: string;
  costUsd: number;
  stateTruncated: boolean;
  createdAt: string;
};

export type SuggestionInput = Omit<SuggestionRow, "id" | "status" | "createdAt" | "evalRunId">;
