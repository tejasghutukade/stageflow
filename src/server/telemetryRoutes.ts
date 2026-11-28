import type { IncomingMessage, ServerResponse } from "node:http";
import { globalStageflowHome } from "../project/globalHome.js";
import {
  createTelemetryConsent,
  TelemetryConsentError,
  type TelemetryConsentErrorCode,
} from "../telemetry/consent.js";
import { readTelemetryEnvSnapshot } from "../telemetry/envSnapshot.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

const MAX_BODY_BYTES = 64 * 1024;

const CONSENT_STATUS: Record<TelemetryConsentErrorCode, number> = {
  TELEMETRY_LOCKED: 409,
  TELEMETRY_STORAGE_FAILED: 500,
};

class TelemetryRequestError extends Error {
  readonly code = "TELEMETRY_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "TelemetryRequestError";
  }
}

function consent() {
  return createTelemetryConsent({
    homeDir: globalStageflowHome(),
    snapshot: readTelemetryEnvSnapshot(),
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new TelemetryRequestError("Telemetry request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TelemetryRequestError("Invalid JSON body");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePut(body: unknown): { enabled: boolean; promptedVersion?: number } {
  if (!isPlainObject(body)) {
    throw new TelemetryRequestError("Telemetry request body must be an object");
  }
  if (typeof body.enabled !== "boolean") {
    throw new TelemetryRequestError("enabled must be a boolean");
  }
  if (!Object.prototype.hasOwnProperty.call(body, "promptedVersion")) {
    return { enabled: body.enabled };
  }
  const version = body.promptedVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    throw new TelemetryRequestError("promptedVersion must be a non-negative integer");
  }
  return { enabled: body.enabled, promptedVersion: version };
}

export async function handleTelemetryRoutes(
  req: IncomingMessage,
  method: string,
  pathname: string,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  const statePath = pathname === "/api/telemetry";
  const resetPath = pathname === "/api/telemetry/reset-id";
  if (!statePath && !resetPath) return false;

  try {
    if (statePath && method === "GET") {
      json(res, 200, consent().getState());
      return true;
    }
    if (statePath && method === "PUT") {
      const parsed = parsePut(await readBody(req));
      const state = consent().setEnabled(parsed.enabled, parsed.promptedVersion);
      json(res, 200, state);
      return true;
    }
    if (resetPath && method === "POST") {
      json(res, 200, consent().resetInstallId());
      return true;
    }
    json(res, 405, { code: "TELEMETRY_INVALID", error: "Method not allowed" });
    return true;
  } catch (error) {
    if (error instanceof TelemetryConsentError) {
      json(res, CONSENT_STATUS[error.code], { code: error.code, error: error.message });
      return true;
    }
    if (error instanceof TelemetryRequestError) {
      json(res, 400, { code: error.code, error: error.message });
      return true;
    }
    throw error;
  }
}
