import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiAgentAdapter } from "../src/agent/piAdapter.js";
import type { StageHandle, StageRunInput } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { runStageWorker } from "../src/runtime/stageWorker.js";
import {
  SANDBOX_CONTAINER_DOCKER_BIN_ENV,
  SANDBOX_CONTAINER_IMAGE_ENV,
} from "../src/runtime/sandboxContainer.js";
import { fileURLToPath } from "node:url";

const fakeDockerBin = fileURLToPath(
  new URL("./fixtures/fakeSandboxDocker.mjs", import.meta.url),
);

async function writeSingleStagePipeline(root: string, stageId = "work"): Promise<string> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  const pipelineFile = path.join(root, "pipelines", "solo.pipeline.yaml");
  await writeFile(
    pipelineFile,
    [
      "id: solo",
      "stages:",
      `  - id: ${stageId}`,
      `    uses: ../stages/${stageId}.yaml`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "stages", `${stageId}.yaml`),
    [
      `id: ${stageId}`,
      "system_prompt: x",
      "model: anthropic/claude-sonnet-4-5",
      "io:",
      "  input:",
      "    schema:",
      "      type: object",
      "  output:",
      "    schema:",
      "      type: object",
      "",
    ].join("\n"),
    "utf8",
  );
  return pipelineFile;
}

