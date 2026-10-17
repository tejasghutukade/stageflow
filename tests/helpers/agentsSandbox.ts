import type { SandboxRunner } from "../../src/agents/sandbox.js";

export { prepareExecutionLaunch } from "../../src/agents/sandbox.js";

export function createFakeSandboxRunner(ref = "sandbox-test"): SandboxRunner {
  return { prepareLaunch: async () => ({ ref }) };
}
