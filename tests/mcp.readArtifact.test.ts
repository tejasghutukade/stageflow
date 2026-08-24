import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { readRunArtifact } from "../src/mcp/readArtifact.js";

describe("readRunArtifact deny-list", () => {
  it("denies .pi-agent/auth.json under attempts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-art-deny-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
    });
    const rel = path.join(
      "stages",
      "clarify",
      "attempts",
      "1",
      ".pi-agent",
      "auth.json",
    );
    await mkdir(path.dirname(path.join(created.workspaceDir, rel)), {
      recursive: true,
    });
    await writeFile(
      path.join(created.workspaceDir, rel),
      JSON.stringify({ secret: "nope" }),
    );

    await expect(readRunArtifact(store, created.runId, rel)).rejects.toThrow(
      /Artifact path denied/,
    );
  });

  it("denies auth.json at any relative depth", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-art-deny-auth-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
    });
    const rel = path.join("stages", "clarify", "auth.json");
    await mkdir(path.dirname(path.join(created.workspaceDir, rel)), {
      recursive: true,
    });
    await writeFile(path.join(created.workspaceDir, rel), '{"x":1}');

    await expect(readRunArtifact(store, created.runId, rel)).rejects.toThrow(
      /Artifact path denied/,
    );
  });

  it("still reads normal artifacts under artifacts/", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-art-ok-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
    });
    const rel = path.join(
      "stages",
      "clarify",
      "attempts",
      "1",
      "artifacts",
      "note.txt",
    );
    await mkdir(path.dirname(path.join(created.workspaceDir, rel)), {
      recursive: true,
    });
    await writeFile(path.join(created.workspaceDir, rel), "hello artifact");

    await expect(readRunArtifact(store, created.runId, rel)).resolves.toBe(
      "hello artifact",
    );
  });
});
