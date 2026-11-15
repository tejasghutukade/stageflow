import type { AgentDefinition, AgentIssue } from "../config/loadAgent.js";
import { STAGEFLOW_GRANT_PREFIX, TOOL_META } from "./meta.js";
import { GUIDE_OWN_TOOL_NAMES } from "./profiles.js";
import { TOOL_RENAMES } from "./toolRenames.js";

export function absorbedOldNames(newTool: string): string[] {
  return Object.entries(TOOL_RENAMES)
    .filter(([, entry]) => entry.newTool === newTool)
    .map(([old]) => old)
    .sort();
}

export function staleBareStageflowTool(name: string): string | undefined {
  if (name in TOOL_META) return undefined;
  return TOOL_RENAMES[name]?.newTool;
}

export function staleStageflowGrantId(grantId: string): string | undefined {
  if (!grantId.startsWith(STAGEFLOW_GRANT_PREFIX)) return undefined;
  return staleBareStageflowTool(grantId.slice(STAGEFLOW_GRANT_PREFIX.length));
}

export function widenedStageflowToolMessage(bareName: string): string | undefined {
  if (!(bareName in TOOL_META)) return undefined;
  const extras = absorbedOldNames(bareName).filter((old) => old !== bareName);
  if (extras.length === 0) return undefined;
  return `Granting ${bareName} also covers ${extras.join(", ")}`;
}

export function widenedStageflowGrantMessage(grantId: string): string | undefined {
  if (!grantId.startsWith(STAGEFLOW_GRANT_PREFIX)) return undefined;
  return widenedStageflowToolMessage(grantId.slice(STAGEFLOW_GRANT_PREFIX.length));
}

export function isKnownGuideEvalTool(name: string): boolean {
  if (name in TOOL_META) return true;
  return (GUIDE_OWN_TOOL_NAMES as readonly string[]).includes(name);
}

export function staleBareToolMessage(name: string): string {
  const replacement = staleBareStageflowTool(name);
  return replacement
    ? `${name} was renamed; use ${replacement}`
    : `${name} is not a Stageflow tool`;
}

export function staleGrantMessage(grantId: string): string {
  const replacement = staleStageflowGrantId(grantId);
  if (!replacement) return `${grantId} is not a Stageflow tool`;
  return `${grantId} was renamed; use ${STAGEFLOW_GRANT_PREFIX}${replacement}`;
}

export function stageflowDefinitionValidation(definition: AgentDefinition): { errors: AgentIssue[]; warnings: AgentIssue[] } {
  const errors: AgentIssue[] = [];
  const warnings: AgentIssue[] = [];
  const granted = new Set<string>();
  definition.tools.stageflow.tools.forEach((tool, index) => {
    const path = `tools.stageflow.tools.${index}`;
    const replacement = staleBareStageflowTool(tool);
    if (replacement) {
      errors.push({ path, code: "agent.stageflow_tool_unknown", message: staleBareToolMessage(tool) });
      return;
    }
    if (!(tool in TOOL_META)) {
      errors.push({ path, code: "agent.stageflow_tool_unknown", message: staleBareToolMessage(tool) });
      return;
    }
    const widened = widenedStageflowToolMessage(tool);
    if (widened) warnings.push({ path, code: "agent.stageflow_tool_widened", message: widened });
  });
  definition.approvals.ask_first.forEach((tool, index) => {
    const path = `approvals.ask_first.${index}`;
    const replacement = staleStageflowGrantId(tool);
    if (replacement) {
      errors.push({ path, code: "agent.stageflow_tool_unknown", message: staleGrantMessage(tool) });
      return;
    }
    if (tool.startsWith(STAGEFLOW_GRANT_PREFIX)) {
      const bare = tool.slice(STAGEFLOW_GRANT_PREFIX.length);
      if (!(bare in TOOL_META)) {
        errors.push({ path, code: "agent.stageflow_tool_unknown", message: staleGrantMessage(tool) });
        return;
      }
      const widened = widenedStageflowGrantMessage(tool);
      if (widened) warnings.push({ path, code: "agent.stageflow_tool_widened", message: widened });
    }
  });
  return { errors, warnings };
}

export function stageflowStaleIssues(definition: AgentDefinition): AgentIssue[] {
  return stageflowDefinitionValidation(definition).errors;
}