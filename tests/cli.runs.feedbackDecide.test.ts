import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { AgentPort, StageRunInput } from "../src/agent/port.js";
import { runRunsCommand } from "../src/cli/runsCommand.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const sendBack: StageEnvelope = {
  status: "success",
  summary: "send-back",
  artifacts: [],
  feedback_loop: { action: "send_back", target: "implement" },
};

type FakeAgentBehavior =
  | { type: "emit"; envelope: StageEnvelope }
  | { type: "never_emit" }
  | { type: "throw"; message: string };

function stageKeyedAgent(
  behaviorsByStage: Record<string, FakeAgentBehavior[]>,
): AgentPort {
  const stageIndex = new Map<string, number>();
  return {
    openStage(input: StageRunInput) {
      const stageId = input.stage.id;
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? { type: "never_emit" as const };
      return scriptedFakeAgent([behavior]).openStage(input);
    },
    async runStage(input) {
      const handle = this.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
}

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

function parkAgent(): AgentPort {
  return stageKeyedAgent({
    plan: [{ type: "emit", envelope: { status: "success", summary: "plan-ok", artifacts: [] } }],
    implement: [
      { type: "emit", envelope: { status: "success", summary: "implement-1", artifacts: [] } },
      { type: "emit", envelope: { status: "success", summary: "implement-2", artifacts: [] } },
    ],
    review: [
      { type: "emit", envelope: sendBack },
      { type: "emit", envelope: sendBack },
    ],
    submit: [{ type: "throw", message: "submit must not run while waiting" }],
  });
}

function continueAgent(): AgentPort {
  return stageKeyedAgent({
    plan: [{ type: "emit", envelope: { status: "success", summary: "plan-ok", artifacts: [] } }],
    implement: [
      { type: "emit", envelope: { status: "success", summary: "implement-1", artifacts: [] } },
      { type: "emit", envelope: { status: "success", summary: "implement-2", artifacts: [] } },
    ],
    review: [
      { type: "emit", envelope: sendBack },
      { type: "emit", envelope: sendBack },
    ],
    submit: [
      { type: "emit", envelope: { status: "success", summary: "submit-ok", artifacts: [] } },
    ],
  });
}

describe("runRunsCommand feedback-decide", () => {
  it("continue after host-down park returns { ok, effect, loopId }", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-fb-cont-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: parkAgent(),
      store,
      cwd: fixtures,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("feedback-loop-wait-human"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await started.done;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.active_feedback_loop?.state === "waiting_for_human";
    });
    const before = await store.readRun(started.runId);
    const loopId = before.active_feedback_loop!.loop_id;

    const cap = captureIo();
    const code = await runRunsCommand(
      [
        "feedback-decide",
        "--run",
        started.runId,
        "--stage",
        "review",
        "--decision",
        "continue",
        "--json",
      ],
      {
        cwd: fixtures,
        projectRoot: root,
        store,
        probeHost: async () => "down",
        createManager: (s) =>
          new RunManager({
            agent: continueAgent(),
            store: s,
            cwd: fixtures,
          }),
        io: cap.io,
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout.join("\n"))).toEqual({
      ok: true,
      effect: "continued",
      loopId,
    });
    const after = await store.readRun(started.runId);
    expect(after.status).toBe("succeeded");
    expect(after.feedback_loops[0]?.loop.state).toBe("continued");
  });

  it("abandon fails the run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-fb-aban-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: parkAgent(),
      store,
      cwd: fixtures,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("feedback-loop-wait-human"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await started.done;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.active_feedback_loop?.state === "waiting_for_human";
    });

    const cap = captureIo();
    const code = await runRunsCommand(
      [
        "feedback-decide",
        "--run",
        started.runId,
        "--stage",
        "review",
        "--decision",
        "abandon",
        "--reason",
        "operator abandoned",
        "--json",
      ],
      {
        cwd: fixtures,
        projectRoot: root,
        store,
        probeHost: async () => "down",
        io: cap.io,
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(cap.stdout.join("\n")) as {
      ok: boolean;
      effect: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.effect).toBe("abandoned");
    const after = await store.readRun(started.runId);
    expect(after.status).toBe("failed");
  });

  it("probeHost up exits 1 without mutating", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-fb-host-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: parkAgent(),
      store,
      cwd: fixtures,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("feedback-loop-wait-human"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await started.done;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.active_feedback_loop?.state === "waiting_for_human";
    });
    const before = await store.readRun(started.runId);

    let constructed = false;
    const cap = captureIo();
    const code = await runRunsCommand(
      [
        "feedback-decide",
        "--run",
        started.runId,
        "--stage",
        "review",
        "--decision",
        "continue",
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
    expect(after.active_feedback_loop?.state).toBe("waiting_for_human");
    expect(after.status).toBe(before.status);
  });

  it("missing --decision exits 1", async () => {
    const cap = captureIo();
    const code = await runRunsCommand(
      ["feedback-decide", "--run", "run-x", "--stage", "review"],
      {
        probeHost: async () => "down",
        io: cap.io,
      },
    );
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toMatch(/Missing --decision/);
  });
});
