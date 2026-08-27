import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ENVELOPE_USAGE,
  runEnvelopeCommand,
  SYNTHETIC_SKIPPED_ENVELOPE,
} from "../src/cli/envelopeCommand.js";
import { buildHandoffDeliverable } from "../src/cli/handoffFormat.js";
import { linearCompatDagSnapshot } from "../src/runstore/pipelineDagSnapshot.js";
import { createRunStore } from "../src/runstore/createStore.js";
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

function okEnvelope(
  summary: string,
  extra?: Partial<StageEnvelope>,
): StageEnvelope {
  return { status: "success", summary, artifacts: [], ...extra };
}

async function seedRun(
  projectRoot: string,
  options: {
    stageIds?: string[];
    envelopes?: Record<string, StageEnvelope>;
    skippedStages?: string[];
  } = {},
): Promise<{ runId: string; runDir: string }> {
  const store = createRunStore({ rootDir: projectRoot });
  const stageIds = options.stageIds ?? ["detect-changes", "author-diagrams"];
  const created = await store.createRun({
    pipelineId: "archify-on-pr",
    taskYaml: "id: a\ngoal: g\n",
    taskId: "a",
    pipelineDag: linearCompatDagSnapshot(stageIds),
  });

  for (const stageId of stageIds) {
    await store.ensureStageWorkspace(created.runId, stageId);
    if (options.skippedStages?.includes(stageId)) {
      await store.appendStageEvent(created.runId, stageId, { event: "skipped" });
      continue;
    }
    await store.createStageExecution(created.runId, stageId);
    await store.appendStageEvent(created.runId, stageId, { event: "started" });
    await store.appendStageEvent(created.runId, stageId, { event: "succeeded" });
    const envelope = options.envelopes?.[stageId];
    if (envelope) {
      await store.writeEnvelope(created.runId, stageId, envelope);
    }
  }

  await store.updateRunStatus(created.runId, "succeeded");
  return { runId: created.runId, runDir: created.workspaceDir };
}

describe("buildHandoffDeliverable", () => {
  it("builds diagrams from payload.diagrams with absolute spec paths", () => {
    const runDir = "/repo/.stageflow/runs/test-run";
    const envelope = okEnvelope("Adds fork skip", {
      artifacts: ["stages/author-diagrams/workflow.spec.json"],
      payload: {
        diagrams: [
          {
            diagram_type: "workflow",
            summary: "Adds fork skip when detect emits empty fork_choice",
          },
        ],
      },
    });

    const result = buildHandoffDeliverable({
      runId: "test-run",
      runDir,
      stageId: "author-diagrams",
      envelope,
    });

    expect(result).toEqual({
      skipped: false,
      runId: "test-run",
      runDir,
      stageId: "author-diagrams",
      diagrams: [
        {
          diagram_type: "workflow",
          summary: "Adds fork skip when detect emits empty fork_choice",
          spec_path: `${runDir}/stages/author-diagrams/workflow.spec.json`,
        },
      ],
    });
  });

  it("falls back to *.spec.json artifacts when payload.diagrams is absent", () => {
    const runDir = "/repo/.stageflow/runs/test-run";
    const envelope = okEnvelope("Author summary", {
      artifacts: ["stages/author-diagrams/context.spec.json"],
    });

    const result = buildHandoffDeliverable({
      runId: "test-run",
      runDir,
      stageId: "author-diagrams",
      envelope,
    });

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.diagrams).toEqual([
      {
        diagram_type: "context",
        summary: "Author summary",
        spec_path: `${runDir}/stages/author-diagrams/context.spec.json`,
      },
    ]);
  });
});

