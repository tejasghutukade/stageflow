import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EXPORT_TRACE_USAGE,
  buildTraceDocument,
  runExportTraceCommand,
} from "../src/cli/exportTraceCommand.js";
import { projectRun } from "../src/projection/projectRun.js";
import { linearCompatDagSnapshot } from "../src/runstore/pipelineDagSnapshot.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStatus } from "../src/runstore/port.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { runWorkspaceDir, storeRootFor } from "../src/runstore/paths.js";
import { attemptSessionPath } from "../src/runstore/workspaceLayout.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

function runCli(args: string[], cwd = root) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

async function seedRun(
  projectRoot: string,
  options: {
    stageIds?: string[];
    runStatus?: RunStatus;
    envelopes?: Record<string, StageEnvelope>;
  } = {},
): Promise<{ runId: string }> {
  const store = createRunStore({ rootDir: projectRoot });
  const stageIds = options.stageIds ?? ["stage-a"];
  const created = await store.createRun({
    pipelineId: "test-pipeline",
    taskYaml: "id: a\ngoal: g\n",
    taskId: "a",
    pipelineDag: linearCompatDagSnapshot(stageIds),
  });

  for (const stageId of stageIds) {
    await store.ensureStageWorkspace(created.runId, stageId);
    await store.createStageExecution(created.runId, stageId);
    await store.appendStageEvent(created.runId, stageId, { event: "started" });
    await store.appendStageEvent(created.runId, stageId, { event: "succeeded" });
    const envelope = options.envelopes?.[stageId];
    if (envelope) {
      await store.writeEnvelope(created.runId, stageId, envelope);
    }
  }

  const runStatus = options.runStatus ?? "succeeded";
  if (runStatus !== "created") {
    await store.updateRunStatus(created.runId, runStatus);
  }

  return { runId: created.runId };
}

describe("buildTraceDocument", () => {
  it("includes stage metadata and pi session path", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-export-trace-"));
    const { runId } = await seedRun(projectRoot);
    const store = createRunStore({ rootDir: projectRoot });
    const detail = await store.readRun(runId);
    const projection = projectRun(detail);
    const runWorkspace = runWorkspaceDir(storeRootFor(projectRoot), runId);
    const sessionPath = attemptSessionPath(runWorkspace, "stage-a", 1);
    await writeFile(
      sessionPath,
      JSON.stringify({ role: "user", content: "hello" }) + "\n",
      "utf8",
    );

    const document = buildTraceDocument({
      runId,
      runWorkspace,
      projection,
      instanceId: "foo__bar-1",
      modelName: "stageflow/test",
    });

    expect(document.instance_id).toBe("foo__bar-1");
    expect(document.run_id).toBe(runId);
    expect(document.model_name_or_path).toBe("stageflow/test");
    const stages = document.stages as Array<{ stage_id: string; pi_session: unknown[] }>;
    expect(stages[0]?.stage_id).toBe("stage-a");
    expect(stages[0]?.pi_session).toHaveLength(1);
  });
});

describe("runExportTraceCommand", () => {
  it("exports trace JSON for a completed run", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-export-trace-"));
    const { runId } = await seedRun(projectRoot);

    const stdout: string[] = [];
    const code = await runExportTraceCommand(
      ["--run", runId, "--instance-id", "inst-1", "--model", "stageflow/test"],
      {
        cwd: projectRoot,
        projectRoot,
        io: { log: (line) => stdout.push(line), error: () => {} },
      },
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join("\n")) as {
      instance_id: string;
      run_id: string;
      stages: unknown[];
    };
    expect(parsed.instance_id).toBe("inst-1");
    expect(parsed.run_id).toBe(runId);
    expect(parsed.stages.length).toBeGreaterThan(0);
  });

  it("--help shows usage", () => {
    const result = runCli(["export-trace", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/sf export-trace/);
    expect(EXPORT_TRACE_USAGE).toMatch(/export-trace/);
  });
});
