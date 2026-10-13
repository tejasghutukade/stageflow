import type {
  CredentialSource,
  ProviderAuthStatus,
  ProviderSummary,
  ProvidersDetectResult,
} from "../api";

export const PROVIDERS_PI_COPY =
  "Connect model providers here. Stageflow stores credentials in the operator auth file (~/.stageflow/agent/auth.json). Override the directory with STAGEFLOW_CREDENTIAL_HOME.";

export function cursorModelReady(detect: ProvidersDetectResult): boolean {
  return (
    detect.cursorSdkReady === true && detect.cursorApiKeyConfigured === true
  );
}

export function needsFirstRun(
  detect: ProvidersDetectResult,
  configuredCount: number,
): boolean {
  if (configuredCount > 0) return false;
  if (cursorModelReady(detect)) return false;
  if (detect.credentialSource === undefined) return true;
  return true;
}

export function providerAllowsApiKey(provider: ProviderSummary): boolean {
  return provider.supportsApiKey;
}

export function providerOauthOnly(provider: ProviderSummary): boolean {
  return provider.supportsOauth && !provider.supportsApiKey;
}

export function statusLabel(status: ProviderAuthStatus | undefined): string {
  if (!status) return "Unknown";
  if (!status.configured) return "Not connected";
  if (status.authKind === "oauth") return "Connected (OAuth)";
  if (status.authKind === "api_key") return "Connected (API key)";
  return "Connected";
}

export function isProviderAuthReady(input: {
  credentialSource?: CredentialSource;
  configuredCount: number;
  detect?: ProvidersDetectResult;
}): boolean {
  if (input.configuredCount > 0) return true;
  if (input.detect !== undefined && cursorModelReady(input.detect)) return true;
  if (input.credentialSource === undefined) return false;
  return false;
}

export function countConfigured(
  statuses: ReadonlyArray<ProviderAuthStatus | undefined>,
): number {
  return statuses.filter((s) => s?.configured === true).length;
}
