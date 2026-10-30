import { startLocalOidcProvider, type LocalOidcProvider } from "./localOidcProvider.js";

export const HOSTED_TEST_IDP_NAME = "stageflow-hosted-test-idp";

/** One loopback OpenID provider used as a separate origin from the Host. Not an enterprise IdP. */
export async function startHostedOidcProvider(options: { subject?: string; deny?: boolean } = {}): Promise<LocalOidcProvider> {
  const provider = await startLocalOidcProvider({ ...options, name: HOSTED_TEST_IDP_NAME });
  if (provider.name !== HOSTED_TEST_IDP_NAME) throw new Error("hosted test IdP name drifted");
  return provider;
}
