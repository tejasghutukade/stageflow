import { lineDiff, type DiffLine } from "./lineDiff.js";

export interface StageDiff {
  changed_keys: string[];
  system_prompt_diff: DiffLine[] | null;
}

type Json = unknown;

function canonical(value: Json): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, Json>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeys(obj[k])]),
    );
  }
  return value;
}

function asRecord(value: Json): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

export function stageDiff(defA: Record<string, Json>, defB: Record<string, Json>): StageDiff {
  const keys = [...new Set([...Object.keys(defA), ...Object.keys(defB)])].sort();
  const changed: string[] = [];
  for (const key of keys) {
    if (canonical(defA[key]) === canonical(defB[key])) continue;
    if (key === "io") {
      const ioA = asRecord(defA.io);
      const ioB = asRecord(defB.io);
      const parts = ["input", "output"].filter(
        (p) => canonical(ioA[p]) !== canonical(ioB[p]),
      );
      if (parts.length === 0) changed.push("io");
      else for (const p of parts) changed.push(`io.${p}`);
      continue;
    }
    changed.push(key);
  }
  const promptChanged = changed.includes("system_prompt");
  const text = (v: Json) => (typeof v === "string" ? v : v === undefined ? "" : canonical(v));
  return {
    changed_keys: changed,
    system_prompt_diff: promptChanged ? lineDiff(text(defA.system_prompt), text(defB.system_prompt)) : null,
  };
}
