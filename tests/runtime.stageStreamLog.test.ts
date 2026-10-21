import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createStageStreamLogWriter,
  parseStreamLogHeader,
} from "../src/runtime/stageStreamLog.js";

async function readParsed(streamLogPath: string) {
  const raw = await readFile(streamLogPath);
  const { base, headerLength } = parseStreamLogHeader(raw);
  return { base, content: raw.subarray(headerLength).toString("utf8") };
}

describe("createStageStreamLogWriter", () => {
  it("writes a fresh file with base 0 on first flush", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-stream-log-"));
    const streamLogPath = path.join(dir, "stream.log");
    const writer = createStageStreamLogWriter(streamLogPath);

    writer.onDelta("Hello, ");
    writer.onDelta("world!");
    await writer.flush();

    const { base, content } = await readParsed(streamLogPath);
    expect(base).toBe(0);
    expect(content).toBe("Hello, world!");
  });

  it("accumulates across multiple flushes without losing content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-stream-log-"));
    const streamLogPath = path.join(dir, "stream.log");
    const writer = createStageStreamLogWriter(streamLogPath);

    writer.onDelta("first chunk. ");
    await writer.flush();
    writer.onDelta("second chunk. ");
    await writer.flush();
    writer.onDelta("third chunk.");
    await writer.flush();

    const { base, content } = await readParsed(streamLogPath);
    expect(base).toBe(0);
    expect(content).toBe("first chunk. second chunk. third chunk.");
  });

  it("flush() is a cheap no-op when the buffer is empty", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-stream-log-"));
    const streamLogPath = path.join(dir, "stream.log");
    const writer = createStageStreamLogWriter(streamLogPath);

    await writer.flush();
    await expect(readFile(streamLogPath)).rejects.toThrow();
  });

  it("compacts by dropping roughly the oldest half once over the cap, advancing base", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-stream-log-"));
    const streamLogPath = path.join(dir, "stream.log");
    const capBytes = 700;
    const writer = createStageStreamLogWriter(streamLogPath, { capBytes });

    // Write comfortably under the cap first.
    writer.onDelta("a".repeat(400));
    await writer.flush();
    let state = await readParsed(streamLogPath);
    expect(state.base).toBe(0);
    expect(Buffer.byteLength(state.content, "utf8")).toBe(400);

    // Push it over the cap — should compact.
    writer.onDelta("b".repeat(400));
    await writer.flush();
    state = await readParsed(streamLogPath);

    const totalBeforeCompaction = 800;
    expect(state.base).toBeGreaterThan(0);
    expect(state.base).toBeCloseTo(totalBeforeCompaction / 2, -1);
    expect(Buffer.byteLength(state.content, "utf8")).toBeLessThan(capBytes);
    // The retained tail should be the newer content, not the dropped head.
    expect(state.content.endsWith("b".repeat(400))).toBe(true);
  });

  it("never splits a multi-byte UTF-8 codepoint when compacting", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-stream-log-"));
    const streamLogPath = path.join(dir, "stream.log");
    // Each "é" is 2 bytes in UTF-8; pick a cap that lands mid-run of them.
    const capBytes = 100;
    const writer = createStageStreamLogWriter(streamLogPath, { capBytes });

    writer.onDelta("é".repeat(80)); // 160 bytes
    await writer.flush();

    const raw = await readFile(streamLogPath);
    const { headerLength } = parseStreamLogHeader(raw);
    const content = raw.subarray(headerLength);
    // A corrupted split would decode as U+FFFD replacement characters.
    expect(content.toString("utf8")).not.toMatch(/�/);
  });
});
