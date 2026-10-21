import { existsSync } from "node:fs";

export const CA_ENV_VARS = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export type CaPathWarning = {
  name: (typeof CA_ENV_VARS)[number];
  path: string;
};

export function warnMissingCaPaths(
  env: NodeJS.ProcessEnv = process.env,
): CaPathWarning[] {
  const warnings: CaPathWarning[] = [];
  for (const name of CA_ENV_VARS) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (!existsSync(value)) {
      warnings.push({ name, path: value });
    }
  }
  return warnings;
}
