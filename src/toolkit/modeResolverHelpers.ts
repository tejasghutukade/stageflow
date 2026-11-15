import type { z } from "zod";
import type { ModeResolverResult } from "./modes.js";

export function reject(message: string): ModeResolverResult {
  return { ok: false, message };
}

export function ok(mode: string, primaryId?: string): ModeResolverResult {
  return { ok: true, resolved: { mode, primaryId } };
}

export function isResolverResult(result: unknown): result is ModeResolverResult {
  return typeof result === "object" && result !== null && "ok" in result;
}

export function parseOrReject<T>(
  schema: z.ZodType<T>,
  args: Record<string, unknown>,
  label: string,
): ModeResolverResult | T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return reject(parsed.error.issues[0]?.message ?? `Invalid ${label} arguments.`);
  }
  return parsed.data;
}