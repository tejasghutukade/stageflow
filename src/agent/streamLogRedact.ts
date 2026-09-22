import { redactString } from "../logging/redact.js";
import { getNamedSecrets } from "../logging/namedSecrets.js";

/** Scrub secret-shaped substrings and registered values before text is persisted. */
export function redactSecrets(text: string): string {
  return redactString(text, { namedSecrets: getNamedSecrets() });
}
