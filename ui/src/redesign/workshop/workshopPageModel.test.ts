import { describe, expect, it } from "vitest";
import type { DraftPackagePayload } from "../../api";
import { addStage } from "./stageMutators";
import {
  AUTOSAVE_DEBOUNCE_MS,
  CREATE_TASK_PREFILL,
  WORKSHOP_CHAT_DEFAULT_WIDTH,
  askAgentToFixPrompt,
  attachmentChipsFromAutosave,
  autosaveArtifactsForAttachments,
  catalogRoots,
  clampWorkshopChatWidth,
  escapeWorkshopAction,
  initialDrawerTab,
  latestPendingMutationId,
  mutationCardOnRegister,
  openDraftInput,
  pipelineFilenameFor,
  planDraftInput,
  projectRootField,
  saveAsIntent,
  saveIntent,
  savedFileCount,
  seedTranscriptFromAutosave,
  workshopBootTarget,
  workshopChangeCount,
  workshopSaveState,
} from "./workshopPageModel";

function emptyDraft(): DraftPackagePayload {
  return { pipeline: { id: "untitled", stages: [] } };
}

describe("workshop page model", () => {
  it("debounces autosave at 2s and defaults the chat column to 384", () => {
    expect(AUTOSAVE_DEBOUNCE_MS).toBe(2000);
    expect(WORKSHOP_CHAT_DEFAULT_WIDTH).toBe(384);
    expect(clampWorkshopChatWidth(200)).toBe(300);
    expect(clampWorkshopChatWidth(900)).toBe(560);
    expect(clampWorkshopChatWidth(420)).toBe(420);
  });

  it("counts stages that are not unchanged against the baseline", () => {
    const draft = emptyDraft();
    expect(workshopChangeCount(draft, null)).toBe(0);
    const first = addStage(draft);
    expect(workshopChangeCount(first.draft, null)).toBe(1);
    expect(workshopChangeCount(first.draft, first.draft)).toBe(0);
    const second = addStage(first.draft);
    expect(workshopChangeCount(second.draft, first.draft)).toBe(1);
  });

  it("derives save state from the saved path and change count", () => {
    expect(workshopSaveState(null, 3)).toBe("new");
    expect(workshopSaveState(undefined, 0)).toBe("new");
    expect(workshopSaveState("pipelines/demo.yaml", 0)).toBe("clean");
    expect(workshopSaveState("pipelines/demo.yaml", 2)).toBe("dirty");
  });

  it("opens a package only when the workshop route has a pipeline", () => {
    expect(workshopBootTarget(undefined)).toBe("session");
    expect(workshopBootTarget("")).toBe("session");
    expect(workshopBootTarget("pipelines/demo.pipeline.yaml")).toBe("package");
  });

  it("omits project_root and task when the route does not have them", () => {
    expect(projectRootField(undefined)).toEqual({});
    expect(openDraftInput({ path: "pipelines/demo.yaml" })).toEqual({
      path: "pipelines/demo.yaml",
    });
    expect(
      openDraftInput({
        path: "pipelines/demo.yaml",
        task: "pipelines/demo.task.yaml",
        projectRoot: "examples",
      }),
    ).toEqual({
      path: "pipelines/demo.yaml",
      task: "pipelines/demo.task.yaml",
      project_root: "examples",
    });
  });

  it("builds catalog roots from unique project_root values", () => {
    expect(
      catalogRoots([
        { project_root: "examples" },
        { project_root: " examples " },
        { project_root: "/abs/other" },
        {},
      ]),
    ).toEqual([
      { value: "examples", label: "examples" },
      { value: "/abs/other", label: "/abs/other" },
    ]);
    expect(catalogRoots([{}, { project_root: "  " }])).toEqual([
      { value: ".", label: "." },
    ]);
  });

  it("chooses direct overwrite only when a destination exists and there are no errors", () => {
    expect(saveIntent({ hasDestination: true, errorCount: 0 })).toEqual({
      kind: "overwrite-direct",
    });
    expect(saveIntent({ hasDestination: true, errorCount: 2 })).toEqual({
      kind: "dialog",
      mode: "overwrite",
      allowInvalidInitial: false,
    });
    expect(saveIntent({ hasDestination: false, errorCount: 0 })).toEqual({
      kind: "dialog",
      mode: "create",
      allowInvalidInitial: false,
    });
    expect(
      saveIntent({ hasDestination: true, errorCount: 2, invalid: true }),
    ).toEqual({
      kind: "dialog",
      mode: "overwrite",
      allowInvalidInitial: true,
    });
    expect(saveIntent({ hasDestination: false, errorCount: 1, invalid: true })).toEqual({
      kind: "dialog",
      mode: "create",
      allowInvalidInitial: true,
    });
    expect(saveAsIntent()).toEqual({
      kind: "dialog",
      mode: "create",
      allowInvalidInitial: false,
    });
  });

  it("plans a save against the dialog root and keeps an existing filename", () => {
    const draft = emptyDraft();
    expect(
      planDraftInput({
        destination: { root: "pipelines", pipelineId: "demo" },
        draft,
        mode: "create",
      }),
    ).toEqual({
      directory: "pipelines",
      draft: { ...draft, pipeline: { ...draft.pipeline, id: "demo" } },
      pipelineFilename: "demo.yaml",
      mode: "create",
    });
    expect(
      planDraftInput({
        destination: { root: "examples", pipelineId: "demo" },
        draft: { ...draft, pipeline: { ...draft.pipeline, id: "demo" } },
        mode: "overwrite",
        projectRoot: "examples",
        filename: "demo.pipeline.yaml",
      }),
    ).toMatchObject({
      directory: "examples",
      pipelineFilename: "demo.pipeline.yaml",
      mode: "overwrite",
      project_root: "examples",
    });
    expect(pipelineFilenameFor("other", { id: "demo", filename: "demo.pipeline.yaml" })).toBe(
      "other.yaml",
    );
  });

  it("counts written files including the pipeline and an optional task", () => {
    expect(savedFileCount({ stagePaths: ["a.yaml", "b.yaml"] })).toBe(3);
    expect(savedFileCount({ stagePaths: ["a.yaml"], taskPath: "t.yaml" })).toBe(3);
  });

  it("marks auto-apply cards and keeps the latest pending id", () => {
    expect(mutationCardOnRegister(true, 10)).toEqual({
      status: "pending",
      auto: true,
      at: 10,
    });
    expect(mutationCardOnRegister(false, 10)).toEqual({ status: "pending", at: 10 });
    const cards = new Map<string, { status: string; at?: number }>([
      ["old", { status: "pending", at: 1 }],
      ["done", { status: "accepted", at: 9 }],
      ["new", { status: "pending", at: 4 }],
    ]);
    expect(latestPendingMutationId(cards)).toBe("new");
    expect(latestPendingMutationId(new Map())).toBeNull();
  });

  it("round-trips attachment chip metadata through autosave artifacts", () => {
    const chips = [{ name: "notes.md", size: 12, mediaType: "text/markdown" }];
    const artifacts = autosaveArtifactsForAttachments(chips);
    expect(attachmentChipsFromAutosave({ artifacts })).toEqual(chips);
    expect(
      attachmentChipsFromAutosave({
        attachments: [{ name: "direct.txt", size: 1, mediaType: "text/plain" }],
        artifacts,
      }),
    ).toEqual([{ name: "direct.txt", size: 1, mediaType: "text/plain" }]);
    expect(attachmentChipsFromAutosave({})).toEqual([]);
    expect(
      seedTranscriptFromAutosave([
        { role: "user", text: "hello", artifacts, createdAt: "2026-10-06T00:00:00.000Z" },
      ]),
    ).toEqual([
      {
        role: "user",
        text: "hello",
        createdAt: "2026-10-06T00:00:00.000Z",
        attachments: chips,
      },
    ]);
  });

  it("builds the fix prompt, drawer default, and escape action", () => {
    expect(CREATE_TASK_PREFILL).toBe("Create a task for this pipeline: ");
    expect(askAgentToFixPrompt("plan.verify", "command missing")).toBe(
      "Fix this validation error in plan.verify: command missing",
    );
    expect(initialDrawerTab(emptyDraft())).toBe("task");
    expect(initialDrawerTab({ pipeline: { stages: [{ id: "a" }] } })).toBe("problems");
    expect(
      initialDrawerTab({
        pipeline: { stages: [] },
        task: { filename: "t.yaml", body: {} },
      }),
    ).toBe("problems");
    expect(escapeWorkshopAction({ bannerVisible: true, selectedStageId: "a" })).toBe(
      "dismiss-banner",
    );
    expect(escapeWorkshopAction({ bannerVisible: false, selectedStageId: "a" })).toBe(
      "clear-selection",
    );
    expect(escapeWorkshopAction({ bannerVisible: false, selectedStageId: null })).toBe("none");
  });
});
