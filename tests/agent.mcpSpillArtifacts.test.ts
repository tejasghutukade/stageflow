import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMcpSpillArtifactExtension,
  relocateSpilledMcpOutput,
} from "../src/agent/mcpSpillArtifacts.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function spillFile(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-output-"));
  cleanup.push(dir);
  const file = path.join(dir, "output-abcd1234.txt");
  await writeFile(file, body, "utf8");
  return file;
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-spill-run-"));
  cleanup.push(dir);
  return dir;
}

describe("relocateSpilledMcpOutput", () => {
  it("copies a spilled MCP result into the stage artifacts and rewrites the path", async () => {
    const runWorkspaceDir = await workspace();
    const spill = await spillFile("full profile text");
    const notice = `preview\n\n[MCP text output truncated: original 10 lines / 80KB. Truncated: 2 lines shown (50.0KB limit). Full text saved to: ${spill} — use read with offset/limit or grep to inspect.]`;
    const relocated = await relocateSpilledMcpOutput({
      runWorkspaceDir,
      stageId: "enrich-profiles",
      attempt: 2,
      content: [{ type: "text", text: notice }],
      details: { outputGuard: { fullOutputPath: spill, truncated: true } },
      structuredContent: { fullOutputPath: spill },
    });
    expect(relocated).toBeDefined();
    const saved = path.join(
      runWorkspaceDir,
      "stages",
      "enrich-profiles",
      "attempts",
      "2",
      "artifacts",
      "mcp-output",
      "output-abcd1234.txt",
    );
    const savedReal = await realpath(saved);
    expect(await readFile(savedReal, "utf8")).toBe("full profile text");
    const text = relocated?.content[0]?.text ?? "";
    expect(text).toContain(savedReal);
    expect(text).not.toContain(spill);
    expect(text).toContain("already stored");
    expect((relocated?.details as { outputGuard: { fullOutputPath: string } }).outputGuard.fullOutputPath).toBe(savedReal);
    expect(relocated?.structuredContent).toEqual({ fullOutputPath: savedReal });
  });

  it("leaves a tool result alone when the named file is not an MCP spill", async () => {
    const runWorkspaceDir = await workspace();
    const outside = path.join(runWorkspaceDir, "notes.txt");
    await writeFile(outside, "nope", "utf8");
    const relocated = await relocateSpilledMcpOutput({
      runWorkspaceDir,
      stageId: "enrich-profiles",
      attempt: 1,
      content: [{ type: "text", text: `Full text saved to: ${outside} — use read` }],
      details: { outputGuard: { fullOutputPath: outside } },
    });
    expect(relocated).toBeUndefined();
  });

  it("does not follow a spill symlink outside the temp directory", async () => {
    const runWorkspaceDir = await workspace();
    const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-output-"));
    cleanup.push(dir);
    const outside = path.join(runWorkspaceDir, "secret.txt");
    await writeFile(outside, "secret", "utf8");
    const link = path.join(dir, "output-abcd1234.txt");
    await symlink(outside, link);
    const relocated = await relocateSpilledMcpOutput({
      runWorkspaceDir,
      stageId: "enrich-profiles",
      attempt: 1,
      content: [{ type: "text", text: `Full text saved to: ${link} — use read` }],
      details: { outputGuard: { fullOutputPath: link } },
    });
    expect(relocated).toBeUndefined();
  });
});

describe("createMcpSpillArtifactExtension", () => {
  it("rewrites the tool result the session will keep", async () => {
    const runWorkspaceDir = await workspace();
    const spill = await spillFile("body");
    let handler: ((event: {
      content: Array<{ type: "text"; text: string }>;
      details: unknown;
      structuredContent?: unknown;
    }) => Promise<{ content: Array<{ type: string; text?: string }> } | undefined>) | undefined;
    const factory = createMcpSpillArtifactExtension({
      runWorkspaceDir,
      stageId: "enrich-profiles",
      attempt: 1,
    });
    factory((({
      on(_event: string, next: typeof handler) {
        handler = next;
      },
    }) as unknown) as Parameters<typeof factory>[0]);
    const result = await handler?.({
      content: [{ type: "text", text: `Full text saved to: ${spill} — keep` }],
      details: { outputGuard: { fullOutputPath: spill } },
    });
    expect(result?.content[0]?.text).toContain("mcp-output/output-abcd1234.txt");
    expect(result?.content[0]?.text).not.toContain(spill);
  });
});
