import type { ChannelConnectionListing, ChannelMeta } from "../../api";
import { providerOf } from "../connections/channelMeta";
import type { StageChannelEntry } from "../workshop/inspector/stageFields";

export type TargetSpec = {
  toLabel: string;
  toPlaceholder: string;
  multiple: boolean;
  cc: boolean;
  template: boolean;
};

const FALLBACK: TargetSpec = { toLabel: "To", toPlaceholder: "", multiple: false, cc: false, template: false };

/** The recipient field for a provider, from the host's description of it. */
export function targetSpec(provider: string | undefined, meta?: ChannelMeta | null): TargetSpec {
  const recipient = providerOf(meta, provider ?? "")?.recipient;
  return recipient
    ? { toLabel: recipient.label, toPlaceholder: recipient.placeholder, multiple: recipient.multiple, cc: recipient.cc, template: recipient.template }
    : FALLBACK;
}

export function splitList(text: string): string[] {
  return text.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
}

export function recipientsText(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? value.join(", ") : value;
}

/** A single recipient stays a string; several become a list. Empty text is an empty string. */
export function parseTo(text: string, multiple: boolean): string | string[] {
  if (!multiple) return text.trim();
  const parts = splitList(text);
  return parts.length === 1 ? parts[0]! : parts;
}

export function emptyChannelEntry(connections: readonly ChannelConnectionListing[]): StageChannelEntry {
  const first = connections.find((connection) => connection.enabled) ?? connections[0];
  return { connection: first?.id ?? "", to: "", operations: ["send"] };
}

export function channelKey(entry: Pick<StageChannelEntry, "alias" | "connection">): string {
  return entry.alias ?? entry.connection;
}

/** Entry names must be unique within a stage. Returns the names that collide. */
export function duplicateKeys(entries: readonly StageChannelEntry[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    const key = channelKey(entry);
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

export function isFilled(entry: StageChannelEntry): boolean {
  return Boolean(entry.connection) && (Array.isArray(entry.to) ? entry.to.length > 0 : entry.to.trim().length > 0);
}

/** The body the validate-target endpoint expects. */
export function targetBody(entry: StageChannelEntry): { to: string | string[]; cc?: string[]; template?: Record<string, unknown> } {
  return {
    to: entry.to,
    ...(entry.cc && entry.cc.length > 0 ? { cc: entry.cc } : {}),
    ...(entry.template ? { template: entry.template } : {}),
  };
}

export type TemplateDraft = { name: string; languageCode: string; bodyParams: string };

export function templateToDraft(template: Record<string, unknown> | undefined): TemplateDraft {
  return {
    name: typeof template?.name === "string" ? template.name : "",
    languageCode: typeof template?.languageCode === "string" ? template.languageCode : "",
    bodyParams: Array.isArray(template?.bodyParams) ? template.bodyParams.map(String).join(", ") : "",
  };
}

export function draftToTemplate(draft: TemplateDraft): Record<string, unknown> | undefined {
  if (!draft.name.trim() && !draft.languageCode.trim() && !draft.bodyParams.trim()) return undefined;
  const params = draft.bodyParams.split(",").map((part) => part.trim()).filter(Boolean);
  return {
    name: draft.name.trim(),
    languageCode: draft.languageCode.trim(),
    ...(params.length > 0 ? { bodyParams: params } : {}),
  };
}

export type ConnectionNote = { tone: "ok" | "warn" | "muted"; text: string };

/** One line telling the user what the editor knows about the selected connection. */
export function connectionNote(connection: ChannelConnectionListing | undefined, id: string): ConnectionNote {
  if (!id) return { tone: "warn", text: "Choose a connection" };
  if (!connection) return { tone: "warn", text: `"${id}" is not defined in connections` };
  if (!connection.enabled) return { tone: "warn", text: "Disabled in connections.yaml" };
  if (!connection.health) return { tone: "muted", text: "Not checked yet" };
  if (connection.health.state === "ok") return { tone: "ok", text: "Connected" };
  return { tone: "warn", text: connection.health.error?.code === "CHANNEL_SECRET_UNAVAILABLE" ? "Not connected" : "Connection broken" };
}
