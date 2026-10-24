import type { AgentDefinition } from "../config/loadAgent.js";

export const EVAL_SESSION_SOURCE = "eval";

export type EvalSessionOverrides = {
  /** Open this revision instead of the current one. Pinned for the life of the session. */
  revision?: number;
  definition?: {
    model?: Partial<AgentDefinition["model"]>;
    limits?: Partial<AgentDefinition["limits"]>;
    observability?: Partial<AgentDefinition["observability"]>;
    evals?: Partial<AgentDefinition["evals"]>;
  };
  limits?: { max_turns?: number; session_minutes?: number; cost_usd?: number | null };
  capture?: AgentDefinition["observability"]["capture"];
};

export function isEvalSession(session: { source: string }): boolean {
  return session.source === EVAL_SESSION_SOURCE;
}

/**
 * The definition an eval session runs on: the pinned revision with the eval's model, limits and capture, and with
 * every side effect off (always-on, OTLP push, groundedness judge). Capture defaults to full so tool calls are recorded.
 */
export function applyEvalOverrides(base: AgentDefinition, overrides: EvalSessionOverrides): AgentDefinition {
  const { definition } = overrides;
  const limits: AgentDefinition["limits"] = {
    ...base.limits,
    ...definition?.limits,
    ...(overrides.limits ? { cost_usd: null, ...overrides.limits } : {}),
    always_on: false,
  };
  return {
    ...base,
    model: { ...base.model, ...definition?.model },
    limits,
    observability: {
      ...base.observability,
      ...definition?.observability,
      capture: overrides.capture ?? definition?.observability?.capture ?? "full",
      otlp: false,
    },
    evals: { ...base.evals, ...definition?.evals, groundedness: false },
  } as AgentDefinition;
}
