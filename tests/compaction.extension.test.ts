import { compact as piCompact } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiSettingsManager } from "../src/agent/piSettings.js";
import { createCompactionExtension } from "../src/compaction/extension.js";
import { COMPACTION_FOCUS, SECTIONS_MARKER } from "../src/compaction/summarize.js";
import { createWorkingStateExtension } from "../src/tools/workingState.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function fakePi() {
  const handlers = new Map<string, Handler>();
  return {
    api: { on: (name: string, h: Handler) => void handlers.set(name, h) } as never,
    fire: (name: string, event: unknown, ctx: unknown) => handlers.get(name)!(event, ctx),
    has: (name: string) => handlers.has(name),
  };
}

const logLines = Array.from({ length: 120 }, (_, i) => `2026-03-14T02:${String(i % 60).padStart(2, "0")}:00Z svc INFO routine ok id=${i}`);
logLines.splice(40, 0, "2026-03-14T05:52:03Z api INFO incident_summary id=INC-4471 failed_checkouts=48211 duration_min=201");

function preparation(previousSummary?: string) {
  return {
    firstKeptEntryId: "kept-1",
    messagesToSummarize: [
      { role: "user", content: [{ type: "text", text: "Review the outage" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "logs/a.log" } }] },
      { role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, content: [{ type: "text", text: logLines.join("\n") }] },
    ],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 123456,
    ...(previousSummary !== undefined ? { previousSummary } : {}),
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  };
}

function ctxFor(entries: unknown[] = []) {
  return {
    model: { provider: "p", id: "m" },
    thinkingLevel: "off",
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: { h: "1" } }) },
    sessionManager: { getEntries: () => entries },
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
  };
}

describe("compaction extension hook", () => {
  it("summarizes with the focus line and appends pinned facts and working state", async () => {
    const compact = vi.fn(async () => ({
      summary: "## Goal\nReview the outage",
      firstKeptEntryId: "kept-1",
      tokensBefore: 123456,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
      details: { readFiles: ["logs/a.log"], modifiedFiles: [] },
    }));
    const pi = fakePi();
    createCompactionExtension({ compact: compact as never })(pi.api);
    const entries = [
      { type: "custom", customType: "stageflow.working_state", data: { op: "set", key: "next", kind: "todo", value: "read shard 4", at: "2026-03-14T00:00:00Z" } },
    ];
    const out = (await pi.fire("session_before_compact", { preparation: preparation(), branchEntries: [], signal: new AbortController().signal }, ctxFor(entries))) as {
      compaction: { summary: string; details: Record<string, unknown>; usage: { cost: { total: number } }; firstKeptEntryId: string };
    };
    expect(compact.mock.calls[0]![4]).toBe(COMPACTION_FOCUS);
    expect(out.compaction.summary).toContain("## Goal");
    expect(out.compaction.summary).toContain(SECTIONS_MARKER);
    expect(out.compaction.summary).toContain("INC-4471");
    expect(out.compaction.summary).toContain("48211");
    expect(out.compaction.summary).toContain("read shard 4");
    expect(out.compaction.usage.cost.total).toBe(0.01);
    expect(out.compaction.firstKeptEntryId).toBe("kept-1");
    expect(out.compaction.details.readFiles).toEqual(["logs/a.log"]);
  });

  it("strips its own sections from the previous summary and carries pinned facts forward", async () => {
    const compact = vi.fn(async (prep: { previousSummary?: string }) => ({
      summary: `updated from: ${prep.previousSummary}`,
      firstKeptEntryId: "k",
      tokensBefore: 1,
      details: { readFiles: ["b"], modifiedFiles: [] },
    }));
    const pi = fakePi();
    createCompactionExtension({ compact: compact as never })(pi.api);
    const previousDetails = {
      readFiles: ["a"],
      modifiedFiles: ["m"],
      stageflowPinned: [{ kind: "id", value: "EARLY-1", context: "from the first compaction", source: { messageIndex: 0 } }],
    };
    const out = (await pi.fire(
      "session_before_compact",
      {
        preparation: preparation(`old core\n\n${SECTIONS_MARKER}\n## Pinned facts\n- EARLY-1`),
        branchEntries: [{ type: "compaction", details: previousDetails }],
        signal: new AbortController().signal,
      },
      ctxFor(),
    )) as { compaction: { summary: string; details: { readFiles: string[]; modifiedFiles: string[] } } };
    expect(compact.mock.calls[0]![0].previousSummary).toBe("old core");
    expect(out.compaction.summary).toContain("EARLY-1");
    expect(out.compaction.summary).toContain("INC-4471");
    expect(out.compaction.summary.match(/## Pinned facts/g)).toHaveLength(1);
    expect(out.compaction.details.readFiles.sort()).toEqual(["a", "b"]);
    expect(out.compaction.details.modifiedFiles).toEqual(["m"]);
  });

  it("falls back to Pi's default on a failure and rethrows an abort", async () => {
    const warn = vi.fn();
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const pi = fakePi();
    createCompactionExtension({ compact: failing as never, onWarn: warn })(pi.api);
    const event = { preparation: preparation(), branchEntries: [], signal: new AbortController().signal };
    expect(await pi.fire("session_before_compact", event, ctxFor())).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    const aborted = new AbortController();
    aborted.abort();
    await expect(pi.fire("session_before_compact", { ...event, signal: aborted.signal }, ctxFor())).rejects.toThrow("boom");
  });

  it("clears stale results in the summarizer input and in later requests when the policy asks", async () => {
    const compact = vi.fn(async (prep: { messagesToSummarize: Array<{ content: Array<{ text?: string }> }> }) => ({
      summary: "s",
      firstKeptEntryId: "k",
      tokensBefore: 1,
      details: {},
      seen: JSON.stringify(prep.messagesToSummarize),
    }));
    const pi = fakePi();
    const policy = { keepRecentTurns: 0, minBytes: 500 };
    createCompactionExtension({
      compact: compact as never,
      policy: { clearInSummary: policy, preemptive: { usageFraction: 0.5, policy: { keepRecentTurns: 1, minBytes: 500 } } },
    })(pi.api);
    const out = (await pi.fire("session_before_compact", { preparation: preparation(), branchEntries: [], signal: new AbortController().signal }, ctxFor())) as {
      compaction: { summary: string };
    };
    expect(JSON.stringify(compact.mock.calls[0]![0].messagesToSummarize)).toContain("Tool result cleared");
    expect(out.compaction.summary).toContain("INC-4471");
    expect(out.compaction.summary).toContain("Cleared tool results");

    const messages = [
      ...preparation().messagesToSummarize,
      { role: "assistant", content: [{ type: "text", text: "next" }] },
      { role: "assistant", content: [{ type: "text", text: "later" }] },
    ];
    const low = { ...ctxFor(), getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }) };
    expect(await pi.fire("context", { messages }, low)).toBeUndefined();
    const high = { ...ctxFor(), getContextUsage: () => ({ tokens: 800, contextWindow: 1000 }) };
    const cleared = (await pi.fire("context", { messages }, high)) as { messages: unknown[] };
    expect(JSON.stringify(cleared.messages)).toContain("Tool result cleared");
  });
});

