import { z } from "zod";
import { UI_PART_FALLBACK_TEXT_MAX_CHARS, UI_PART_SCHEMA_VERSION, capFallbackText } from "./uiPartShared.js";

export const UI_PART_KIND_APPROVAL = "approval" as const;
export const UI_PART_APPROVAL_ID_MAX = 80;
export const UI_PART_APPROVAL_SUMMARY_MAX = 2_000;
export const UI_PART_APPROVAL_TOOL_MAX = 80;

const fallbackSchema = z.object({
  text: z.string().max(UI_PART_FALLBACK_TEXT_MAX_CHARS),
  url: z.string(),
});

const approvalSchema = z.object({
  v: z.literal(UI_PART_SCHEMA_VERSION),
  kind: z.literal(UI_PART_KIND_APPROVAL),
  approvalId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  title: z.string().min(1).max(200),
  tool: z.string().min(1).max(UI_PART_APPROVAL_TOOL_MAX),
  summary: z.string().min(1).max(UI_PART_APPROVAL_SUMMARY_MAX),
  risk: z.enum(["read", "write", "destructive", "external"]).optional(),
  status: z.enum(["pending", "approved", "denied", "expired"]).optional(),
  fallback: fallbackSchema,
});

export type UiPartApproval = z.infer<typeof approvalSchema>;

export function parseUiPartApproval(value: unknown): { ok: true; part: UiPartApproval } | { ok: false } {
  try {
    const parsed = approvalSchema.safeParse(value);
    if (!parsed.success) return { ok: false };
    return { ok: true, part: capFallbackText(parsed.data) };
  } catch {
    return { ok: false };
  }
}

export function approvalPartHeadline(part: UiPartApproval): string {
  return `${part.title}: ${part.tool}`;
}

export function approvalChannelFallback(part: UiPartApproval, consoleAccess: boolean): string {
  const lines = [approvalPartHeadline(part), part.summary];
  if (part.status && part.status !== "pending") {
    lines.push(`Decision: ${part.status}`);
  } else {
    lines.push("Waiting for a decision in the operator console.");
  }
  lines.push(part.fallback.text);
  if (consoleAccess) lines.push(part.fallback.url);
  return lines.join("\n");
}