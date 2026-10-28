import { isOperatorOnlyTool, TOOL_META } from "./meta.js";

/**
 * The Workshop and Agent-author profiles are agents with a fixed grant list.
 * Their tools are checked through the same grant-id check as any agent's tools,
 * so there is one permission layer. The lists are literals so this module has no
 * dependency on the profiles; tests keep them equal to the profiles' tool names.
 * Guide is the exception: it may call every Stageflow tool a person could grant,
 * except the ones only a person may decide.
 */

export const GUIDE_OWN_TOOL_NAMES = ["confirm_action", "show_ui", "list_guide_topics", "read_guide_topic"] as const;

/** Tool names Guide may call. Operator-only decisions stay out. */
export function stageflowGuideToolNames(): readonly string[] {
  return [...Object.keys(TOOL_META).filter((name) => !isOperatorOnlyTool(name)), ...GUIDE_OWN_TOOL_NAMES];
}

export const PROFILE_GRANTS: Readonly<Record<string, { prefix: string; tools: readonly string[] }>> = {
  "workshop-author": {
    prefix: "workshop.",
    tools: ["list_builds", "focus_build", "create_build", "read_draft", "validate_draft", "create_pipeline", "edit_pipeline", "create_stage", "edit_stage", "create_task", "edit_task", "save", "propose_draft", "retrieve_docs"],
  },
  "agent-author": {
    prefix: "agent_author.",
    tools: ["read_agent_draft", "read_project_file", "list_project_files", "list_mcp_servers", "list_author_catalog", "update_agent_draft"],
  },
  "stageflow-guide": {
    prefix: "guide.",
    tools: stageflowGuideToolNames(),
  },
};

export function profileGrantIds(profileId: string): Set<string> {
  const grants = PROFILE_GRANTS[profileId];
  return new Set((grants?.tools ?? []).map((tool) => `${grants!.prefix}${tool}`));
}

/** True when the profile holds the grant for this tool. Unknown profiles hold nothing. */
export function profileMayUse(profileId: string, tool: string): boolean {
  const grants = PROFILE_GRANTS[profileId];
  return grants !== undefined && profileGrantIds(profileId).has(`${grants.prefix}${tool}`);
}
