import { resolveCredentialBinding } from "../../runtime/credentialBinding.js";
import { readAuthKey } from "../providerKeys.js";
import { TYPESAFE_KEY_ENV_NAMES, TYPESAFE_PROVIDER_ID } from "./constants.js";

export const STORED_KEY_SOURCE = `stored:${TYPESAFE_PROVIDER_ID}`;

export type TypesafeKeyLookup = {
  /** The key. Never log it, return it from an API or put it in an error. */
  key: string | undefined;
  /** Names (never values) of the sources that hold a key, in lookup order. */
  sources: string[];
};

export type TypesafeKeyResolver = (projectRoot: string) => Promise<TypesafeKeyLookup> | TypesafeKeyLookup;

/**
 * Lookup order: the stored `typesafe` provider credential (Settings, Providers, or boot from
 * STAGEFLOW_PROVIDER_TYPESAFE_API_KEY), then the env names in TYPESAFE_KEY_ENV_NAMES. The first one set wins.
 */
export function resolveTypesafeKey(projectRoot: string, env: NodeJS.ProcessEnv = process.env): TypesafeKeyLookup {
  const found: Array<{ source: string; key: string }> = [];
  const stored = readAuthKey(resolveCredentialBinding(projectRoot).authPath, TYPESAFE_PROVIDER_ID);
  if (stored !== undefined) found.push({ source: STORED_KEY_SOURCE, key: stored });
  for (const name of TYPESAFE_KEY_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) found.push({ source: name, key: value });
  }
  return { key: found[0]?.key, sources: found.map((entry) => entry.source) };
}
