import { z } from "zod";
import { parseUiPartApproval, UI_PART_KIND_APPROVAL, type UiPartApproval } from "./uiPartApproval.js";
import { parseUiPartForm, UI_PART_KIND_FORM, type UiPartForm } from "./uiPartForm.js";
import { UI_PART_FALLBACK_TEXT_MAX_CHARS, UI_PART_SCHEMA_VERSION } from "./uiPartShared.js";

export {
  UI_PART_FALLBACK_TEXT_MAX_CHARS,
  UI_PART_SCHEMA_VERSION,
} from "./uiPartShared.js";
export { UI_PART_KIND_ARTIFACT_REF } from "./uiPartArtifactRef.js";
export { UI_PART_KIND_FORM, UI_PART_FORM_EVENT_KEY_PREFIX, formUiEventKey, type UiPartForm } from "./uiPartForm.js";
export { UI_PART_KIND_APPROVAL, type UiPartApproval } from "./uiPartApproval.js";

export type { UiPartArtifactRef } from "./uiPartArtifactRef.js";

import { parseUiPartArtifactRef, UI_PART_KIND_ARTIFACT_REF, type UiPartArtifactRef } from "./uiPartArtifactRef.js";

export const UI_PART_KIND_ERROR = "ui-error" as const;
export const UI_PART_ERROR_MESSAGE_MAX_CHARS = 240;

const errorSchema = z.object({
  v: z.literal(UI_PART_SCHEMA_VERSION),
  kind: z.literal(UI_PART_KIND_ERROR),
  title: z.string(),
  message: z.string(),
  fallback: z.object({ text: z.string(), url: z.string() }),
});

export type UiPartError = z.infer<typeof errorSchema>;
export type UiPart = UiPartArtifactRef | UiPartForm | UiPartApproval | UiPartError;

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

export type UiPartEnvelope = {
  type: "ui";
  ui: UiPart;
};

export type ParsedUiPart =
  | { ok: true; part: UiPart }
  | { ok: false; kind: "unsupported" };

export function parseUiPart(value: unknown): ParsedUiPart {
  try {
    if (typeof value !== "object" || value === null) return { ok: false, kind: "unsupported" };
    const record = value as Record<string, unknown>;
    if (record.v !== UI_PART_SCHEMA_VERSION) return { ok: false, kind: "unsupported" };
    const kind = record.kind;
    if (kind === UI_PART_KIND_ARTIFACT_REF) {
      const parsed = parseUiPartArtifactRef(value);
      if (!parsed.ok) return { ok: false, kind: "unsupported" };
      return { ok: true, part: parsed.part };
    }
    if (kind === UI_PART_KIND_ERROR) {
      const parsed = errorSchema.safeParse(value);
      if (!parsed.success) return { ok: false, kind: "unsupported" };
      const message = parsed.data.message.slice(0, UI_PART_ERROR_MESSAGE_MAX_CHARS);
      const text = parsed.data.fallback.text.slice(0, UI_PART_FALLBACK_TEXT_MAX_CHARS);
      return { ok: true, part: { ...parsed.data, message, fallback: { ...parsed.data.fallback, text } } };
    }
    if (kind === UI_PART_KIND_FORM) {
      const parsed = parseUiPartForm(value);
      if (!parsed.ok) return { ok: false, kind: "unsupported" };
      return { ok: true, part: parsed.part };
    }
    if (kind === UI_PART_KIND_APPROVAL) {
      const parsed = parseUiPartApproval(value);
      if (!parsed.ok) return { ok: false, kind: "unsupported" };
      return { ok: true, part: parsed.part };
    }
    return { ok: false, kind: "unsupported" };
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