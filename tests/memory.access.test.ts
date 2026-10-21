import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMemoryRequest } from "../src/memory/access.js";
import { createMemoryHost } from "../src/memory/host.js";

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sf-memory-access-"));
}

describe("runMemoryRequest", () => {
  it("maps bad content and keys to memory errors and treats a missing search query as empty hits", async () => {
    const host = createMemoryHost(await home());
    await host.create({ id: "notebook", description: "Shared notes." });
    const allowed = ["notebook"];

    await expect(runMemoryRequest(host, allowed, "memory.replace", { memory: "notebook", content: 1 })).rejects.toMatchObject({
      code: "MEMORY_UNREADABLE",
    });
    await expect(runMemoryRequest(host, allowed, "memory.addCard", { memory: "notebook", key: "k", content: null })).rejects.toMatchObject({
      code: "MEMORY_UNREADABLE",
    });
    await expect(runMemoryRequest(host, allowed, "memory.updateCard", { memory: "notebook", key: "k", content: false })).rejects.toMatchObject({
      code: "MEMORY_UNREADABLE",
    });
    await expect(runMemoryRequest(host, allowed, "memory.readCard", { memory: "notebook", key: 9 })).rejects.toMatchObject({
      code: "MEMORY_INVALID_KEY",
    });
    await expect(runMemoryRequest(host, allowed, "memory.addCard", { memory: "notebook", key: 9, content: "x" })).rejects.toMatchObject({
      code: "MEMORY_INVALID_KEY",
    });

    expect(await runMemoryRequest(host, allowed, "memory.searchCards", { memory: "notebook", query: undefined })).toEqual({
      hits: [],
    });
    expect(await runMemoryRequest(host, allowed, "memory.searchCards", { memory: "notebook", query: 42 })).toEqual({
      hits: [],
    });
  });
});
