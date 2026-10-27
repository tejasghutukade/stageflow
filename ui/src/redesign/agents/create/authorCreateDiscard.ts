/** Mirrors server `draftHasWork`: transcript or non-empty name/instructions/description. */
export function authorCreateDraftHasWork(
  definition: { name?: string; instructions?: string; description?: string },
  transcriptMessages: number,
): boolean {
  if (transcriptMessages > 0) return true;
  for (const key of ["name", "instructions", "description"] as const) {
    const value = definition[key];
    if (typeof value === "string" && value.trim()) return true;
  }
  return false;
}

export type AuthorCreateDiscardPlan =
  | { action: "navigate" }
  | { action: "delete"; sessionId: string; confirm: boolean };

export function planAuthorCreateDiscard(input: {
  sessionId?: string;
  definition: { name?: string; instructions?: string; description?: string };
  transcriptMessages: number;
}): AuthorCreateDiscardPlan {
  if (!input.sessionId) return { action: "navigate" };
  return {
    action: "delete",
    sessionId: input.sessionId,
    confirm: authorCreateDraftHasWork(input.definition, input.transcriptMessages),
  };
}
