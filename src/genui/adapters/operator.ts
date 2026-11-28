import type { TSchema } from "typebox";
import type { Surface } from "../surface.js";
import type { GenUiToolResult, GenUiToolSpec } from "../tools.js";

export type OperatorToolResult = { ok: boolean; content: unknown; error?: string };

/** A tool shaped for an operator agent profile (the Guide). The surface is built per call from the session context. */
export type GenUiOperatorTool<C> = {
  name: string;
  description: string;
  parameters: TSchema;
  handler(args: Record<string, unknown>, ctx: C): Promise<OperatorToolResult>;
};

export function operatorToolResult(result: GenUiToolResult): OperatorToolResult {
  if (result.ok) return { ok: true, content: result.value };
  const content = { code: result.code, message: result.message, ...(result.issues !== undefined ? { issues: result.issues } : {}) };
  return { ok: false, content, error: result.code };
}

export function toOperatorTool<C>(spec: GenUiToolSpec, surfaceFor: (ctx: C) => Surface): GenUiOperatorTool<C> {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    handler: async (args, ctx) => operatorToolResult(await spec.handler(args, surfaceFor(ctx))),
  };
}
