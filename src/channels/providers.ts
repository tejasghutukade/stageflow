import type { AnyChannelProvider } from "./types.js";
import { createAgentMailProvider } from "./providers/agentmail.js";

const providers = new Map<string, AnyChannelProvider>([
  ["agentmail", createAgentMailProvider() as AnyChannelProvider],
]);

/** Built-in providers are listed in the initial map as they are implemented. */
export function channelProviders(): AnyChannelProvider[] {
  return [...providers.values()];
}

export function registerChannelProvider(provider: AnyChannelProvider): void {
  providers.set(provider.id, provider);
}

export function unregisterChannelProvider(id: string): void {
  providers.delete(id);
}
