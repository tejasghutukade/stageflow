import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EXPORT_RUN_USAGE,
  runExportRunCommand,
} from "../src/cli/exportRunCommand.js";
import { linearCompatDagSnapshot } from "../src/runstore/pipelineDagSnapshot.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStatus } from "../src/runstore/port.js";
import type { StageEnvelope } from "../src/types/envelope.js";

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
    completeStages?: boolean;
  } = {},
): Promise<{ runId: string }> {
  const store = createRunStore({ rootDir: projectRoot });
  const stageIds = options.stageIds ?? ["stage-a", "stage-b"];
  const completeStages = options.completeStages ?? true;
  const created = await store.createRun({
    pipelineId: "test-pipeline",
    taskYaml: "id: a\ngoal: g\n",
    taskId: "a",
    pipelineDag: linearCompatDagSnapshot(stageIds),
  });

  for (const stageId of stageIds) {
    await store.ensureStageWorkspace(created.runId, stageId);
    if (!completeStages && stageId !== stageIds[0]) {
      continue;
    }
    await store.createStageExecution(created.runId, stageId);
    await store.appendStageEvent(created.runId, stageId, { event: "started" });
    if (completeStages) {
      await store.appendStageEvent(created.runId, stageId, { event: "succeeded" });
    }
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

describe("runExportRunCommand", () => {
  it("exports succeeded run JSON with run_id, status, and stages", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-export-run-"));
    const { runId } = await seedRun(projectRoot);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runExportRunCommand(["--run", runId], {
      cwd: projectRoot,
      projectRoot,
      io: {
        log: (line) => stdout.push(line),
        error: (line) => stderr.push(line),
      },
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const parsed = JSON.parse(stdout.join("\n")) as {
      run_id: string;
      status: string;
      stages: Array<{ stage_id: string; envelope: unknown }>;
      pipeline_track: { nodes: unknown[] };
    };
    expect(parsed.run_id).toBe(runId);
    expect(parsed.status).toBe("succeeded");
    expect(parsed.stages).toHaveLength(2);
    expect(parsed.stages.map((s) => s.stage_id)).toEqual(["stage-a", "stage-b"]);
    expect(parsed.pipeline_track.nodes.length).toBeGreaterThan(0);
  });

  it("reads runId from --from sf-run.json", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-export-from-"));
    const { runId } = await seedRun(projectRoot);
    const sfRunPath = path.join(projectRoot, "sf-run.json");
    await writeFile(
      sfRunPath,
      JSON.stringify({
        ok: true,
        outcome: "succeeded",
        runId,
        runDir: path.join(projectRoot, ".stageflow", "runs", runId),
      }),
      "utf8",
    );

    const stdout: string[] = [];
    const code = await runExportRunCommand(["--from", "sf-run.json"], {
      cwd: projectRoot,
      projectRoot,
      io: {
        log: (line) => stdout.push(line),
        error: () => undefined,
      },
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join("\n")) as { run_id: string };
    expect(parsed.run_id).toBe(runId);
  });

  it("writes JSON to --out and confirms on stderr", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-export-out-"));
    const { runId } = await seedRun(projectRoot);
    const outFile = path.join(projectRoot, "run-export.json");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runExportRunCommand(
      ["--run", runId, "--out", "run-export.json"],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: (line) => stdout.push(line),
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/Wrote .*run-export\.json/);
    const contents = await readFile(outFile, "utf8");
    const parsed = JSON.parse(contents) as { run_id: string; status: string };
    expect(parsed.run_id).toBe(runId);
    expect(parsed.status).toBe("succeeded");
  });

  it("rejects in-progress runs", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-export-inprog-"));
    const { runId } = await seedRun(projectRoot, { completeStages: false });

    const stderr: string[] = [];
    const code = await runExportRunCommand(["--run", runId], {
      cwd: projectRoot,
      projectRoot,
      io: {
        log: () => undefined,
        error: (line) => stderr.push(line),
      },
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(
      new RegExp(`run is not complete: ${runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(status: running\\)`),
    );
  });

  it("rejects created runs", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-export-created-"));
    const store = createRunStore({ rootDir: projectRoot });
    const created = await store.createRun({
      pipelineId: "test-pipeline",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
      pipelineDag: linearCompatDagSnapshot(["stage-a", "stage-b"]),
    });

    const stderr: string[] = [];
    const code = await runExportRunCommand(["--run", created.runId], {
      cwd: projectRoot,
      projectRoot,
      io: {
        log: () => undefined,
        error: (line) => stderr.push(line),
      },
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/run is not complete.*status: created/);
  });

  it("exits 1 for unknown run", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-export-unknown-"));

    const stderr: string[] = [];
    const code = await runExportRunCommand(["--run", "missing-run-id"], {
      cwd: projectRoot,
      projectRoot,
      io: {
        log: () => undefined,
        error: (line) => stderr.push(line),
      },
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/Run not found: missing-run-id/);
  });

  it("includes stages[].envelope.fork_choice when present", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-export-fork-"));
    const { runId } = await seedRun(projectRoot, {
      stageIds: ["detect", "author"],
      envelopes: {
        detect: {
          status: "success",
          summary: "skip downstream",
          artifacts: [],
          fork_choice: [],
        },
      },
    });

    const stdout: string[] = [];
    const code = await runExportRunCommand(["--run", runId], {
      cwd: projectRoot,
      projectRoot,
      io: {
        log: (line) => stdout.push(line),
        error: () => undefined,
      },
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join("\n")) as {
      stages: Array<{
        stage_id: string;
        envelope: { fork_choice?: string[] } | null;
      }>;
    };
    const detect = parsed.stages.find((s) => s.stage_id === "detect");
    expect(detect?.envelope?.fork_choice).toEqual([]);
  });

  it("prints usage when --run is missing", async () => {
    const stderr: string[] = [];
    const code = await runExportRunCommand([], {
      io: {
        log: () => undefined,
        error: (line) => stderr.push(line),
      },
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/Missing --run/);
    expect(stderr.join("\n")).toMatch(/sf export-run/);
  });

  it("prints usage on --help", async () => {
    const stderr: string[] = [];
    const code = await runExportRunCommand(["--help"], {
      io: {
        log: () => undefined,
        error: (line) => stderr.push(line),
      },
    });

    expect(code).toBe(0);
    expect(stderr.join("\n")).toBe(EXPORT_RUN_USAGE);
  });
});

describe("CLI export-run", { timeout: 15_000 }, () => {
  it("export-run --help shows usage and exits zero", () => {
    const result = runCli(["export-run", "--help"]);
    expect(result.status).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/sf export-run/);
    expect(out).toMatch(/--run <runId>/);
    expect(out).toMatch(/--from <sf-run\.json>/);
    expect(out).toMatch(/--out <file>/);
  });

  it("top-level --help lists export-run", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sf export-run/);
  });
});
