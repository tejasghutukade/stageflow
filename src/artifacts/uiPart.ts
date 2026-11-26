import { z } from "zod";

export const UI_PART_SCHEMA_VERSION = 1 as const;
export const UI_PART_KIND_ARTIFACT_REF = "artifact-ref" as const;
export const UI_PART_FALLBACK_TEXT_MAX_CHARS = 2_000;

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

export type UiPartArtifactRef = z.infer<typeof artifactRefSchema>;

export type UiPartEnvelope = {
  type: "ui";
  ui: UiPartArtifactRef;
};

export type ParsedUiPart =
  | { ok: true; part: UiPartArtifactRef }
  | { ok: false; kind: "unsupported" };

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
    if (version !== UI_PART_SCHEMA_VERSION || kind !== UI_PART_KIND_ARTIFACT_REF) {
      return { ok: false, kind: "unsupported" };
    }
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