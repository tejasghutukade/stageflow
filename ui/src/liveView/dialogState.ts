export type DialogKind = "alert" | "confirm" | "prompt" | "beforeunload";

export type ViewerDialog = {
  id: string;
  kind: DialogKind;
  message: string;
  defaultPrompt: string;
  answerable: boolean;
  autoClosed: boolean;
};

export type DialogAnswerBody = { id: string; accept: boolean; promptText?: string };

export type DialogOutcome = "answered" | "gone" | "failed";

export const DIALOG_LABEL = "A page dialog is waiting";
export const DIALOG_HANDLED_LABEL = "A page dialog was handled automatically";
export const DIALOG_VIEW_ONLY_HINT = "Only the operator in control can answer.";
export const DIALOG_TIMEOUT_NOTICE = "The page dialog was dismissed after waiting too long.";
export const DIALOG_FAILED_NOTICE = "The dialog could not be answered.";
export const MAX_PROMPT_TEXT = 2000;

const KINDS: readonly string[] = ["alert", "confirm", "prompt", "beforeunload"];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function parseDialogOpened(payload: unknown): ViewerDialog | undefined {
  const p = record(payload);
  if (p === undefined || typeof p.id !== "string" || typeof p.kind !== "string" || !KINDS.includes(p.kind)) {
    return undefined;
  }
  const kind = p.kind as DialogKind;
  return {
    id: p.id,
    kind,
    message: typeof p.message === "string" ? p.message : "",
    defaultPrompt: typeof p.defaultPrompt === "string" ? p.defaultPrompt : "",
    answerable: (kind === "confirm" || kind === "prompt") && p.answerable === true,
    autoClosed: false,
  };
}

export type DialogClosedEffect = {
  dialog: ViewerDialog | null;
  notice: string | null;
  /** True when a read-only dialog stays visible briefly so the operator can read it. */
  linger: boolean;
};

export function applyDialogClosed(current: ViewerDialog | null, payload: unknown): DialogClosedEffect {
  const p = record(payload);
  if (current === null || p === undefined || p.id !== current.id) {
    return { dialog: current, notice: null, linger: false };
  }
  if (!current.answerable) return { dialog: { ...current, autoClosed: true }, notice: null, linger: true };
  return {
    dialog: null,
    notice: p.result === "timeout" ? DIALOG_TIMEOUT_NOTICE : null,
    linger: false,
  };
}

export function buildDialogAnswer(dialog: ViewerDialog, accept: boolean, text: string): DialogAnswerBody {
  if (accept && dialog.kind === "prompt") {
    return { id: dialog.id, accept, promptText: text.slice(0, MAX_PROMPT_TEXT) };
  }
  return { id: dialog.id, accept };
}

export function dialogOutcome(status: number): DialogOutcome {
  if (status === 200) return "answered";
  if (status === 409) return "gone";
  return "failed";
}

export function canAnswer(dialog: ViewerDialog, mode: "control" | "view"): boolean {
  return mode === "control" && dialog.answerable && !dialog.autoClosed;
}
