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
  it("emits header + projectRun lines including non-terminal with pipeline_source", async () => {
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
  it("fills inline pipeline body when persisted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-export-proj-"));
    const store = createRunStore({ rootDir: root, openerMode: "migrate" });
    const pipeline = {
      id: "inline-export",
      stages: [{ id: "plan", system_prompt: "x" }],
    };
    const body = JSON.stringify(pipeline);
    const created = await store.createRun({
      pipelineId: "inline-export",
      taskYaml: "id: t\ngoal: g\n",
      pipelineSource: "inline",
      pipelineBody: body,
    });
    const detail = await store.readRun(created.runId);
    const projected = projectRunForExport(detail, body);
    expect(projected.pipeline_source).toEqual({
      kind: "inline",
      pipeline,
    });
    await store.close();
  });

  it("marks legacy runs without source as unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-export-legacy-"));
    const store = createRunStore({ rootDir: root, openerMode: "migrate" });
    const created = await store.createRun({
      pipelineId: "p",
      taskYaml: "id: t\ngoal: g\n",
    });
    const detail = await store.readRun(created.runId);
    const projected = projectRunForExport(detail, null);
    expect(projected.pipeline_source.kind).toBe("unavailable");
    expect(projected.pipeline_source).toMatchObject({
      pipeline: null,
      note: "pipeline source not recorded",
    });
    await store.close();
  });
});
