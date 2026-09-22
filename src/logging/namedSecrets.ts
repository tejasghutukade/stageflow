import type { NamedSecret } from "../logging/redact.js";

let registry: NamedSecret[] = [];

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
