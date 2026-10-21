import {
  asAgentBackendId,
  STAGE_LEVEL_AGENT_OVERRIDE_ENABLED,
  type AgentBackendId,
} from "./agentBackend.js";
import type { StagePort } from "./port.js";
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
export function resolveStageBackend(selection: AgentSelection = {}): AgentBackendId {
  if (STAGE_LEVEL_AGENT_OVERRIDE_ENABLED && selection.stage !== undefined) {
    return selection.stage;
  }
  return selection.pipeline ?? selection.global ?? "pi";
}

/** Existing Pi StagePort. Hosted runs pass this into createHostedRuntime. */
export function createPiStagePort(): StagePort {
  return new PiAgentAdapter();
}

export function resolveStagePort(selection: AgentSelection = {}): StagePort {
  const backend = resolveStageBackend(selection);
  switch (backend) {
    case "pi":
      return createPiStagePort();
    case "claude":
      return new ClaudeAgentAdapter();
  }
}

/** The global tier's backend id from an already-loaded manifest, or undefined for missing/invalid/unset. */
export function globalStageBackendFromManifest(
  manifest: LoadedManifest | null,
): AgentBackendId | undefined {
  return manifest ? asAgentBackendId(manifest.manifest.agent) : undefined;
}

/**
 * Resolves an StagePort using only the global (stageflow.yaml) tier — for
 * the three call sites that construct an agent before any pipeline is
 * known (`cli.ts`'s ui/mcp servers, `runCommand.ts`, `runsCommand.ts`).
 * Named explicitly so it's clear these sites are scoped to the global tier
 * on purpose, not by omission: production stage execution always goes
 * through `stageWorker.ts`, which resolves the full stage > pipeline >
 * global chain once it has loaded the specific pipeline and stage.
 */
export async function resolveGlobalOnlyStagePort(projectRoot: string): Promise<StagePort> {
  const outcome = await loadStageflowManifestOutcome(projectRoot);
  return resolveStagePort({
    global: outcome.ok ? globalStageBackendFromManifest(outcome.value) : undefined,
  });
}
