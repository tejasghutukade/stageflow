import { describe, expect, it, vi } from "vitest";
import { AgentApiError, type AgentDefinition, type AgentDetail } from "../../../api/agents";
import { newAgentDefinition } from "../model/definition";
import {
  createAgentHandlingIdCollision,
  isAutoDerivedAgentId,
  messageForExplicitIdCollision,
  slugAgentId,
} from "./createCollision";

function draft(patch: Partial<AgentDefinition>): AgentDefinition {
  return { ...newAgentDefinition(), ...patch };
}

function detail(id: string): AgentDetail {
  return { agent: { id, name: id } as AgentDetail["agent"], definition: draft({ id, name: id }), yaml: "", warnings: [] };
}

describe("createCollision", () => {
  it("slugs names like the server generator", () => {
    expect(slugAgentId("Research Assistant!")).toBe("research_assistant");
    expect(slugAgentId("123")).toBe("");
  });

  it("treats empty and slug-matching ids as auto-derived", () => {
    expect(isAutoDerivedAgentId("", "Support")).toBe(true);
    expect(isAutoDerivedAgentId("support", "Support")).toBe(true);
    expect(isAutoDerivedAgentId("my_custom_id", "Support")).toBe(false);
  });

  it("uniquifies auto-derived collisions by clearing id and retrying once", async () => {
    const create = vi.fn(async (definition: AgentDefinition) => {
      if (definition.id === "support") {
        throw new AgentApiError("agent.exists", 409, "agent.exists");
      }
      expect(definition.id).toBe("");
      return detail("support_2");
    });
    const created = await createAgentHandlingIdCollision(draft({ id: "support", name: "Support" }), create);
    expect(created.agent.id).toBe("support_2");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("fails closed with a readable message for an explicit colliding id", async () => {
    const create = vi.fn(async () => {
      throw new AgentApiError("agent.exists", 409, "agent.exists");
    });
    await expect(
      createAgentHandlingIdCollision(draft({ id: "my_custom_id", name: "Support" }), create),
    ).rejects.toMatchObject({
      code: "agent.exists",
      message: messageForExplicitIdCollision("my_custom_id"),
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
