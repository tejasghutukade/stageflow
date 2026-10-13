export const WORKSHOP_UNTITLED_AUTOSAVE_KEY = "__untitled__";

export function workshopAutosaveKey(
  pipelinePath: string | null | undefined,
): string {
  const trimmed = pipelinePath?.trim();
  if (!trimmed) return WORKSHOP_UNTITLED_AUTOSAVE_KEY;
  return trimmed.replace(/\\/g, "/");
}