async function writeTwoIndependentStagesPipeline(root: string): Promise<string> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  const pipelineFile = path.join(root, "pipelines", "duo.pipeline.yaml");
  await writeFile(
    pipelineFile,
    [
      "id: duo",
      "stages:",
      "  - id: work-a",
      "    uses: ../stages/work-a.yaml",
      "  - id: work-b",
      "    uses: ../stages/work-b.yaml",
      "",
    ].join("\n"),
    "utf8",
  );
  for (const stageId of ["work-a", "work-b"]) {
    await writeFile(
      path.join(root, "stages", `${stageId}.yaml`),
      [
        `id: ${stageId}`,
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "io:",
        "  input:",
        "    schema:",
        "      type: object",
        "  output:",
        "    schema:",
        "      type: object",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return pipelineFile;
}

function mockOpenStage(outcome: "succeeded" | "failed" | "waiting"): StageRunInput[] {
  const opened: StageRunInput[] = [];
  vi.spyOn(PiAgentAdapter.prototype, "openStage").mockImplementation(
    (input: StageRunInput): StageHandle => {
      opened.push(input);
      return {
        stageId: input.stageId ?? input.stage.id,
        async next() {
          if (outcome === "succeeded") {
            return {
              status: "completed",
              result: {
                ok: true,
                envelope: { status: "success", summary: "done", artifacts: [] },
              },
            };
          }
          if (outcome === "failed") {
            return {
              status: "completed",
              result: { ok: false, reason: "boom" },
            };
          }
          return {
            status: "waiting_for_input",
            request: { kind: "free_text", id: "q1", message: "need input" },
          };
        },
        deliverAnswer() {},
        async close() {},
      };
    },
  );
  return opened;
}

describe("runStageWorker — sandbox container lifecycle (bash-in-a-box)", () => {
  const previousImage = process.env[SANDBOX_CONTAINER_IMAGE_ENV];
  const previousDockerBin = process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV];
  const previousLogFile = process.env.FAKE_DOCKER_LOG_FILE;

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousImage === undefined) delete process.env[SANDBOX_CONTAINER_IMAGE_ENV];
    else process.env[SANDBOX_CONTAINER_IMAGE_ENV] = previousImage;
    if (previousDockerBin === undefined) delete process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV];
    else process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] = previousDockerBin;
    if (previousLogFile === undefined) delete process.env.FAKE_DOCKER_LOG_FILE;
    else process.env.FAKE_DOCKER_LOG_FILE = previousLogFile;
  });

  it("starts no container and leaves roots.containerName undefined when no image is configured (default, unchanged behavior)", async () => {
    delete process.env[SANDBOX_CONTAINER_IMAGE_ENV];
    const root = await mkdtemp(path.join(tmpdir(), "sf-sandbox-worker-default-"));
    const logFile = path.join(root, "docker.log");
    process.env.FAKE_DOCKER_LOG_FILE = logFile;
    process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] = fakeDockerBin;

    const pipelineFile = await writeSingleStagePipeline(root);
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "solo",
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });

    const opened = mockOpenStage("succeeded");
    const outcome = await runStageWorker({ runId: run.runId, stageId: "work", rootDir: root });

    expect(outcome).toMatchObject({ ok: true });
    expect(opened[0]?.roots.containerName).toBeUndefined();
    await expect(readFile(logFile, "utf8")).rejects.toThrow();
  });

  it("starts a container scoped to run+stage+attempt, passes its name through roots, and stops it after a successful attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sandbox-worker-success-"));
    const logFile = path.join(root, "docker.log");
    process.env.FAKE_DOCKER_LOG_FILE = logFile;
    process.env[SANDBOX_CONTAINER_IMAGE_ENV] = "stageflow-bash:v1";
    process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] = fakeDockerBin;

    const pipelineFile = await writeSingleStagePipeline(root);
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "solo",
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });

    const opened = mockOpenStage("succeeded");
    const outcome = await runStageWorker({ runId: run.runId, stageId: "work", rootDir: root });

    expect(outcome).toMatchObject({ ok: true });
    const containerName = opened[0]?.roots.containerName;
    expect(containerName).toMatch(new RegExp(`^stageflow-${run.runId}-work-1-[0-9a-f]{8}$`));

    const log = await readFile(logFile, "utf8");
    expect(log).toContain(`start ${containerName}`);
    expect(log).toContain(`stop ${containerName}`);
  });

  it("stops the container even when the stage attempt fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sandbox-worker-fail-"));
    const logFile = path.join(root, "docker.log");
    process.env.FAKE_DOCKER_LOG_FILE = logFile;
    process.env[SANDBOX_CONTAINER_IMAGE_ENV] = "stageflow-bash:v1";
    process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] = fakeDockerBin;

    const pipelineFile = await writeSingleStagePipeline(root);
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "solo",
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });

    const opened = mockOpenStage("failed");
    const outcome = await runStageWorker({ runId: run.runId, stageId: "work", rootDir: root });

    expect(outcome).toMatchObject({ ok: false });
    const containerName = opened[0]?.roots.containerName;
    expect(containerName).toBeDefined();
    const log = await readFile(logFile, "utf8");
    expect(log).toContain(`start ${containerName}`);
    expect(log).toContain(`stop ${containerName}`);
  });

  it("stops the container even when the stage attempt parks waiting for operator input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sandbox-worker-wait-"));
    const logFile = path.join(root, "docker.log");
    process.env.FAKE_DOCKER_LOG_FILE = logFile;
    process.env[SANDBOX_CONTAINER_IMAGE_ENV] = "stageflow-bash:v1";
    process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] = fakeDockerBin;

    const pipelineFile = await writeSingleStagePipeline(root);
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "solo",
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });

    const opened = mockOpenStage("waiting");
    const outcome = await runStageWorker({ runId: run.runId, stageId: "work", rootDir: root });

    expect(outcome).toEqual({ waiting: true });
    const containerName = opened[0]?.roots.containerName;
    expect(containerName).toBeDefined();
    const log = await readFile(logFile, "utf8");
    expect(log).toContain(`start ${containerName}`);
    expect(log).toContain(`stop ${containerName}`);
  });

  it("gives each concurrent worker (e.g. fan-out clones) its own container, with no shared state between them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sandbox-worker-fanout-"));
    const logFile = path.join(root, "docker.log");
    process.env.FAKE_DOCKER_LOG_FILE = logFile;
    process.env[SANDBOX_CONTAINER_IMAGE_ENV] = "stageflow-bash:v1";
    process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] = fakeDockerBin;

    const pipelineFile = await writeTwoIndependentStagesPipeline(root);
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "duo",
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });

    const opened = mockOpenStage("succeeded");

    const [outcomeOne, outcomeTwo] = await Promise.all([
      runStageWorker({ runId: run.runId, stageId: "work-a", rootDir: root }),
      runStageWorker({ runId: run.runId, stageId: "work-b", rootDir: root }),
    ]);

    expect(outcomeOne).toMatchObject({ ok: true });
    expect(outcomeTwo).toMatchObject({ ok: true });

    const containerNames = opened.map((i) => i.roots.containerName);
    expect(new Set(containerNames).size).toBe(2);
    const log = await readFile(logFile, "utf8");
    for (const name of containerNames) {
      expect(log).toContain(`start ${name}`);
      expect(log).toContain(`stop ${name}`);
    }
  });
});
