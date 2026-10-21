export const STAGE_TIMEOUT_REASON_PREFIX = "stage timed out after ";

export function stageTimeoutReason(timeoutMs: number): string {
  return `${STAGE_TIMEOUT_REASON_PREFIX}${timeoutMs}ms`;
}

export function isStageTimeoutReason(reason: string | undefined): boolean {
  return (
    typeof reason === "string" && reason.startsWith(STAGE_TIMEOUT_REASON_PREFIX)
  );
}

export function lastFailedReason(
  events: ReadonlyArray<{ event: string; reason?: string }>,
): string | undefined {
  let reason: string | undefined;
  for (const event of events) {
    if (event.event === "failed") reason = event.reason;
  }
  return reason;
}

export const TIMEOUT_ABORT_TOOL_RESULT =
  "Command aborted: the stage timed out. Continue without a debugger. Do not use --inspect or --inspect-brk.";

export function composeTimeoutResumePrompt(): string {
  return [
    "The previous turn was interrupted because the stage timed out.",
    "Continue the same work from the conversation above. Do not start over.",
    "Do not attach a debugger (no --inspect or --inspect-brk).",
    "Finish the stage and emit the envelope when done.",
  ].join(" ");
}
