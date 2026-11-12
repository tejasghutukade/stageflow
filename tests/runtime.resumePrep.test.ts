import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stageBrowserEnv from "../src/browser/stageBrowserEnv.js";
import { stageTimeoutReason } from "../src/agent/stageTimeout.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { appendOperatorPrompt } from "../src/hitl/qaTrail.js";
import { attemptCredentialsDir } from "../src/runtime/credentialMaterialisation.js";
import { attemptWorkspaceDir } from "../src/runstore/workspaceLayout.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { attemptSessionPath } from "../src/runstore/workspaceLayout.js";
import * as pipelineScheduler from "../src/runtime/pipelineScheduler.js";
import { RunManager } from "../src/runtime/runManager.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import type { StageProcessLauncher as StageProcessLauncherPort } from "../src/runtime/stageProcessLauncher.js";
import { okEnvelope } from "./helpers/envelopes.js";
import {
  catalogLocators,
  SAMPLE_TASK,
  SINGLE_PIPELINE,
} from "./helpers/fixturePaths.js";
import { waitFor as poll } from "./helpers/waitFor.js";
import { withEnv } from "./helpers/withEnv.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const mockWorker = fileURLToPath(
  new URL("./fixtures/mockStageWorker.mjs", import.meta.url),
);

const answer = {
  promptId: "q1",
  kind: "free_text" as const,
  text: "approved",
};

async function seedTimedOutClarifyRun(root: string) {
  const store = createRunStore({ rootDir: root });
  const run = await store.createRun({
    ...catalogLocators("single"),
    projectRoot: fixtures,
    taskYaml: "id: sample\ngoal: timeout-resume-process\n",
    taskId: "sample",
  });
  await store.createStageExecution(run.runId, "clarify");
  await store.appendStageEvent(run.runId, "clarify", { event: "started" });
  await store.appendStageEvent(run.runId, "clarify", {
    event: "failed",
    reason: stageTimeoutReason(1000),
  });
  await store.updateRunStatus(run.runId, "failed");
  return { store, run };
}

async function writeSecretsPipeline(root: string): Promise<string> {
  const pipelineFile = path.join(root, "two-secrets.pipeline.yaml");
  await writeFile(
    pipelineFile,
    [
      "id: two-secrets",
      "stages:",
      "  - id: clarify",
      "    system_prompt: Clarify the task.",
      "    model: anthropic/claude-sonnet-4-5",
      "    secrets:",
      "      - GITHUB_TOKEN",
      "      - NPM_TOKEN",
      "    io:",
      "      input:",
      "        schema:",
      "          type: object",
      "      output:",
      "        schema:",
      "          type: object",
      "",
    ].join("\n"),
    "utf8",
  );
  return pipelineFile;
}

