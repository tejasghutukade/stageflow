import {
  BROWSER_STAGE_PATTERNS,
  redact,
  redactString,
} from "../logging/redact.js";
import { getNamedSecrets } from "../logging/namedSecrets.js";

/** Scrub secret-shaped substrings and registered values before text is persisted. */
export function redactSecrets(text: string): string {
  return redactString(text, { namedSecrets: getNamedSecrets() });
}

/** Like redactSecrets plus cookie/storage/header shapes; for browser stages only. */
export function redactBrowserSecrets(text: string): string {
  return redactString(text, {
    patterns: BROWSER_STAGE_PATTERNS,
    namedSecrets: getNamedSecrets(),
  });
}

const BROWSER_REDACTED_EVENTS = new Set([
  "message",
  "tool_start",
  "tool_end",
  "tool_progress",
]);

/** Tool/message previews of browser stages can carry cookie or token values. */
export function redactBrowserActivityEvent<T extends { event: string }>(
  event: T,
): T {
  if (!BROWSER_REDACTED_EVENTS.has(event.event)) return event;
  return redact(event as unknown as Record<string, unknown>, {
    patterns: BROWSER_STAGE_PATTERNS,
    namedSecrets: getNamedSecrets(),
  }) as unknown as T;
}
