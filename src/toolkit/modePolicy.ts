import { TOOL_META } from "./meta.js";
import type { ResolvedMode } from "./modes.js";
import { resolveMode } from "./modes.js";

export type GuideConfirmFieldSpec = { action?: true; id?: true };

export type GuideModePolicy = { confirmation: true; confirmFields?: GuideConfirmFieldSpec };

const NEVER_CONFIRMED = new Set(["probe_project_mcp"]);

export const GUIDE_MODE_POLICY: Readonly<Partial<Record<string, Readonly<Record<string, GuideModePolicy>>>>> = {
  start_run: {
    pipeline: { confirmation: true, confirmFields: { action: true } },
    stage: { confirmation: true, confirmFields: { action: true } },
    from_run: { confirmation: true, confirmFields: { action: true, id: true } },
  },
  stage_action: {
    retry: { confirmation: true, confirmFields: { action: true, id: true } },
    recover: { confirmation: true, confirmFields: { action: true, id: true } },
    resume: { confirmation: true, confirmFields: { action: true, id: true } },
    stop_recovery: { confirmation: true, confirmFields: { action: true, id: true } },
  },
  delete_runs: {
    delete: { confirmation: true, confirmFields: { id: true } },
    gc: { confirmation: true, confirmFields: { action: true } },
    gc_execute: { confirmation: true, confirmFields: { action: true } },
  },
  set_agent_enabled: {
    enable: { confirmation: true },
  },
  save_trigger: {
    create_enabled: { confirmation: true },
    enable: { confirmation: true, confirmFields: { id: true } },
    disable: { confirmation: true, confirmFields: { id: true } },
    update: { confirmation: true, confirmFields: { id: true } },
  },
};

export type GuideConfirmationOutcome = "none" | "required" | "resolver_rejected";

function riskBasedGuideConfirmation(tool: string): boolean {
  if (NEVER_CONFIRMED.has(tool)) return false;
  const meta = TOOL_META[tool];
  if (!meta) return false;
  return meta.risk === "external" || meta.risk === "destructive";
}

export function guideModePolicy(tool: string, mode: string): GuideModePolicy | undefined {
  return GUIDE_MODE_POLICY[tool]?.[mode];
}

export function guideConfirmationOutcome(tool: string, args: Record<string, unknown>): GuideConfirmationOutcome {
  const resolved = resolveMode(tool, args);
  if (resolved === undefined) return riskBasedGuideConfirmation(tool) ? "required" : "none";
  if (!resolved.ok) return "resolver_rejected";
  const modePolicy = guideModePolicy(tool, resolved.resolved.mode);
  if (modePolicy?.confirmation) return "required";
  return riskBasedGuideConfirmation(tool) ? "required" : "none";
}

export function guideToolMayNeedConfirmation(tool: string): boolean {
  if (GUIDE_MODE_POLICY[tool]) return true;
  return riskBasedGuideConfirmation(tool);
}

export const GUIDE_CONFIRMED_TOOLS: ReadonlySet<string> = new Set(
  [...Object.keys(TOOL_META), ...Object.keys(GUIDE_MODE_POLICY)].filter(guideToolMayNeedConfirmation),
);

export function resolvedModeForCall(tool: string, args: Record<string, unknown>): ResolvedMode | undefined {
  const resolved = resolveMode(tool, args);
  return resolved?.ok ? resolved.resolved : undefined;
}

export function evalGateDeniedByMode(tool: string, args: Record<string, unknown>): string | undefined {
  const resolved = resolveMode(tool, args);
  if (resolved && !resolved.ok) return resolved.message || "Invalid arguments.";
  return undefined;
}

export function placementDeniedByMode(tool: string, args: Record<string, unknown>): string | undefined {
  return evalGateDeniedByMode(tool, args);
}

export function guardDeniedByMode(tool: string, args: Record<string, unknown>): string | undefined {
  return evalGateDeniedByMode(tool, args);
}

export function guideToolRequiresConfirmAction(tool: string): boolean {
  const modes = GUIDE_MODE_POLICY[tool];
  if (!modes) return false;
  return Object.values(modes).some((policy) => policy.confirmFields?.action === true);
}

export function confirmFieldsForTool(tool: string, action: string | undefined): GuideConfirmFieldSpec | undefined {
  if (action) return GUIDE_MODE_POLICY[tool]?.[action]?.confirmFields;
  if (!guideToolRequiresConfirmAction(tool)) return undefined;
  return { action: true };
}