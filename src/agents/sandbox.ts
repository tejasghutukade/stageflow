import type { AgentDefinition } from "../config/loadAgent.js";
import { AgentError } from "./errors.js";

export type SandboxRunner = {
  prepareLaunch(input: { projectRoot: string; definition: AgentDefinition }): Promise<{ ref: string }>;
};

export type ExecutionLaunch = { mode: "trusted-local" } | { mode: "sandbox"; ref: string };

/** A sandboxed agent never falls back to trusted-local when no sandbox is available. */
export async function prepareExecutionLaunch(
  definition: AgentDefinition,
  projectRoot: string,
  runner: SandboxRunner | undefined,
): Promise<ExecutionLaunch> {
  if (definition.execution === "trusted-local") return { mode: "trusted-local" };
  if (!runner) throw new AgentError("agent.sandbox_unavailable");
  const launched = await runner.prepareLaunch({ projectRoot, definition });
  return { mode: "sandbox", ref: launched.ref };
}
