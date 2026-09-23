import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readSecretFromEnvOrFile } from "../config/secretFromEnvOrFile.js";
import { isLoopbackHostname } from "./allowedHosts.js";

export type ControlScope = "read" | "drive";

export type ControlTokens = {
  driveDigest: Buffer | undefined;
  readDigest: Buffer | undefined;
};

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function validateToken(token: string, label: string): string {
  if (!token || /\s/.test(token) || token.length < 32) {
    throw new Error(
      `${label} requires a token of at least 32 characters with no whitespace`,
    );
  }
  return token;
}

export function loadControlTokens(
  env: NodeJS.ProcessEnv = process.env,
): ControlTokens {
  const driveRaw = readSecretFromEnvOrFile(env, "STAGEFLOW_CONTROL_TOKEN");
  const readRaw = readSecretFromEnvOrFile(env, "STAGEFLOW_READ_TOKEN");
  return {
    driveDigest: driveRaw
      ? digest(validateToken(driveRaw, "STAGEFLOW_CONTROL_TOKEN"))
      : undefined,
    readDigest: readRaw
      ? digest(validateToken(readRaw, "STAGEFLOW_READ_TOKEN"))
      : undefined,
  };
}

/** Plain bearer for CLI→host calls. Drive preferred; read only for GET/HEAD. */
export function resolveClientBearerToken(
  method: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const driveRaw = readSecretFromEnvOrFile(env, "STAGEFLOW_CONTROL_TOKEN");
  if (driveRaw !== undefined) {
    return validateToken(driveRaw, "STAGEFLOW_CONTROL_TOKEN");
  }
  if (method === "GET" || method === "HEAD") {
    const readRaw = readSecretFromEnvOrFile(env, "STAGEFLOW_READ_TOKEN");
    if (readRaw !== undefined) {
      return validateToken(readRaw, "STAGEFLOW_READ_TOKEN");
    }
  }
  return undefined;
}

export function clientAuthorizationHeaders(
  method: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const token = resolveClientBearerToken(method, env);
  if (token === undefined) return {};
  return { Authorization: `Bearer ${token}` };
}

export function hasDriveToken(tokens: ControlTokens): boolean {
  return tokens.driveDigest !== undefined;
}

export function hasAnyToken(tokens: ControlTokens): boolean {
  return tokens.driveDigest !== undefined || tokens.readDigest !== undefined;
}

export function isLoopbackBind(bind: string): boolean {
  const normalized = bind.startsWith("[") && bind.endsWith("]")
    ? bind.slice(1, -1)
    : bind;
  return isLoopbackHostname(normalized);
}

export function refuseBindMessage(bind: string): string {
  return `Refusing to start: Stageflow is configured to bind ${bind}, which is reachable from outside this
machine, but no control token is set.

Anyone who can reach this port could start a pipeline run, and pipeline stages execute arbitrary
shell commands with this process's environment — including provider API keys.

Set one of:
  STAGEFLOW_CONTROL_TOKEN=<at least 32 characters>
  STAGEFLOW_CONTROL_TOKEN_FILE=/path/to/secret

Or bind to loopback instead:
  --host 127.0.0.1   (or unset STAGEFLOW_BIND)`;
}

export function assertBindAllowed(bind: string, tokens: ControlTokens): void {
  if (!isLoopbackBind(bind) && !hasDriveToken(tokens)) {
    throw new BindRefusedError(refuseBindMessage(bind));
  }
}

export class BindRefusedError extends Error {
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = "BindRefusedError";
  }
}

export function requiredScopeFor(
  method: string,
  pathname: string,
): ControlScope | null {
  if (pathname === "/mcp") return "drive";
  if (!pathname.startsWith("/api/")) return null;
  // Slot 7 replaces this exemption with /livez + gated /api/health.
  if (pathname === "/api/health" && (method === "GET" || method === "HEAD")) {
    return null;
  }
  if (method === "GET" || method === "HEAD") return "read";
  return "drive";
}

export function authenticateBearer(
  tokens: ControlTokens,
  authorization: string | undefined,
): ControlScope | undefined {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match) return undefined;
  const hash = digest(match[1]!);
  if (tokens.driveDigest && timingSafeEqual(tokens.driveDigest, hash)) {
    return "drive";
  }
  if (tokens.readDigest && timingSafeEqual(tokens.readDigest, hash)) {
    return "read";
  }
  return undefined;
}

function scopeSatisfies(
  granted: ControlScope,
  required: ControlScope,
): boolean {
  if (required === "read") return granted === "read" || granted === "drive";
  return granted === "drive";
}

export function enforceBearerAuth(
  tokens: ControlTokens,
  req: IncomingMessage,
  res: ServerResponse,
  required: ControlScope,
): boolean {
  if (!hasAnyToken(tokens)) return true;
  const granted = authenticateBearer(tokens, req.headers.authorization);
  if (granted === undefined) {
    const payload = JSON.stringify({ error: "Unauthorized" });
    res.writeHead(401, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "WWW-Authenticate": "Bearer",
    });
    res.end(payload);
    return false;
  }
  if (!scopeSatisfies(granted, required)) {
    const payload = JSON.stringify({ error: "Forbidden" });
    res.writeHead(403, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
    return false;
  }
  return true;
}
