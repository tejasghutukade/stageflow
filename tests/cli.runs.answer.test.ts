import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeHitlResumePath,
  scriptedFakeAgent,
} from "../src/agent/fakeAgent.js";
import { runRunsCommand } from "../src/cli/runsCommand.js";
import { operatorPromptEvent } from "../src/hitl/qaTrail.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { linearCompatDagSnapshot } from "../src/runstore/pipelineDagSnapshot.js";
import { RunManager } from "../src/runtime/runManager.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import type { AskOperatorPrompt } from "../src/tools/askOperator.js";
import {
  catalogLocators,
  SAMPLE_TASK,
  SINGLE_PIPELINE,
} from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const freeTextPrompt: AskOperatorPrompt = {
  kind: "free_text",
  id: "prompt-1",
  message: "What should the module name be?",
};

const freeTextAnswer = {
  promptId: "prompt-1",
  kind: "free_text" as const,
  text: "payments",
};

const confirmPrompt: AskOperatorPrompt = {
  kind: "confirm",
  id: "confirm-proceed",
  message: "Proceed?",
};

const confirmAnswer = {
  promptId: "confirm-proceed",
  kind: "confirm" as const,
  decision: "accept" as const,
};

const successEnvelope = {
  status: "success" as const,
  summary: "clarify-ok",
  artifacts: [] as string[],
};

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      log: (line: string) => {
        stdout.push(line);
      },
      error: (line: string) => {
        stderr.push(line);
      },
    },
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

