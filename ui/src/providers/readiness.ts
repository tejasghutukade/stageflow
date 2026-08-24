import {
  fetchProviderAuth,
  fetchProviders,
  fetchProvidersDetect,
  type CredentialSource,
} from "../api";
import {
  countConfigured,
  isProviderAuthReady,
  needsFirstRun,
} from "./helpers";

export type ProviderAuthReadiness = {
  ready: boolean;
  credentialSource?: CredentialSource;
  message?: string;
};

export async function loadProviderAuthReadiness(): Promise<ProviderAuthReadiness> {
  const detect = await fetchProvidersDetect();
  if (needsFirstRun(detect)) {
    return {
      ready: false,
      message:
        "Connect providers before starting a run. Choose an existing Pi login or add API keys in Stageflow.",
    };
  }
  const credentialSource = detect.credentialSource;
  if (credentialSource === "pi_home") {
    return { ready: true, credentialSource };
  }

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
  if (
    !isProviderAuthReady({
      credentialSource,
      configuredCount,
    })
  ) {
    return {
      ready: false,
      credentialSource,
      message:
        "Connect at least one provider API key in Settings → Providers (or #/connect) before starting a run.",
    };
  }
  return { ready: true, credentialSource };
}
