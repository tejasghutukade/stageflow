import { parseUiPart, UI_PART_KIND_ERROR, type UiPart } from "../artifacts/uiPart.js";
import type { ChannelUiCapability } from "./types.js";
import { channelUiCapabilityForProvider } from "./uiCapability.js";

export type RenderUiPartForChannelOptions = {
  /** When false, `link` (and `image` without a snapshot) show fallback text only. */
  consoleAccess?: boolean;
  /** Optional snapshot URL when capability is `image`. Not produced yet. */
  snapshotUrl?: string | null;
};

export function renderUiPartForChannel(
  part: UiPart,
  capability: ChannelUiCapability,
  options: RenderUiPartForChannelOptions = {},
): string {
  if (part.kind === UI_PART_KIND_ERROR) return part.fallback.text;
  switch (capability) {
    case "interactive":
      return part.fallback.text;
    case "image": {
      const body = renderUiPartForChannel(part, "link", options);
      const snapshot = options.snapshotUrl?.trim();
      return snapshot ? `${body}\n${snapshot}` : body;
    }
    case "link":
      if (options.consoleAccess === false) return part.fallback.text;
      return `${part.title}\n${part.fallback.url}`;
    default: {
      const exhaustive: never = capability;
      return exhaustive;
    }
  }
}

export function renderUnknownUiPartForChannel(
  part: unknown,
  capability: ChannelUiCapability,
  options?: RenderUiPartForChannelOptions,
): string {
  const parsed = parseUiPart(part);
  if (!parsed.ok) return "";
  return renderUiPartForChannel(parsed.part, capability, options);
}

export function assistantMessageTextForChannel(
  message: { text: string; parts?: readonly unknown[] },
  providerId: string,
  options: RenderUiPartForChannelOptions = {},
): string {
  const capability = channelUiCapabilityForProvider(providerId);
  const extras = (message.parts ?? [])
    .map((part) => renderUnknownUiPartForChannel(part, capability, options))
    .filter((line) => line.length > 0);
  return [message.text.trim(), ...extras].filter((chunk) => chunk.length > 0).join("\n\n");
}

/** Protected web-chat visitors have no console token; summarize ui in plain text. */
export function webChatVisitorAssistantText(message: { text: string; parts?: readonly unknown[] }): string {
  return assistantMessageTextForChannel(message, "slack", { consoleAccess: false });
}