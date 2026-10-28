export const RUN_CLOCK_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type RunClockTerminalStatus =
  (typeof RUN_CLOCK_TERMINAL_STATUSES)[number];

export type RunClockStatus =
  | "created"
  | "queued"
  | "running"
  | RunClockTerminalStatus;

const TERMINAL: ReadonlySet<string> = new Set(RUN_CLOCK_TERMINAL_STATUSES);

export function isRunClockTerminal(
  status: string | undefined,
): status is RunClockTerminalStatus {
  return status !== undefined && TERMINAL.has(status);
}

export type FinishedAtDecision =
  | { action: "stamp"; finishedAt: string }
  | { action: "keep" }
  | { action: "clear" };

export function nextFinishedAt(input: {
  nextStatus: RunClockStatus;
  currentFinishedAt: string | null | undefined;
  now: string;
}): FinishedAtDecision {
  if (isRunClockTerminal(input.nextStatus)) {
    if (
      input.currentFinishedAt != null &&
      input.currentFinishedAt !== ""
    ) {
      return { action: "keep" };
    }
    return { action: "stamp", finishedAt: input.now };
  }
  return { action: "clear" };
}
