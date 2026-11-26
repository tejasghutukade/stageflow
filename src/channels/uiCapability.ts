import type { ChannelUiCapability } from "./types.js";

export const BUILTIN_CHANNEL_PROVIDER_IDS = ["agentmail", "imessage", "slack", "telegram", "whatsapp"] as const;

export type BuiltinChannelProviderId = (typeof BUILTIN_CHANNEL_PROVIDER_IDS)[number];

/** Operator-console web chat embed (not a connections provider). */
export const WEB_CHAT_UI_CAPABILITY: ChannelUiCapability = "interactive";

/**
 * Declared ui capability per built-in channel provider. A `Record` over the id union makes a missing
 * provider a compile error when a new one is added.
 */
export const CHANNEL_PROVIDER_UI_CAPABILITY: Record<BuiltinChannelProviderId, ChannelUiCapability> = {
  agentmail: "link",
  imessage: "link",
  slack: "link",
  telegram: "link",
  whatsapp: "link",
};

export function channelUiCapabilityForProvider(providerId: string): ChannelUiCapability {
  return (CHANNEL_PROVIDER_UI_CAPABILITY as Record<string, ChannelUiCapability | undefined>)[providerId] ?? "link";
}