import {
  asAgentBackendId,
  STAGE_LEVEL_AGENT_OVERRIDE_ENABLED,
  type AgentBackendId,
} from "./agentBackend.js";
import type { AgentPort } from "./port.js";
import { PiAgentAdapter } from "./piAdapter.js";
import { ClaudeAgentAdapter } from "./claudeAdapter.js";
import { loadStageflowManifestOutcome } from "../config/loadStageflowManifest.js";
import type { LoadedManifest } from "../types/stageflowManifest.js";

export type AgentSelection = {
  /** stageflow.yaml top-level `agent`. */
  global?: AgentBackendId;
  /** Pipeline yaml top-level `agent`; overrides global. */
  pipeline?: AgentBackendId;
  /** Stage yaml `agent`; would override pipeline/global once enabled. */
  stage?: AgentBackendId;
};

/** stage > pipeline > global > "pi", with stage gated off for now. */
export function resolveAgentBackend(selection: AgentSelection = {}): AgentBackendId {
  if (STAGE_LEVEL_AGENT_OVERRIDE_ENABLED && selection.stage !== undefined) {
    return selection.stage;
  }
  return selection.pipeline ?? selection.global ?? "pi";
}

export function resolveAgentPort(selection: AgentSelection = {}): AgentPort {
  const backend = resolveAgentBackend(selection);
  switch (backend) {
    case "pi":
      return new PiAgentAdapter();
    case "claude":
      return new ClaudeAgentAdapter();
  }
}

/** The global tier's backend id from an already-loaded manifest, or undefined for missing/invalid/unset. */
export function globalAgentBackendFromManifest(
  manifest: LoadedManifest | null,
): AgentBackendId | undefined {
  return manifest ? asAgentBackendId(manifest.manifest.agent) : undefined;
}

/**
 * Resolves an AgentPort using only the global (stageflow.yaml) tier — for
 * the three call sites that construct an agent before any pipeline is
 * known (`cli.ts`'s ui/mcp servers, `runCommand.ts`, `runsCommand.ts`).
 * Named explicitly so it's clear these sites are scoped to the global tier
 * on purpose, not by omission: production stage execution always goes
 * through `stageWorker.ts`, which resolves the full stage > pipeline >
 * global chain once it has loaded the specific pipeline and stage.
 */
export async function resolveGlobalOnlyAgentPort(projectRoot: string): Promise<AgentPort> {
  const outcome = await loadStageflowManifestOutcome(projectRoot);
  return resolveAgentPort({
    global: outcome.ok ? globalAgentBackendFromManifest(outcome.value) : undefined,
  });
}