describe("compaction extension in a real Pi session", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
  });

  it("runs inside a real Pi session: replaces the summary and keeps pinned facts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-compaction-ext-"));
    tempDirs.push(root);
    const faux = createFauxCore({ models: [{ id: "tiny", contextWindow: 100000, maxTokens: 1000 }] });
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    modelRuntime.registerProvider("faux-ext", {
      api: faux.api,
      streamSimple: (m, c, o) => faux.streamSimple(m, c, o),
      baseUrl: "http://localhost:0",
      apiKey: "test",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100000, maxTokens: 1000, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    const model = modelRuntime.getModel("faux-ext", "tiny")!;
    const warns: string[] = [];
    const settingsManager = createPiSettingsManager();
    const viaFaux: typeof piCompact = (prep, m, key, headers, instr, signal, thinking, _stream, env) =>
      piCompact(prep, m, key, headers, instr, signal, thinking, ((mm: never, c: never, o: never) => faux.streamSimple(mm, c, o)) as never, env);
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: path.join(root, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        { name: "sf-compaction", factory: createCompactionExtension({ compact: viaFaux, onWarn: (m) => warns.push(m) }) },
        { name: "sf-working-state", factory: createWorkingStateExtension() },
      ] as never,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: path.join(root, "agent"),
      modelRuntime,
      model,
      resourceLoader,
      sessionManager: SessionManager.inMemory(root),
      settingsManager,
    });
    const bulk = `incident_summary id=INC-4471 failed_checkouts=48211 duration_min=201\n${"lorem ipsum dolor sit amet ".repeat(5000)}`;
    let chatCalls = 0;
    faux.setResponses(
      Array.from({ length: 12 }, () => (context: { messages: Array<{ role: string; content: unknown }> }, _o: unknown, _s: unknown, m: { provider: string; id: string; api: string }) => {
        const stamp = <T extends object>(msg: T): T => Object.assign(msg, { provider: m.provider, model: m.id, api: m.api });
        const last = context.messages[context.messages.length - 1];
        const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
        if (text.includes("The messages above")) return stamp(fauxAssistantMessage("## Goal\nreview the outage"));
        chatCalls += 1;
        if (chatCalls === 1) return stamp(fauxAssistantMessage(bulk));
        if (chatCalls === 2) return stamp(fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 500000 tokens > 100000 maximum" }));
        return stamp(fauxAssistantMessage("recovered answer"));
      }) as never,
    );
    await session.prompt(`first question ${bulk}`);
    await session.prompt("second question");
    const compaction = session.sessionManager.getEntries().find((e) => e.type === "compaction") as { summary: string; fromHook?: boolean; usage?: unknown };
    expect(warns).toEqual([]);
    expect(compaction).toBeTruthy();
    expect(compaction.summary).toContain("## Goal");
    expect(compaction.summary).toContain(SECTIONS_MARKER);
    expect(compaction.summary).toContain("INC-4471");
    expect(compaction.summary).toContain("48211");
    session.dispose();
  });
});