describe("runRunsCommand answer", () => {
  it("parked free_text --answer resumes with { ok: true } exit 0", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-ans-ok-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: successEnvelope,
      },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: SINGLE_PIPELINE,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.stages.some((s) => s.status === "waiting_for_input");
    });

    const cap = captureIo();
    const code = await runRunsCommand(
      [
        "answer",
        "--run",
        started.runId,
        "--stage",
        "clarify",
        "--answer",
        JSON.stringify(freeTextAnswer),
        "--json",
      ],
      {
        cwd: fixtures,
        projectRoot: root,
        store,
        probeHost: async () => "down",
        createManager: (s) =>
          new RunManager({
            agent: scriptedFakeAgent([
              {
                type: "wait_then_emit",
                waitRequests: [freeTextPrompt],
                envelope: successEnvelope,
              },
            ]),
            store: s,
            cwd: fixtures,
          }),
        io: cap.io,
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout.join("\n"))).toEqual({ ok: true });
  });

  it("parked confirm --answer returns { ok: true } exit 0", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-ans-cf-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [confirmPrompt],
        envelope: successEnvelope,
      },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: SINGLE_PIPELINE,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.stages.some((s) => s.status === "waiting_for_input");
    });

    const cap = captureIo();
    const code = await runRunsCommand(
      [
        "answer",
        "--run",
        started.runId,
        "--stage",
        "clarify",
        "--answer",
        JSON.stringify(confirmAnswer),
        "--json",
      ],
      {
        cwd: fixtures,
        projectRoot: root,
        store,
        probeHost: async () => "down",
        createManager: (s) =>
          new RunManager({
            agent: scriptedFakeAgent([
              {
                type: "wait_then_emit",
                waitRequests: [confirmPrompt],
                envelope: successEnvelope,
              },
            ]),
            store: s,
            cwd: fixtures,
          }),
        io: cap.io,
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout.join("\n"))).toEqual({ ok: true });
  });

  it("reads stdin JSON when --answer omitted and stdinIsTTY is false", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-ans-stdin-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: successEnvelope,
      },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: SINGLE_PIPELINE,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.stages.some((s) => s.status === "waiting_for_input");
    });

    const cap = captureIo();
    const code = await runRunsCommand(
      ["answer", "--run", started.runId, "--stage", "clarify", "--json"],
      {
        cwd: fixtures,
        projectRoot: root,
        store,
        probeHost: async () => "down",
        stdinIsTTY: false,
        readStdin: () => JSON.stringify(freeTextAnswer),
        createManager: (s) =>
          new RunManager({
            agent: scriptedFakeAgent([
              {
                type: "wait_then_emit",
                waitRequests: [freeTextPrompt],
                envelope: successEnvelope,
              },
            ]),
            store: s,
            cwd: fixtures,
          }),
        io: cap.io,
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout.join("\n"))).toEqual({ ok: true });
  });

  it("--answer omitted + stdinIsTTY true exits 1 missing-answer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-ans-tty-"));
    const store = createRunStore({ rootDir: root });
    const cap = captureIo();
    const code = await runRunsCommand(
      ["answer", "--run", "run-x", "--stage", "clarify"],
      {
        projectRoot: root,
        store,
        probeHost: async () => "down",
        stdinIsTTY: true,
        io: cap.io,
      },
    );
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toMatch(/Missing --answer/);
  });

  it("probeHost up exits 1 and leaves the waiting row unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-ans-host-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: successEnvelope,
      },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: SINGLE_PIPELINE,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.stages.some((s) => s.status === "waiting_for_input");
    });
    const before = await store.readRun(started.runId);

    let constructed = false;
    const cap = captureIo();
    const code = await runRunsCommand(
      [
        "answer",
        "--run",
        started.runId,
        "--stage",
        "clarify",
        "--answer",
        JSON.stringify(freeTextAnswer),
        "--json",
      ],
      {
        cwd: fixtures,
        projectRoot: root,
        store,
        probeHost: async () => "up",
        createManager: () => {
          constructed = true;
          throw new Error("must not construct manager when host is up");
        },
        io: cap.io,
      },
    );
    expect(code).toBe(1);
    expect(constructed).toBe(false);
    expect(cap.stderr.join("\n")).toMatch(/http:\/\/127\.0\.0\.1:3847/);
    const after = await store.readRun(started.runId);
    expect(
      after.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");
    expect(after.status).toBe(before.status);
  });

  it("unknown promptId / kind mismatch returns 400-shaped payload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-ans-400-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const locators = catalogLocators("single");
    const created = await store.createRun({
      ...locators,
      taskYaml,
      taskId: "sample",
      pipelineDag: linearCompatDagSnapshot(["clarify"]),
    });
    await store.ensureStageWorkspace(created.runId, "clarify");
    await store.createStageExecution(created.runId, "clarify");
    await store.appendStageEvent(created.runId, "clarify", { event: "started" });
    await store.appendStageEvent(
      created.runId,
      "clarify",
      operatorPromptEvent(freeTextPrompt),
    );
    const resumePath = fakeHitlResumePath(
      buildStageRoots(created.workspaceDir, "clarify"),
      "clarify",
    );
    await writeFile(
      resumePath,
      `${JSON.stringify({
        waitRequests: [freeTextPrompt],
        envelope: successEnvelope,
        waitIndex: 1,
      })}\n`,
      "utf8",
    );
    await store.appendStageEvent(created.runId, "clarify", {
      event: "waiting_for_input",
    });
    await store.updateRunStatus(created.runId, "running");

    const capUnknown = captureIo();
    const unknownCode = await runRunsCommand(
      [
        "answer",
        "--run",
        created.runId,
        "--stage",
        "clarify",
        "--answer",
        JSON.stringify({
          promptId: "no-such-prompt",
          kind: "free_text",
          text: "x",
        }),
        "--json",
      ],
      {
        cwd: fixtures,
        projectRoot: root,
        store,
        probeHost: async () => "down",
        io: capUnknown.io,
      },
    );
    expect(unknownCode).toBe(1);
    const unknownPayload = JSON.parse(capUnknown.stdout.join("\n")) as {
      error: string;
      status: number;
    };
    expect(unknownPayload.status).toBe(400);
    expect(unknownPayload.error).toMatch(/prompt/i);

    const capKind = captureIo();
    const kindCode = await runRunsCommand(
      [
        "answer",
        "--run",
        created.runId,
        "--stage",
        "clarify",
        "--answer",
        JSON.stringify({
          promptId: "prompt-1",
          kind: "confirm",
          decision: "accept",
        }),
        "--json",
      ],
      {
        cwd: fixtures,
        projectRoot: root,
        store,
        probeHost: async () => "down",
        io: capKind.io,
      },
    );
    expect(kindCode).toBe(1);
    const kindPayload = JSON.parse(capKind.stdout.join("\n")) as {
      error: string;
      status: number;
    };
    expect(kindPayload.status).toBe(400);
    expect(kindPayload.error).toMatch(/kind/i);
  });

  it("missing --stage exits 1 with human error", async () => {
    const cap = captureIo();
    const code = await runRunsCommand(
      [
        "answer",
        "--run",
        "run-x",
        "--answer",
        JSON.stringify(freeTextAnswer),
      ],
      {
        probeHost: async () => "down",
        io: cap.io,
      },
    );
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toMatch(/Missing --stage/);
    expect(cap.stdout.join("\n")).toBe("");
  });
});
