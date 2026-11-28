import { z } from "zod";
import { UI_PART_FALLBACK_TEXT_MAX_CHARS, UI_PART_SCHEMA_VERSION, capFallbackText } from "./uiPartShared.js";

export const UI_PART_KIND_FORM = "form" as const;
export const UI_PART_FORM_MAX_FIELDS = 25;
export const UI_PART_FORM_MAX_LABEL = 120;
export const UI_PART_FORM_MAX_DESCRIPTION = 500;
export const UI_PART_FORM_MAX_SUBMIT_TEXT = 4_000;
export const UI_PART_FORM_MAX_STRING = 2_000;
export const UI_PART_FORM_EVENT_KEY_PREFIX = "_ui/form/" as const;

const fieldId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const fallbackSchema = z.object({
  text: z.string().max(UI_PART_FALLBACK_TEXT_MAX_CHARS),
  url: z.string(),
});

const baseField = z.object({
  id: fieldId,
  label: z.string().min(1).max(UI_PART_FORM_MAX_LABEL),
  required: z.boolean().optional(),
});

const stringField = baseField.extend({
  type: z.literal("string"),
  maxLength: z.number().int().min(1).max(UI_PART_FORM_MAX_STRING).optional(),
  multiline: z.boolean().optional(),
});

const numberField = baseField.extend({
  type: z.literal("number"),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().optional(),
});

const booleanField = baseField.extend({
  type: z.literal("boolean"),
});

const selectField = baseField.extend({
  type: z.literal("select"),
  options: z
    .array(
      z.object({
        value: z.string().min(1).max(80),
        label: z.string().min(1).max(UI_PART_FORM_MAX_LABEL),
      }),
    )
    .min(1)
    .max(32),
});

const formFieldSchema = z.discriminatedUnion("type", [stringField, numberField, booleanField, selectField]);

export type UiPartFormField = z.infer<typeof formFieldSchema>;

const formSchema = z.object({
  v: z.literal(UI_PART_SCHEMA_VERSION),
  kind: z.literal(UI_PART_KIND_FORM),
  id: fieldId,
  title: z.string().min(1).max(200),
  description: z.string().max(UI_PART_FORM_MAX_DESCRIPTION).optional(),
  fields: z.array(formFieldSchema).min(1).max(UI_PART_FORM_MAX_FIELDS),
  submit: z.object({
    template: z.string().min(1).max(UI_PART_FORM_MAX_SUBMIT_TEXT),
  }),
  fallback: fallbackSchema,
});

export type UiPartForm = z.infer<typeof formSchema>;

export function formUiEventKey(formId: string): string {
  return `${UI_PART_FORM_EVENT_KEY_PREFIX}${formId}`;
}

export function parseUiPartForm(value: unknown): { ok: true; part: UiPartForm } | { ok: false } {
  try {
    const parsed = formSchema.safeParse(value);
    if (!parsed.success) return { ok: false };
    const ids = new Set<string>();
    for (const field of parsed.data.fields) {
      if (ids.has(field.id)) return { ok: false };
      ids.add(field.id);
    }
    return { ok: true, part: capFallbackText(parsed.data) };
  } catch {
    return { ok: false };
  }
}

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g;

export function fillFormTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) throw new Error(`${name} is required`);
    const value = values[name];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    throw new Error(`${name} must be a scalar`);
  });
}

export type FormValueIssue = { field: string; message: string };

export function validateFormValues(form: UiPartForm, raw: Record<string, unknown>): FormValueIssue[] {
  const issues: FormValueIssue[] = [];
  for (const field of form.fields) {
    const has = Object.prototype.hasOwnProperty.call(raw, field.id);
    const value = raw[field.id];
    const empty = !has || value === undefined || value === null || value === "";
    if (empty) {
      if (field.required !== false) issues.push({ field: field.id, message: "is required" });
      continue;
    }
    switch (field.type) {
      case "string": {
        if (typeof value !== "string") {
          issues.push({ field: field.id, message: "must be text" });
          break;
        }
        const max = field.maxLength ?? UI_PART_FORM_MAX_STRING;
        if (value.length > max) issues.push({ field: field.id, message: `must be at most ${max} characters` });
        break;
      }
      case "number": {
        if (typeof value !== "number" || Number.isNaN(value)) {
          issues.push({ field: field.id, message: "must be a number" });
          break;
        }
        if (field.integer && !Number.isInteger(value)) issues.push({ field: field.id, message: "must be a whole number" });
        if (field.min !== undefined && value < field.min) issues.push({ field: field.id, message: `must be at least ${field.min}` });
        if (field.max !== undefined && value > field.max) issues.push({ field: field.id, message: `must be at most ${field.max}` });
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") issues.push({ field: field.id, message: "must be yes or no" });
        break;
      }
      case "select": {
        if (typeof value !== "string") {
          issues.push({ field: field.id, message: "must be a choice" });
          break;
        }
        if (!field.options.some((option) => option.value === value)) issues.push({ field: field.id, message: "is not an allowed choice" });
        break;
      }
      default: {
        const exhaustive: never = field;
        return exhaustive;
      }
    }
  }
  return issues;
}

export function coerceFormValues(form: UiPartForm, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of form.fields) {
    if (!Object.prototype.hasOwnProperty.call(raw, field.id)) continue;
    const value = raw[field.id];
    if (value === undefined || value === null || value === "") continue;
    out[field.id] = value;
  }
  return out;
}

export function formChannelFallback(part: UiPartForm, consoleAccess: boolean): string {
  const lines = [part.title];
  if (part.description) lines.push(part.description);
  for (const field of part.fields) {
    const required = field.required !== false ? " (required)" : "";
    lines.push(`- ${field.label}${required}`);
  }
  lines.push(part.fallback.text);
  if (consoleAccess) lines.push(part.fallback.url);
  return lines.join("\n");
}