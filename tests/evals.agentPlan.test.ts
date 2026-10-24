import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildEvalPlan } from "../src/evals/plan.js";
import { agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/evals/agent/project");
const engine = { name: "fake", version: "1", nodeVersion: "22" };

async function project() {
  const fx = await agentsFixture();
  fixtures.push(fx);
  await cp(SRC, fx.project, { recursive: true, force: true });
  return fx;
}

describe("buildEvalPlan for agents", () => {
  it("pins the current revision and fills agent settings", async () => {
    const fx = await project();
    const result = await buildEvalPlan({
      projectRoot: fx.project,
      evalPath: "evals/support-basics.eval.yaml",
      evalRunId: "er_1",
      engine,
      agents: fx.service,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.findings.filter((f) => f.severity === "error")));
    const { plan, snapshot } = result;
    expect(plan.target).toMatchObject({ kind: "agent", agentId: "support" });
    expect(plan.target.kind === "agent" && plan.target.revision).toBeGreaterThan(0);
    expect(plan.conversation).toMatchObject({ mode: "simulated", maxTurns: 8 });
    expect(plan.userModel).toBe("anthropic/claude-sonnet-4-5");
    expect(plan.agent?.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.target.kind).toBe("agent");
    expect(plan.cases.length).toBeGreaterThan(0);
  });

  it("reports agents unavailable without a service", async () => {
    const fx = await project();
    const result = await buildEvalPlan({ projectRoot: fx.project, evalPath: "evals/support-basics.eval.yaml", evalRunId: "er_1", engine });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.findings.map((f) => f.code)).toContain("eval.agents_unavailable");
  });
});
