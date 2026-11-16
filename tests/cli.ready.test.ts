import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runReadyChecks } from "../src/cli/readyCommand.js";
import { helloPipelineYaml } from "../src/cli/initTemplates.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

describe("sf ready", () => {
  it("fails when pipeline has CHANGE_ME placeholder", async () => {
    await withIsolatedHome(async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "sf-ready-"));
      const pipelinePath = path.join(cwd, "pipelines", "hello.pipeline.yaml");
      await mkdir(path.dirname(pipelinePath), { recursive: true });
      await writeFile(pipelinePath, helloPipelineYaml("CHANGE_ME/<provider-model>"), "utf8");
      const result = await runReadyChecks({
        cwd,
        pipeline: "pipelines/hello.pipeline.yaml",
      });
      expect(result.ok).toBe(false);
      expect(result.checks.some((c) => c.id === "model_placeholder")).toBe(true);
    });
  });
});