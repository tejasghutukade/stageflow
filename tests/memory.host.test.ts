import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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

  it("adds a card and reads the current body back", async () => {
    const host = createMemoryHost(await home());
    await host.create({ id: "pool", description: "People already sourced." });
    await host.addCard("pool", "ada@example.com", "sourced");
    expect(await host.readCard("pool", "ada@example.com")).toBe("sourced");
    expect(await host.listCards("pool")).toEqual(["ada@example.com"]);
  });

  it("stores a key that contains dotdot and a slash inside the memory folder", async () => {
    const dir = await home();
    const host = createMemoryHost(dir);
    await host.create({ id: "pool", description: "People already sourced." });
    const key = "../odd key/../../outside";
    await host.addCard("pool", key, "kept inside");
    expect(await host.readCard("pool", key)).toBe("kept inside");
    const folder = path.join(dir, "memories", "pool");
    const names = await readdir(folder);
    const folderPrefix = folder.endsWith(path.sep) ? folder : folder + path.sep;
    for (const name of names) {
      expect(path.resolve(folder, name).startsWith(folderPrefix)).toBe(true);
      expect(name.includes("/") || name.includes("..")).toBe(false);
    }
    await expect(readFile(path.resolve(folder, key), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a second add of the same key and leaves the first body", async () => {
    const host = createMemoryHost(await home());
    await host.create({ id: "pool", description: "People already sourced." });
    await host.addCard("pool", "ada@example.com", "sourced");
    await expect(host.addCard("pool", "ada@example.com", "shortlisted")).rejects.toMatchObject({ code: "MEMORY_CARD_EXISTS" });
    expect(await host.readCard("pool", "ada@example.com")).toBe("sourced");
  });

  it("lets one of two overlapping adds win and keeps that body", async () => {
    const host = createMemoryHost(await home());
    await host.create({ id: "pool", description: "People already sourced." });
    const results = await Promise.allSettled([
      host.addCard("pool", "ada@example.com", "sourced"),
      host.addCard("pool", "ada@example.com", "shortlisted"),
    ]);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "MEMORY_CARD_EXISTS" });
    const body = await host.readCard("pool", "ada@example.com");
    expect(body === "sourced" || body === "shortlisted").toBe(true);
  });

  it("refuses an update of a missing key and writes no card file", async () => {
    const dir = await home();
    const host = createMemoryHost(dir);
    await host.create({ id: "pool", description: "People already sourced." });
    await expect(host.updateCard("pool", "missing", "sourced")).rejects.toMatchObject({ code: "MEMORY_CARD_NOT_FOUND" });
    const names = await readdir(path.join(dir, "memories", "pool"));
    expect(names.filter((name) => name !== "memory.yaml" && name !== "body.md")).toEqual([]);
  });

  it("keeps only the latest previous card body across two updates", async () => {
    const dir = await home();
    const host = createMemoryHost(dir);
    await host.create({ id: "pool", description: "People already sourced." });
    await host.addCard("pool", "ada@example.com", "sourced");
    await host.updateCard("pool", "ada@example.com", "shortlisted");
    expect(await host.readCard("pool", "ada@example.com")).toBe("shortlisted");
    expect(await host.readPreviousCard("pool", "ada@example.com")).toBe("sourced");
    await host.updateCard("pool", "ada@example.com", "hired");
    expect(await host.readCard("pool", "ada@example.com")).toBe("hired");
    expect(await host.readPreviousCard("pool", "ada@example.com")).toBe("shortlisted");
    const names = await readdir(path.join(dir, "memories", "pool"));
    expect(names.filter((name) => name.endsWith(".prev"))).toHaveLength(1);
    expect(await host.searchCards("pool", "sourced")).toEqual([]);
  });

  it("does not return a previous card or a leftover temp file from read or search", async () => {
    const dir = await home();
    const host = createMemoryHost(dir);
    await host.create({ id: "pool", description: "People already sourced." });
    await host.addCard("pool", "ada@example.com", "sourced");
    await host.updateCard("pool", "ada@example.com", "shortlisted");
    const folder = path.join(dir, "memories", "pool");
    await writeFile(path.join(folder, ".card.interrupted.tmp"), "leftover temp marker");
    expect(await host.readCard("pool", "ada@example.com")).toBe("shortlisted");
    expect(await host.searchCards("pool", "sourced")).toEqual([]);
    expect(await host.searchCards("pool", "leftover temp")).toEqual([]);
  });

  it("searches current card keys and bodies and skips a previous copy", async () => {
    const host = createMemoryHost(await home());
    await host.create({ id: "pool", description: "People already sourced." });
    await host.addCard("pool", "4412", "old refund denied");
    await host.updateCard("pool", "4412", "refund approved");
    const hits = await host.searchCards("pool", "Refund");
    expect(hits.map((hit) => hit.key)).toEqual(["4412"]);
    expect(hits[0]?.snippet.toLowerCase()).toContain("refund");
    expect(hits[0]?.snippet).not.toContain("denied");
    expect(await host.searchCards("pool", "denied")).toEqual([]);
  });

  it("returns at most 20 search hits", async () => {
    const host = createMemoryHost(await home());
    await host.create({ id: "pool", description: "People already sourced." });
    for (let i = 0; i < 21; i += 1) {
      await host.addCard("pool", `n${String(i).padStart(2, "0")}`, "refund approved");
    }
    await host.addCard("pool", "other", "no match here");
    const hits = await host.searchCards("pool", "refund");
    expect(hits).toHaveLength(20);
    expect(hits.every((hit) => hit.snippet.toLowerCase().includes("refund"))).toBe(true);
    expect(hits.some((hit) => hit.key === "other")).toBe(false);
  });

  it("refuses a 201st card, a body over the cap, an empty key, and a key over 1024 characters", async () => {
    const host = createMemoryHost(await home());
    await host.create({ id: "pool", description: "People already sourced." });
    await expect(host.addCard("pool", "", "sourced")).rejects.toMatchObject({ code: "MEMORY_INVALID_KEY" });
    await expect(host.addCard("pool", "k".repeat(1025), "sourced")).rejects.toMatchObject({ code: "MEMORY_INVALID_KEY" });
    await expect(host.addCard("pool", "ada@example.com", "x".repeat(64_001))).rejects.toMatchObject({ code: "MEMORY_TOO_LARGE" });
    expect(await host.listCards("pool")).toEqual([]);
    for (let i = 0; i < 200; i += 1) {
      await host.addCard("pool", `k${i}`, "sourced");
    }
    await expect(host.addCard("pool", "k200", "sourced")).rejects.toMatchObject({ code: "MEMORY_TOO_MANY_CARDS" });
    expect(await host.listCards("pool")).toHaveLength(200);
  });

  it("deletes the current card and its previous copy", async () => {
    const host = createMemoryHost(await home());
    await host.create({ id: "pool", description: "People already sourced." });
    await host.addCard("pool", "ada@example.com", "sourced");
    await host.updateCard("pool", "ada@example.com", "shortlisted");
    await host.deleteCard("pool", "ada@example.com");
    await expect(host.readCard("pool", "ada@example.com")).rejects.toMatchObject({ code: "MEMORY_CARD_NOT_FOUND" });
    await expect(host.readPreviousCard("pool", "ada@example.com")).rejects.toMatchObject({ code: "MEMORY_CARD_NOT_FOUND" });
  });

  it("replaces the cover without removing cards and keeps the previous cover", async () => {
    const dir = await home();
    const host = createMemoryHost(dir);
    await host.create({ id: "pool", description: "People already sourced." });
    await host.replace("pool", "old cover");
    await host.addCard("pool", "ada@example.com", "sourced");
    await host.replace("pool", "new cover");
    expect(await host.read("pool")).toBe("new cover");
    expect(await host.readCard("pool", "ada@example.com")).toBe("sourced");
    expect(await host.readPreviousCover("pool")).toBe("old cover");
    const yaml = await readFile(path.join(dir, "memories", "pool", "memory.yaml"), "utf8");
    expect(yaml).toContain("version: 1");
  });

  it("lists and reads a memory that only has memory.yaml and body.md", async () => {
    const dir = await home();
    const folder = path.join(dir, "memories", "pool");
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, "memory.yaml"),
      "id: pool\nversion: 1\ndescription: People already sourced.\n",
      "utf8",
    );
    await writeFile(path.join(folder, "body.md"), "Ada was sourced.\n", "utf8");
    const host = createMemoryHost(dir);
    expect(await host.list()).toEqual([{ id: "pool", description: "People already sourced.", cardCount: 0 }]);
    expect(await host.read("pool")).toBe("Ada was sourced.\n");
    expect(await host.listCards("pool")).toEqual([]);
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
