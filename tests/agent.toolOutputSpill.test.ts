import { access, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeSpillBody,
  sanitizeNamePart,
  spillToolOutput,
  wrapLongLines,
} from "../src/agent/toolOutputSpill.js";

function artifactsDir(runWorkspaceDir: string): string {
  return path.join(runWorkspaceDir, "stages", "enrich", "attempts", "2", "artifacts");
}

describe("spillToolOutput", () => {
  it("writes pretty-printed JSON under the attempt artifacts dir", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-spill-"));
    const payload = { results: [{ url: "https://example.com", text: "x".repeat(100) }] };

    const spilled = await spillToolOutput({
      runWorkspaceDir,
      stageId: "enrich",
      attempt: 2,
      toolCallId: "call_1",
      toolName: "exa_web_fetch_exa",
      text: JSON.stringify(payload),
    });

    expect(spilled.runRelativePath).toBe(
      "stages/enrich/attempts/2/artifacts/tool-output/call_1-exa_web_fetch_exa.json",
    );
    expect(spilled.absolutePath).toBe(
      path.join(artifactsDir(runWorkspaceDir), "tool-output", "call_1-exa_web_fetch_exa.json"),
    );
    expect(spilled.format).toBe("json");
    const written = await readFile(spilled.absolutePath, "utf8");
    expect(written).toBe(JSON.stringify(payload, null, 2));
    expect(JSON.parse(written)).toEqual(payload);
    expect(spilled.lines).toBe(written.split("\n").length);
    expect(spilled.bytes).toBe(Buffer.byteLength(written));
  });

  it("writes text as .txt and overwrites the same tool call on resume", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-spill-"));
    const base = {
      runWorkspaceDir,
      stageId: "enrich",
      attempt: 2,
      toolCallId: "call/../2",
      toolName: "fetch",
    };
    const first = await spillToolOutput({ ...base, text: "first" });
    const second = await spillToolOutput({ ...base, text: "second" });

    expect(first.absolutePath).toBe(second.absolutePath);
    expect(path.basename(first.absolutePath)).toBe("call_.._2-fetch.txt");
    expect(await readFile(second.absolutePath, "utf8")).toBe("second");
  });

  it("refuses to write through a symlink that leaves the artifacts dir", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-spill-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sf-spill-outside-"));
    await mkdir(artifactsDir(runWorkspaceDir), { recursive: true });
    await symlink(outside, path.join(artifactsDir(runWorkspaceDir), "tool-output"));

    await expect(
      spillToolOutput({
        runWorkspaceDir,
        stageId: "enrich",
        attempt: 2,
        toolCallId: "c1",
        toolName: "fetch",
        text: "secret",
      }),
    ).rejects.toThrow(/escape/i);
    await expect(access(path.join(outside, "c1-fetch.txt"))).rejects.toThrow();
  });
});

describe("spill normalization", () => {
  it("sanitizes and caps file name parts", () => {
    expect(sanitizeNamePart("a b/c")).toBe("a_b_c");
    expect(sanitizeNamePart("..hidden")).toBe("_hidden");
    expect(sanitizeNamePart("")).toBe("_");
    expect(sanitizeNamePart("x".repeat(100))).toHaveLength(64);
  });

  it("wraps long lines without splitting characters", () => {
    const line = "é".repeat(10);
    const { text, wrapped } = wrapLongLines(`short\n${line}`, 7);
    expect(wrapped).toBe(true);
    expect(text.split("\n")).toEqual(["short", "ééé", "ééé", "ééé", "é"]);
    expect(text.replace(/\n/g, "")).toBe(`short${line}`);
  });

  it("keeps surrogate pairs whole", () => {
    const { text } = wrapLongLines("😀😀😀", 5);
    expect(text.split("\n")).toEqual(["😀", "😀", "😀"]);
  });

  it("leaves short text untouched", () => {
    expect(wrapLongLines("a\nb", 10)).toEqual({ text: "a\nb", wrapped: false });
  });

  it("pretty-prints a single-line JSON body so it can be paged by line", () => {
    const value = { items: Array.from({ length: 50 }, (_, i) => ({ i })) };
    const normalized = normalizeSpillBody(JSON.stringify(value));
    expect(normalized.format).toBe("json");
    expect(normalized.wrapped).toBe(false);
    expect(normalized.hasLongLines).toBe(false);
    expect(normalized.body.split("\n").length).toBeGreaterThan(100);
    expect(normalized.json).toEqual(value);
  });

  it("keeps JSON with long string values valid and flags the long lines", () => {
    const value = { results: [{ text: "x".repeat(140_000) }] };
    const normalized = normalizeSpillBody(JSON.stringify(value));
    expect(normalized.wrapped).toBe(false);
    expect(normalized.hasLongLines).toBe(true);
    expect(JSON.parse(normalized.body)).toEqual(value);
  });

  it("treats JSON-looking text that does not parse as text", () => {
    expect(normalizeSpillBody("{not json").format).toBe("text");
  });

  it("wraps a 140 KB single-line text body into pageable lines", () => {
    const normalized = normalizeSpillBody("a".repeat(140_000));
    expect(normalized.format).toBe("text");
    expect(normalized.wrapped).toBe(true);
    expect(normalized.body.split("\n").every((l) => l.length <= 4096)).toBe(true);
  });
});
