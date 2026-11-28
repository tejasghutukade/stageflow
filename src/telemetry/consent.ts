import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { TelemetryEnvSnapshot } from "./envSnapshot.js";

export type TelemetryLock = "env" | "ci" | null;

export type TelemetryConsentState = {
  enabled: boolean;
  storedEnabled: boolean;
  locked: TelemetryLock;
  installId: string;
  promptedVersion: number | null;
  decidedAt: string | null;
};

export type TelemetryConsentErrorCode = "TELEMETRY_LOCKED" | "TELEMETRY_STORAGE_FAILED";

export class TelemetryConsentError extends Error {
  readonly code: TelemetryConsentErrorCode;

  constructor(code: TelemetryConsentErrorCode, message: string) {
    super(message);
    this.name = "TelemetryConsentError";
    this.code = code;
  }
}

export type TelemetryConsentService = {
  getState(): TelemetryConsentState;
  setEnabled(enabled: boolean, promptedVersion?: number): TelemetryConsentState;
  resetInstallId(): TelemetryConsentState;
  isTelemetryEnabled(): boolean;
};

type StoredConsent = {
  enabled: boolean;
  decidedAt: string | null;
  promptedVersion: number | null;
  installId: string;
};

type LockPolicy = {
  locked: TelemetryLock;
  forceEnabled: boolean;
};

const FILE_NAME = "telemetry.json";

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function doNotTrackLocks(value: string | undefined): boolean {
  const flag = normalized(value);
  return flag === "1" || flag === "true";
}

function telemetryFlag(value: string | undefined): "on" | "off" | "unset" {
  const flag = normalized(value);
  if (flag === "1" || flag === "true") return "on";
  if (flag === "0" || flag === "false") return "off";
  return "unset";
}

function ciLocks(value: string | undefined): boolean {
  return normalized(value) === "true";
}

function lockPolicy(snapshot: TelemetryEnvSnapshot): LockPolicy {
  const flag = telemetryFlag(snapshot.stageflowTelemetry);
  if (doNotTrackLocks(snapshot.doNotTrack) || flag === "off") {
    return { locked: "env", forceEnabled: false };
  }
  if (flag === "on") return { locked: null, forceEnabled: true };
  if (ciLocks(snapshot.ci)) return { locked: "ci", forceEnabled: false };
  return { locked: null, forceEnabled: false };
}

function effectiveEnabled(stored: boolean, policy: LockPolicy): boolean {
  if (policy.locked !== null) return false;
  if (policy.forceEnabled) return true;
  return stored;
}

function isStoredConsent(value: unknown): value is StoredConsent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") return false;
  if (record.decidedAt !== null && typeof record.decidedAt !== "string") return false;
  if (
    record.promptedVersion !== null &&
    (typeof record.promptedVersion !== "number" || !Number.isInteger(record.promptedVersion))
  ) {
    return false;
  }
  return typeof record.installId === "string" && record.installId.length > 0;
}

function atomicWrite(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* the temp file may not exist */
    }
    throw error;
  }
}

function freshRecord(): StoredConsent {
  return {
    enabled: false,
    decidedAt: null,
    promptedVersion: null,
    installId: randomUUID(),
  };
}

export function createTelemetryConsent(options: {
  homeDir: string;
  snapshot: TelemetryEnvSnapshot;
}): TelemetryConsentService {
  const file = path.join(options.homeDir, FILE_NAME);
  const policy = lockPolicy(options.snapshot);

  function writeRecord(record: StoredConsent): void {
    try {
      atomicWrite(file, `${JSON.stringify({
        enabled: record.enabled,
        decidedAt: record.decidedAt,
        promptedVersion: record.promptedVersion,
        installId: record.installId,
      }, null, 2)}\n`);
    } catch (error) {
      if (error instanceof TelemetryConsentError) throw error;
      throw new TelemetryConsentError(
        "TELEMETRY_STORAGE_FAILED",
        "Telemetry consent file could not be written",
      );
    }
  }

  function readRecord(): StoredConsent {
    if (!existsSync(file)) {
      const created = freshRecord();
      writeRecord(created);
      return created;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new TelemetryConsentError(
        "TELEMETRY_STORAGE_FAILED",
        "Telemetry consent file is unreadable",
      );
    }
    if (!isStoredConsent(parsed)) {
      throw new TelemetryConsentError(
        "TELEMETRY_STORAGE_FAILED",
        "Telemetry consent file is invalid",
      );
    }
    return {
      enabled: parsed.enabled,
      decidedAt: parsed.decidedAt,
      promptedVersion: parsed.promptedVersion,
      installId: parsed.installId,
    };
  }

  function toState(record: StoredConsent): TelemetryConsentState {
    return {
      enabled: effectiveEnabled(record.enabled, policy),
      storedEnabled: record.enabled,
      locked: policy.locked,
      installId: record.installId,
      promptedVersion: record.promptedVersion,
      decidedAt: record.decidedAt,
    };
  }

  return {
    getState() {
      return toState(readRecord());
    },
    setEnabled(enabled, promptedVersion) {
      if (policy.locked !== null) {
        throw new TelemetryConsentError("TELEMETRY_LOCKED", "Telemetry consent is locked");
      }
      const current = readRecord();
      const next: StoredConsent = {
        enabled,
        decidedAt: new Date().toISOString(),
        promptedVersion: promptedVersion !== undefined ? promptedVersion : current.promptedVersion,
        installId: current.installId,
      };
      writeRecord(next);
      return toState(next);
    },
    resetInstallId() {
      const current = readRecord();
      const next: StoredConsent = { ...current, installId: randomUUID() };
      writeRecord(next);
      return toState(next);
    },
    isTelemetryEnabled() {
      return effectiveEnabled(readRecord().enabled, policy);
    },
  };
}
