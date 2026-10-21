import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiAgentAdapter } from "../src/agent/piAdapter.js";
import {
  createSandboxBashTool,
  createSandboxEditTool,
  createSandboxReadTool,
  createSandboxWriteTool,
} from "../src/agent/sandboxPiTools.js";
import type { StageHandle, StageRunInput } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { globalStageflowHome } from "../src/project/globalHome.js";
import { runStageWorker } from "../src/runtime/stageWorker.js";
import {
  SANDBOX_CONTAINER_DOCKER_BIN_ENV,
  SANDBOX_CONTAINER_IMAGE_ENV,
} from "../src/runtime/sandboxContainer.js";
import { attemptWorkspaceDir } from "../src/runstore/workspaceLayout.js";
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
  const previousHome = process.env.HOME;

  beforeEach(async () => {
    process.env.HOME = await mkdtemp(path.join(tmpdir(), "sf-sandbox-worker-home-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousImage === undefined) delete process.env[SANDBOX_CONTAINER_IMAGE_ENV];
    else process.env[SANDBOX_CONTAINER_IMAGE_ENV] = previousImage;
    if (previousDockerBin === undefined) delete process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV];
    else process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] = previousDockerBin;
    if (previousLogFile === undefined) delete process.env.FAKE_DOCKER_LOG_FILE;
    else process.env.FAKE_DOCKER_LOG_FILE = previousLogFile;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  it("starts no container and leaves roots.containerName undefined when no image is configured (default, unchanged behavior)", async () => {
    delete process.env[SANDBOX_CONTAINER_IMAGE_ENV];
    const root = await mkdtemp(path.join(tmpdir(), "sf-sandbox-worker-default-"));
    const logFile = path.join(root, "docker.log");
    process.env.FAKE_DOCKER_LOG_FILE = logFile;
    process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] = fakeDockerBin;

    const pipelineFile = await writeSingleStagePipeline(root);
    const store = createRunStore({ rootDir: globalStageflowHome() });
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
    const store = createRunStore({ rootDir: globalStageflowHome() });
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
    const store = createRunStore({ rootDir: globalStageflowHome() });
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
    const store = createRunStore({ rootDir: globalStageflowHome() });
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
    const store = createRunStore({ rootDir: globalStageflowHome() });
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

  it("sandboxes read, write, edit, and bash without a checkout and copies work/ back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sandbox-worker-desk-"));
    const logFile = path.join(root, "docker.log");
    process.env.FAKE_DOCKER_LOG_FILE = logFile;
    process.env[SANDBOX_CONTAINER_IMAGE_ENV] = "stageflow-bash:v1";
    process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] = fakeDockerBin;

    const pipelineFile = await writeSingleStagePipeline(root);
    await writeFile(
      path.join(root, "stages", "work.yaml"),
      [
        "id: work",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "io:",
        "  input:",
        "    schema:",
        "      type: object",
        "  output:",
        "    schema:",
        "      type: object",
        "verify:",
        "  - id: scratch-landed",
        "    type: command",
        "    run: test -f stages/work/attempts/1/work/hello.txt && test -f stages/work/attempts/1/work/from-bash.txt",
        "",
      ].join("\n"),
      "utf8",
    );
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const run = await store.createRun({
      pipelineId: "solo",
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });
    const attemptDir = attemptWorkspaceDir(store.getWorkspaceDir(run.runId), "work", 1);
    await mkdir(attemptDir, { recursive: true });
    await writeFile(path.join(attemptDir, "pi-session.jsonl"), "SECRET_SESSION\n");
    await writeFile(path.join(root, "secret.txt"), "SECRET_HOST\n");

    vi.spyOn(PiAgentAdapter.prototype, "openStage").mockImplementation((input: StageRunInput) => {
      const target = {
        containerName: input.roots.containerName ?? "",
        dockerBin: input.roots.containerDockerBin,
      };
      return {
        stageId: input.stageId ?? input.stage.id,
        async next() {
          const read = createSandboxReadTool(target);
          const write = createSandboxWriteTool(target);
          const edit = createSandboxEditTool(target);
          const bash = createSandboxBashTool(target);
          const outside = await read.execute("read-outside", { path: "/etc/passwd" });
          expect(outside.isError).toBe(true);
          expect(outside.content[0]?.text ?? "").not.toContain("root:");
          const session = await read.execute("read-session", { path: "pi-session.jsonl" });
          expect(session.isError).toBe(true);
          expect(session.content[0]?.text ?? "").not.toContain("SECRET_SESSION");
          const hostFile = await read.execute("read-host", { path: path.join(root, "secret.txt") });
          expect(hostFile.isError).toBe(true);
          expect(hostFile.content[0]?.text ?? "").not.toContain("SECRET_HOST");
          await write.execute("write-work", { path: "work/hello.txt", content: "from-sandbox\n" });
          const readBack = await read.execute("read-work", { path: "work/hello.txt" });
          expect(readBack.isError).toBeFalsy();
          expect(readBack.content[0]?.text).toContain("from-sandbox");
          const edited = await edit.execute("edit-work", {
            path: "work/hello.txt",
            edits: [{ oldText: "sandbox", newText: "desk" }],
          });
          expect(edited.isError).toBeFalsy();
          const bashed = await bash.execute("bash-work", {
            command: "printf 'bash\\n' > work/from-bash.txt",
          });
          expect(bashed.isError).toBeFalsy();
          expect(bashed.content[0]?.text).toContain("Exit code: 0");
          return {
            status: "completed",
            result: {
              ok: true,
              envelope: { status: "success", summary: "done", artifacts: [] },
            },
          };
        },
        deliverAnswer() {},
        async close() {},
      };
    });

    const outcome = await runStageWorker({ runId: run.runId, stageId: "work", rootDir: root });
    expect(outcome).toMatchObject({ ok: true });
    expect(await readFile(path.join(attemptDir, "work", "hello.txt"), "utf8")).toBe("from-desk\n");
    expect(await readFile(path.join(attemptDir, "work", "from-bash.txt"), "utf8")).toBe("bash\n");
    expect(await readFile(path.join(attemptDir, "pi-session.jsonl"), "utf8")).toBe("SECRET_SESSION\n");
  });

  it("returns a failed outcome when copying the desk back fails and still stops the container", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sandbox-worker-sync-fail-"));
    const logFile = path.join(root, "docker.log");
    process.env.FAKE_DOCKER_LOG_FILE = logFile;
    process.env[SANDBOX_CONTAINER_IMAGE_ENV] = "stageflow-bash:v1";
    process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] = fakeDockerBin;
    delete process.env.FAKE_DOCKER_FAIL_CP;

    const pipelineFile = await writeSingleStagePipeline(root);
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const run = await store.createRun({
      pipelineId: "solo",
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });

    const opened: StageRunInput[] = [];
    vi.spyOn(PiAgentAdapter.prototype, "openStage").mockImplementation((input: StageRunInput) => {
      opened.push(input);
      return {
        stageId: input.stageId ?? input.stage.id,
        async next() {
          process.env.FAKE_DOCKER_FAIL_CP = "1";
          return {
            status: "completed",
            result: {
              ok: true,
              envelope: { status: "success", summary: "done", artifacts: [] },
            },
          };
        },
        deliverAnswer() {},
        async close() {},
      };
    });

    try {
      const outcome = await runStageWorker({ runId: run.runId, stageId: "work", rootDir: root });
      expect(outcome.ok).toBe(false);
      if (outcome.ok === false) {
        expect(outcome.reason).toMatch(/copy/i);
      }
      const containerName = opened[0]?.roots.containerName;
      const log = await readFile(logFile, "utf8");
      expect(log).toContain(`stop ${containerName}`);
    } finally {
      delete process.env.FAKE_DOCKER_FAIL_CP;
    }
  });
});
