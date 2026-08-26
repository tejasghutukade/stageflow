import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipelineForRun } from "../src/runtime/loadPipelineForRun.js";
import type { RunMeta } from "../src/runstore/port.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const owned = path.join(fixtures, "pipeline-owned", "inline-leaf");
const pipelinePath = path.join(owned, "inline.pipeline.yaml");

function meta(extra: Partial<RunMeta> = {}): RunMeta {
  return {
    run_id: "run-1",
    pipeline_id: "inline-leaf",
    created_at: "2026-08-18T00:00:00.000Z",
    ...extra,
  };
}

describe("loadPipelineForRun", () => {
  it("loads pipeline from stored absolute path", async () => {
    const loaded = await loadPipelineForRun(
      meta({ pipeline_path: pipelinePath, project_root: owned }),
      "/wrong/cwd",
    );
    expect(loaded.pipeline.id).toBe("inline-leaf");
    expect(loaded.stages.map((s) => s.id)).toEqual(["decide", "branch-a", "branch-b"]);
  });

  it("throws when stored path is missing", async () => {
    const missing = path.join(owned, "missing.pipeline.yaml");
    await expect(
      loadPipelineForRun(meta({ pipeline_path: missing }), fixtures),
    ).rejects.toThrow(`Pipeline not found at stored path: ${missing}`);
  });

  it("rejects bare pipeline_id when pipeline_path is absent", async () => {
    await expect(
      loadPipelineForRun(meta({ pipeline_id: "locator-fallback" }), fixtures),
    ).rejects.toThrow(/filesystem path/i);
  });

  it("uses project_root as loader cwd when set", async () => {
    const loaded = await loadPipelineForRun(
      meta({ pipeline_path: pipelinePath, project_root: owned }),
      "/wrong/cwd",
    );
    expect(loaded.pipelinePath).toBe(path.resolve(pipelinePath));
  });
});
