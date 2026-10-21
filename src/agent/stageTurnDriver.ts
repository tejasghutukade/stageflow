import type { EmitCapture } from "../tools/emitStageEnvelope.js";

/** Follow-up turns sent when the agent ends its turn without an accepted envelope. */
export const DEFAULT_EMIT_REMINDERS = 2;

const PROVIDER_ERROR_MAX_CHARS = 500;

/** The slice of a Pi session the driver needs; a fake in tests. */
export type StageTurnSession = {
  prompt(text: string): Promise<void>;
  readonly messages: readonly unknown[];
};

export type RemindOptions = {
  emitToolName: string;
  maxReminders?: number;
  /** True once the stage is closing, parked, or timed out: never start another turn then. */
  shouldStop: () => boolean;
};

export type RemindOutcome = {
  reminders: number;
  /** Set when the last turn ended on a provider error; no reminder is sent after one. */
  providerError?: string;
};

type AssistantLike = { role?: unknown; stopReason?: unknown; errorMessage?: unknown };

function lastAssistant(messages: readonly unknown[]): AssistantLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AssistantLike | undefined;
    if (m && typeof m === "object" && m.role === "assistant") return m;
  }
  return undefined;
}

/** Trimmed, length-capped provider error text for a stage failure reason. */
export function formatProviderError(text: string | undefined): string {
  const t = text?.trim() ? text.trim() : "the model provider returned an error";
  return t.length > PROVIDER_ERROR_MAX_CHARS ? `${t.slice(0, PROVIDER_ERROR_MAX_CHARS)}…` : t;
}

/**
 * Error text of the last assistant turn when it ended on a provider error (bad key, auth,
 * model unavailable, or a transient error Pi already gave up retrying). Undefined otherwise.
 */
export function lastTurnProviderError(messages: readonly unknown[]): string | undefined {
  const m = lastAssistant(messages);
  if (!m || m.stopReason !== "error") return undefined;
  return formatProviderError(typeof m.errorMessage === "string" ? m.errorMessage : undefined);
}

function lastTurnAborted(messages: readonly unknown[]): boolean {
  return lastAssistant(messages)?.stopReason === "aborted";
}

export function emitReminderPrompt(
  emitToolName: string,
  attempt: number,
  max: number,
  rejectedEmit?: string,
): string {
  const lines = [
    `Reminder ${attempt} of ${max}: your turn ended without an accepted ${emitToolName} call, so this stage has not finished.`,
  ];
  if (rejectedEmit !== undefined) {
    lines.push(`Your last ${emitToolName} call was rejected: ${rejectedEmit}`);
    lines.push(`Fix that and call ${emitToolName} again.`);
  } else {
    lines.push(`Continue the stage's work if any is left, then call ${emitToolName}.`);
  }
  lines.push(
    `If the stage cannot be completed, call ${emitToolName} with status "failure" and a summary that says why. Do not end your turn without calling it.`,
  );
  return lines.join("\n");
}

/**
 * Called after a turn returns. While no envelope was accepted, nudge the agent with a short
 * follow-up turn, up to `maxReminders` times. Stops at once when an envelope is captured,
 * the stage is stopping, the turn was aborted, or the turn ended on a provider error.
 */
export async function remindUntilEmitted(
  session: StageTurnSession,
  capture: EmitCapture,
  options: RemindOptions,
): Promise<RemindOutcome> {
  const max = options.maxReminders ?? DEFAULT_EMIT_REMINDERS;
  let reminders = 0;
  for (;;) {
    if (capture.envelope) return { reminders };
    const providerError = lastTurnProviderError(session.messages);
    if (providerError !== undefined) return { reminders, providerError };
    if (options.shouldStop() || lastTurnAborted(session.messages) || reminders >= max) {
      return { reminders };
    }
    reminders++;
    await session.prompt(emitReminderPrompt(options.emitToolName, reminders, max, capture.error));
  }
}
