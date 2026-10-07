import { globalModelFromManifest } from "../config/resolveModel.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { readFactorySettings } from "../runtime/settingsFile.js";

export const DEFAULT_WORKSHOP_MODEL = "cursor/auto";

export type ResolveWorkshopModelInput = {
  sessionOverride?: string | null;
  settingsDefault?: string | null;
  profileDefault?: string | null;
};

/**
 * Effective Workshop chat model: session override → Settings default → profile fallback.
 * Credentials stay on the shared Stageflow provider auth stack; this only picks a model id.
 */
export function resolveWorkshopModel(
  input: ResolveWorkshopModelInput = {},
): string {
  const session = normalizeModelId(input.sessionOverride);
  if (session) return session;
  const settings = normalizeModelId(input.settingsDefault);
  if (settings) return settings;
  const profile = normalizeModelId(input.profileDefault);
  if (profile) return profile;
  return DEFAULT_WORKSHOP_MODEL;
}

export function parseWorkshopModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Model selected when Workshop chat opens.
 * stageflow.yaml `model` wins; a saved Settings workshop model is used only
 * when the manifest has none.
 */
export async function readWorkshopOpenModel(cwd: string): Promise<string> {
  const ctx = await resolveStageflowContext(cwd);
  return resolveWorkshopModel({
    settingsDefault:
      globalModelFromManifest(ctx.manifest) ??
      readFactorySettings(cwd).workshopModel,
  });
}

function normalizeModelId(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
