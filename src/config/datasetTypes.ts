import type { ValidationFinding } from "./validateCatalog.js";

export type DatasetFormat = "jsonl" | "json" | "csv";

export type DatasetCase = {
  id: string;
  input: Record<string, unknown>;
  title?: string;
  expected?: unknown;
  tags?: string[];
  goal?: string;
  metadata?: Record<string, unknown>;
};

export type DatasetLimits = {
  maxCases: number;
  maxCaseBytes: number;
  maxFileBytes: number;
};

export type ParseDatasetResult = {
  cases: DatasetCase[];
  findings: ValidationFinding[];
  contentHash: string;
};

export type DatasetLoadResult = ParseDatasetResult & {
  path: string;
  relPath: string;
  format: DatasetFormat | undefined;
  fileBytes: number;
};
