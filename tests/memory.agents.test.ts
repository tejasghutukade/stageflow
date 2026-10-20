import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError } from "../src/agents/errors.js";
import { parseAgentDefinition } from "../src/config/loadAgent.js";
import { createMemoryHost } from "../src/memory/host.js";
import { agentInput, agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("agent memories", () => {
  it("still parses an agent that does not name a memory", () => {
    const parsed = parseAgentDefinition(agentInput("helper"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.memories).toBeUndefined();
  });

  it("refuses to create, save, or enable an agent whose memory is missing", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const actor = { source: "console" as const };
    const missing = agentInput("helper", { memories: ["refunds"] });

    await expect(fixture.service.create(fixture.project, missing, actor)).rejects.toMatchObject({
      code: "agent.invalid",
      issues: [expect.objectContaining({ code: "agent.memory_unavailable" })],
    });

    const host = createMemoryHost(process.env.STAGEFLOW_HOME!);
    await host.create({ id: "refunds", description: "Refunds already given." });
    const created = await fixture.service.create(fixture.project, missing, actor);
    expect(created.definition.memories).toEqual(["refunds"]);

    await rm(path.join(process.env.STAGEFLOW_HOME!, "memories", "refunds"), { recursive: true });
    await expect(fixture.service.setEnabled(fixture.project, "helper", true, actor)).rejects.toBeInstanceOf(AgentError);

    await host.create({ id: "refunds", description: "Refunds already given." });
    await fixture.service.setEnabled(fixture.project, "helper", true, actor);
    await rm(path.join(process.env.STAGEFLOW_HOME!, "memories", "refunds"), { recursive: true });
    await expect(
      fixture.service.save(
        fixture.project,
        "helper",
        { baseRevision: 2, definition: { ...created.definition, memories: ["refunds"] } },
        actor,
      ),
    ).rejects.toMatchObject({
      code: "agent.invalid",
      issues: [expect.objectContaining({ code: "agent.memory_unavailable" })],
    });
  });
});
