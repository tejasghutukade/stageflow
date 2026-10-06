/**
 * Dual-read adapter: accept old YAML authoring keys and warn (`catalog.legacy_yaml`).
 *
 * This is not the runtime IR. Stage workers, snapshots, emit, and VSE already
 * use those same strings as TypeScript fields (`StageConfig.payload_schema`,
 * DAG `completion` / `recovery`). Target YAML compiles onto that IR in
 * `yamlDialect.ts`. New catalog fields go on `io` / `verify` / `on_verify_fail`,
 * not here.
 *
 * Off: STAGEFLOW_LEGACY_YAML=0. migrate-yaml still reads legacy via
 * withLegacyYamlAllowedAsync.
 *
 * Delete this file plus migrateYaml.ts, printTargetYaml.ts,
 * migrateYamlCommand.ts, and tests/fixtures/dual-read to stop accepting
 * payload_schema / pre_emit_checks / completion / recovery as authoring keys.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { LoadIssue } from "./loadOutcome.js";
import type { YamlDialect } from "./yamlDialect.js";

export const LEGACY_CONTRACT_KEYS = new Set([
  "payload_schema",
  "clone_input_schema",
  "pre_emit_checks",
  "completion",
  "recovery",
]);

export const LEGACY_KEY_REPLACEMENTS: Record<string, string> = {
  payload_schema: "io.output.schema",
  clone_input_schema: "io.input.schema",
  pre_emit_checks: "verify items with when including emit",
  completion: "verify items with when including after",
  recovery: "on_verify_fail",
};

const TARGET_AUTHORING_KEYS = new Set(["io", "verify", "on_verify_fail"]);
const legacyYamlOverride = new AsyncLocalStorage<boolean>();

function collectDocumentKeys(raw: Record<string, unknown>): Set<string> {
  const keys = new Set(Object.keys(raw));
  if (Array.isArray(raw.stages)) {
    for (const entry of raw.stages) {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        for (const key of Object.keys(entry)) keys.add(key);
      }
    }
  }
  return keys;
}

export function formatLegacyReplacements(keys: string[]): string {
  return keys
    .map((key) => {
      const replacement = LEGACY_KEY_REPLACEMENTS[key];
      return replacement ? `${key} → ${replacement}` : key;
    })
    .join(", ");
}

export function presentLegacyKeys(keys: Iterable<string>): string[] {
  const set = keys instanceof Set ? keys : new Set(keys);
  return [...LEGACY_CONTRACT_KEYS].filter((key) => set.has(key));
}

export function legacyYamlIssue(fileLabel: string, keys: string[]): LoadIssue {
  return {
    code: "catalog.legacy_yaml",
    message: `${fileLabel} uses legacy YAML keys (${formatLegacyReplacements(keys)})`,
    category: "catalog",
  };
}

export function dialectWarningForDocument(
  raw: Record<string, unknown>,
  fileLabel: string,
): LoadIssue | undefined {
  const keys = collectDocumentKeys(raw);
  const legacyKeys = presentLegacyKeys(keys);
  if (legacyKeys.length === 0) return undefined;
  for (const key of keys) {
    if (TARGET_AUTHORING_KEYS.has(key)) return undefined;
  }
  return legacyYamlIssue(fileLabel, legacyKeys);
}

export function allowLegacyYamlAuthoring(): boolean {
  if (legacyYamlOverride.getStore() === true) return true;
  const raw = process.env.STAGEFLOW_LEGACY_YAML;
  if (raw === "0" || raw === "false") return false;
  return true;
}

export function withLegacyYamlAllowed<T>(fn: () => T): T {
  return legacyYamlOverride.run(true, fn);
}

export function withLegacyYamlAllowedAsync<T>(fn: () => Promise<T>): Promise<T> {
  return legacyYamlOverride.run(true, fn);
}

export function legacyAuthoringRejected(
  dialect: YamlDialect,
  fileLabel: string,
  keys: string[],
): LoadIssue | undefined {
  if (dialect !== "legacy" || allowLegacyYamlAuthoring()) return undefined;
  return {
    code: "catalog.legacy_yaml",
    message: `${fileLabel}: dual-read is disabled (STAGEFLOW_LEGACY_YAML=0). Run sf migrate-yaml or author io / verify / on_verify_fail (${formatLegacyReplacements(keys)}).`,
    category: "catalog",
  };
}
