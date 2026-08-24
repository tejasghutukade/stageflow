import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AskOperatorWaitChannel,
  createConnectedAskWaitStageHandle,
  createStageSessionManager,
  PiAgentAdapter,
  repairPrematureAskOperatorClosure,
  StageSessionReconstructError,
} from "../src/agent/piAdapter.js";
import type { StageRunResult } from "../src/agent/port.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import {
  createAskOperatorTool,
  type AskOperatorPrompt,
} from "../src/tools/askOperator.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-pi-hitl-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

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

const freeTextPrompt2: AskOperatorPrompt = {
  kind: "free_text",
  id: "prompt-2",
  message: "Owner?",
};

const freeTextAnswer2 = {
  promptId: "prompt-2",
  kind: "free_text" as const,
  text: "tejas",
};

const successResult: StageRunResult = {
  ok: true,
  envelope: { status: "success", summary: "done", artifacts: [] },
};

describe("Pi HITL ask_operator wait channel ↔ StageHandle (U1)", () => {
  it("ask_operator → next yields waiting_for_input with T2 prompt; deliverAnswer resolves tool", async () => {
    const channel = new AskOperatorWaitChannel();
    const tool = createAskOperatorTool({
      requestWait: (prompt) => channel.requestWait(prompt),
    });
    const flushed: AskOperatorPrompt[] = [];

    const handle = createConnectedAskWaitStageHandle({
      stageId: "clarify",
      askWaitChannel: channel,
      onBeforeWaitYield: (prompt) => {
        flushed.push(prompt);
      },
      run: async () => {
        const exec = tool.execute("t1", {
          kind: "free_text",
          id: "prompt-1",
          message: "What should the module name be?",
        });
        const result = await exec;
        expect(result.isError).toBeUndefined();
        expect(result.details).toMatchObject({
          prompt: { id: "prompt-1" },
          answer: freeTextAnswer,
        });
        return successResult;
      },
    });

    const first = await handle.next();
    expect(first).toEqual({
      status: "waiting_for_input",
      request: freeTextPrompt,
    });
    expect(flushed).toEqual([freeTextPrompt]);
    expect(channel.hasPending).toBe(true);

    handle.deliverAnswer(freeTextAnswer);

    const second = await handle.next();
    expect(second.status).toBe("completed");
    if (second.status === "completed") {
      expect(second.result.ok).toBe(true);
    }
    await handle.close();
  });

  it("same-process multi-wait: two ask_operator turns then complete", async () => {
    const channel = new AskOperatorWaitChannel();
    const tool = createAskOperatorTool({
      requestWait: (prompt) => channel.requestWait(prompt),
    });

    const handle = createConnectedAskWaitStageHandle({
      stageId: "clarify",
      askWaitChannel: channel,
      run: async () => {
        const first = await tool.execute("t1", {
          kind: "free_text",
          id: "prompt-1",
          message: "What should the module name be?",
        });
        expect(first.details).toMatchObject({ answer: freeTextAnswer });

        const second = await tool.execute("t2", {
          kind: "free_text",
          id: "prompt-2",
          message: "Owner?",
        });
        expect(second.details).toMatchObject({ answer: freeTextAnswer2 });
        return successResult;
      },
    });

    expect(await handle.next()).toMatchObject({
      status: "waiting_for_input",
      request: { id: "prompt-1" },
    });
    handle.deliverAnswer(freeTextAnswer);

    expect(await handle.next()).toMatchObject({
      status: "waiting_for_input",
      request: { id: "prompt-2" },
    });
    handle.deliverAnswer(freeTextAnswer2);

    const done = await handle.next();
    expect(done.status).toBe("completed");
    await handle.close();
  });

  it("deliverAnswer with no pending wait is a safe no-op", async () => {
    const channel = new AskOperatorWaitChannel();
    const handle = createConnectedAskWaitStageHandle({
      stageId: "clarify",
      askWaitChannel: channel,
      run: async () => successResult,
    });

    handle.deliverAnswer(freeTextAnswer);
    expect(channel.hasPending).toBe(false);

    const done = await handle.next();
    expect(done.status).toBe("completed");
    await handle.close();
  });

  it("park close preserves pending wait for cross-process resume", async () => {
    const channel = new AskOperatorWaitChannel();
    const tool = createAskOperatorTool({
      requestWait: (prompt) => channel.requestWait(prompt),
    });

    const handle = createConnectedAskWaitStageHandle({
      stageId: "clarify",
      askWaitChannel: channel,
      run: async () => {
        await tool.execute("t1", {
          kind: "free_text",
          id: "prompt-1",
          message: "What should the module name be?",
        });
        return successResult;
      },
    });

    expect((await handle.next()).status).toBe("waiting_for_input");
    expect(channel.hasPending).toBe(true);

    await handle.close({ park: true });
    expect(channel.hasPending).toBe(true);
  });

  it("close rejects pending wait", async () => {
    const channel = new AskOperatorWaitChannel();
    const tool = createAskOperatorTool({
      requestWait: (prompt) => channel.requestWait(prompt),
    });
    let toolError: unknown;

    const handle = createConnectedAskWaitStageHandle({
      stageId: "clarify",
      askWaitChannel: channel,
      run: async () => {
        try {
          await tool.execute("t1", {
            kind: "free_text",
            id: "prompt-1",
            message: "What should the module name be?",
          });
        } catch (err) {
          toolError = err;
          throw err;
        }
        return successResult;
      },
    });

    expect((await handle.next()).status).toBe("waiting_for_input");
    expect(channel.hasPending).toBe(true);

    await handle.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(channel.hasPending).toBe(false);
    expect(String(toolError)).toMatch(/closed|reject/i);
  });

  it("reconstruct shape: open arms wait; deliverAnswer injects then continueRun (no re-park)", async () => {
    const channel = new AskOperatorWaitChannel();
    const injected: unknown[] = [];
    let continueCalls = 0;

    const handle = createConnectedAskWaitStageHandle({
      stageId: "clarify",
      askWaitChannel: channel,
      run: async () => {
        throw new Error("fresh run must not start on resume handle");
      },
      resume: {
        onDeliver: (answer) => {
          injected.push(answer);
        },
        continueRun: async () => {
          continueCalls += 1;
          return successResult;
        },
      },
    });

    handle.deliverAnswer(freeTextAnswer);
    expect(injected).toEqual([freeTextAnswer]);

    const first = await handle.next();
    expect(first.status).toBe("completed");
    if (first.status === "completed") {
      expect(first.result.ok).toBe(true);
    }
    expect(continueCalls).toBe(1);
    expect(channel.hasPending).toBe(false);
    await handle.close();
  });

  it("reconstruct: next before deliverAnswer parks until inject+continue", async () => {
    const channel = new AskOperatorWaitChannel();
    const injected: unknown[] = [];

    const handle = createConnectedAskWaitStageHandle({
      stageId: "clarify",
      askWaitChannel: channel,
      run: async () => successResult,
      resume: {
        onDeliver: (answer) => {
          injected.push(answer);
        },
        continueRun: async () => successResult,
      },
    });

    const nextPromise = handle.next();
    await new Promise((r) => setTimeout(r, 10));
    expect(injected).toEqual([]);

    handle.deliverAnswer(freeTextAnswer);
    expect(injected).toEqual([freeTextAnswer]);

    const done = await nextPromise;
    expect(done.status).toBe("completed");
    await handle.close();
  });

  it("openStage fails closed when session file exists without open tool call", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "clarify");
    const sm = await createStageSessionManager(roots, "clarify");
    sm.appendMessage({
      role: "user",
      content: "prior turn without open wait",
      timestamp: Date.now(),
    });

    const agent = new PiAgentAdapter();
    expect(() =>
      agent.openStage({
        roots,
        stage: {
          id: "clarify",
          system_prompt: "clarify",
          model: "anthropic/claude-sonnet-4-5",
        },
        task: { id: "t1", goal: "goal" },
        priorEnvelope: null,
      }),
    ).toThrow(StageSessionReconstructError);
  });

  it("repairPrematureAskOperatorClosure removes erroneous closed toolResult", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "clarify");
    const sessionFile = path.join(runWs, "stages", "clarify", "attempts", "1", "pi-session.jsonl");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "sess-1",
          timestamp: "2026-08-20T00:00:00.000Z",
          cwd: roots.cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tool-1",
                name: "ask_operator",
                arguments: { kind: "confirm", message: "Proceed?" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "result-1",
          message: {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "ask_operator",
            content: [{ type: "text", text: "stage handle closed" }],
            isError: true,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-2",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "This operation was aborted",
          },
        }),
      ].join("\n") + "\n",
    );

    const repaired = await repairPrematureAskOperatorClosure(sessionFile);
    expect(repaired).toBe(true);
    const raw = await readFile(sessionFile, "utf8");
    expect(raw).toContain('"toolCall"');
    expect(raw).not.toContain("stage handle closed");
    expect(raw).not.toContain("This operation was aborted");
  });
});
