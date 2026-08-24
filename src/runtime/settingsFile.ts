import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { storeRootFor } from "../runstore/paths.js";

export const SETTINGS_FILE_NAME = "settings.json";

export const INVALID_SLOT_COUNT_MESSAGE =
  "maxConcurrent must be an integer >= 1";

export const INVALID_CREDENTIAL_SOURCE_MESSAGE =
  'credentialSource must be "pi_home" or "sf_owned"';

export type CredentialSource = "pi_home" | "sf_owned";

export type FactorySettings = {
  maxConcurrent?: number;
  credentialSource?: CredentialSource;
};

export function settingsFilePath(cwd: string): string {
  return path.join(storeRootFor(cwd), SETTINGS_FILE_NAME);
}

export function parseSlotCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

export function parseCredentialSource(
  value: unknown,
): CredentialSource | undefined {
  if (value === "pi_home" || value === "sf_owned") {
    return value;
  }
  return undefined;
}

function readRawSettings(cwd: string): Record<string, unknown> {
  const filePath = settingsFilePath(cwd);
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }
    return raw as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readFactorySettings(cwd: string): FactorySettings {
  const raw = readRawSettings(cwd);
  const settings: FactorySettings = {};
  const maxConcurrent = parseSlotCount(raw.maxConcurrent);
  if (maxConcurrent !== undefined) {
    settings.maxConcurrent = maxConcurrent;
  }
  const credentialSource = parseCredentialSource(raw.credentialSource);
  if (credentialSource !== undefined) {
    settings.credentialSource = credentialSource;
  }
  return settings;
}

export function writeFactorySettings(
  cwd: string,
  patch: FactorySettings,
): void {
  if (
    patch.credentialSource !== undefined &&
    parseCredentialSource(patch.credentialSource) === undefined
  ) {
    throw new Error(INVALID_CREDENTIAL_SOURCE_MESSAGE);
  }
  if (
    patch.maxConcurrent !== undefined &&
    parseSlotCount(patch.maxConcurrent) === undefined
  ) {
    throw new Error(INVALID_SLOT_COUNT_MESSAGE);
  }

  const current = readFactorySettings(cwd);
  const next: FactorySettings = { ...current };
  if (patch.maxConcurrent !== undefined) {
    next.maxConcurrent = patch.maxConcurrent;
  }
  if (patch.credentialSource !== undefined) {
    next.credentialSource = patch.credentialSource;
  }

  const out: Record<string, unknown> = {};
  if (next.maxConcurrent !== undefined) {
    out.maxConcurrent = next.maxConcurrent;
  }
  if (next.credentialSource !== undefined) {
    out.credentialSource = next.credentialSource;
  }

  mkdirSync(storeRootFor(cwd), { recursive: true });
  writeFileSync(
    settingsFilePath(cwd),
    `${JSON.stringify(out, null, 2)}\n`,
    "utf8",
  );
}

export function readMaxConcurrentFromFile(cwd: string): number | undefined {
  return readFactorySettings(cwd).maxConcurrent;
}

export function writeMaxConcurrentToFile(
  cwd: string,
  maxConcurrent: number,
): void {
  writeFactorySettings(cwd, { maxConcurrent });
}

export function readCredentialSourceFromFile(
  cwd: string,
): CredentialSource | undefined {
  return readFactorySettings(cwd).credentialSource;
}

export function writeCredentialSourceToFile(
  cwd: string,
  credentialSource: CredentialSource,
): void {
  writeFactorySettings(cwd, { credentialSource });
}
