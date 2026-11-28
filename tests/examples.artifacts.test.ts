import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { validatePipeline } from "../src/config/validateCatalog.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { listArtifacts } from "../src/artifacts/query.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import type { StageConfig } from "../src/config/types.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = path.join(root, "examples", "artifacts");
const FIXTURE_PIPELINE = path.join(root, "tests", "fixtures", "pipelines", "publish-report.pipeline.yaml");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe("examples/artifacts", () => {
  it("loads and validates the publish-report pipeline", async () => {
    const pipelinePath = path.join(EXAMPLE, "publish-report.pipeline.yaml");
    const loaded = await loadPipeline(pipelinePath);
    expect(loaded.stages[0]?.artifacts).toEqual({
      publish: true,
      expect: ["weekly-report", "metrics-table"],
    });
    const result = await validatePipeline(pipelinePath, { cwd: root, strict: true });
    const errors = result.findings.filter((f) => f.severity === "error");
    expect(result.ok, JSON.stringify(errors)).toBe(true);
    expect(errors).toEqual([]);
  });

  it("matches the canonical fixture shape", async () => {
    const example = await loadPipeline(path.join(EXAMPLE, "publish-report.pipeline.yaml"));
    const fixture = await loadPipeline(FIXTURE_PIPELINE);
    expect(example.stages[0]?.artifacts).toEqual(fixture.stages[0]?.artifacts);
    expect(example.stages[0]?.id).toBe(fixture.stages[0]?.id);
  });
});

describe("examples/artifacts publish integration", () => {
  it("stores both expected artifact ids after a fake stage worker publishes", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-ex-art-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-ex-art-proj-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    cleanups.push(async () => {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    });
    const store = createRunStore({ rootDir: home });
    cleanups.push(() => store.close().catch(() => undefined));
    const projectRoot = await store.ensureProject(project);
    const db = sqliteConnectionFromStore(store);
    expect(db).toBeDefined();
    if (!db) return;
    const roots = await catalogRootsForArtifacts(store);

    const reportMd = "# Weekly\n";
    const tableCsv = "metric,value\ndemo,1\n";

    const worker = fileURLToPath(new URL("./fixtures/publishReportWorker.mjs", import.meta.url));
    const launcher = new StageProcessLauncher({
      cliEntry: worker,
      env: {
        PUBLISH_REPORT_INPUT: JSON.stringify([
          {
            id: "weekly-report",
            kind: "static.markdown",
            title: "Weekly report",
            content_base64: Buffer.from(reportMd).toString("base64"),
          },
          {
            id: "metrics-table",
            kind: "static.table",
            title: "Metrics",
            content_base64: Buffer.from(tableCsv).toString("base64"),
          },
        ]),
      },
    });
    const stage: StageConfig = {
      id: "publish-report",
      system_prompt: "Publish report and table.",
      model: "anthropic/claude-sonnet-4-5",
      artifacts: { publish: true, expect: ["weekly-report", "metrics-table"] },
      io: {
        input: { schema: { type: "object" } },
        output: { schema: { type: "object" } },
      },
    };
    const result = await launcher.launch({
      rootDir: project,
      factoryCwd: project,
      stageId: "publish-report",
      runId: "run-worker",
      pipelineId: "publish-report",
      stage,
      attempt: 1,
    });
    expect(result).toEqual({ type: "succeeded" });

    const listed = listArtifacts(db, { limit: 50 }, roots);
    const ids = listed.artifacts.map((row) => row.id).sort();
    expect(ids).toEqual(["metrics-table", "weekly-report"]);
  });
});