import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectContext } from "../project/resolveProjectContext.js";
import type { StageflowContext } from "../project/resolveStageflowContext.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { storeRootFor } from "../runstore/paths.js";

export const SETTINGS_FILE_NAME = "settings.json";

export const INVALID_SLOT_COUNT_MESSAGE =
  "maxConcurrent must be an integer >= 1";

export const INVALID_CREDENTIAL_SOURCE_MESSAGE =
  'credentialSource must be "pi_home" or "sf_owned"';

export const INVALID_WORKSHOP_MODEL_MESSAGE =
  "workshopModel must be a non-empty string";

export type CredentialSource = "pi_home" | "sf_owned";

export type FactorySettings = {
  maxConcurrent?: number;
  credentialSource?: CredentialSource;
  workshopModel?: string;
};

export function globalSettingsFilePath(): string {
  return path.join(globalStageflowHome(), SETTINGS_FILE_NAME);
}

export function settingsFilePathForContext(ctx: ProjectContext | StageflowContext): string {
  if (ctx.isGitProject) {
    return path.join(storeRootFor(ctx.projectRoot), SETTINGS_FILE_NAME);
  }
  if (path.resolve(ctx.projectRoot) === path.resolve(os.homedir())) {
    return path.join(ctx.globalHome, SETTINGS_FILE_NAME);
  }
  return path.join(storeRootFor(ctx.projectRoot), SETTINGS_FILE_NAME);
}