describe("runEnvelopeCommand", () => {
  it("outputs valid JSON envelope for a succeeded stage", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-env-get-"));
    const envelope = okEnvelope("detect ok", {
      fork_choice: ["author-diagrams"],
    });
    const { runId } = await seedRun(projectRoot, {
      envelopes: { "detect-changes": envelope },
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runEnvelopeCommand(
      ["get", "--run", runId, "--stage", "detect-changes", "--json"],
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
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toEqual(envelope);
  });

  it("reads runId from --from sf-run.json", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-env-from-"));
    const envelope = okEnvelope("detect ok");
    const { runId, runDir } = await seedRun(projectRoot, {
      envelopes: { "detect-changes": envelope },
    });
    await writeFile(
      path.join(projectRoot, "sf-run.json"),
      JSON.stringify({ ok: true, outcome: "succeeded", runId, runDir }),
      "utf8",
    );

    const stdout: string[] = [];
    const code = await runEnvelopeCommand(
      ["get", "--from", "sf-run.json", "--stage", "detect-changes", "--json"],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: (line) => stdout.push(line),
          error: () => undefined,
        },
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toEqual(envelope);
  });

  it("rejects --from sf-run.json for handoff when outcome is not succeeded", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-env-handoff-fail-"));
    const { runId, runDir } = await seedRun(projectRoot);
    await writeFile(
      path.join(projectRoot, "sf-run.json"),
      JSON.stringify({ ok: false, outcome: "failed", runId, runDir }),
      "utf8",
    );

    const stderr: string[] = [];
    const code = await runEnvelopeCommand(
      [
        "get",
        "--from",
        "sf-run.json",
        "--stage",
        "author-diagrams",
        "--format",
        "handoff",
        "--json",
      ],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: () => undefined,
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/pipeline outcome is not succeeded/);
  });

  it("rejects --from sf-run.json for handoff when ok is not true", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-env-handoff-ok-"));
    const { runId, runDir } = await seedRun(projectRoot);
    await writeFile(
      path.join(projectRoot, "sf-run.json"),
      JSON.stringify({ ok: false, outcome: "succeeded", runId, runDir }),
      "utf8",
    );

    const stderr: string[] = [];
    const code = await runEnvelopeCommand(
      [
        "get",
        "--from",
        "sf-run.json",
        "--stage",
        "author-diagrams",
        "--format",
        "handoff",
        "--json",
      ],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: () => undefined,
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/pipeline ok is not true/);
  });

  it("emits handoff skip when detect-stage fork_choice is empty", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-env-handoff-skip-"));
    const { runId } = await seedRun(projectRoot, {
      envelopes: {
        "detect-changes": okEnvelope("no arch changes", { fork_choice: [] }),
        "author-diagrams": okEnvelope("should not matter"),
      },
    });

    const stdout: string[] = [];
    const code = await runEnvelopeCommand(
      [
        "get",
        "--run",
        runId,
        "--stage",
        "author-diagrams",
        "--detect-stage",
        "detect-changes",
        "--format",
        "handoff",
        "--json",
      ],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: (line) => stdout.push(line),
          error: () => undefined,
        },
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toEqual({ skipped: true });
  });

  it("emits handoff diagrams with absolute paths", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-env-handoff-deliver-"));
    const authorEnvelope = okEnvelope("Author summary", {
      artifacts: ["stages/author-diagrams/workflow.spec.json"],
      payload: {
        diagrams: [{ diagram_type: "workflow", summary: "Workflow diagram" }],
      },
    });
    const { runId, runDir } = await seedRun(projectRoot, {
      envelopes: {
        "detect-changes": okEnvelope("arch changes", {
          fork_choice: ["author-diagrams"],
        }),
        "author-diagrams": authorEnvelope,
      },
    });

    const stdout: string[] = [];
    const code = await runEnvelopeCommand(
      [
        "get",
        "--run",
        runId,
        "--stage",
        "author-diagrams",
        "--detect-stage",
        "detect-changes",
        "--format",
        "handoff",
        "--json",
      ],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: (line) => stdout.push(line),
          error: () => undefined,
        },
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      skipped: false,
      runId,
      runDir,
      stageId: "author-diagrams",
      diagrams: [
        {
          diagram_type: "workflow",
          summary: "Workflow diagram",
          spec_path: path.join(runDir, "stages/author-diagrams/workflow.spec.json"),
        },
      ],
    });
  });

  it("returns synthetic skipped envelope for fork-skipped stages", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-env-synthetic-"));
    const { runId } = await seedRun(projectRoot, {
      envelopes: {
        "detect-changes": okEnvelope("no changes", { fork_choice: [] }),
      },
      skippedStages: ["author-diagrams"],
    });

    const stdout: string[] = [];
    const code = await runEnvelopeCommand(
      ["get", "--run", runId, "--stage", "author-diagrams", "--json"],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: (line) => stdout.push(line),
          error: () => undefined,
        },
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toEqual(SYNTHETIC_SKIPPED_ENVELOPE);
  });

  it("prints human output without --json", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-env-human-"));
    const envelope = okEnvelope("hello");
    const { runId } = await seedRun(projectRoot, {
      stageIds: ["build"],
      envelopes: { build: envelope },
    });

    const stdout: string[] = [];
    const code = await runEnvelopeCommand(
      ["get", "--run", runId, "--stage", "build"],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: (line) => stdout.push(line),
          error: () => undefined,
        },
      },
    );

    expect(code).toBe(0);
    expect(stdout.join("\n")).toBe(
      "[build] status=success  summary: hello  artifacts: 0",
    );
  });

  it("prints usage when --stage is missing", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-env-missing-stage-"));
    const { runId } = await seedRun(projectRoot);

    const stderr: string[] = [];
    const code = await runEnvelopeCommand(["get", "--run", runId], {
      cwd: projectRoot,
      projectRoot,
      io: {
        log: () => undefined,
        error: (line) => stderr.push(line),
      },
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/Missing --stage/);
    expect(stderr.join("\n")).toMatch(/sf envelope get/);
  });

  it("exits 1 for unknown run", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-env-unknown-run-"));

    const stderr: string[] = [];
    const code = await runEnvelopeCommand(
      ["get", "--run", "missing-run-id", "--stage", "detect-changes", "--json"],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: () => undefined,
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/Run not found: missing-run-id/);
  });

  it("exits 1 when succeeded stage has no envelope", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-env-no-envelope-"));
    const { runId } = await seedRun(projectRoot, {
      stageIds: ["build"],
      envelopes: {},
    });

    const stderr: string[] = [];
    const code = await runEnvelopeCommand(
      ["get", "--run", runId, "--stage", "build", "--json"],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: () => undefined,
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(
      /No envelope found for stage 'build' in run/,
    );
  });

  it("prints usage on --help", async () => {
    const stderr: string[] = [];
    const code = await runEnvelopeCommand(["get", "--help"], {
      io: {
        log: () => undefined,
        error: (line) => stderr.push(line),
      },
    });

    expect(code).toBe(0);
    expect(stderr.join("\n")).toBe(ENVELOPE_USAGE);
  });
});

describe("CLI envelope get", { timeout: 15_000 }, () => {
  it("envelope get --help shows usage and exits zero", () => {
    const result = runCli(["envelope", "get", "--help"]);
    expect(result.status).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/sf envelope get/);
    expect(out).toMatch(/--format envelope\|handoff/);
  });

  it("top-level --help lists envelope get", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sf envelope get/);
  });
});
