import { AsyncLocalStorage } from "node:async_hooks";
import type { FunctionGrant } from "../config/loadFunction.js";
import type { JsonValue } from "../functions/protocol.js";
import type { StageEnvelope } from "../types/envelope.js";

export type FunctionCheckPhase = "emit" | "after";

export type FunctionCheckRequest = {
  functionId: string;
  revision: number;
  grants: readonly FunctionGrant[];
  phase: FunctionCheckPhase;
  checkId: string;
  envelope: StageEnvelope;
  runId?: string;
  stageId?: string;
  attempt?: number;
};

export type FunctionCheckResponse = {
  ok: boolean;
  value?: JsonValue;
  code?: string;
  message?: string;
  revision: number | null;
};

export type FunctionCheckInvoker = {
  invoke(request: FunctionCheckRequest): Promise<FunctionCheckResponse>;
};

export type FunctionCheckScope = {
  invoke: FunctionCheckInvoker["invoke"];
  revision: FunctionRevisionLookup;
  runId: string;
  stageId: string;
  attempt: number;
};

const activeChecks = new AsyncLocalStorage<FunctionCheckScope>();

export function activeFunctionChecks(): FunctionCheckScope | undefined {
  return activeChecks.getStore();
}

export function runWithFunctionChecks<T>(scope: FunctionCheckScope, run: () => Promise<T>): Promise<T> {
  return activeChecks.run(scope, run);
}

export type FunctionRevisionLookup = (
  functionId: string,
) => number | undefined | Promise<number | undefined>;

export type FunctionVerificationVerdict =
  | {
      outcome: "passed" | "failed";
      revision: number;
      message?: string;
      details?: JsonValue;
    }
  | {
      outcome: "error";
      code: string;
      message: string;
      revision: number;
    };

const RESULT_FIELDS = new Set(["passed", "message", "details"]);

export function judgeFunctionVerification(
  response: FunctionCheckResponse,
  revision: number,
): FunctionVerificationVerdict {
  if (!response.ok) {
    return {
      outcome: "error",
      code: response.code && response.code.length > 0 ? response.code : "exception",
      message: response.message ?? "function check failed",
      revision,
    };
  }
  const value = response.value;
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      outcome: "error",
      code: "invalid_output",
      message: "verification result must be an object",
      revision,
    };
  }
  const extra = Object.keys(value).find((key) => !RESULT_FIELDS.has(key));
  if (extra !== undefined) {
    return {
      outcome: "error",
      code: "invalid_output",
      message: `verification result has unexpected field "${extra}"`,
      revision,
    };
  }
  if (typeof value.passed !== "boolean") {
    return {
      outcome: "error",
      code: "invalid_output",
      message: "verification result passed must be a boolean",
      revision,
    };
  }
  if (value.message !== undefined && typeof value.message !== "string") {
    return {
      outcome: "error",
      code: "invalid_output",
      message: "verification result message must be a string",
      revision,
    };
  }
  const message = typeof value.message === "string" ? value.message : undefined;
  const details = value.details;
  if (value.passed) {
    return {
      outcome: "passed",
      revision,
      ...(message !== undefined ? { message } : {}),
      ...(details !== undefined ? { details } : {}),
    };
  }
  return {
    outcome: "failed",
    revision,
    message: message ?? "function check failed",
    ...(details !== undefined ? { details } : {}),
  };
}

export function functionCheckErrorText(code: string, message: string): string {
  return `function check ${code}: ${message}`;
}
