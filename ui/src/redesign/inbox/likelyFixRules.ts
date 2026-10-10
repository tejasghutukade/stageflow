const PROVIDERS_SETTINGS_HREF = "#/settings?section=providers";

export type LikelyFix = {
  title: string;
  body: string;
  settingsHref: string;
};

export function matchLikelyFix(
  failedReason: string | undefined,
): LikelyFix | null {
  if (!failedReason?.trim()) return null;
  const reason = failedReason.toLowerCase();

  if (
    /openrouter/.test(reason) ||
    (/api[_\s-]?key/.test(reason) && /openrouter/.test(reason))
  ) {
    return {
      title: "OpenRouter credentials",
      body:
        "This failure often means the OpenRouter API key is missing, expired, or rejected. Add or update it under Providers.",
      settingsHref: PROVIDERS_SETTINGS_HREF,
    };
  }

  if (/anthropic/.test(reason)) {
    return {
      title: "Anthropic provider",
      body:
        "Check that Anthropic is connected and the API key is valid. Billing or rate limits can also surface as stage failures.",
      settingsHref: PROVIDERS_SETTINGS_HREF,
    };
  }

  if (
    /api[_\s-]?key/.test(reason) ||
    /invalid.*key/.test(reason) ||
    /missing.*key/.test(reason) ||
    /\b401\b/.test(reason) ||
    /unauthorized/.test(reason) ||
    /authentication failed/.test(reason) ||
    /invalid.*token/.test(reason)
  ) {
    return {
      title: "API key or auth",
      body:
        "The agent could not authenticate with the model provider. Confirm the API key in Settings → Providers.",
      settingsHref: PROVIDERS_SETTINGS_HREF,
    };
  }

  if (
    /provider/.test(reason) ||
    /model.*not.*found/.test(reason) ||
    /no model/.test(reason) ||
    /connection refused/.test(reason)
  ) {
    return {
      title: "Model provider",
      body:
        "Verify the selected provider is configured, reachable, and has access to the model this stage uses.",
      settingsHref: PROVIDERS_SETTINGS_HREF,
    };
  }

  return null;
}
