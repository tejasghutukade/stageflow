import { LIVE_PROGRAM_MAX_BYTES } from "./limits.js";
import { validateProgram } from "./program.js";

import type { InlinePreview } from "./inlinePreviewTypes.js";

export type { InlinePreview };

const ERROR_MESSAGE_MAX = 240;

export function extractJsonStringField(
  source: string,
  field: string,
): { value: string; closed: boolean } | undefined {
  const key = `"${field}"`;
  const at = source.indexOf(key);
  if (at < 0) return undefined;
  let index = at + key.length;
  while (index < source.length && /\s/.test(source[index]!)) index += 1;
  if (source[index] !== ":") return undefined;
  index += 1;
  while (index < source.length && /\s/.test(source[index]!)) index += 1;
  if (source[index] !== '"') return undefined;
  index += 1;
  let value = "";
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\") {
      if (index + 1 >= source.length) return { value, closed: false };
      const next = source[index + 1]!;
      const mapped: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", "/": "/" };
      value += mapped[next] ?? next;
      index += 2;
      continue;
    }
    if (char === '"') return { value, closed: true };
    value += char;
    index += 1;
  }
  return { value, closed: false };
}

function kindField(partial: string): { value: string; closed: boolean } | undefined {
  const manifestAt = partial.indexOf('"manifest"');
  return extractJsonStringField(manifestAt >= 0 ? partial.slice(manifestAt) : partial, "kind");
}

/** Skeleton while the program is still arriving. A closed live program that does not parse is an error card. */
export function previewPresentArgs(partial: string): InlinePreview {
  const program = extractJsonStringField(partial, "program");
  if (!program || !program.closed) return { phase: "skeleton" };
  const kind = kindField(partial);
  if (!kind?.closed || kind.value !== "live.declarative") return { phase: "skeleton" };
  if (Buffer.byteLength(program.value) > LIVE_PROGRAM_MAX_BYTES) {
    return { phase: "error", message: "That program is too large." };
  }
  const validated = validateProgram(program.value);
  if (!validated.ok) {
    const message = validated.errors[0]?.message ?? "That program is not valid.";
    return { phase: "error", message: message.slice(0, ERROR_MESSAGE_MAX) };
  }
  return { phase: "skeleton" };
}
