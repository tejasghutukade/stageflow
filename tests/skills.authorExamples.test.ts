import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validatePipeline } from "../src/config/validateCatalog.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplesRoot = path.join(
  repoRoot,
  "skills",
  "stageflow-author",
  "assets",
  "examples",
);

async function discoverAuthorExamplePipelines(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await discoverAuthorExamplePipelines(abs)));
    else if (entry.name.endsWith(".pipeline.yaml")) out.push(abs);
  }
  return out;
}

describe("stageflow-author example pipelines", () => {
  it("validate --strict with no error findings", async () => {
    const pipelines = (await discoverAuthorExamplePipelines(examplesRoot)).sort();
    expect(pipelines.length).toBeGreaterThan(0);

    for (const pipelinePath of pipelines) {
      const rel = path.relative(repoRoot, pipelinePath);
      const result = await validatePipeline(pipelinePath, {
        cwd: repoRoot,
        strict: true,
      });
      const errors = result.findings.filter((finding) => finding.severity === "error");
      expect(result.ok, `${rel}: ${JSON.stringify(result.findings)}`).toBe(true);
      expect(errors, rel).toEqual([]);
    }
  });
});
