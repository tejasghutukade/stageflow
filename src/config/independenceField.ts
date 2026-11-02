import { INDEPENDENCE_LEVELS, type IndependenceLevel } from "../types/stage.js";

export type ParsedIndependenceField =
  | { ok: true; value: IndependenceLevel | undefined }
  | { ok: false; message: string };

const LEVELS = new Set<string>(INDEPENDENCE_LEVELS);

/**
 * Validates a raw `independence:` value (stage body, root pipeline, or manifest).
 * Absent is fine. Present must be strict, persistent, or open.
 */
export function parseIndependenceField(raw: unknown): ParsedIndependenceField {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return { ok: false, message: "independence must be strict, persistent, or open" };
  }
  const value = raw.trim();
  if (!LEVELS.has(value)) {
    return { ok: false, message: "independence must be strict, persistent, or open" };
  }
  return { ok: true, value: value as IndependenceLevel };
}
