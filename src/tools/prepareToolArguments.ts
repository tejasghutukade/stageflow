function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonArrayString(value: unknown): unknown[] | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObjectString(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function coerceJsonArrayField(
  args: Record<string, unknown>,
  key: string,
): void {
  const parsed = parseJsonArrayString(args[key]);
  if (parsed !== undefined) {
    args[key] = parsed;
  }
}

export function coerceJsonObjectField(
  args: Record<string, unknown>,
  key: string,
): void {
  const parsed = parseJsonObjectString(args[key]);
  if (parsed !== undefined) {
    args[key] = parsed;
  }
}

function coerceJsonObjectArrayElements(
  args: Record<string, unknown>,
  key: string,
): void {
  const value = args[key];
  if (!Array.isArray(value)) return;
  args[key] = value.map((item) => parseJsonObjectString(item) ?? item);
}

export function prepareAskOperatorArguments(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const args = { ...input };
  coerceJsonArrayField(args, "questions");
  coerceJsonObjectArrayElements(args, "questions");
  coerceJsonArrayField(args, "artifacts");
  return args;
}

export function prepareEmitStageEnvelopeArguments(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const args = { ...input };
  coerceJsonObjectField(args, "payload");
  coerceJsonObjectField(args, "feedback_loop");
  coerceJsonArrayField(args, "artifacts");
  coerceJsonArrayField(args, "fork_choice");
  coerceJsonArrayField(args, "checklist_attestations");
  coerceJsonObjectArrayElements(args, "checklist_attestations");
  if (Array.isArray(args.checklist_attestations)) {
    args.checklist_attestations = args.checklist_attestations.map((item) => {
      if (!isRecord(item)) return item;
      const next = { ...item };
      coerceJsonArrayField(next, "items");
      return next;
    });
  }
  return args;
}
