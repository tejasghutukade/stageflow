import { describe, expect, it, vi, afterEach } from "vitest";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendOperatorPrompt } from "../src/hitl/qaTrail.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import * as pipelineScheduler from "../src/runtime/pipelineScheduler.js";
import { RunManager } from "../src/runtime/runManager.js";
import type { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { catalogLocators } from "./helpers/fixturePaths.js";
import { withEnv } from "./helpers/withEnv.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const okEnvelope = (): StageEnvelope => ({
  status: "success",
  summary: "clarify-ok",
  artifacts: [],
  payload: {},
});

const answer = {
  promptId: "q1",
  kind: "free_text" as const,
  text: "approved",
};

async function createWaitingRun(root: string) {
  const store = createRunStore({ rootDir: root });
  const taskYaml = "id: sample\ngoal: process-mode-hitl\n";
  const run = await store.createRun({
    ...catalogLocators("linear-explicit"),
    taskYaml,
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
  return { store, run };
}

describe("runtime HITL deliverAnswer process mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subprocess succeeded calls resumeRun with envelope from store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-process-"));
    const { store, run } = await createWaitingRun(root);
    const envelope = okEnvelope();
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", envelope);

    const launch = vi.fn().mockResolvedValue({ type: "succeeded" });
    const mockLauncher = { launch } as unknown as StageProcessLauncher;
    const resumeRunSpy = vi
      .spyOn(pipelineScheduler, "resumeRun")
      .mockResolvedValue({
        ok: true,
        outcome: "succeeded",
        runDir: run.workspaceDir,
        runId: run.runId,
      });

    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });

    const result = await manager.deliverAnswer(run.runId, "clarify", answer);
    expect(result).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        stageId: "clarify",
        rootDir: fixtures,
        mode: "resume",
        resumeAnswer: answer,
        attempt: 1,
        sessionFilePath: expect.stringMatching(
          /stages\/clarify\/attempts\/1\/pi-session\.jsonl$/,
        ),
      }),
    );    expect(resumeRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeFromStageId: "clarify",
        initialPrior: envelope,
        executionMode: "process",
        stageProcessLauncher: mockLauncher,
      }),
    );
  });

  it("subprocess waiting returns ok without resumeRun", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-process-"));
    const { store, run } = await createWaitingRun(root);

    const launch = vi.fn().mockImplementation(async ({ runId, stageId }) => {
      await store.appendStageEvent(runId, stageId, {
        event: "waiting_for_input",
      });
      return { type: "waiting" };
    });
    const mockLauncher = { launch } as unknown as StageProcessLauncher;
    const resumeRunSpy = vi.spyOn(pipelineScheduler, "resumeRun");

    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });

    const result = await manager.deliverAnswer(run.runId, "clarify", answer);
    expect(result).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "resume",
        resumeAnswer: answer,
      }),
    );
    expect(resumeRunSpy).not.toHaveBeenCalled();

    const detail = await store.readRun(run.runId);
    expect(
      detail.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");
  });

  it("subprocess failed marks run failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-process-"));
    const { store, run } = await createWaitingRun(root);

    const launch = vi.fn().mockResolvedValue({
      type: "failed",
      reason: "stage worker failed",
    });
    const mockLauncher = { launch } as unknown as StageProcessLauncher;

    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });

    const result = await manager.deliverAnswer(run.runId, "clarify", answer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stage worker failed");

    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("failed");
    expect(
      detail.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("failed");
  });

  it("resumeRun waiting after answer is deliverAnswer ok", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-process-wait-"));
    const { store, run } = await createWaitingRun(root);
    const envelope = okEnvelope();
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", envelope);

    const launch = vi.fn().mockResolvedValue({ type: "succeeded" });
    const mockLauncher = { launch } as unknown as StageProcessLauncher;
    vi.spyOn(pipelineScheduler, "resumeRun").mockResolvedValue({
      ok: false,
      outcome: "waiting",
      runDir: run.workspaceDir,
      runId: run.runId,
    });

    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });

    const result = await manager.deliverAnswer(run.runId, "clarify", answer);
    expect(result).toEqual({ ok: true });
  });

  it("resumeRun failed after answer is deliverAnswer not ok", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-process-fail-"));
    const { store, run } = await createWaitingRun(root);
    const envelope = okEnvelope();
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", envelope);

    const launch = vi.fn().mockResolvedValue({ type: "succeeded" });
    const mockLauncher = { launch } as unknown as StageProcessLauncher;
    vi.spyOn(pipelineScheduler, "resumeRun").mockResolvedValue({
      ok: false,
      outcome: "failed",
      runDir: run.workspaceDir,
      runId: run.runId,
      reason: "downstream stage failed",
    });

    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });

    const result = await manager.deliverAnswer(run.runId, "clarify", answer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("downstream stage failed");
  });

  it("resumeInProcess prepared keeps the operator catalog pair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-process-cat-"));
    const { store, run } = await createWaitingRun(root);
    const envelope = okEnvelope();
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", envelope);

    const launch = vi.fn().mockResolvedValue({ type: "succeeded" });
    const mockLauncher = { launch } as unknown as StageProcessLauncher;
    const resumeRunSpy = vi
      .spyOn(pipelineScheduler, "resumeRun")
      .mockResolvedValue({
        ok: true,
        outcome: "succeeded",
        runDir: run.workspaceDir,
        runId: run.runId,
      });

    const operatorCatalog = {
      cwd: fixtures,
      agentDir: "/tmp/operator-agent-catalog",
    };
    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
      operatorCatalog,
    });

    const result = await manager.deliverAnswer(run.runId, "clarify", answer);
    expect(result).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "resume",
        operatorCatalog,
      }),
    );
    expect(resumeRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        prepared: expect.objectContaining({
          operatorCatalog,
        }),
      }),
    );
  });

  it("resume after answer keeps declared secrets and the attempt home", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-resume-secrets-"));
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
        resetGlobalStageflowHomeForTests();
        try {
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
            askpass?: string;
            token?: string;
            attemptHome?: string;
          } = {};
          const launch = vi.fn().mockImplementation(async (input) => {
            const tokenFile = input.grants?.env?.STAGEFLOW_GIT_ASKPASS_TOKEN_FILE;
            captured.declared = input.grants?.declaredSecretNames;
            captured.askpass = input.grants?.env?.GIT_ASKPASS;
            captured.token =
              typeof tokenFile === "string"
                ? await readFile(tokenFile, "utf8")
                : undefined;
            captured.attemptHome = input.attemptHome;
            if (typeof input.attemptHome === "string") {
              await access(input.attemptHome);
            }
            return { type: "waiting" };
          });
          const mockLauncher = { launch } as unknown as StageProcessLauncher;
          const manager = new RunManager({
            agent: { openStage: vi.fn(), runStage: vi.fn() },
            store,
            cwd: root,
            executionMode: "process",
            stageProcessLauncher: mockLauncher,
          });

          const result = await manager.deliverAnswer(run.runId, "clarify", answer);
          expect(result).toEqual({ ok: true });
          expect(launch).toHaveBeenCalledTimes(1);
          expect(captured.declared).toEqual(["GITHUB_TOKEN"]);
          expect(captured.askpass).toEqual(expect.any(String));
          expect(captured.token).toBe(token);
          expect(captured.attemptHome).toBe(attemptHome);
        } finally {
          resetGlobalStageflowHomeForTests();
        }
      },
    );
    resetGlobalStageflowHomeForTests();
  });
});
