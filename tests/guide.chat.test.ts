import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  abortGuideTurn,
  isGuideThreadRunning,
  resetGuideSessionsForTests,
  streamGuideTurn,
} from "../src/guide/chat.js";
import {
  createGuideThread,
  listGuideThreads,
  parseGuideThread,
  readGuideThread,
  setGuideThreadModel,
} from "../src/guide/threadStore.js";
import { createWorkshopOperatorHost } from "../src/operatorAgent/fakeHost.js";
import { createOperatorAgentHost, type OperatorAgentModel } from "../src/operatorAgent/host.js";
import { createStageflowGuideProfile, STAGEFLOW_GUIDE_PROFILE_ID, STAGEFLOW_GUIDE_TOOL_NAMES } from "../src/operatorAgent/profiles/stageflowGuide.js";

describe("stageflow guide", () => {
  let storeRoot: string;

  afterEach(async () => {
    resetGuideSessionsForTests();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  it("mounts every non-decision catalog tool when the host has services", () => {
    const profile = createStageflowGuideProfile({
      cwd: process.cwd(),
      manager: {} as never,
      store: {} as never,
    });
    expect(profile.tools.map((tool) => tool.name).sort()).toEqual([...STAGEFLOW_GUIDE_TOOL_NAMES].sort());
    expect(profile.playbook).toContain("You can read and change this project");
    expect(profile.playbook).not.toContain("You have no tools");
    expect(profile.playbook).toContain("Stay inside Stageflow");
    expect(profile.playbook).toContain("Call a tool only for its answer");
    expect(profile.playbook).toContain("One question mark in the whole reply, and only one thing asked");
    expect(profile.playbook).toContain("the first and only tool is show_ui component \"plan\"");
    expect(profile.playbook).toContain("the first and only tool is confirm_action");
    expect(profile.playbook).toContain("confirm_action is still the reply");
    expect(profile.playbook).toContain("was not executed");
    expect(profile.playbook).toContain("Do not put a tool name or an error code");
    expect(profile.playbook).toContain("The Memories page cannot add a card");
    expect(profile.playbook).toContain("You cannot agree to your own card");
    expect(profile.playbook).toContain("Do not read or list first");
    expect(profile.playbook).toContain("only replace one that already exists");
    expect(profile.playbook).toContain("Do not round");
    expect(profile.playbook).toContain("Two asks joined by \"and\" still count as two");
    expect(profile.playbook).toContain("The plan card is the approval");
    expect(profile.playbook).toContain("a few seconds");
    expect(profile.playbook).toContain("pipelines/<id>/<id>.pipeline.yaml");
    const createPipeline = profile.tools.find((tool) => tool.name === "create_pipeline");
    expect(createPipeline?.description).toContain("pipelines/<id>/");
    expect(profile.playbook).toContain("Do not create stand-in documents");
    expect(profile.playbook).not.toContain("Read what already exists in the project before you suggest anything new");
    expect(profile.tools.some((tool) => tool.name === "answer_gate")).toBe(false);
  });

  it("talks without changing anything until the host gives it tools", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-"));
    const host = createWorkshopOperatorHost([{ type: "echo" }]);
    const profile = host.getProfile(STAGEFLOW_GUIDE_PROFILE_ID);
    expect(profile?.tools).toEqual([]);
    expect(STAGEFLOW_GUIDE_TOOL_NAMES).toContain("create_pipeline");
    expect(STAGEFLOW_GUIDE_TOOL_NAMES).not.toContain("answer_gate");

    const thread = createGuideThread(storeRoot);
    const frames = [];
    for await (const frame of streamGuideTurn({
      host,
      threadId: thread.id,
      text: "I file the same report every Friday",
      storeRoot,
    })) {
      frames.push(frame);
    }

    const done = frames.find((frame) => frame.type === "done");
    expect(done).toMatchObject({ type: "done", message: { role: "assistant", text: "Got it: I file the same report every Friday" } });
    const stored = readGuideThread(thread.id, storeRoot);
    expect(stored?.title).toBe("I file the same report every Friday");
    expect(stored?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(listGuideThreads(storeRoot).map((item) => item.id)).toEqual([thread.id]);
  });

  it("includes an attached file in the prompt", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-"));
    const host = createWorkshopOperatorHost([{ type: "echo" }]);
    const thread = createGuideThread(storeRoot);
    const frames = [];
    for await (const frame of streamGuideTurn({
      host,
      threadId: thread.id,
      text: "Read this",
      attachments: [{ name: "notes.md", mediaType: "text/markdown", content: "stages then a pipeline" }],
      model: "openrouter/test-model",
      storeRoot,
    })) {
      frames.push(frame);
    }
    const done = frames.find((frame) => frame.type === "done");
    expect(done && done.type === "done" ? done.message.text : "").toContain("stages then a pipeline");
    expect(readGuideThread(thread.id, storeRoot)?.messages[0]?.attachments).toEqual([
      { name: "notes.md", mediaType: "text/markdown", size: Buffer.byteLength("stages then a pipeline") },
    ]);
  });

  it("streams tool frames and stores ordered parts", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-"));
    const host = createWorkshopOperatorHost([{ type: "call_tool", name: "list_pipelines", args: { project_root: "demo" }, message: "You have one pipeline." }]);
    host.registerProfile({
      ...createStageflowGuideProfile(),
      tools: [{ name: "list_pipelines", description: "", handler: () => ({ ok: true, content: { pipelines: ["release"] } }) }],
    });
    const thread = createGuideThread(storeRoot);
    const frames = [];
    for await (const frame of streamGuideTurn({ host, threadId: thread.id, text: "What do I have?", storeRoot })) {
      frames.push(frame);
    }
    expect(frames.map((frame) => frame.type)).toEqual(["tool", "tool", "delta", "done"]);
    expect(frames[0]).toEqual({ type: "tool", id: expect.any(String), name: "list_pipelines", status: "running", args: { project_root: "demo" } });
    expect(frames[1]).toEqual({ type: "tool", id: (frames[0] as { id: string }).id, name: "list_pipelines", status: "complete", result: { pipelines: ["release"] } });
    const parts = [
      { type: "tool", id: (frames[0] as { id: string }).id, name: "list_pipelines", status: "complete", args: { project_root: "demo" }, result: { pipelines: ["release"] } },
      { type: "text", text: "You have one pipeline." },
    ];
    expect(frames[3]).toMatchObject({ type: "done", message: { role: "assistant", text: "You have one pipeline.", parts } });
    const stored = readGuideThread(thread.id, storeRoot);
    expect(stored?.messages[1]).toMatchObject({ role: "assistant", text: "You have one pipeline.", parts });
    expect(stored?.messages[0]?.parts).toBeUndefined();
  });

  it("reports a failed tool with a short error and never streams a secret", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-"));
    const secret = "test-bot-token-not-a-real-credential";
    const host = createWorkshopOperatorHost([
      { type: "call_tool", name: "create_connection", args: { provider: "slack", secrets: { botToken: secret } }, message: "That did not work." },
    ]);
    host.registerProfile({
      ...createStageflowGuideProfile(),
      tools: [{ name: "create_connection", description: "", handler: () => ({ ok: false, content: { error: "CHANNEL_INVALID_INPUT" }, error: "CHANNEL_INVALID_INPUT" }) }],
    });
    const thread = createGuideThread(storeRoot);
    const frames = [];
    for await (const frame of streamGuideTurn({ host, threadId: thread.id, text: "Connect Slack", storeRoot })) {
      frames.push(frame);
    }
    expect(frames[0]).toMatchObject({ type: "tool", status: "running", args: { provider: "slack", secrets: "[redacted]" } });
    expect(frames[1]).toMatchObject({ type: "tool", status: "error", error: "CHANNEL_INVALID_INPUT" });
    expect(frames[1]).not.toHaveProperty("result");
    expect(JSON.stringify(frames)).not.toContain(secret);
    const stored = readGuideThread(thread.id, storeRoot);
    expect(stored?.messages[1]?.parts?.[0]).toMatchObject({ type: "tool", status: "error", error: "CHANNEL_INVALID_INPUT" });
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it("keeps text between tool calls in order, keeps show_ui results, and truncates large ones", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-"));
    const bigUi = { ui: { component: "plan", title: "Plan", steps: [{ title: "x".repeat(25_000), status: "todo" }] } };
    const bigList = { items: "y".repeat(25_000) };
    const model: OperatorAgentModel = {
      async complete({ onDelta, onActivity }) {
        onDelta?.("Let me look. ");
        onActivity?.({ id: "c1", name: "show_ui", status: "running", args: { component: "plan" } });
        onActivity?.({ id: "c1", name: "show_ui", status: "complete", result: bigUi });
        onActivity?.({ id: "c2", name: "list_runs", status: "running", args: {} });
        onActivity?.({ id: "c2", name: "list_runs", status: "complete", result: bigList });
        onDelta?.("Done.");
        return { events: [{ type: "message", role: "assistant", text: "Let me look. Done." }] };
      },
    };
    const host = createOperatorAgentHost(model, [createStageflowGuideProfile()]);
    const thread = createGuideThread(storeRoot);
    const frames = [];
    for await (const frame of streamGuideTurn({ host, threadId: thread.id, text: "Plan it", storeRoot })) {
      frames.push(frame);
    }
    expect(frames.map((frame) => (frame.type === "tool" ? `tool:${frame.status}` : frame.type))).toEqual([
      "delta",
      "tool:running",
      "tool:complete",
      "tool:running",
      "tool:complete",
      "delta",
      "done",
    ]);
    const expected = [
      { type: "text", text: "Let me look. " },
      { type: "tool", id: "c1", name: "show_ui", status: "complete", args: { component: "plan" }, result: bigUi },
      { type: "tool", id: "c2", name: "list_runs", status: "complete", args: {}, result: { truncated: true } },
      { type: "text", text: "Done." },
    ];
    const done = frames.at(-1);
    expect(done).toMatchObject({ type: "done", message: { text: "Let me look. Done.", parts: expected } });
    expect(readGuideThread(thread.id, storeRoot)?.messages[1]?.parts).toEqual(expected);
  });

  it("stores a reply that is only a card", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-"));
    const ui = { ui: { component: "links", links: [{ kind: "pipeline", id: "release" }] } };
    const model: OperatorAgentModel = {
      async complete({ onActivity }) {
        onActivity?.({ id: "c1", name: "show_ui", status: "running", args: { component: "links" } });
        onActivity?.({ id: "c1", name: "show_ui", status: "complete", result: ui });
        return { events: [] };
      },
    };
    const host = createOperatorAgentHost(model, [createStageflowGuideProfile()]);
    const thread = createGuideThread(storeRoot);
    const frames = [];
    for await (const frame of streamGuideTurn({ host, threadId: thread.id, text: "Links", storeRoot })) {
      frames.push(frame);
    }
    expect(frames.at(-1)).toMatchObject({
      type: "done",
      message: { text: "", parts: [{ type: "tool", id: "c1", name: "show_ui", status: "complete", result: ui }] },
    });
  });

  it("refuses an empty message and an unknown conversation", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-"));
    const host = createWorkshopOperatorHost([{ type: "echo" }]);
    const thread = createGuideThread(storeRoot);
    await expect(streamGuideTurn({ host, threadId: thread.id, text: "   ", storeRoot }).next()).rejects.toThrow("guide.invalid");
    await expect(streamGuideTurn({ host, threadId: "missing", text: "hello", storeRoot }).next()).rejects.toThrow("guide.not_found");
  });

  it("persists the turn model on the thread and reuses it on later turns", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-"));
    const used: string[] = [];
    const model: OperatorAgentModel = {
      async complete({ modelId }) {
        if (modelId) used.push(modelId);
        return { events: [{ type: "message", role: "assistant", text: "ok" }] };
      },
    };
    const host = createOperatorAgentHost(model, [createStageflowGuideProfile()]);
    const thread = createGuideThread(storeRoot);

    for await (const frame of streamGuideTurn({
      host,
      threadId: thread.id,
      text: "first",
      model: "openrouter/foo",
      storeRoot,
    })) {
      expect(frame.type).toBeTruthy();
    }
    expect(readGuideThread(thread.id, storeRoot)?.model).toBe("openrouter/foo");
    expect(used).toEqual(["openrouter/foo"]);

    for await (const frame of streamGuideTurn({
      host,
      threadId: thread.id,
      text: "second",
      storeRoot,
    })) {
      expect(frame.type).toBeTruthy();
    }
    expect(readGuideThread(thread.id, storeRoot)?.model).toBe("openrouter/foo");
    expect(used).toEqual(["openrouter/foo", "openrouter/foo"]);
  });

  it("round-trips model through parseGuideThread and setGuideThreadModel", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-"));
    const thread = createGuideThread(storeRoot);
    expect(parseGuideThread({ ...thread, model: "  openrouter/bar  " })?.model).toBe("openrouter/bar");
    expect(parseGuideThread({ ...thread, model: "   " })?.model).toBeUndefined();
    expect(setGuideThreadModel(thread.id, "openrouter/baz", storeRoot)?.model).toBe("openrouter/baz");
    expect(readGuideThread(thread.id, storeRoot)?.model).toBe("openrouter/baz");
    expect(setGuideThreadModel(thread.id, null, storeRoot)?.model).toBeUndefined();
    expect(readGuideThread(thread.id, storeRoot)?.model).toBeUndefined();
    expect(setGuideThreadModel("missing", "openrouter/x", storeRoot)).toBeNull();
  });

  it("abortGuideTurn stops an in-flight turn and persists the partial reply", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-"));
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let markEntered!: () => void;
    const enteredSend = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let aborted = false;
    const model: OperatorAgentModel = {
      async complete({ onDelta, onActivity }) {
        onDelta?.("partial");
        onActivity?.({ id: "t1", name: "list_pipelines", status: "running", args: {} });
        markEntered();
        await sendGate;
        return { events: [{ type: "message", role: "assistant", text: "partial" }] };
      },
      async abort() {
        aborted = true;
        releaseSend();
      },
    };
    const host = createOperatorAgentHost(model, [createStageflowGuideProfile()]);
    const thread = createGuideThread(storeRoot);
    expect(abortGuideTurn(thread.id)).toBe(false);
    expect(isGuideThreadRunning(thread.id)).toBe(false);

    const pending = (async () => {
      const frames = [];
      for await (const frame of streamGuideTurn({
        host,
        threadId: thread.id,
        text: "go",
        storeRoot,
      })) {
        frames.push(frame);
      }
      return frames;
    })();

    await enteredSend;
    expect(isGuideThreadRunning(thread.id)).toBe(true);
    expect(
      listGuideThreads(storeRoot).map((item) => ({
        id: item.id,
        status: isGuideThreadRunning(item.id) ? "running" : "open",
      })),
    ).toEqual([{ id: thread.id, status: "running" }]);
    expect(abortGuideTurn(thread.id)).toBe(true);

    const frames = await pending;
    expect(aborted).toBe(true);
    expect(frames.some((frame) => frame.type === "done")).toBe(false);
    expect(isGuideThreadRunning(thread.id)).toBe(false);
    expect(abortGuideTurn(thread.id)).toBe(false);
    expect(
      listGuideThreads(storeRoot).map((item) => ({
        id: item.id,
        status: isGuideThreadRunning(item.id) ? "running" : "open",
      })),
    ).toEqual([{ id: thread.id, status: "open" }]);

    const stored = readGuideThread(thread.id, storeRoot);
    expect(stored?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(stored?.messages[1]).toMatchObject({
      role: "assistant",
      text: "partial",
      parts: [
        { type: "text", text: "partial" },
        { type: "tool", id: "t1", name: "list_pipelines", status: "error", error: "guide.tool_interrupted", args: {} },
      ],
    });
  });

  it("honors an optional AbortSignal and still persists the partial reply", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-"));
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let markEntered!: () => void;
    const enteredSend = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const model: OperatorAgentModel = {
      async complete({ onDelta }) {
        onDelta?.("half");
        markEntered();
        await sendGate;
        return { events: [{ type: "message", role: "assistant", text: "half" }] };
      },
      async abort() {
        releaseSend();
      },
    };
    const host = createOperatorAgentHost(model, [createStageflowGuideProfile()]);
    const thread = createGuideThread(storeRoot);
    const abort = new AbortController();
    const pending = (async () => {
      for await (const _frame of streamGuideTurn({
        host,
        threadId: thread.id,
        text: "go",
        storeRoot,
        signal: abort.signal,
      })) {
        /* drain */
      }
    })();
    await enteredSend;
    abort.abort();
    await pending;
    expect(readGuideThread(thread.id, storeRoot)?.messages[1]).toMatchObject({
      role: "assistant",
      text: "half",
    });
    expect(isGuideThreadRunning(thread.id)).toBe(false);
  });

  it("finishes and persists when the consumer keeps draining without abort", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-"));
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let markEntered!: () => void;
    const enteredSend = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const model: OperatorAgentModel = {
      async complete({ onDelta }) {
        onDelta?.("still going");
        markEntered();
        await sendGate;
        return { events: [{ type: "message", role: "assistant", text: "still going" }] };
      },
    };
    const host = createOperatorAgentHost(model, [createStageflowGuideProfile()]);
    const thread = createGuideThread(storeRoot);
    const pending = (async () => {
      const frames = [];
      for await (const frame of streamGuideTurn({
        host,
        threadId: thread.id,
        text: "keep going",
        storeRoot,
      })) {
        frames.push(frame);
      }
      return frames;
    })();
    await enteredSend;
    expect(isGuideThreadRunning(thread.id)).toBe(true);
    expect(abortGuideTurn("missing")).toBe(false);
    releaseSend();
    const frames = await pending;
    expect(frames.at(-1)).toMatchObject({ type: "done", message: { text: "still going" } });
    expect(readGuideThread(thread.id, storeRoot)?.messages[1]?.text).toBe("still going");
  });
});