export function settingsFilePath(cwd: string): string {
  return path.join(storeRootFor(path.resolve(cwd)), SETTINGS_FILE_NAME);
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

export function parseWorkshopModelSetting(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRawSettingsFromFile(filePath: string): Record<string, unknown> {
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

function readRawSettings(ctx: ProjectContext): Record<string, unknown> {
  return readRawSettingsFromFile(settingsFilePathForContext(ctx));
}

function parseFactorySettingsFromRaw(
  raw: Record<string, unknown>,
): FactorySettings {
  const settings: FactorySettings = {};
  const maxConcurrent = parseSlotCount(raw.maxConcurrent);
  if (maxConcurrent !== undefined) {
    settings.maxConcurrent = maxConcurrent;
  }
  const credentialSource = parseCredentialSource(raw.credentialSource);
  if (credentialSource !== undefined) {
    settings.credentialSource = credentialSource;
  }
  const workshopModel = parseWorkshopModelSetting(raw.workshopModel);
  if (workshopModel !== undefined) {
    settings.workshopModel = workshopModel;
  }
  return settings;
}

function serializeFactorySettings(next: FactorySettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (next.maxConcurrent !== undefined) {
    out.maxConcurrent = next.maxConcurrent;
  }
  if (next.credentialSource !== undefined) {
    out.credentialSource = next.credentialSource;
  }
  if (next.workshopModel !== undefined) {
    out.workshopModel = next.workshopModel;
  }
  return out;
}

function applyFactorySettingsPatch(
  current: FactorySettings,
  patch: FactorySettings,
): FactorySettings {
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
  if (
    patch.workshopModel !== undefined &&
    parseWorkshopModelSetting(patch.workshopModel) === undefined
  ) {
    throw new Error(INVALID_WORKSHOP_MODEL_MESSAGE);
  }

  const next: FactorySettings = { ...current };
  if (patch.maxConcurrent !== undefined) {
    next.maxConcurrent = patch.maxConcurrent;
  }
  if (patch.credentialSource !== undefined) {
    next.credentialSource = patch.credentialSource;
  }
  if (patch.workshopModel !== undefined) {
    next.workshopModel = parseWorkshopModelSetting(patch.workshopModel);
  }
  return next;
}

export function readCredentialSourceFromContext(
  ctx: ProjectContext,
): CredentialSource | undefined {
  if (ctx.isGitProject) {
    const fromProject = parseCredentialSource(
      readRawSettingsFromFile(settingsFilePathForContext(ctx)).credentialSource,
    );
    if (fromProject !== undefined) {
      return fromProject;
    }
  }
  return parseCredentialSource(
    readRawSettingsFromFile(globalSettingsFilePath()).credentialSource,
  );
}

export function readPersistedCredentialSourceFromContext(
  ctx: ProjectContext,
): CredentialSource | undefined {
  return parseCredentialSource(
    readRawSettingsFromFile(settingsFilePathForContext(ctx)).credentialSource,
  );
}

export function readFactorySettingsForContext(
  ctx: ProjectContext,
): FactorySettings {
  return parseFactorySettingsFromRaw(readRawSettings(ctx));
}

export function readFactorySettings(cwd: string): FactorySettings {
  return parseFactorySettingsFromRaw(
    readRawSettingsFromFile(settingsFilePath(cwd)),
  );
}

function ensureSettingsDirForContext(ctx: ProjectContext): void {
  mkdirSync(path.dirname(settingsFilePathForContext(ctx)), { recursive: true });
}

export function writeFactorySettingsForContext(
  ctx: ProjectContext,
  patch: FactorySettings,
): void {
  const next = applyFactorySettingsPatch(
    readFactorySettingsForContext(ctx),
    patch,
  );
  const out = serializeFactorySettings(next);

  ensureSettingsDirForContext(ctx);
  writeFileSync(
    settingsFilePathForContext(ctx),
    `${JSON.stringify(out, null, 2)}\n`,
    "utf8",
  );
}

export function writeFactorySettings(
  cwd: string,
  patch: FactorySettings,
): void {
  const next = applyFactorySettingsPatch(readFactorySettings(cwd), patch);
  const out = serializeFactorySettings(next);

  const root = path.resolve(cwd);
  mkdirSync(storeRootFor(root), { recursive: true });
  writeFileSync(
    settingsFilePath(cwd),
    `${JSON.stringify(out, null, 2)}\n`,
    "utf8",
  );
}

export function readMaxConcurrentFromContext(
  ctx: ProjectContext,
): number | undefined {
  return readFactorySettingsForContext(ctx).maxConcurrent;
}

export function readMaxConcurrentFromFile(cwd: string): number | undefined {
  return readFactorySettings(cwd).maxConcurrent;
}

export function writeMaxConcurrentToContext(
  ctx: ProjectContext,
  maxConcurrent: number,
): void {
  writeFactorySettingsForContext(ctx, { maxConcurrent });
}

export function writeMaxConcurrentToFile(
  cwd: string,
  maxConcurrent: number,
): void {
  writeFactorySettings(cwd, { maxConcurrent });
}

export function readMaxConcurrentFromGlobal(): number | undefined {
  return parseFactorySettingsFromRaw(
    readRawSettingsFromFile(globalSettingsFilePath()),
  ).maxConcurrent;
}

export function writeMaxConcurrentToGlobal(maxConcurrent: number): void {
  if (parseSlotCount(maxConcurrent) === undefined) {
    throw new Error(INVALID_SLOT_COUNT_MESSAGE);
  }
  const current = parseFactorySettingsFromRaw(
    readRawSettingsFromFile(globalSettingsFilePath()),
  );
  const next = applyFactorySettingsPatch(current, { maxConcurrent });
  const out = serializeFactorySettings(next);
  mkdirSync(path.dirname(globalSettingsFilePath()), { recursive: true });
  writeFileSync(
    globalSettingsFilePath(),
    `${JSON.stringify(out, null, 2)}\n`,
    "utf8",
  );
}

export function readWorkshopModelFromFile(cwd: string): string | undefined {
  return readFactorySettings(cwd).workshopModel;
}

export function writeWorkshopModelToFile(
  cwd: string,
  workshopModel: string,
): void {
  writeFactorySettings(cwd, { workshopModel });
}

export function readCredentialSourceFromFile(
  cwd: string,
): CredentialSource | undefined {
  return readFactorySettings(cwd).credentialSource;
}

export function writeCredentialSourceToContext(
  ctx: ProjectContext,
  credentialSource: CredentialSource,
): void {
  writeFactorySettingsForContext(ctx, { credentialSource });
}

export function writeCredentialSourceToFile(
  cwd: string,
  credentialSource: CredentialSource,
): void {
  writeFactorySettings(cwd, { credentialSource });
}

export function projectSettingsContext(
  cwd: string,
  projectRoot: string,
  isGitProject: boolean,
): ProjectContext {
  return {
    invocationCwd: path.resolve(cwd),
    projectRoot: path.resolve(projectRoot),
    globalHome: globalStageflowHome(),
    isGitProject,
  };
}
