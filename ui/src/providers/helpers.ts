import type {
  CredentialSource,
  PiHomeDetectResult,
  ProviderAuthStatus,
  ProviderSummary,
} from "../api";

export const PROVIDERS_PI_COPY =
  "Providers are connected through Pi. Stageflow binds the credential store you choose; it is not a standalone non-Pi LLM client.";

export function needsFirstRun(detect: PiHomeDetectResult): boolean {
  return detect.credentialSource === undefined;
}

export function defaultOfferChoice(piHomeUsable: boolean): CredentialSource {
  return piHomeUsable ? "pi_home" : "sf_owned";
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
}): boolean {
  if (input.credentialSource === undefined) return false;
  if (input.credentialSource === "pi_home") return true;
  return input.configuredCount > 0;
}

export function countConfigured(
  statuses: ReadonlyArray<ProviderAuthStatus | undefined>,
): number {
  return statuses.filter((s) => s?.configured === true).length;
}
