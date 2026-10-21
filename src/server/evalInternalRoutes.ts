import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunTokenRegistry } from "../evals/engine/promptfoo/runTokens.js";
import type { StageCaseRunner } from "../evals/runner/stageCaseRunner.js";
import type { RunCaseRequest } from "../evals/types.js";

export const EVAL_INTERNAL_RUN_CASE_PATH = "/api/evals/internal/run-case";

const MAX_BODY_BYTES = 8192;

export type EvalInternalServices = {
  tokens: Pick<RunTokenRegistry, "verify">;
  runner: Pick<StageCaseRunner, "runCase">;
  isRunning(evalRunId: string): boolean;
};

export type EvalServices = EvalInternalServices | (() => EvalInternalServices | undefined);

type Json = (res: ServerResponse, status: number, body: unknown) => void;

export function isEvalInternalPath(pathname: string): boolean {
  return pathname === EVAL_INTERNAL_RUN_CASE_PATH;
}

function resolveServices(services: EvalServices | undefined): EvalInternalServices | undefined {
  return typeof services === "function" ? services() : services;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseRequest(body: unknown): RunCaseRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { eval_run_id: evalRunId, case_id: caseId, repeat_index: repeatIndex } = body as Record<string, unknown>;
  if (typeof evalRunId !== "string" || evalRunId.length === 0) return undefined;
  if (typeof caseId !== "string" || caseId.length === 0) return undefined;
  if (typeof repeatIndex !== "number" || !Number.isInteger(repeatIndex) || repeatIndex < 0) return undefined;
  return { evalRunId, caseId, repeatIndex };
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const match = typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
  return match?.[1];
}

export async function handleEvalInternalRoutes(
  req: IncomingMessage,
  method: string,
  pathname: string,
  services: EvalServices | undefined,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  if (!isEvalInternalPath(pathname)) return false;
  const deps = resolveServices(services);
  if (deps === undefined || method !== "POST") {
    json(res, 404, { error: "Not found" });
    return true;
  }
  const entry = deps.tokens.verify(bearerToken(req));
  if (entry === undefined) {
    json(res, 401, { code: "unauthorized" });
    return true;
  }
  let request: RunCaseRequest | undefined;
  try {
    request = parseRequest(await readBody(req));
  } catch {
    request = undefined;
  }
  if (request === undefined) {
    json(res, 400, { code: "invalid_request" });
    return true;
  }
  if (request.evalRunId !== entry.evalRunId) {
    json(res, 401, { code: "unauthorized" });
    return true;
  }
  if (!deps.isRunning(request.evalRunId)) {
    json(res, 409, { code: "eval_run_not_running" });
    return true;
  }
  try {
    const { binding } = entry;
    const result = binding.runCase
      ? await binding.runCase(request)
      : binding.plan
        ? await deps.runner.runCase(binding.plan, request)
        : undefined;
    if (result === undefined) {
      json(res, 500, { code: "EVAL_ENGINE_ERROR" });
      return true;
    }
    json(res, 200, result);
  } catch {
    json(res, 500, { code: "EVAL_ENGINE_ERROR" });
  }
  return true;
}
