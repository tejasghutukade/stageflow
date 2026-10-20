import type { NormalizedGrade, PlanCase } from "../types.js";

export type Subject = {
  status: "success" | "failure";
  summary: string;
  payload?: Record<string, unknown>;
  artifacts: string[];
};

export type GraderContext = {
  evalId: string;
  runId: string;
  repeat: number;
  passThreshold: number;
  outputSchema?: unknown;
  codeTimeoutMs?: number;
};

export type GradeData = NormalizedGrade;

export type GradeCase = PlanCase;
