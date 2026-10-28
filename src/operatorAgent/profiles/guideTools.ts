import { accessSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { placeGuideWriteArgs } from "../../guide/writeRoot.js";
import type { McpToolDeps } from "../../mcp/deps.js";
import { buildToolkit } from "../../toolkit/index.js";
import { isOperatorOnlyTool } from "../../toolkit/meta.js";
import type { OperatorAgentTool, OperatorAgentToolResult } from "../types.js";
import { checkGuideConfirmation, GUIDE_CONFIRMED_TOOLS } from "./guideConfirm.js";

const PLACED_TOOLS = new Set([
  "create_pipeline",
  "create_stage",
  "create_stage_file",
  "edit_pipeline",
  "edit_stage",
  "create_task",
  "edit_task",
  "read_pipeline",
]);

const PLACE_NOTE =
  "Pipeline and stage files are stored at pipelines/<id>/, stage files beside the pipeline. A path the person named is not a save location. The host replaces directory, pipeline_directory, and a path that is not already a saved pipeline.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withConfirmationId(schema: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(schema.anyOf)) {
    return {
      ...schema,
      anyOf: schema.anyOf.map((branch) => withConfirmationId(isRecord(branch) ? branch : {})),
    };
  }
  if (Array.isArray(schema.oneOf)) {
    return {
      ...schema,
      oneOf: schema.oneOf.map((branch) => withConfirmationId(isRecord(branch) ? branch : {})),
    };
  }
  const properties = {
    ...(isRecord(schema.properties) ? schema.properties : {}),
    confirmation_id: { type: "string", minLength: 1 },
  };
  const required = [
    ...(Array.isArray(schema.required)
      ? schema.required.filter((item) => item !== "confirmation_id")
      : []),
    "confirmation_id",
  ];
  return { ...schema, type: "object", properties, required };
}

function modelParameters(schema: Record<string, unknown>, confirmed: boolean): TSchema {
  const parameters = confirmed ? withConfirmationId(schema) : schema;
  return Type.Unsafe(parameters as TSchema);
}

function contentOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorOf(content: unknown): string {
  if (content !== null && typeof content === "object" && "error" in content) {
    const error = (content as { error: unknown }).error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return "tool_failed";
}

function placeArgs(name: string, args: Record<string, unknown>, deps: McpToolDeps): Record<string, unknown> {
  const root = deps.projectRoot ?? deps.cwd;
  return placeGuideWriteArgs(name, args, (rel) => {
    const abs = path.resolve(root, rel);
    const back = path.relative(root, abs);
    if (back.startsWith("..") || path.isAbsolute(back)) return false;
    try {
      accessSync(abs);
      return true;
    } catch {
      return false;
    }
  });
}

function wrapCatalogTool(
  tool: ReturnType<typeof buildToolkit>[number],
  deps: McpToolDeps,
  signal: AbortSignal,
): OperatorAgentTool {
  const confirmed = GUIDE_CONFIRMED_TOOLS.has(tool.name);
  const placed = PLACED_TOOLS.has(tool.name);
  const description = [
    tool.description,
    placed ? PLACE_NOTE : "",
    confirmed ? "Needs confirmation_id from confirm_action, issued before the person's latest message." : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return {
    name: tool.name,
    description,
    parameters: modelParameters(tool.parameters, confirmed),
    handler: async (args, ctx): Promise<OperatorAgentToolResult> => {
      let input = args;
      if (confirmed) {
        const refused = checkGuideConfirmation(tool.name, args, ctx);
        if (refused) return refused;
        const { confirmation_id: _, ...rest } = args;
        input = rest;
      }
      if (placed) input = placeArgs(tool.name, input, deps);
      const result = await tool.run(input, { signal });
      const content = contentOf(result.text);
      return result.ok ? { ok: true, content } : { ok: false, content, error: errorOf(content) };
    },
  };
}

/**
 * Guide-facing catalog tools. Owns confirm gating and pipeline/stage placement over `buildToolkit`.
 * MCP and other agents keep using raw `buildToolkit`.
 */
export function GuideToolkit(deps: McpToolDeps): OperatorAgentTool[] {
  const signal = new AbortController().signal;
  return buildToolkit(deps)
    .filter((tool) => !isOperatorOnlyTool(tool.name))
    .map((tool) => wrapCatalogTool(tool, deps, signal));
}
