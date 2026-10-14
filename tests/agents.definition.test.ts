import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentField } from "../src/agent/agentBackend.js";
import { AgentService } from "../src/agents/service.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

const homes: string[] = [];

function yaml(fields: Record<string, string | boolean>): string {
  return Object.entries(fields)
    .map(([key, value]) =>
      typeof value === "boolean" ? `${key}: ${value}` : `${key}: ${JSON.stringify(value)}`,
    )
    .join("\n");
}

async function fixture(): Promise<{ home: string; project: string; service: AgentService }> {
  const home = path.join(tmpdir(), `sf-agents-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const project = path.join(home, "project");
  await mkdir(path.join(project, "agents"), { recursive: true });
  homes.push(home);
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  return { home, project, service: new AgentService({ homeDir: home }) };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("agent definitions", () => {
  it("loads a valid file as revision 1", async () => {
    const { project, service } = await fixture();
    await writeFile(
      path.join(project, "agents", "research_assistant.agent.yaml"),
      yaml({
        id: "research_assistant",
        name: "Research assistant",
        instructions: "Find sources.",
        enabled: false,
      }),
    );

    const listed = await service.list(project);
    expect(listed).toEqual([
      expect.objectContaining({
        id: "research_assistant",
        revision: 1,
        enabled: false,
        archived: false,
      }),
    ]);
    const revision = await service.revision(project, "research_assistant", 1);
    expect(revision?.name).toBe("Research assistant");
  });

  it("keeps revision 1 when a second valid write creates revision 2", async () => {
    const { project, service } = await fixture();
    const file = path.join(project, "agents", "research_assistant.agent.yaml");
    await writeFile(
      file,
      yaml({
        id: "research_assistant",
        name: "Research assistant",
        instructions: "Find sources.",
        enabled: false,
      }),
    );
    await service.list(project);
    await writeFile(
      file,
      yaml({
        id: "research_assistant",
        name: "Research assistant",
        instructions: "Find sources and cite them.",
        enabled: false,
      }),
    );

    const current = await service.get(project, "research_assistant");
    const first = await service.revision(project, "research_assistant", 1);
    expect(current?.revision).toBe(2);
    expect(first?.instructions).toBe("Find sources.");
    expect(current?.instructions).toBe("Find sources and cite them.");
  });

  it("keeps the last valid revision when a write is invalid and omits file contents", async () => {
    const { project, service } = await fixture();
    const file = path.join(project, "agents", "research_assistant.agent.yaml");
    await writeFile(
      file,
      yaml({
        id: "research_assistant",
        name: "Research assistant",
        instructions: "Find sources.",
        enabled: false,
      }),
    );
    await service.list(project);
    await writeFile(file, "id: research_assistant\ninstructions: \"sk-live-secret\n");

    const current = await service.get(project, "research_assistant");
    expect(current?.revision).toBe(1);
    expect(current?.error?.message ?? "").not.toContain("sk-live-secret");
    expect(JSON.stringify(current)).not.toContain("sk-live-secret");
  });

  it("rejects a stale console save and leaves the file unchanged", async () => {
    const { project, service } = await fixture();
    const created = await service.create(project, {
      id: "research_assistant",
      name: "Research assistant",
      instructions: "Find sources.",
    });
    await service.save(project, "research_assistant", {
      baseRevision: created.revision,
      name: "Research assistant",
      instructions: "Cite sources.",
    });
    const before = await readFile(
      path.join(project, "agents", "research_assistant.agent.yaml"),
      "utf8",
    );

    const conflict = await service.save(project, "research_assistant", {
      baseRevision: created.revision,
      name: "Research assistant",
      instructions: "Overwrite.",
    });
    const after = await readFile(
      path.join(project, "agents", "research_assistant.agent.yaml"),
      "utf8",
    );
    expect(conflict).toEqual({ ok: false, code: "agent.conflict" });
    expect(after).toBe(before);
  });

  it("rejects new sessions and turns while disabled, and keeps a session readable after archive", async () => {
    const { project, service } = await fixture();
    await service.create(project, {
      id: "research_assistant",
      name: "Research assistant",
      instructions: "Find sources.",
    });
    await service.setEnabled(project, "research_assistant", true);
    const session = await service.openSession(project, "research_assistant");
    expect(session.ok).toBe(true);
    await service.setEnabled(project, "research_assistant", false);

    const nextSession = await service.openSession(project, "research_assistant");
    const turn = await service.startTurn(project, session.ok ? session.session.id : "");
    expect(nextSession).toEqual({ ok: false, code: "agent.disabled" });
    expect(turn).toEqual({ ok: false, code: "agent.disabled" });

    await service.archive(project, "research_assistant");
    const stored = await service.getSession(project, session.ok ? session.session.id : "");
    expect(stored?.agentId).toBe("research_assistant");
    expect((await service.get(project, "research_assistant"))?.archived).toBe(true);
  });

  it("archives an agent when its YAML file is removed", async () => {
    const { project, service } = await fixture();
    await service.create(project, {
      id: "research_assistant",
      name: "Research assistant",
      instructions: "Find sources.",
    });
    await rm(path.join(project, "agents", "research_assistant.agent.yaml"));

    const agent = await service.get(project, "research_assistant");
    expect(agent?.archived).toBe(true);
    expect(agent?.revision).toBe(1);
  });

  it("still treats stage agent: pi as a backend id", () => {
    expect(parseAgentField("pi")).toEqual({ ok: true, value: "pi" });
  });
});
