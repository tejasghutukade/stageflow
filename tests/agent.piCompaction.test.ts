import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSettingsManager } from "../src/agent/piSettings.js";

const OVERFLOW = "prompt is too long: 500000 tokens > 100000 maximum";
const BULK = "lorem ipsum dolor sit amet ".repeat(5000);
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function runOverflow(settingsManager: SettingsManager) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-pi-compaction-"));
  tempDirs.push(root);
  const faux = createFauxCore({ models: [{ id: "tiny", contextWindow: 100000, maxTokens: 1000 }] });
  {
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    modelRuntime.registerProvider("faux-compaction", {
      api: faux.api,
      streamSimple: (model, context, options) => faux.streamSimple(model, context, options),
      baseUrl: "http://localhost:0",
      apiKey: "test",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100000, maxTokens: 1000, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    const model = modelRuntime.getModel("faux-compaction", "tiny");
    if (!model) throw new Error("faux model not registered");
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: path.join(root, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
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
    faux.setResponses([
      fauxAssistantMessage(BULK),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW }),
      fauxAssistantMessage("summary of the earlier conversation"),
      fauxAssistantMessage("recovered answer"),
    ]);
    await session.prompt(`first question ${BULK}`);
    await session.prompt("second question");
    const texts = session.messages
      .filter((m) => m.role === "assistant")
      .map((m) => ({ stop: (m as { stopReason: string }).stopReason }));
    const last = [...session.messages].reverse().find((m) => m.role === "assistant") as { stopReason: string };
    session.dispose();
    return { lastStop: last.stopReason, calls: faux.state.callCount, texts };
  }
}

describe("Pi auto-compaction on context overflow", () => {
  it("Stageflow settings always enable compaction", () => {
    expect(createPiSettingsManager().getCompactionEnabled()).toBe(true);
  });

  it("fails the turn when compaction is disabled (the old stage behaviour)", async () => {
    const out = await runOverflow(SettingsManager.inMemory({ compaction: { enabled: false } }));
    expect(out.lastStop).toBe("error");
    expect(out.calls).toBe(2);
  });

  it("compacts and retries once with the Stageflow settings", async () => {
    const out = await runOverflow(createPiSettingsManager());
    expect(out.lastStop).toBe("stop");
    expect(out.calls).toBe(4);
  });
});
