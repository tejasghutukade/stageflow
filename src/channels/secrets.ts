import { readSecretFromEnvOrFile, SecretFromEnvError } from "../config/secretFromEnvOrFile.js";
import { ChannelError } from "./errors.js";
import type { SecretRef } from "./types.js";

export const SECRET_REF_PATTERN = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

export function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === "string" && SECRET_REF_PATTERN.test(value);
}

/**
 * Resolves `env:NAME` with the repo's `NAME` / `NAME_FILE` convention. Errors carry the
 * connection id and field only, never the variable value or the file path.
 */
export function resolveSecretRef(
  ref: SecretRef,
  env: NodeJS.ProcessEnv,
  where: { connectionId: string; field: string },
): string {
  const name = ref.slice("env:".length);
  let value: string | undefined;
  try {
    value = readSecretFromEnvOrFile(env, name);
  } catch (error) {
    if (error instanceof SecretFromEnvError) throw new ChannelError("CHANNEL_SECRET_UNAVAILABLE", false, where);
    throw error;
  }
  if (value === undefined || value.length === 0) throw new ChannelError("CHANNEL_SECRET_UNAVAILABLE", false, where);
  return value;
}

export function resolveSecrets(
  refs: Readonly<Record<string, SecretRef>>,
  env: NodeJS.ProcessEnv,
  connectionId: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, ref] of Object.entries(refs)) out[field] = resolveSecretRef(ref, env, { connectionId, field });
  return out;
}

/** Removes every secret value from text before it reaches an error, log, or tool result. */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join("[redacted]");
  }
  return result;
}
