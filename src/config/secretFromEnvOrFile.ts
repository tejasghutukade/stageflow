import { readFileSync } from "node:fs";

export class SecretFromEnvError extends Error {
  readonly code = "config_invalid";
  constructor(message: string) {
    super(message);
    this.name = "SecretFromEnvError";
  }
}

/**
 * Read a secret from `NAME` or `NAME_FILE`. Both set → error.
 * File values trim exactly one trailing newline (`\n` or `\r\n`).
 */
export function readSecretFromEnvOrFile(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const fileKey = `${name}_FILE`;
  const plain = env[name];
  const filePath = env[fileKey];
  const hasPlain = plain !== undefined && plain.length > 0;
  const hasFile = filePath !== undefined && filePath.length > 0;
  if (hasPlain && hasFile) {
    throw new SecretFromEnvError(
      `Set only one of ${name} or ${fileKey}, not both`,
    );
  }
  if (hasFile) {
    try {
      return readFileSync(filePath!, "utf8").replace(/\r?\n$/, "");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new SecretFromEnvError(
        `Failed to read ${fileKey}=${filePath}: ${detail}`,
      );
    }
  }
  if (hasPlain) return plain;
  return undefined;
}
