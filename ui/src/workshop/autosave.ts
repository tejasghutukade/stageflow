import type { ChatMessage, DraftPackage } from "./draft";

export const WORKSHOP_UNTITLED_AUTOSAVE_KEY = "__untitled__";

export type WorkshopAutosaveDestination = {
  directory: string;
  pipelineFilename?: string;
};

export type WorkshopAutosavePayload = {
  version: 1;
  key: string;
  updatedAt: string;
  draft: DraftPackage;
  messages: ChatMessage[];
  autoApply: boolean;
  sessionModelOverride?: string | null;
  destination?: WorkshopAutosaveDestination | null;
  savedPath?: string | null;
  savedTaskPath?: string | null;
  diskFingerprints?: Record<string, string>;
};

export function workshopAutosaveSlotKey(
  pipelinePath: string | null | undefined,
): string {
  const trimmed = pipelinePath?.trim();
  if (!trimmed) return WORKSHOP_UNTITLED_AUTOSAVE_KEY;
  return trimmed.replace(/\\/g, "/");
}

export function workshopSessionFingerprint(input: {
  draft: DraftPackage;
  messages: ChatMessage[];
  autoApply: boolean;
  sessionModelOverride?: string | null;
}): string {
  return JSON.stringify({
    draft: input.draft,
    messages: input.messages,
    autoApply: input.autoApply,
    sessionModelOverride: input.sessionModelOverride ?? null,
  });
}

export const DIRTY_LEAVE_CONFIRM =
  "You have unsaved Workshop changes. Leave anyway? Your draft is autosaved and can be resumed.";

export const DIRTY_DISCARD_CONFIRM =
  "Discard this Workshop draft? This clears the autosave and cannot be undone.";

export const DIRTY_NEW_CONFIRM =
  "Start a new Workshop draft? The current autosave slot will be cleared.";
