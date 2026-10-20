import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryHost, type MemoryHost } from "../src/memory/host.js";
import { handleMemoryRoutes } from "../src/server/memoryRoutes.js";

const KEY = "../odd key/%2F..";

async function host(): Promise<MemoryHost> {
  return createMemoryHost(await mkdtemp(path.join(tmpdir(), "sf-memory-routes-")));
}

async function invoke(memory: MemoryHost, method: string, url: string, payload?: unknown) {
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]) as IncomingMessage;
  req.method = method;
  req.url = url;
  let status = 0;
  let body: unknown;
  const handled = await handleMemoryRoutes(req, method, url.split("?")[0]!, memory, {} as ServerResponse, (_res, code, value) => {
    status = code;
    body = value;
  });
  return { handled, status, body };
}

describe("memory card routes", () => {
  it("reads, corrects, and deletes a card whose key is only in the query string", async () => {
    const memory = await host();
    await memory.create({ id: "pool", description: "People already sourced." });
    await memory.addCard("pool", KEY, "sourced");
    const readUrl = `/api/memories/pool/cards?key=${encodeURIComponent(KEY)}`;
    expect(readUrl.split("?")[0]).toBe("/api/memories/pool/cards");

    const listed = await invoke(memory, "GET", "/api/memories/pool/cards");
    expect(listed).toMatchObject({ handled: true, status: 200, body: { keys: [KEY] } });

    const read = await invoke(memory, "GET", readUrl);
    expect(read).toMatchObject({ handled: true, status: 200, body: { body: "sourced" } });

    const created = await invoke(memory, "POST", "/api/memories/pool/cards", { key: "other", body: "no" });
    expect(created.handled).toBe(false);

    const corrected = await invoke(memory, "PATCH", "/api/memories/pool/cards", { key: KEY, body: "shortlisted" });
    expect(corrected.status).toBe(200);
    expect(await invoke(memory, "GET", readUrl)).toMatchObject({ status: 200, body: { body: "shortlisted" } });
    expect(await invoke(memory, "GET", `/api/memories/pool/cards/previous?key=${encodeURIComponent(KEY)}`)).toMatchObject({
      status: 200,
      body: { body: "sourced" },
    });

    const removed = await invoke(memory, "DELETE", "/api/memories/pool/cards", { key: KEY });
    expect(removed).toMatchObject({ handled: true, status: 200 });
    expect(await invoke(memory, "GET", readUrl)).toMatchObject({ status: 404, body: { code: "MEMORY_CARD_NOT_FOUND" } });
    expect(await invoke(memory, "GET", `/api/memories/pool/cards/previous?key=${encodeURIComponent(KEY)}`)).toMatchObject({
      status: 404,
      body: { code: "MEMORY_CARD_NOT_FOUND" },
    });
  });

  it("patches the cover, keeps cards, and reads the previous cover", async () => {
    const memory = await host();
    await memory.create({ id: "pool", description: "People already sourced." });
    await memory.replace("pool", "old cover");
    await memory.addCard("pool", KEY, "sourced");

    const patched = await invoke(memory, "PATCH", "/api/memories/pool", { body: "new cover" });
    expect(patched).toMatchObject({
      handled: true,
      status: 200,
      body: { id: "pool", description: "People already sourced.", body: "new cover" },
    });
    expect(await invoke(memory, "GET", "/api/memories/pool/previous")).toMatchObject({
      status: 200,
      body: { body: "old cover" },
    });
    expect(await invoke(memory, "GET", "/api/memories/pool/cards")).toMatchObject({ body: { keys: [KEY] } });
    expect(await invoke(memory, "GET", `/api/memories/pool/cards?key=${encodeURIComponent(KEY)}`)).toMatchObject({
      body: { body: "sourced" },
    });
  });

  it("returns not-found for a missing key and too-large for an over-cap body", async () => {
    const memory = await host();
    await memory.create({ id: "pool", description: "People already sourced." });
    await memory.addCard("pool", "ada@example.com", "sourced");

    expect(await invoke(memory, "GET", "/api/memories/pool/cards?key=missing")).toMatchObject({
      status: 404,
      body: { code: "MEMORY_CARD_NOT_FOUND" },
    });
    expect(await invoke(memory, "PATCH", "/api/memories/pool/cards", { key: "ada@example.com", body: "x".repeat(64_001) })).toMatchObject({
      status: 400,
      body: { code: "MEMORY_TOO_LARGE" },
    });
    expect(await memory.readCard("pool", "ada@example.com")).toBe("sourced");
  });
});
