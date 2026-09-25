import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readSecretFromEnvOrFile } from "../config/secretFromEnvOrFile.js";
import { isLoopbackHostname } from "./allowedHosts.js";

export type ControlScope = "read" | "drive";

export type BearerAuth = {
  scope: ControlScope;
  caller_id: string;
};

export type NamedDriveToken = {
  caller_id: string;
  digest: Buffer;
};

export type ControlTokens = {
  driveDigest: Buffer | undefined;
  readDigest: Buffer | undefined;
  namedDrive: readonly NamedDriveToken[];
};

const CONTROL_TOKEN_PREFIX = "STAGEFLOW_CONTROL_TOKEN_";
const DEFAULT_CALLER_ID = "default";

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

function normalizeCallerId(name: string): string {
  return name.toLowerCase();
}

/** Parse named drive callers from STAGEFLOW_CONTROL_TOKEN_<NAME> / _FILE. */
export function listNamedControlTokenEnvKeys(
  env: NodeJS.ProcessEnv = process.env,
): Array<{ envKey: string; caller_id: string; isFile: boolean }> {
  const out: Array<{ envKey: string; caller_id: string; isFile: boolean }> = [];
  const seen = new Set<string>();
  for (const key of Object.keys(env)) {
    if (!key.startsWith(CONTROL_TOKEN_PREFIX)) continue;
    let namePart: string;
    let isFile = false;
    if (key.endsWith("_FILE")) {
      namePart = key.slice(CONTROL_TOKEN_PREFIX.length, -"_FILE".length);
      isFile = true;
    } else {
      namePart = key.slice(CONTROL_TOKEN_PREFIX.length);
    }
    if (namePart === "" || namePart === "FILE") continue;
    const caller_id = normalizeCallerId(namePart);
    const dedupe = `${caller_id}:${isFile ? "file" : "plain"}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ envKey: key, caller_id, isFile });
  }
  return out;
}

function assertUniqueDigests(
  entries: Array<{ label: string; digest: Buffer }>,
): void {
  const byHex = new Map<string, string>();
  for (const entry of entries) {
    const hex = entry.digest.toString("hex");
    const prior = byHex.get(hex);
    if (prior !== undefined) {
      throw new Error(
        `Duplicate control token digests for ${prior} and ${entry.label}`,
      );
    }
    byHex.set(hex, entry.label);
  }
}

export function loadControlTokens(
  env: NodeJS.ProcessEnv = process.env,
): ControlTokens {
  const driveRaw = readSecretFromEnvOrFile(env, "STAGEFLOW_CONTROL_TOKEN");
  const readRaw = readSecretFromEnvOrFile(env, "STAGEFLOW_READ_TOKEN");

  const callerBases = new Map<string, string>();
  for (const named of listNamedControlTokenEnvKeys(env)) {
    const base = named.isFile
      ? named.envKey.slice(0, -"_FILE".length)
      : named.envKey;
    if (!callerBases.has(named.caller_id)) {
      callerBases.set(named.caller_id, base);
    }
  }

  const namedDrive: NamedDriveToken[] = [];
  for (const [caller_id, base] of callerBases) {
    const raw = readSecretFromEnvOrFile(env, base);
    if (raw === undefined) continue;
    namedDrive.push({
      caller_id,
      digest: digest(validateToken(raw, base)),
    });
  }

  const driveDigest = driveRaw
    ? digest(validateToken(driveRaw, "STAGEFLOW_CONTROL_TOKEN"))
    : undefined;
  const readDigest = readRaw
    ? digest(validateToken(readRaw, "STAGEFLOW_READ_TOKEN"))
    : undefined;

  const uniqueness: Array<{ label: string; digest: Buffer }> = [];
  if (driveDigest) {
    uniqueness.push({ label: "STAGEFLOW_CONTROL_TOKEN", digest: driveDigest });
  }
  if (readDigest) {
    uniqueness.push({ label: "STAGEFLOW_READ_TOKEN", digest: readDigest });
  }
  for (const named of namedDrive) {
    uniqueness.push({
      label: `STAGEFLOW_CONTROL_TOKEN_${named.caller_id}`,
      digest: named.digest,
    });
  }
  assertUniqueDigests(uniqueness);

  return { driveDigest, readDigest, namedDrive };
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
  return tokens.driveDigest !== undefined || tokens.namedDrive.length > 0;
}

export function hasAnyToken(tokens: ControlTokens): boolean {
  return (
    tokens.driveDigest !== undefined ||
    tokens.readDigest !== undefined ||
    tokens.namedDrive.length > 0
  );
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
  STAGEFLOW_CONTROL_TOKEN_<NAME>=<at least 32 characters>

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
  if (pathname === "/api/backup" || pathname.startsWith("/api/backup/")) {
    return "drive";
  }
  if (method === "GET" || method === "HEAD") return "read";
  return "drive";
}

/**
 * Digest once; timingSafeEqual against every loaded digest (no early-return oracle).
 * Named control tokens are drive-only; READ stays the singular global token.
 */
export function authenticateBearer(
  tokens: ControlTokens,
  authorization: string | undefined,
): BearerAuth | undefined {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match) return undefined;
  const hash = digest(match[1]!);

  type Candidate = { scope: ControlScope; caller_id: string; digest: Buffer };
  const candidates: Candidate[] = [];
  if (tokens.driveDigest) {
    candidates.push({
      scope: "drive",
      caller_id: DEFAULT_CALLER_ID,
      digest: tokens.driveDigest,
    });
  }
  if (tokens.readDigest) {
    candidates.push({
      scope: "read",
      caller_id: DEFAULT_CALLER_ID,
      digest: tokens.readDigest,
    });
  }
  for (const named of tokens.namedDrive) {
    candidates.push({
      scope: "drive",
      caller_id: named.caller_id,
      digest: named.digest,
    });
  }

  let matched: BearerAuth | undefined;
  for (const candidate of candidates) {
    if (timingSafeEqual(candidate.digest, hash)) {
      matched = { scope: candidate.scope, caller_id: candidate.caller_id };
    }
  }
  return matched;
}

function scopeSatisfies(
  granted: ControlScope,
  required: ControlScope,
): boolean {
  if (required === "read") return granted === "read" || granted === "drive";
  return granted === "drive";
}

export type EnforceBearerResult =
  | { ok: true; auth: BearerAuth | undefined }
  | { ok: false };

export function enforceBearerAuth(
  tokens: ControlTokens,
  req: IncomingMessage,
  res: ServerResponse,
  required: ControlScope,
): EnforceBearerResult {
  if (!hasAnyToken(tokens)) return { ok: true, auth: undefined };
  const granted = authenticateBearer(tokens, req.headers.authorization);
  if (granted === undefined) {
    const payload = JSON.stringify({ error: "Unauthorized" });
    res.writeHead(401, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "WWW-Authenticate": "Bearer",
    });
    res.end(payload);
    return { ok: false };
  }
  if (!scopeSatisfies(granted.scope, required)) {
    const payload = JSON.stringify({ error: "Forbidden" });
    res.writeHead(403, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
    return { ok: false };
  }
  return { ok: true, auth: granted };
}
