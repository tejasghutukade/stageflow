import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionsSource } from "../config/datasetFromSessions.js";
import type { EvalSampleAgents } from "../config/installEvalSample.js";
import type { EngineStatus } from "../evals/engine/promptfoo/status.js";
import type { TokenPrice } from "../evals/estimate.js";
import type { EvalAgentsPort, EvalRunManager } from "../evals/manager.js";
import { badRequest, EvalApiError, runByIdOr404 as runByIdOr404Shared } from "../evals/read/api.js";
import type { EvalRunRow } from "../evals/storeTypes.js";
import type { TriageDeps } from "../evals/triage/service.js";
import { writeAudit } from "../logging/audit.js";
import type { Logger } from "../logging/logger.js";
import type { RunStore } from "../runstore/port.js";
import type { RunManager } from "../runtime/runManager.js";
import { callerIdFromRequestAuth, getRequestAuth } from "./requestAuthContext.js";

export type EvalRoutesDeps = {
  cwd: string;
  store: RunStore;
  manager: RunManager;
  evalRunManager: EvalRunManager | undefined;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage) => Promise<unknown>;
  auditLog: Logger;
  engineStatus: () => EngineStatus;
  isKnownModel?: (id: string) => Promise<boolean>;
  sampleSourceDir?: string;
  now?: () => Date;
  /** Lazy view of the agent service; absent or undefined means agents are unavailable on this host. */
  agents?: () => RouteAgents | undefined;
  /** Model prices (USD per million tokens) for the agent cost estimate; unknown models are simply absent. */
  loadPrices?: (modelIds: string[], projectRoot: string) => Promise<Map<string, TokenPrice>>;
  /** Failure sorting: the Host's agent backend (judge classifier) and test seams (fetch, key lookup, base URL). */
  triage?: Omit<TriageDeps, "store">;
};

export type Ctx = EvalRoutesDeps & {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
  evalRunManager: EvalRunManager;
};

export type RouteAgents = EvalAgentsPort & SessionsSource & Partial<Pick<EvalSampleAgents, "create" | "setEnabled">>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function bad(message: string, code = "invalid_request"): EvalApiError {
  return badRequest(message, code);
}

function surface() {
  return getRequestAuth()?.surface ?? "rest";
}

export function audit(c: Ctx, action: string, outcome: "ok" | "error", target?: string, code?: string): void {
  writeAudit(c.auditLog, {
    caller_id: callerIdFromRequestAuth(),
    surface: surface(),
    action,
    outcome,
    ...(target !== undefined ? { target_run_id: target } : {}),
    ...(code !== undefined ? { error_code: code } : {}),
  });
}

export async function readOptionalBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.readJsonBody(c.req);
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

export function optStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) {
    throw bad(`"${key}" must be an array of non-empty strings`);
  }
  return value as string[];
}

export async function runByIdOr404(c: Ctx, id: string): Promise<EvalRunRow> {
  return runByIdOr404Shared(c.store, id);
}
