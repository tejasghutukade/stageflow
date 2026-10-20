import { createHash } from "node:crypto";

export const MEMORY_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const MEMORY_PAGE_CAP = 64_000;
export const MEMORY_DESCRIPTION_MAX = 500;
export const MEMORY_KEY_MAX = 1024;
export const MEMORY_CARD_MAX = 200;

export function memoryCardFileName(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function isMemoryId(value: string): boolean {
  return MEMORY_ID_PATTERN.test(value);
}

/** `undefined` when the key is absent or an empty list. Duplicates and bad ids fail. */
export function parseMemoryIdList(
  raw: unknown,
): { ok: true; value: string[] | undefined } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, message: "memories must be a list of ids" };
  if (raw.length === 0) return { ok: true, value: undefined };
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !isMemoryId(item)) {
      return { ok: false, message: "each memory id must be lowercase letters, digits, _ or -, starting with a letter, at most 64 characters" };
    }
    ids.push(item);
  }
  if (new Set(ids).size !== ids.length) return { ok: false, message: "duplicate memory id" };
  return { ok: true, value: ids };
}
