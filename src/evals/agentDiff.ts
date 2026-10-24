import { lineDiff, type DiffLine } from "./lineDiff.js";
import { stageDiff } from "./stageDiff.js";

export interface AgentDiff {
  changed_keys: string[];
  instructions_diff: DiffLine[] | null;
  revision: { a: number | null; b: number | null };
}

export function agentDiff(
  defA: Record<string, unknown>,
  defB: Record<string, unknown>,
  revision: { a: number | null; b: number | null },
): AgentDiff {
  const changed = stageDiff(defA, defB).changed_keys;
  const text = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
  return {
    changed_keys: changed,
    instructions_diff: changed.includes("instructions") ? lineDiff(text(defA.instructions), text(defB.instructions)) : null,
    revision,
  };
}
