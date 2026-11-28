let warned = false;

export function resetLiveActionWarningForTests(): void {
  warned = false;
}

/** Levels 3 and 4 stay off. @OpenUrl is never followed. */
export function ignoreLiveArtifactAction(event: unknown): void {
  if (warned) return;
  warned = true;
  const type = event && typeof event === "object" && "type" in event ? String((event as { type: unknown }).type) : "action";
  console.warn(`Live artifact action ignored (${type}). Mutations, @ToAssistant, and @OpenUrl are disabled.`);
}
