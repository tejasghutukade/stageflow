import {
  fetchProviderAuth,
  fetchProviders,
  fetchProvidersDetect,
  type CredentialSource,
} from "../api";
import { countConfigured, needsFirstRun } from "./helpers";

export type ProviderAuthReadiness = {
  ready: boolean;
  credentialSource?: CredentialSource;
  message?: string;
};

export async function loadProviderAuthReadiness(): Promise<ProviderAuthReadiness> {
  const detect = await fetchProvidersDetect();
  const listed = await fetchProviders();
  const statuses = await Promise.all(
    listed.providers.map(async (provider) => {
      try {
        const { provider: status } = await fetchProviderAuth(provider.id);
        return status;
      } catch {
        return undefined;
      }
    }),
  );
  const configuredCount = countConfigured(statuses);
  const credentialSource = detect.credentialSource;

  if (needsFirstRun(detect, configuredCount)) {
    if (credentialSource === undefined) {
      return {
        ready: false,
        message:
          "Connect providers before starting a run. Add API keys or OAuth in Stageflow, or set up Cursor (SDK) with CURSOR_API_KEY.",
      };
    }
    return {
      ready: false,
      credentialSource,
      message:
        "Connect at least one model provider in Settings → Providers (Pi API key or OAuth, or Cursor SDK with CURSOR_API_KEY) before starting a run.",
    };
  }

  return { ready: true, credentialSource };
}
