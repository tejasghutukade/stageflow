import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../src/agents/service.js";
import { AgentConversation, type ConversationBackend } from "../src/agents/sessions.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

afterEach(() => {
  resetGlobalStageflowHomeForTests();
});

describe("agent session restart", () => {
  it("continues a reloaded session on its pinned instructions", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agents-restart-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-agents-restart-project-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const service = new AgentService({ homeDir: home });
    const created = await service.create(project, {
      id: "research_assistant",
      name: "Research assistant",
      instructions: "Pinned",
    });
    const enabled = await service.setEnabled(project, created.id, true);
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    const seen: string[] = [];
    const backend: ConversationBackend = {
      id: "pi",
      async complete(input) {
        seen.push(input.instructions);
        return { text: "ok" };
      },
    };
    const first = await new AgentConversation({ service, backend }).send({
      projectRoot: project,
      agentId: created.id,
      text: "First",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await service.save(project, created.id, {
      baseRevision: enabled.agent.revision,
      name: "Research assistant",
      instructions: "Changed",
    });
    const second = await new AgentConversation({
      service: new AgentService({ homeDir: home }),
      backend,
    }).send({
      projectRoot: project,
      agentId: created.id,
      sessionId: first.session.id,
      text: "Second",
    });
    expect(second.ok).toBe(true);
    expect(seen).toEqual(["Pinned", "Pinned"]);
  });
});