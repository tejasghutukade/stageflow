import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createOpenRouterRoutingExtension } from "../agent/openRouterRouting.js";
import { createWorkingStateExtension } from "../tools/workingState.js";
import { createCompactionExtension } from "./extension.js";
import { WORKING_STATE_TOOL_NAME } from "./types.js";
import { WORKING_STATE_GUIDANCE } from "./workingState.js";

export type SessionContextWiring = {
  /** Inline extensions to register, in order. */
  extensions: InlineExtension[];
  /** Tool names to add to the session's allowlist. */
  toolNames: string[];
  /** Text for the system prompt; empty when the session has no working state. */
  guidance: string;
  /** Tools whose output the tool-output budget must never spill or cap. */
  budgetExemptNames: string[];
  /** Tools the agent tool gate lets through without a grant or an approval. */
  isInternalTool(toolName: string): boolean;
};

const warn = (message: string): void => console.error(message);

/**
 * What a Pi session needs for context management, owned in one place: OpenRouter routing, compaction and
 * (unless `workingState` is false) the working_state tool with its allowlist entry, prompt guidance and
 * gate and budget exemptions. Stage sessions, project agents and the operator agent all call this, so the
 * pieces cannot drift apart.
 */
export function createSessionContextWiring(options: { workingState: boolean }): SessionContextWiring {
  const withState = options.workingState;
  return {
    extensions: [
      { name: "stageflow-openrouter-routing", factory: createOpenRouterRoutingExtension() },
      { name: "stageflow-compaction", factory: createCompactionExtension({ onWarn: warn }) },
      ...(withState ? [{ name: "stageflow-working-state", factory: createWorkingStateExtension() }] : []),
    ],
    toolNames: withState ? [WORKING_STATE_TOOL_NAME] : [],
    guidance: withState ? WORKING_STATE_GUIDANCE : "",
    budgetExemptNames: withState ? [WORKING_STATE_TOOL_NAME] : [],
    isInternalTool: (toolName) => withState && toolName === WORKING_STATE_TOOL_NAME,
  };
}
