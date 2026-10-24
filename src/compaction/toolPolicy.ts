import { classifyTool } from "../agents/toolRisk.js";
import { WORKING_STATE_TOOL_NAME } from "./types.js";

export type ClearingClass = "clearable" | "keep";

const ALWAYS_KEEP = new Set([
  "ask_operator",
  "emit_stage_envelope",
  "write_stage_artifact",
  "write",
  "edit",
  WORKING_STATE_TOOL_NAME,
]);

const CLEARABLE_BUILTINS = new Set(["read", "grep", "find", "ls"]);

/** Fail closed: only provably re-fetchable read results are clearable; everything else is kept. */
export function classifyForClearing(toolName: string, isError: boolean, _details?: unknown): ClearingClass {
  if (isError) return "keep";
  if (typeof toolName !== "string" || toolName.length === 0) return "keep";
  if (ALWAYS_KEEP.has(toolName)) return "keep";
  if (CLEARABLE_BUILTINS.has(toolName)) return "clearable";
  if (toolName === "bash") return "clearable";
  if (toolName.startsWith("stageflow_")) {
    const name = toolName.slice("stageflow_".length);
    return ALWAYS_KEEP.has(name) ? "keep" : classifyTool(undefined, `stageflow.${name}`).readOnly ? "clearable" : "keep";
  }
  try {
    return classifyTool(undefined, toolName).readOnly ? "clearable" : "keep";
  } catch {
    return "keep";
  }
}
