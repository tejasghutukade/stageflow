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
    };

export type LoadOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; issues: LoadIssue[] };

export function loadFailure<T>(issues: LoadIssue[]): LoadOutcome<T> {
  return { ok: false, issues };
}

export function loadSuccess<T>(value: T): LoadOutcome<T> {
  return { ok: true, value };
}
