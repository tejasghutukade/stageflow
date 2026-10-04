export const DEFAULT_WORKSHOP_MODEL = "anthropic/claude-sonnet-4-5";

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

function normalizeModelId(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
