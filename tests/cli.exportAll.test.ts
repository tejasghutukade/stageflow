import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertExportOutPathAllowed,
  buildExportHeader,
  iterateExportNdjson,
  projectRunForExport,
} from "../src/cli/exportAllCommand.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { withIsolatedHome } from "./helpers/projectContext.js";
import { globalStageflowHome } from "../src/project/globalHome.js";

describe("export --all", () => {
  it("emits header + projectRun lines including non-terminal with pipeline_source stub", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      const store = createRunStore({ rootDir: home, openerMode: "migrate" });
      const running = await store.createRun({
        pipelineId: "p",
        taskYaml: "id: t\ngoal: g\n",
      });
      await store.updateRunStatus(running.runId, "running");

      const lines: string[] = [];
      for await (const line of iterateExportNdjson({ store })) {
        lines.push(line.trimEnd());
      }
      expect(JSON.parse(lines[0]!)).toMatchObject({
        type: "stageflow_export",
        version: 1,
      });
      const runLine = JSON.parse(lines[1]!);
      expect(runLine.type).toBe("projectRun");
      expect(runLine.run.status).toBe("running");
      expect(runLine.run.pipeline_source.kind).toBe("unavailable");
      expect(runLine.run).not.toHaveProperty("agent/auth.json");
      await store.close();
    });
  });

  it("refuses worktree outs", () => {
    const home = "/tmp/sf-home";
    expect(() =>
      assertExportOutPathAllowed(`${home}/worktrees/x/out.ndjson`, home),
    ).toThrow(/worktrees/);
  });

  it("buildExportHeader is stable", () => {
    expect(buildExportHeader().type).toBe("stageflow_export");
  });
});

describe("projectRunForExport", () => {
  it("adds pipeline_source stub", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-export-proj-"));
    const store = createRunStore({ rootDir: root, openerMode: "migrate" });
    const created = await store.createRun({
      pipelineId: "p",
      taskYaml: "id: t\ngoal: g\n",
    });
    const detail = await store.readRun(created.runId);
    const projected = projectRunForExport(detail);
    expect(projected.pipeline_source.note).toMatch(/Slot 9/);
    await store.close();
  });
});
