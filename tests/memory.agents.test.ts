import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError } from "../src/agents/errors.js";
import { parseAgentDefinition } from "../src/config/loadAgent.js";
import { bindStageMemory, formatMemoryPrompt } from "../src/memory/access.js";
import { createMemoryHost } from "../src/memory/host.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import {
  createAddMemoryCardTool,
  createReadMemoryCardTool,
  createSearchMemoryCardsTool,
  createUpdateMemoryCardTool,
} from "../src/tools/memoryTools.js";
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function notebookHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sf-memory-cards-"));
}

describe("memory cards for an attached session", () => {
  it("adds ada@example.com and a second call reads sourced", async () => {
    const dir = await notebookHome();
    try {
      const host = createMemoryHost(dir);
      await host.create({ id: "notebook", description: "People already sourced." });
      const memory = await bindStageMemory(host, ["notebook"]);
      const add = createAddMemoryCardTool(memory);
      const read = createReadMemoryCardTool(memory);
      const wrote = await add.execute("1", { memory: "notebook", key: "ada@example.com", content: "sourced" });
      expect(wrote.isError).toBeUndefined();
      expect(JSON.stringify(wrote)).not.toContain(dir);
      const got = await read.execute("2", { memory: "notebook", key: "ada@example.com" });
      expect(got.isError).toBeUndefined();
      expect(got.content[0]?.text).toBe("sourced");
      expect(JSON.stringify(got)).not.toContain(dir);
      expect("deleteCard" in memory).toBe(false);
      expect("readPreviousCard" in memory).toBe(false);
      expect("readPreviousCover" in memory).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("updates the body and search returns that key", async () => {
    const dir = await notebookHome();
    try {
      const host = createMemoryHost(dir);
      await host.create({ id: "notebook", description: "People already sourced." });
      const memory = await bindStageMemory(host, ["notebook"]);
      const add = createAddMemoryCardTool(memory);
      const update = createUpdateMemoryCardTool(memory);
      const search = createSearchMemoryCardsTool(memory);
      await add.execute("1", { memory: "notebook", key: "ada@example.com", content: "sourced" });
      const updated = await update.execute("2", {
        memory: "notebook",
        key: "ada@example.com",
        content: "shortlisted for the role",
      });
      expect(updated.isError).toBeUndefined();
      expect(JSON.stringify(updated)).not.toContain(dir);
      expect(await memory.readCard("notebook", "ada@example.com")).toBe("shortlisted for the role");
      const found = await search.execute("3", { memory: "notebook", query: "shortlisted" });
      expect(found.isError).toBeUndefined();
      expect(JSON.stringify(found)).not.toContain(dir);
      expect(JSON.parse(found.content[0]?.text ?? "[]")).toEqual([
        expect.objectContaining({ key: "ada@example.com" }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an id that is not attached and writes no card", async () => {
    const dir = await notebookHome();
    try {
      const host = createMemoryHost(dir);
      await host.create({ id: "notebook", description: "People already sourced." });
      await host.create({ id: "payroll", description: "Not for this session." });
      const memory = await bindStageMemory(host, ["notebook"]);
      const add = createAddMemoryCardTool(memory);
      const denied = await add.execute("1", { memory: "payroll", key: "ada@example.com", content: "sourced" });
      expect(denied.isError).toBe(true);
      expect(JSON.parse(denied.content[0]?.text ?? "{}")).toEqual({ code: "MEMORY_NOT_ATTACHED" });
      expect(denied.content[0]?.text ?? "").not.toContain(dir);
      expect(denied.details).toEqual({ code: "MEMORY_NOT_ATTACHED" });
      await expect(memory.addCard("payroll", "ada@example.com", "sourced")).rejects.toMatchObject({
        code: "MEMORY_NOT_ATTACHED",
      });
      expect(await host.listCards("payroll")).toEqual([]);
      expect(await host.listCards("notebook")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names the card tools and the memory id without the page or card body", async () => {
    const dir = await notebookHome();
    try {
      const host = createMemoryHost(dir);
      await host.create({ id: "notebook", description: "People already sourced." });
      await host.replace("notebook", "page-body-marker");
      await host.addCard("notebook", "ada@example.com", "card-body-marker");
      const memory = await bindStageMemory(host, ["notebook"]);
      const text = formatMemoryPrompt(memory.attachments);
      expect(text).toContain("notebook");
      expect(text).toContain("People already sourced.");
      for (const name of ["add_memory_card", "update_memory_card", "read_memory_card", "search_memory_cards"]) {
        expect(text).toContain(name);
      }
      expect(text).not.toContain("page-body-marker");
      expect(text).not.toContain("card-body-marker");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns the same card through the worker IPC path", async () => {
    const dir = await notebookHome();
    const previousHome = process.env.STAGEFLOW_HOME;
    process.env.STAGEFLOW_HOME = dir;
    const scriptPath = path.join(dir, "card-worker.ts");
    const script = `
import { MemoryError } from ${JSON.stringify(path.join(repoRoot, "src/memory/host.ts"))};
import { workerMemoryForStage } from ${JSON.stringify(path.join(repoRoot, "src/memory/worker.ts"))};

setTimeout(() => {
  process.send?.({ type: "failed", reason: "timed out" });
  process.exit(1);
}, 8000).unref();

async function main() {
  try {
    const memory = await workerMemoryForStage(["notebook"]);
    await memory.addCard("notebook", "ada@example.com", "sourced");
    const body = await memory.readCard("notebook", "ada@example.com");
    if (body !== "sourced") {
      process.send?.({ type: "failed", reason: "body mismatch" });
      process.exit(1);
    }
    process.send?.({ type: "succeeded" });
    process.exit(0);
  } catch (error) {
    const reason = error instanceof MemoryError ? error.code : error instanceof Error ? error.name : "failed";
    process.send?.({ type: "failed", reason });
    process.exit(1);
  }
}

void main();
`;
    try {
      const host = createMemoryHost(dir);
      await host.create({ id: "notebook", description: "People already sourced." });
      await writeFile(scriptPath, script);
      const launcher = new StageProcessLauncher({ cliEntry: scriptPath });
      const result = await launcher.launch({
        runId: "card-run",
        stageId: "source",
        rootDir: dir,
        stage: { id: "source", system_prompt: "Remember people.", memories: ["notebook"] },
      });
      expect(result).toEqual({ type: "succeeded" });
      expect(await host.readCard("notebook", "ada@example.com")).toBe("sourced");
    } finally {
      if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
      else process.env.STAGEFLOW_HOME = previousHome;
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
