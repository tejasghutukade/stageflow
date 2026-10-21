import type { BrowserSandboxOrchestrator } from "./sandboxOrchestrator.js";

export type LiveViewSourceRequest = {
  runId: string;
  stageId: string;
  /** Opaque sandbox reference of the stage's browser. */
  sandboxId: string;
};

export type LiveViewAddress = {
  /** Short-lived and per-session. Never store it in a gate, run file, log or audit record. */
  url: string;
  /** Origin the console must allow to embed the viewer. */
  embedOrigin: string;
  expiresAt: number;
};

export interface LiveViewSource {
  viewerAddress(request: LiveViewSourceRequest): Promise<LiveViewAddress>;
}

export type SandboxIdResolver = (input: {
  scope: string;
  runId: string;
  stageId: string;
  profile?: string;
}) => Promise<string | undefined>;

/** Finds the stage's sandbox by the labels every orchestrator stamps on it. */
export function sandboxIdFromLabels(
  orchestrator: Pick<BrowserSandboxOrchestrator, "listByLabel">,
): SandboxIdResolver {
  return async ({ scope, runId, profile }) => {
    const found = await orchestrator.listByLabel({ scope, runId, ...(profile !== undefined ? { profile } : {}) });
    return found.find((info) => info.status === "running")?.ref.id;
  };
}
