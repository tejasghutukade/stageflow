import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRESENT_UI_TOOL_NAME, resetCardLimiterForTests, toolPartsReplayText as guideMessageReplayText } from "../src/genui/index.js";
import { UI_PART_KIND_CARD, UI_PART_SCHEMA_VERSION } from "../src/artifacts/uiPart.js";
import { resetGuideSessionsForTests, streamGuideTurn } from "../src/guide/chat.js";
import { createGuideThread, readGuideThread } from "../src/guide/threadStore.js";
import { createWorkshopOperatorHost } from "../src/operatorAgent/fakeHost.js";
import { guideContextOf } from "../src/operatorAgent/profiles/guideConfirm.js";
import { createGuidePresentUiTool } from "../src/guide/presentUi.js";
import { createStageflowGuideProfile } from "../src/operatorAgent/profiles/stageflowGuide.js";

const program = 'root = Card([CardHeader("Regional sales", "This week"), TextContent("North leads.")])';
const manifest = { kind: "live.declarative", format: "openui-lang", library: { name: "stageflow", version: "1.0.0" }, bindings: [] };

describe("Guide present_ui", () => {
  let storeRoot: string;

  afterEach(async () => {
    resetGuideSessionsForTests();
    resetCardLimiterForTests();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  it("registers present_ui with the armed playbook and HTML guidance only when reachable", () => {
    const without = createStageflowGuideProfile({ cwd: process.cwd(), manager: {} as never, store: {} as never });
    expect(without.tools.some((tool) => tool.name === PRESENT_UI_TOOL_NAME)).toBe(true);
    expect(without.playbook).toContain("present_ui");
    expect(without.playbook).toContain("Plot only numbers a tool returned");
    expect(without.playbook).not.toContain("### HTML cards");

    const withSandbox = createStageflowGuideProfile(
      { cwd: process.cwd(), manager: {} as never, store: {} as never },
      { htmlCardsAvailable: true },
    );
    expect(withSandbox.playbook).toContain("### HTML cards");
    expect(withSandbox.resolvePlaybook?.()).toContain("live.html");
  });

  it("returns a declarative card and refuses bindings or oversize programs", async () => {
    const tool = createGuidePresentUiTool({ cwd: process.cwd(), manager: {} as never, store: {} as never, projectRoot: process.cwd() });
    const ctx = {
      getContext: () => guideContextOf({ kind: "stageflow_guide", turn: 1, confirmations: [], threadId: "t1", presentUiInTurn: 0 }),
      setContext: () => {},
      emitProposal: () => {},
    };
    const ok = await tool.handler({ program, manifest, title: "Regional sales" }, ctx);
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    if (!ok.ok) return;
    expect(ok.content).toMatchObject({
      type: "ui",
      ui: {
        kind: UI_PART_KIND_CARD,
        format: "live.declarative",
        title: "Regional sales",
        program,
      },
    });
    const badBinding = await tool.handler(
      { program, manifest: { ...manifest, bindings: [{ id: "x", function: "f", args: {} }] }, title: "Runs" },
      ctx,
    );
    expect(badBinding).toMatchObject({ ok: false, error: "ui.card_display_only" });
    const big = await tool.handler({ program: "x".repeat(70_000), manifest, title: "Runs" }, ctx);
    expect(big).toMatchObject({ ok: false, error: "artifact.too_large" });
  });

  it("refuses live.html when the Host has no reachable sandbox", async () => {
    const tool = createGuidePresentUiTool(
      { cwd: process.cwd(), manager: {} as never, store: {} as never, projectRoot: process.cwd() },
      { htmlCardsAvailable: false },
    );
    const ctx = {
      getContext: () => guideContextOf({ kind: "stageflow_guide", turn: 1, confirmations: [], threadId: "t1" }),
      setContext: () => {},
      emitProposal: () => {},
    };
    const result = await tool.handler(
      { program: "<p>1</p>", manifest: { kind: "live.html", format: "html" }, title: "Counts" },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, error: "ui.kind_not_granted" });
  });

  it("keeps present_ui results in the thread file", async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), "sf-guide-present-"));
    const host = createWorkshopOperatorHost([
      { type: "call_tool", name: PRESENT_UI_TOOL_NAME, args: { program, manifest, title: "Runs" }, message: "Here are the runs." },
    ]);
    host.registerProfile(createStageflowGuideProfile({ cwd: process.cwd(), manager: {} as never, store: {} as never, projectRoot: process.cwd() }));
    const thread = createGuideThread(storeRoot);
    const frames = [];
    for await (const frame of streamGuideTurn({ host, threadId: thread.id, text: "Chart my runs", storeRoot })) {
      frames.push(frame);
    }
    const done = frames.find((frame) => frame.type === "done");
    expect(done?.type === "done" && done.message.parts?.[0]).toMatchObject({
      type: "tool",
      name: PRESENT_UI_TOOL_NAME,
      status: "complete",
      result: { type: "ui", ui: { kind: UI_PART_KIND_CARD, format: "live.declarative" } },
    });
    const stored = readGuideThread(thread.id, storeRoot);
    const toolPart = stored?.messages[1]?.parts?.find((part) => part.type === "tool" && part.name === PRESENT_UI_TOOL_NAME);
    expect(toolPart?.result).toMatchObject({ type: "ui", ui: { program } });
  });

  it("includes card markers in replay text after restart", () => {
    const envelope = {
      type: "ui" as const,
      ui: {
        v: UI_PART_SCHEMA_VERSION,
        kind: UI_PART_KIND_CARD,
        title: "Regional sales",
        format: "live.declarative",
        program,
        library: { name: "stageflow", version: "1.0.0" },
        fallback: { text: "Runs", url: "" },
      },
    };
    const replay = guideMessageReplayText({
      text: "Here are the runs.",
      parts: [
        { type: "tool", id: "c1", name: PRESENT_UI_TOOL_NAME, status: "complete", result: envelope },
      ],
    });
    expect(replay).toContain("Here are the runs.");
    expect(replay).toContain("CardHeader");
    expect(replay).toContain('"type":"ui"');
  });
});