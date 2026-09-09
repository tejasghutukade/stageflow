export type ParsedModelField =
  | { ok: true; value: string | undefined }
  | { ok: false; message: string };

/**
 * Validates a raw `model:` config value (stage, pipeline, or manifest YAML).
 * Callers own their own error shape — this only owns the shared rule: absent
 * is fine, present must be a non-empty trimmed string.
 */
export function parseModelField(raw: unknown): ParsedModelField {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      message: "model must be a non-empty string",
    };
  }
  return { ok: true, value: raw.trim() };
}
