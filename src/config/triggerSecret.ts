import { ChannelError } from "../channels/errors.js";
import { STORE_NAME_PATTERN, type SecretReader } from "../channels/secretStore.js";
import { readSecretFromEnvOrFile, SecretFromEnvError } from "./secretFromEnvOrFile.js";

export const TRIGGER_STORE_PREFIX = "store:";

const SECRET_SOURCES = (source: string): boolean =>
  source === "webhook" || source === "email.message" || source.startsWith("github.");

export function triggerSourceTakesSecret(source: string): boolean {
  return SECRET_SOURCES(source);
}

export function triggerSecretStoreName(id: string): string {
  return `trigger.${id}.secret`;
}

/** The store entry a `store:NAME` ref names, or undefined for a plain ref or a malformed name. */
export function storeNameOfRef(ref: string): string | undefined {
  if (!ref.startsWith(TRIGGER_STORE_PREFIX)) return undefined;
  const name = ref.slice(TRIGGER_STORE_PREFIX.length);
  return STORE_NAME_PATTERN.test(name) ? name : undefined;
}

/** Error text for a malformed `store:` name, or null. Plain refs are not checked here. */
export function secretRefError(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.startsWith(TRIGGER_STORE_PREFIX)) return null;
  return storeNameOfRef(ref) === undefined
    ? "event.config.secretRef: a store: name must be letters, digits, '.', '_' or '-', start with a letter or digit, and be at most 200 characters"
    : null;
}

/**
 * One resolver for a trigger's `secretRef`: `store:NAME` reads the console secret store, a plain
 * name reads the environment or `NAME_FILE`. Returns undefined when unset. Throws only
 * `SecretFromEnvError`, whose message never holds a secret value.
 */
export function resolveTriggerSecret(
  ref: string,
  options: { env: NodeJS.ProcessEnv; secrets?: SecretReader },
): string | undefined {
  if (ref.startsWith(TRIGGER_STORE_PREFIX)) {
    const name = storeNameOfRef(ref);
    if (name === undefined || options.secrets === undefined) return undefined;
    try {
      return options.secrets.get(name);
    } catch (error) {
      const code = error instanceof ChannelError ? error.code : "CHANNEL_STORAGE_FAILED";
      throw new SecretFromEnvError(`secret store unavailable (${code})`);
    }
  }
  return readSecretFromEnvOrFile(options.env, ref);
}