describe("resume attempt prep (U12)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("second secret throws: attempt credential directory gone and no browser started", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-resume-prep-fail-"));
    const pipelineFile = await writeSecretsPipeline(root);
    const browserSpy = vi.spyOn(stageBrowserEnv, "resolveStageBrowserEnv");

    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "two-secrets",
      pipelinePath: pipelineFile,
      projectRoot: root,
      taskYaml: "id: sample\ngoal: resume-prep\n",
      taskId: "sample",
    });
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await appendOperatorPrompt(store, run.runId, "clarify", {
      kind: "free_text",
      id: "q1",
      message: "Need input?",
    });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });

    const launch = vi.fn();
    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: root,
      executionMode: "process",
      stageProcessLauncher: { launch } as unknown as StageProcessLauncherPort,
    });

    await withEnv({ GITHUB_TOKEN: "ghp_first_secret_value_xx" }, async () => {
      const result = await manager.deliverAnswer(run.runId, "clarify", answer);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/secret_unavailable/);
    });

    expect(browserSpy).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    const credentialsRoot = path.join(
      attemptWorkspaceDir(store.getWorkspaceDir(run.runId), "clarify", 1),
      "credentials",
    );
    expect(existsSync(credentialsRoot)).toBe(false);
  });

  it("process-mode timeout resume launches a worker without operator answer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-timeout-resume-process-"));
    const { store, run } = await seedTimedOutClarifyRun(root);
    const launch = vi.fn().mockResolvedValue({ type: "waiting" });
    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: { launch } as unknown as StageProcessLauncherPort,
    });

    const sessionFile = attemptSessionPath(
      store.getWorkspaceDir(run.runId),
      "clarify",
      1,
    );
    await writeFile(
      sessionFile,
      '{"role":"assistant","text":"partial work"}\n',
    );

    const resumed = await manager.resumeTimedOutStage(run.runId, "clarify");
    expect(resumed.ok).toBe(true);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        stageId: "clarify",
        mode: "timeout_resume",
        attempt: 1,
        sessionFilePath: sessionFile,
        grants: expect.any(Object),
        attemptHome: expect.stringMatching(/\/home$/),
      }),
    );
    const launchArg = launch.mock.calls[0]?.[0] as
      | { resumeAnswer?: unknown }
      | undefined;
    expect(launchArg?.resumeAnswer).toBeUndefined();
  });

  it("process-mode timeout resume leaves a run cancelled mid-launch as cancelled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-timeout-resume-cancel-"));
    const { store, run } = await seedTimedOutClarifyRun(root);
    // The run is cancelled while the worker runs; the worker then dies and launch reports a failure.
    const launch = vi.fn(async () => {
      await store.updateRunStatus(run.runId, "cancelled");
      return { type: "failed", reason: "stage process exited (SIGTERM)" };
    });
    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: { launch } as unknown as StageProcessLauncherPort,
    });
    await writeFile(
      attemptSessionPath(store.getWorkspaceDir(run.runId), "clarify", 1),
      '{"role":"assistant","text":"partial work"}\n',
    );
    await manager.resumeTimedOutStage(run.runId, "clarify");
    await poll(async () => launch.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await store.readRunMeta(run.runId)).status).toBe("cancelled");
  });

  it("process-mode timeout worker child has no provider key or control token", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-timeout-worker-env-"));
    const dumpPath = path.join(rootDir, "child-env.json");
    const root = await mkdtemp(path.join(tmpdir(), "sf-timeout-worker-run-"));
    const { store, run } = await seedTimedOutClarifyRun(root);
    const prev = {
      control: process.env.STAGEFLOW_CONTROL_TOKEN,
      anthropic: process.env.ANTHROPIC_API_KEY,
    };
    process.env.STAGEFLOW_CONTROL_TOKEN =
      "control-token-value-32chars-min!!";
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-secret";

    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      env: {
        MOCK_DELAY: "20",
        MOCK_EXIT_CODE: "0",
        MOCK_DUMP_ENV: dumpPath,
        MOCK_DUMP_KEYS: [
          "STAGEFLOW_CONTROL_TOKEN",
          "ANTHROPIC_API_KEY",
          "SF_STAGE_WORKER",
        ].join(","),
      },
    });

    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: launcher,
    });

    try {
      const sessionFile = attemptSessionPath(
        store.getWorkspaceDir(run.runId),
        "clarify",
        1,
      );
      await writeFile(
        sessionFile,
        '{"role":"assistant","text":"partial work"}\n',
      );

      vi.spyOn(pipelineScheduler, "resumeRun").mockResolvedValue({
        ok: true,
        outcome: "succeeded",
        runDir: run.workspaceDir,
        runId: run.runId,
      });

      const resumed = await manager.resumeTimedOutStage(run.runId, "clarify");
      expect(resumed.ok).toBe(true);
      const dumped = JSON.parse(await readFile(dumpPath, "utf8")) as Record<
        string,
        string | null
      >;
      expect(dumped.STAGEFLOW_CONTROL_TOKEN).toBeNull();
      expect(dumped.ANTHROPIC_API_KEY).toBeNull();
      expect(dumped.SF_STAGE_WORKER).toBe("1");
    } finally {
      if (prev.control === undefined) delete process.env.STAGEFLOW_CONTROL_TOKEN;
      else process.env.STAGEFLOW_CONTROL_TOKEN = prev.control;
      if (prev.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev.anthropic;
    }
  });

  it("in-process timeout resume does not launch a worker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-timeout-inprocess-"));
    const store = createRunStore({ rootDir: root });
    const launch = vi.fn();
    const agent = scriptedFakeAgent([
      { type: "throw", message: stageTimeoutReason(1000) },
      { type: "emit", envelope: okEnvelope("clarify-resumed") },
    ]);
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      executionMode: "inprocess",
      stageProcessLauncher: { launch } as unknown as StageProcessLauncherPort,
    });

    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: SINGLE_PIPELINE,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await poll(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "clarify")?.status === "failed"
      );
    });

    const sessionFile = attemptSessionPath(
      store.getWorkspaceDir(started.runId),
      "clarify",
      1,
    );
    await writeFile(
      sessionFile,
      '{"role":"assistant","text":"partial work"}\n',
    );

    const resumed = await manager.resumeTimedOutStage(started.runId, "clarify");
    expect(resumed.ok).toBe(true);
    expect(launch).not.toHaveBeenCalled();
  });

  it("answer-resume still passes grants and attempt home", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-answer-resume-grants-"));
    const home = path.join(root, "sf-home");
    const token = "ghp_resume_after_answer_token";
    const pipelineFile = path.join(root, "secret-gate.pipeline.yaml");
    await writeFile(
      pipelineFile,
      [
        "id: secret-gate",
        "stages:",
        "  - id: clarify",
        "    system_prompt: Clarify the task.",
        "    model: anthropic/claude-sonnet-4-5",
        "    secrets:",
        "      - GITHUB_TOKEN",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
      "utf8",
    );

    await withEnv(
      { STAGEFLOW_HOME: home, GITHUB_TOKEN: token },
      async () => {
        const store = createRunStore({ rootDir: root });
        const run = await store.createRun({
          pipelineId: "secret-gate",
          pipelinePath: pipelineFile,
          projectRoot: root,
          taskYaml: "id: sample\ngoal: process-mode-hitl\n",
          taskId: "sample",
        });
        await store.ensureStageWorkspace(run.runId, "clarify");
        await store.appendStageEvent(run.runId, "clarify", { event: "started" });
        await appendOperatorPrompt(store, run.runId, "clarify", {
          kind: "free_text",
          id: "q1",
          message: "Need input?",
        });
        await store.appendStageEvent(run.runId, "clarify", {
          event: "waiting_for_input",
        });
        const attemptHome = path.join(
          run.workspaceDir,
          "stages",
          "clarify",
          "attempts",
          "1",
          "home",
        );

        const captured: {
          declared?: string[];
          attemptHome?: string;
          credDir?: string;
        } = {};
        const launch = vi.fn().mockImplementation(async (input) => {
          captured.declared = input.grants?.declaredSecretNames;
          captured.attemptHome = input.attemptHome;
          if (typeof input.attemptHome === "string") {
            await access(input.attemptHome);
          }
          const attemptDir = attemptWorkspaceDir(
            store.getWorkspaceDir(run.runId),
            "clarify",
            1,
          );
          captured.credDir = attemptCredentialsDir(attemptDir, "GITHUB_TOKEN");
          await access(captured.credDir);
          return { type: "waiting" };
        });
        const manager = new RunManager({
          agent: { openStage: vi.fn(), runStage: vi.fn() },
          store,
          cwd: root,
          executionMode: "process",
          stageProcessLauncher: { launch } as unknown as StageProcessLauncherPort,
        });

        const result = await manager.deliverAnswer(run.runId, "clarify", answer);
        expect(result).toEqual({ ok: true });
        expect(launch).toHaveBeenCalledTimes(1);
        expect(captured.declared).toEqual(["GITHUB_TOKEN"]);
        expect(captured.attemptHome).toBe(attemptHome);
        expect(captured.credDir).toBeTruthy();
      },
    );
  });
});
