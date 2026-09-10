import type { ValidationFindingCode } from "./validateCatalog.js";

export type TaskLoadCode = "task.invalid_shape" | "task.load_error";

export type LoadIssue =
  | {
      code: ValidationFindingCode;
      message: string;
      category: "pipeline";
      pipelineId?: string;
    }
  | {
      code: ValidationFindingCode;
      message: string;
      category: "stage";
      stageId?: string;
    }
  | {
      code: TaskLoadCode;
      message: string;
      category: "task";
      taskId?: string;
    }
  | {
      code: ValidationFindingCode | string;
      message: string;
      category: "catalog";
    };

export type LoadOutcome<T> =
  | { ok: true; value: T; issues?: LoadIssue[] }
  | { ok: false; issues: LoadIssue[] };

export function loadFailure<T>(issues: LoadIssue[]): LoadOutcome<T> {
  return { ok: false, issues };
}

export function loadSuccess<T>(value: T, issues?: LoadIssue[]): LoadOutcome<T> {
  if (issues && issues.length > 0) {
    return { ok: true, value, issues };
  }
  return { ok: true, value };
}
