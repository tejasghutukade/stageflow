import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UI_PART_KIND_ARTIFACT_REF, UI_PART_SCHEMA_VERSION } from "../src/artifacts/uiPart.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { listArtifacts } from "../src/artifacts/query.js";
import { parseOwnerKey } from "../src/artifacts/keys.js";
import { deletePublishedArtifact } from "../src/artifacts/publish.js";
import { readArtifactContent } from "../src/artifacts/content.js";
import { createGuideSaveCardTool } from "../src/guide/saveCard.js";
import { createGuideThread, saveGuideThread, type GuideThreadRecord } from "../src/guide/threadStore.js";
import { createOperatorEvalGate } from "../src/operatorAgent/evalGate.js";
import { guideContextOf } from "../src/operatorAgent/profiles/guideConfirm.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { guideToolMayNeedConfirmation } from "../src/toolkit/modePolicy.js";

const program = "<p>North 4, South 1</p>";
const libraries = [{ name: "chartjs", version: "4.6.2" }];
const previousHome = process.env.STAGEFLOW_HOME;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openProject(): Promise<{ store: RunStore; home: string; project: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "sf-save-card-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-save-card-proj-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  const store = createRunStore({ rootDir: home });
  const registered = await store.ensureProject(project);
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  return { store, home, project: registered };
}

function cardThread(id: string, cardId: string): GuideThreadRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    id,
    title: "Runs",
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: "m1",
        role: "assistant",
        text: "Here is the chart.",
        createdAt: now,
        parts: [
          {
            type: "tool",
            id: cardId,
            name: "present_ui",
            status: "complete",
            result: {
              type: "ui",
              ui: {
                v: UI_PART_SCHEMA_VERSION,
                kind: "card",
                title: "Runs this week",
                format: "live.html",
                program,
                libraries,
                fallback: { text: "Runs this week", url: "" },
              },
            },
          },
        ],
      },
    ],
  };
}

function ctx(threadId: string) {
  return {
    getContext: () => guideContextOf({ kind: "stageflow_guide", turn: 2, confirmations: [], threadId }),
    setContext: () => {},
    emitProposal: () => {},
  };
}

describe("Guide save_card", () => {
  it("saves the stored program, kind, libraries and title, including after a fresh session", async () => {
    const { store, project } = await openProject();
    const thread = createGuideThread();
    saveGuideThread(cardThread(thread.id, "card-1"));
    const restarted = createGuideSaveCardTool({ cwd: project, manager: {} as never, store, projectRoot: project });
    const saved = await restarted.handler({ card_id: "card-1", title: "Kept chart" }, ctx(thread.id));
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    if (!saved.ok) return;
    expect(saved.content).toMatchObject({
      type: "ui",
      ui: {
        kind: UI_PART_KIND_ARTIFACT_REF,
        title: "Kept chart",
        version: 1,
        fallback: { text: "Open in Artifacts" },
      },
    });
    const ui = (saved.content as { ui: { key: string } }).ui;
    expect(ui.key.startsWith("guide/card_")).toBe(true);
    const again = await restarted.handler({ card_id: "card-1" }, ctx(thread.id));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    // Saving the same card again returns the artifact it already made, not a duplicate.
    const second = (again.content as { ui: { key: string; title: string } }).ui;
    expect(second.key).toBe(ui.key);
    expect(second.title).toBe("Kept chart");

    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const listed = listArtifacts(db, { projectRoot: project, limit: 20, owner: "guide" }, roots);
    expect(listed.artifacts.map((record) => record.owner)).toEqual([{ kind: "guide" }]);
    const kept = listed.artifacts.find((record) => record.title === "Kept chart");
    expect(kept).toMatchObject({ kind: "live.html", scope: "project", title: "Kept chart" });
    expect(kept?.live?.libraries).toEqual(libraries);
    const id = ui.key.slice("guide/".length);
    const body = await readArtifactContent(db, store, "guide", id, project, roots);
    expect(body.bytes.toString("utf8")).toBe(program);
  });

  it("handles guide-owned artifacts across keys, search and delete, and saves a deleted card again as one artifact", async () => {
    expect(parseOwnerKey("guide")).toEqual({ kind: "guide" });
    expect(parseOwnerKey("guide:x")).toBeUndefined();
    const { store, project } = await openProject();
    const thread = createGuideThread();
    saveGuideThread(cardThread(thread.id, "card-1"));
    const tool = createGuideSaveCardTool({ cwd: project, manager: {} as never, store, projectRoot: project });
    const first = await tool.handler({ card_id: "card-1" }, ctx(thread.id));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const key = (first.content as { ui: { key: string } }).ui.key;
    const id = key.slice("guide/".length);
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    expect(listArtifacts(db, { projectRoot: project, limit: 20, q: "guide" }, roots).artifacts.map((record) => record.id)).toContain(id);
    await deletePublishedArtifact(db, "guide", id, project, roots);
    expect(listArtifacts(db, { projectRoot: project, limit: 20, owner: "guide" }, roots).artifacts).toEqual([]);
    const again = await tool.handler({ card_id: "card-1" }, ctx(thread.id));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(listArtifacts(db, { projectRoot: project, limit: 20, owner: "guide" }, roots).artifacts).toHaveLength(1);
  });

  it("saves the latest card when no id is given, or the card with that title, as one artifact", async () => {
    const { store, project } = await openProject();
    const thread = createGuideThread();
    saveGuideThread(cardThread(thread.id, "card-1"));
    const tool = createGuideSaveCardTool({ cwd: project, manager: {} as never, store, projectRoot: project });
    const latest = await tool.handler({}, ctx(thread.id));
    const byTitle = await tool.handler({ card_id: "runs this week" }, ctx(thread.id));
    const byId = await tool.handler({ card_id: "card-1" }, ctx(thread.id));
    const keys = [latest, byTitle, byId].map((result) => (result.ok ? (result.content as { ui: { key: string } }).ui.key : "failed"));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]?.startsWith("guide/card_")).toBe(true);
    const empty = createGuideThread();
    saveGuideThread({ ...cardThread(empty.id, "x"), messages: [] });
    expect(await tool.handler({}, ctx(empty.id))).toMatchObject({ ok: false, error: "guide.card_not_found" });
  });

  it("refuses an unknown id and a card that belongs to another thread", async () => {
    const { store, project } = await openProject();
    const thread = createGuideThread();
    saveGuideThread(cardThread(thread.id, "card-1"));
    const other = createGuideThread();
    saveGuideThread(cardThread(other.id, "other-card"));
    const tool = createGuideSaveCardTool({ cwd: project, manager: {} as never, store, projectRoot: project });
    expect(await tool.handler({ card_id: "missing" }, ctx(thread.id))).toMatchObject({
      ok: false,
      error: "guide.card_not_found",
    });
    expect(await tool.handler({ card_id: "other-card" }, ctx(thread.id))).toMatchObject({
      ok: false,
      error: "guide.card_not_found",
    });
  });

  it("does not ask for confirmation and is stubbed in an eval", () => {
    expect(guideToolMayNeedConfirmation("save_card")).toBe(false);
    const gate = createOperatorEvalGate({ policy: { tools: "read_only", mocks: {} }, turn: () => 1 });
    expect(gate.decide("save_card", { card_id: "card-1" })).toMatchObject({ ok: false, error: "eval.tool_not_run" });
    expect(gate.decide("run_stats", { group_by: "day" })).toBeNull();
  });
});
