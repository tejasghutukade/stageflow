import { z } from "zod";

export const UI_PART_SCHEMA_VERSION = 1 as const;
export const UI_PART_KIND_ARTIFACT_REF = "artifact-ref" as const;
export const UI_PART_KIND_ERROR = "ui-error" as const;
export const UI_PART_FALLBACK_TEXT_MAX_CHARS = 2_000;
export const UI_PART_ERROR_MESSAGE_MAX_CHARS = 240;

const fallbackSchema = z.object({
  text: z.string(),
  url: z.string(),
});

const artifactRefSchema = z.object({
  v: z.literal(UI_PART_SCHEMA_VERSION),
  kind: z.literal(UI_PART_KIND_ARTIFACT_REF),
  key: z.string().min(1),
  version: z.number().int().positive().optional(),
  title: z.string(),
  fallback: fallbackSchema,
});

const errorSchema = z.object({
  v: z.literal(UI_PART_SCHEMA_VERSION),
  kind: z.literal(UI_PART_KIND_ERROR),
  title: z.string(),
  message: z.string(),
  fallback: fallbackSchema,
});

export type UiPartArtifactRef = z.infer<typeof artifactRefSchema>;
export type UiPartError = z.infer<typeof errorSchema>;
export type UiPart = UiPartArtifactRef | UiPartError;

export type UiPartEnvelope = {
  type: "ui";
  ui: UiPartArtifactRef;
};

export type ParsedUiPart =
  | { ok: true; part: UiPart }
  | { ok: false; kind: "unsupported" };

export function uiErrorPart(message: string): UiPartError {
  const text = message.trim().slice(0, UI_PART_ERROR_MESSAGE_MAX_CHARS) || "That could not be shown.";
  return {
    v: UI_PART_SCHEMA_VERSION,
    kind: UI_PART_KIND_ERROR,
    title: "Could not show that",
    message: text,
    fallback: { text: "Could not show that", url: "" },
  };
}

function capFallbackText(part: UiPartArtifactRef): UiPartArtifactRef {
  const { text } = part.fallback;
  if (text.length <= UI_PART_FALLBACK_TEXT_MAX_CHARS) return part;
  return {
    ...part,
    fallback: { ...part.fallback, text: text.slice(0, UI_PART_FALLBACK_TEXT_MAX_CHARS) },
  };
}

export function parseUiPart(value: unknown): ParsedUiPart {
  try {
    if (typeof value !== "object" || value === null) return { ok: false, kind: "unsupported" };
    const record = value as Record<string, unknown>;
    const version = record.v;
    const kind = record.kind;
    if (version !== UI_PART_SCHEMA_VERSION) return { ok: false, kind: "unsupported" };
    if (kind === UI_PART_KIND_ERROR) {
      const parsed = errorSchema.safeParse(value);
      if (!parsed.success) return { ok: false, kind: "unsupported" };
      const message = parsed.data.message.slice(0, UI_PART_ERROR_MESSAGE_MAX_CHARS);
      return { ok: true, part: { ...parsed.data, message, fallback: { ...parsed.data.fallback, text: parsed.data.fallback.text.slice(0, UI_PART_FALLBACK_TEXT_MAX_CHARS) } } };
    }
    if (kind !== UI_PART_KIND_ARTIFACT_REF) return { ok: false, kind: "unsupported" };
    const parsed = artifactRefSchema.safeParse(value);
    if (!parsed.success) return { ok: false, kind: "unsupported" };
    return { ok: true, part: capFallbackText(parsed.data) };
  } catch {
    return { ok: false, kind: "unsupported" };
  }
}

export function parseUiPartEnvelope(value: unknown): ParsedUiPart {
  try {
    if (typeof value !== "object" || value === null) return { ok: false, kind: "unsupported" };
    const record = value as Record<string, unknown>;
    if (record.type !== "ui") return { ok: false, kind: "unsupported" };
    return parseUiPart(record.ui);
  } catch {
    return { ok: false, kind: "unsupported" };
  }
}