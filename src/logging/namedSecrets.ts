import type { NamedSecret } from "../logging/redact.js";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

let registry: NamedSecret[] = [];

export const REDACTION_SECRETS_FILENAME = "redaction-secrets.json";

export function registerNamedSecrets(secrets: readonly NamedSecret[]): void {
  const next = [...registry];
  for (const secret of secrets) {
    const idx = next.findIndex((s) => s.name === secret.name);
    if (idx >= 0) next[idx] = secret;
    else next.push(secret);
  }
  registry = next;
}

export function clearNamedSecretsForTests(): void {
  registry = [];
}

export function getNamedSecrets(): readonly NamedSecret[] {
  return registry;
}

export function loadNamedSecretsFromAttemptDir(attemptDir: string): void {
  const filePath = path.join(attemptDir, REDACTION_SECRETS_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const secrets: NamedSecret[] = [];
      for (const item of parsed) {
        if (
          item !== null &&
          typeof item === "object" &&
          typeof (item as { name?: unknown }).name === "string" &&
          typeof (item as { value?: unknown }).value === "string"
        ) {
          secrets.push({
            name: (item as { name: string }).name,
            value: (item as { value: string }).value,
          });
        }
      }
      if (secrets.length > 0) {
        registerNamedSecrets(secrets);
      }
    }
  } catch {
    // A malformed handoff is ignored. The file is still removed below.
  }
  // The attempt holds the values in memory. The file is only a startup handoff.
  try {
    unlinkSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}
