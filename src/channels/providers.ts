import type { AnyChannelProvider } from "./types.js";
import { createAgentMailProvider } from "./providers/agentmail.js";
import { createSlackProvider } from "./providers/slack.js";
import { createTelegramProvider } from "./providers/telegram.js";
import { createPhotonImessageProvider } from "./providers/photonImessage.js";

const providers = new Map<string, AnyChannelProvider>([
  ["agentmail", createAgentMailProvider() as AnyChannelProvider],
  ["slack", createSlackProvider() as AnyChannelProvider],
  ["telegram", createTelegramProvider() as AnyChannelProvider],
  ["imessage", createPhotonImessageProvider() as AnyChannelProvider],
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
