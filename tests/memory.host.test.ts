import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryHost, MemoryError } from "../src/memory/host.js";
import { bindStageMemory } from "../src/memory/access.js";
import { createReadMemoryTool, createReplaceMemoryTool } from "../src/tools/memoryTools.js";
import { durableRootFileToolDenial, STAGEFLOW_PATH_DENIED } from "../src/runstore/workspaceLayout.js";

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sf-memory-"));
}

describe("memory host", () => {
  it("creates an empty page and refuses a duplicate or a bad id", async () => {
    const host = createMemoryHost(await home());
    const created = await host.create({ id: "candidate-pool", description: "People already sourced." });
    expect(created).toEqual({ id: "candidate-pool", description: "People already sourced.", body: "" });
    expect(await host.read("candidate-pool")).toBe("");
    await expect(host.create({ id: "candidate-pool", description: "Again." })).rejects.toMatchObject({ code: "MEMORY_EXISTS" });
    await expect(host.create({ id: "Candidate", description: "No." })).rejects.toMatchObject({ code: "MEMORY_INVALID_ID" });
    await expect(host.create({ id: "pool", description: "  " })).rejects.toMatchObject({ code: "MEMORY_INVALID_DESCRIPTION" });
  });

  it("replaces the page and leaves a temp file unread", async () => {
    const dir = await home();
    const host = createMemoryHost(dir);
    await host.create({ id: "pool", description: "People already sourced." });
    await host.replace("pool", "Ada was sourced.");
    expect(await host.read("pool")).toBe("Ada was sourced.");
    const folder = path.join(dir, "memories", "pool");
    await writeFile(path.join(folder, ".body.md.interrupted.tmp"), "half written");
    expect(await host.read("pool")).toBe("Ada was sourced.");
    expect(await readFile(path.join(folder, "body.md"), "utf8")).toBe("Ada was sourced.");
  });

  it("refuses a page over the cap and a missing id", async () => {
    const host = createMemoryHost(await home());
    await host.create({ id: "pool", description: "People already sourced." });
    await expect(host.replace("pool", "x".repeat(64_001))).rejects.toBeInstanceOf(MemoryError);
    await expect(host.replace("pool", "x".repeat(64_001))).rejects.toMatchObject({ code: "MEMORY_TOO_LARGE" });
    await expect(host.read("missing")).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
  });

  it("lets an attached caller replace and read, and refuses any other id", async () => {
    const host = createMemoryHost(await home());
    await host.create({ id: "pool", description: "People already sourced." });
    await host.create({ id: "other", description: "Not for this pipeline." });
    const memory = await bindStageMemory(host, ["pool"]);
    const replace = createReplaceMemoryTool(memory);
    const read = createReadMemoryTool(memory);
    const wrote = await replace.execute("1", { memory: "pool", content: "ten shortlisted" });
    expect(wrote.isError).toBeUndefined();
    const got = await read.execute("2", { memory: "pool" });
    expect(got.content[0]?.text).toBe("ten shortlisted");
    const denied = await read.execute("3", { memory: "other" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("MEMORY_NOT_ATTACHED");
  });

  it("keeps the memory folder inside the data directory the stage file tools cannot read", async () => {
    const dir = process.env.STAGEFLOW_HOME!;
    const host = createMemoryHost(dir);
    await host.create({ id: "path-deny", description: "People already sourced." });
    const workspace = await mkdtemp(path.join(tmpdir(), "sf-memory-ws-"));
    const body = path.join(dir, "memories", "path-deny", "body.md");
    expect(await durableRootFileToolDenial(body, workspace, dir)).toBe(STAGEFLOW_PATH_DENIED);
  });
});
