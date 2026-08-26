import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePipelinePath } from "../src/config/loadPipeline.js";

describe("resolvePipelinePath", () => {
  it("throws for bare name with actionable message (AE1)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-resolve-pipeline-"));
    await expect(resolvePipelinePath("single", root)).rejects.toThrow(
      /not found/i,
    );
    await expect(resolvePipelinePath("single", root)).rejects.toThrow(
      /filesystem path/i,
    );
  });

  it("returns absolute normalized path for relative path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-resolve-pipeline-"));
    const rel = "pipelines/demo.yaml";
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "id: demo\nstages: []\n");
    const resolved = await resolvePipelinePath(rel, root);
    expect(resolved).toBe(path.normalize(abs));
  });

  it("returns absolute path unchanged when already absolute", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-resolve-pipeline-"));
    const abs = path.join(root, "demo.yaml");
    await writeFile(abs, "id: demo\nstages: []\n");
    const resolved = await resolvePipelinePath(abs, root);
    expect(resolved).toBe(path.normalize(abs));
  });

  it("does not fall back to pipelines/<name>.yaml", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-resolve-pipeline-"));
    const fallback = path.join(root, "pipelines", "missing.yaml");
    await mkdir(path.dirname(fallback), { recursive: true });
    await writeFile(fallback, "id: missing\nstages: []\n");
    await expect(resolvePipelinePath("missing", root)).rejects.toThrow(
      /not found/i,
    );
  });
});
