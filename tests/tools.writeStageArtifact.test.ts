import { describe, expect, it } from "vitest";
import { access, link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWriteStageArtifactTool } from "../src/tools/writeStageArtifact.js";

function attemptArtifactsDir(
  runWorkspaceDir: string,
  stageId: string,
  attempt: number,
): string {
  return path.join(
    runWorkspaceDir,
    "stages",
    stageId,
    "attempts",
    String(attempt),
    "artifacts",
  );
}

describe("write_stage_artifact tool", () => {
  it("writes file under stage artifacts and returns run-relative path", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-artifact-"));
    const tool = createWriteStageArtifactTool({
      runWorkspaceDir,
      stageId: "clarify",
      attempt: 1,
    });

    const out = await tool.execute("1", {
      path: "notes.md",
      content: "hello artifact",
    });

    expect(out.isError).toBeUndefined();
    expect(out.terminate).toBeUndefined();
    expect(out.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("stages/clarify/attempts/1/artifacts/notes.md"),
    });
    expect(out.details).toMatchObject({
      path: "stages/clarify/attempts/1/artifacts/notes.md",
      error: "",
    });

    const written = await readFile(
      path.join(attemptArtifactsDir(runWorkspaceDir, "clarify", 1), "notes.md"),
      "utf8",
    );
    expect(written).toBe("hello artifact");
  });

  it("writes attempt 2 artifacts without overwriting attempt 1", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-artifact-"));
    const attempt1Tool = createWriteStageArtifactTool({
      runWorkspaceDir,
      stageId: "clarify",
      attempt: 1,
    });
    const attempt2Tool = createWriteStageArtifactTool({
      runWorkspaceDir,
      stageId: "clarify",
      attempt: 2,
    });

    await attempt1Tool.execute("1", { path: "doc.md", content: "attempt one" });
    const out = await attempt2Tool.execute("2", { path: "doc.md", content: "attempt two" });

    expect(out.isError).toBeUndefined();
    expect(out.details.path).toBe("stages/clarify/attempts/2/artifacts/doc.md");
    expect(
      await readFile(path.join(attemptArtifactsDir(runWorkspaceDir, "clarify", 1), "doc.md"), "utf8"),
    ).toBe("attempt one");
    expect(
      await readFile(path.join(attemptArtifactsDir(runWorkspaceDir, "clarify", 2), "doc.md"), "utf8"),
    ).toBe("attempt two");
  });

  it("rejects ../ escape and does not create files outside artifacts dir", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-artifact-"));
    const tool = createWriteStageArtifactTool({
      runWorkspaceDir,
      stageId: "clarify",
      attempt: 1,
    });

    const out = await tool.execute("1", {
      path: "../escape.md",
      content: "should not land",
    });

    expect(out.isError).toBe(true);
    expect(out.details.error).toMatch(/outside|escape|invalid/i);

    await expect(
      access(path.join(runWorkspaceDir, "stages", "clarify", "escape.md")),
    ).rejects.toThrow();
    await expect(
      access(path.join(runWorkspaceDir, "stages", "escape.md")),
    ).rejects.toThrow();
  });

  it("creates intermediate directories for nested relative paths", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-artifact-"));
    const tool = createWriteStageArtifactTool({
      runWorkspaceDir,
      stageId: "design",
      attempt: 1,
    });

    const out = await tool.execute("1", {
      path: "nested/dir/doc.md",
      content: "nested content",
    });

    expect(out.isError).toBeUndefined();
    expect(out.details).toMatchObject({
      path: "stages/design/attempts/1/artifacts/nested/dir/doc.md",
      error: "",
    });

    const written = await readFile(
      path.join(
        attemptArtifactsDir(runWorkspaceDir, "design", 1),
        "nested",
        "dir",
        "doc.md",
      ),
      "utf8",
    );
    expect(written).toBe("nested content");
  });

  it("rejects absolute paths", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-artifact-"));
    const tool = createWriteStageArtifactTool({
      runWorkspaceDir,
      stageId: "clarify",
      attempt: 1,
    });

    const out = await tool.execute("1", {
      path: "/tmp/abs.md",
      content: "nope",
    });

    expect(out.isError).toBe(true);
    expect(out.details.error).toMatch(/relative/);
  });

  it("rejects empty path", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-artifact-"));
    const tool = createWriteStageArtifactTool({
      runWorkspaceDir,
      stageId: "clarify",
      attempt: 1,
    });

    const out = await tool.execute("1", {
      path: "",
      content: "nope",
    });

    expect(out.isError).toBe(true);
    expect(out.details.error).toMatch(/non-empty/);
  });

  it("rejects writes through a symlink outside artifacts", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-artifact-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sf-outside-"));
    const artifactsDir = attemptArtifactsDir(runWorkspaceDir, "clarify", 1);
    await mkdir(artifactsDir, { recursive: true });
    await symlink(outside, path.join(artifactsDir, "link"));

    const tool = createWriteStageArtifactTool({
      runWorkspaceDir,
      stageId: "clarify",
      attempt: 1,
    });

    const out = await tool.execute("1", {
      path: "link/pwned.txt",
      content: "escaped",
    });

    expect(out.isError).toBe(true);
    expect(out.details.error).toMatch(/escape/i);
    await expect(access(path.join(outside, "pwned.txt"))).rejects.toThrow();
  });

  it("rejects when artifacts dir itself is a symlink outside the run workspace", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-artifact-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sf-outside-"));
    const attemptDir = path.join(runWorkspaceDir, "stages", "clarify", "attempts", "1");
    await mkdir(attemptDir, { recursive: true });
    await symlink(outside, path.join(attemptDir, "artifacts"));

    const tool = createWriteStageArtifactTool({
      runWorkspaceDir,
      stageId: "clarify",
      attempt: 1,
    });

    const out = await tool.execute("1", {
      path: "pwned.txt",
      content: "escaped",
    });

    expect(out.isError).toBe(true);
    expect(out.details.error).toMatch(/escape/i);
    await expect(access(path.join(outside, "pwned.txt"))).rejects.toThrow();
  });

  it("rejects overwrite of a hard-linked file and does not mutate the outside inode", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-artifact-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sf-outside-"));
    const artifactsDir = attemptArtifactsDir(runWorkspaceDir, "clarify", 1);
    await mkdir(artifactsDir, { recursive: true });
    const outsideFile = path.join(outside, "shared.txt");
    await writeFile(outsideFile, "original");
    await link(outsideFile, path.join(artifactsDir, "shared.txt"));

    const tool = createWriteStageArtifactTool({
      runWorkspaceDir,
      stageId: "clarify",
      attempt: 1,
    });

    const out = await tool.execute("1", {
      path: "shared.txt",
      content: "mutated",
    });

    expect(out.isError).toBe(true);
    expect(out.details.error).toMatch(/hard-linked/i);
    expect(await readFile(outsideFile, "utf8")).toBe("original");
  });

  it("does not mkdir through a symlink when rejecting nested escape", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-artifact-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sf-outside-"));
    const artifactsDir = attemptArtifactsDir(runWorkspaceDir, "clarify", 1);
    await mkdir(artifactsDir, { recursive: true });
    await symlink(outside, path.join(artifactsDir, "link"));

    const tool = createWriteStageArtifactTool({
      runWorkspaceDir,
      stageId: "clarify",
      attempt: 1,
    });

    const out = await tool.execute("1", {
      path: "link/nested/pwned.txt",
      content: "escaped",
    });

    expect(out.isError).toBe(true);
    expect(out.details.error).toMatch(/escape/i);
    await expect(access(path.join(outside, "nested"))).rejects.toThrow();
    await expect(access(path.join(outside, "nested", "pwned.txt"))).rejects.toThrow();
  });
});
