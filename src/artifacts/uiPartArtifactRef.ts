import { z } from "zod";
import { UI_PART_SCHEMA_VERSION, capFallbackText } from "./uiPartShared.js";

export const UI_PART_KIND_ARTIFACT_REF = "artifact-ref" as const;

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

export function parseUiPartArtifactRef(value: unknown): { ok: true; part: UiPartArtifactRef } | { ok: false } {
  try {
    const parsed = artifactRefSchema.safeParse(value);
    if (!parsed.success) return { ok: false };
    return { ok: true, part: capFallbackText(parsed.data) };
  } catch {
    return { ok: false };
  }
}