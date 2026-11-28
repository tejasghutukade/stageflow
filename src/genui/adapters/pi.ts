import type { TSchema } from "typebox";
import type { Surface } from "../surface.js";
import type { GenUiToolResult, GenUiToolSpec } from "../tools.js";

export type PiToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: true;
};

/** A tool shaped for a Pi session (`defineTool`): stage workers and project agents. */
export type GenUiPiTool<P extends TSchema = TSchema> = {
  name: string;
  label: string;
  description: string;
  parameters: P;
  execute(toolCallId: string, params: unknown): Promise<PiToolResult>;
};

export function piToolResult(result: GenUiToolResult): PiToolResult {
  if (result.ok) return { content: [{ type: "text", text: JSON.stringify(result.value) }], details: result.value };
  const payload = { code: result.code, message: result.message, ...(result.issues !== undefined ? { issues: result.issues } : {}) };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload, isError: true };
}

export function toPiTool<P extends TSchema>(spec: GenUiToolSpec<P>, surface: Surface): GenUiPiTool<P> {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (_toolCallId, params) => piToolResult(await spec.handler(params, surface)),
  };
}
