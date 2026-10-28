import { describe, expect, it, vi } from "vitest";
import type { CatalogRoot, DraftPackagePayload } from "../../api";
import { addStage, deleteStage } from "./stageMutators";
import {
  AUTOSAVE_DEBOUNCE_MS,
  CREATE_TASK_PREFILL,
  DEFAULT_WRITE_CATALOG_WIRE_ID,
  WORKSHOP_CHAT_DEFAULT_WIDTH,
  askAgentToFixPrompt,
  attachmentChipsFromAutosave,
  autosaveArtifactsForAttachments,
  clampWorkshopChatWidth,
  defaultPackageDirectory,
  defaultWritableRootWireId,
  draftOriginFromCatalogRoot,
  draftOriginFromResponse,
  emptyDiskChangeState,
  escapeWorkshopAction,
  fallbackDraftOrigin,
  initialDrawerTab,
  nextStudioGeneration,
  omitDefaultWriteProjectRoot,
  openDraftInput,
  packageFocusInputForChat,
  draftForWorkshopSave,
  draftWithCatalogFilenames,
  mergeTaskFromAuthoritativeDraft,
  pipelineFilenameFor,
  planDraftInput,
  projectRootField,
  projectRootForPipelinePath,
  saveAsIntent,
  saveIntent,
  saveIntentForOrigin,
  savedFileCount,
  catalogSaveBindingFromRelativePath,
  settledMutationCardsFromTranscript,
  seedTranscriptFromAutosave,
  studioGenerationIsCurrent,
  writableRootOptions,
  shouldBootWorkshopPackage,
  workshopBootTarget,
  workshopPackageBootKey,
  workshopChangeCount,
  workshopPrimarySaveDisabled,
  workshopSaveState,
  workshopUrlAfterNewChat,
  workshopUrlAfterPackageOpen,
  workshopUrlAfterSession,
} from "./workshopPageModel";
import { workshopPath } from "../../routes";
import { WORKSHOP_UNTITLED_AUTOSAVE_KEY } from "./workshopAutosaveKey";

function emptyDraft(): DraftPackagePayload {
  return { pipeline: { id: "untitled", stages: [] } };
}

const sampleRoots: CatalogRoot[] = [
  {
    project_root: "examples",
    kind: "seeded",
    label: "Examples (read-only)",
    read_only: true,
    available: true,
  },
  {
    project_root: "workspace",
    kind: "workspace",
    label: "Workspace",
    read_only: false,
    available: true,
  },
  {
    project_root: "/data/catalog",
    kind: "registered",
    label: "catalog",
    read_only: false,
    available: true,
  },
];

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

  it("counts deleted stages against the baseline for save state", () => {
    const first = addStage(emptyDraft());
    const second = addStage(first.draft);
    const base = second.draft;
    const trimmed = deleteStage(base, first.stageId);
    expect(workshopChangeCount(trimmed, base)).toBeGreaterThan(0);
    expect(workshopSaveState("demo/demo.pipeline.yaml", workshopChangeCount(trimmed, base))).toBe(
      "dirty",
    );
  });

  it("derives save state from the saved path and change count", () => {
    expect(workshopSaveState(null, 3)).toBe("new");
    expect(workshopSaveState(undefined, 0)).toBe("new");
    expect(workshopSaveState("pipelines/demo.yaml", 0)).toBe("clean");
    expect(workshopSaveState("pipelines/demo.yaml", 2)).toBe("dirty");
  });

  it("disables primary save when clean on disk but keeps new/dirty saves enabled", () => {
    expect(
      workshopPrimarySaveDisabled({
        stageCount: 2,
        saving: false,
        hasDestination: true,
        saveState: "clean",
      }),
    ).toBe(true);
    expect(
      workshopPrimarySaveDisabled({
        stageCount: 2,
        saving: false,
        hasDestination: true,
        saveState: "dirty",
      }),
    ).toBe(false);
    expect(
      workshopPrimarySaveDisabled({
        stageCount: 2,
        saving: false,
        hasDestination: false,
        saveState: "new",
      }),
    ).toBe(false);
  });

  it("boots session when both session and pipeline are present", () => {
    expect(workshopBootTarget({})).toBe("session");
    expect(workshopBootTarget({ pipelinePath: "" })).toBe("session");
    expect(
      workshopBootTarget({ pipelinePath: "pipelines/demo.pipeline.yaml" }),
    ).toBe("package");
    expect(
      workshopBootTarget({
        sessionId: "sess-1",
        pipelinePath: "pipelines/demo.pipeline.yaml",
      }),
    ).toBe("session");
    expect(workshopBootTarget({ sessionId: "  sess-1  " })).toBe("session");
  });

  it("builds workshop URLs that strip the loser of session vs package", () => {
    expect(workshopPath(workshopUrlAfterNewChat())).toBe("/workshop");
    expect(workshopPath(workshopUrlAfterSession("sess-9"))).toBe(
      "/workshop?session=sess-9",
    );
    expect(
      workshopPath(
        workshopUrlAfterPackageOpen({
          pipeline: "pipelines/demo.pipeline.yaml",
          task: "pipelines/demo.task.yaml",
          projectRoot: "examples",
        }),
      ),
    ).toBe(
      "/workshop?pipeline=pipelines%2Fdemo.pipeline.yaml&task=pipelines%2Fdemo.task.yaml&project_root=examples",
    );
  });

  it("clears disk-change state and bumps studio generation tokens", () => {
    expect(emptyDiskChangeState()).toEqual({
      fingerprints: {},
      changedPaths: [],
      showBanner: false,
    });
    const ref = { current: 3 };
    expect(nextStudioGeneration(ref)).toBe(4);
    expect(studioGenerationIsCurrent(4, ref)).toBe(true);
    expect(studioGenerationIsCurrent(3, ref)).toBe(false);
    expect(WORKSHOP_UNTITLED_AUTOSAVE_KEY).toBe("__untitled__");
  });

  it("focuses the open package on first chat only when no build is selected", () => {
    expect(
      packageFocusInputForChat({
        selectedBuildId: null,
        savedPipelinePath: "pipelines/demo.pipeline.yaml",
        projectRoot: "examples",
      }),
    ).toEqual({
      projectRoot: "examples",
      relativePath: "pipelines/demo.pipeline.yaml",
    });
    expect(
      packageFocusInputForChat({
        selectedBuildId: "build-1",
        savedPipelinePath: "pipelines/demo.pipeline.yaml",
        projectRoot: "examples",
      }),
    ).toBeNull();
    expect(
      packageFocusInputForChat({
        selectedBuildId: null,
        savedPipelinePath: null,
        projectRoot: "examples",
      }),
    ).toBeNull();
  });

  it("does not open the same package again when only the session id changes", () => {
    const pipelinePath = "policy-check/policy-check.pipeline.yaml";
    const projectRoot = "workspace";
    expect(shouldBootWorkshopPackage(null, pipelinePath, undefined, projectRoot)).toBe(true);
    const key = workshopPackageBootKey(pipelinePath, undefined, projectRoot);
    expect(shouldBootWorkshopPackage(key, pipelinePath, undefined, projectRoot)).toBe(false);
    expect(shouldBootWorkshopPackage(key, pipelinePath, "other.task.yaml", projectRoot)).toBe(true);
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

  it("infers project_root when exactly one listing matches the pipeline path", () => {
    const pipelines = [
      { project_root: "/catalog-a", path: "pipelines/demo.pipeline.yaml" },
      { project_root: "/catalog-b", path: "pipelines/other.pipeline.yaml" },
    ];
    expect(
      projectRootForPipelinePath(pipelines, "pipelines/demo.pipeline.yaml"),
    ).toBe("/catalog-a");
    expect(
      projectRootForPipelinePath(pipelines, "pipelines/missing.pipeline.yaml"),
    ).toBeUndefined();
  });

  it("builds draft origin and default write targets from catalog roots", () => {
    expect(
      draftOriginFromResponse({
        project_root: "examples",
        root_kind: "seeded",
        read_only: true,
      }),
    ).toEqual({
      project_root: "examples",
      kind: "seeded",
      readOnly: true,
    });
    expect(draftOriginFromCatalogRoot(sampleRoots, "examples")).toEqual({
      project_root: "examples",
      kind: "seeded",
      readOnly: true,
    });
    expect(draftOriginFromCatalogRoot(sampleRoots, "workspace")?.readOnly).toBe(
      false,
    );
    expect(defaultWritableRootWireId(sampleRoots)).toBe("workspace");
    expect(writableRootOptions(sampleRoots).map((row) => row.value)).toEqual([
      "workspace",
      "/data/catalog",
    ]);
    expect(
      omitDefaultWriteProjectRoot("workspace", DEFAULT_WRITE_CATALOG_WIRE_ID),
    ).toEqual({});
    expect(
      omitDefaultWriteProjectRoot("/data/catalog", DEFAULT_WRITE_CATALOG_WIRE_ID),
    ).toEqual({ project_root: "/data/catalog" });
    expect(defaultPackageDirectory("workspace", "demo")).toBe("demo");
    expect(defaultPackageDirectory("registered", "demo")).toBe("workshop/demo");
    expect(fallbackDraftOrigin()).toEqual({
      project_root: "workspace",
      kind: "workspace",
      readOnly: false,
    });
  });

  it("forces create intent when the draft origin is read-only", () => {
    expect(
      saveIntentForOrigin({
        hasDestination: true,
        errorCount: 0,
        originReadOnly: true,
      }),
    ).toEqual({
      kind: "dialog",
      mode: "create",
      allowInvalidInitial: false,
    });
    expect(
      saveIntentForOrigin({
        hasDestination: true,
        errorCount: 0,
        originReadOnly: false,
      }),
    ).toEqual({
      kind: "dialog",
      mode: "overwrite",
      allowInvalidInitial: false,
    });
  });

  it("rehydrates settled mutation cards from session transcript", () => {
    const baseDraft: DraftPackagePayload = {
      pipeline: { id: "demo", stages: [{ id: "scan" }] },
    };
    const nextDraft: DraftPackagePayload = {
      pipeline: { id: "demo", stages: [{ id: "scan" }, { id: "review" }] },
    };
    const cards = settledMutationCardsFromTranscript([
      {
        mutations: [
          {
            id: "mut-1",
            summary: "Add task",
            affectedStageIds: ["review"],
            artifacts: [{ path: "scan.stage.yaml", kind: "added" }],
            status: "accepted",
            autoApplied: true,
            baseDraft,
            nextDraft,
            baseFingerprint: "fp-1",
          },
        ],
      },
    ]);
    expect(cards.get("mut-1")).toMatchObject({
      status: "accepted",
      auto: true,
      proposal: {
        id: "mut-1",
        summary: "Add task",
        affectedStageIds: ["review"],
        baseDraft,
        nextDraft,
        baseFingerprint: "fp-1",
      },
    });
  });

  it("falls back to an empty draft package for legacy mutation rows", () => {
    const cards = settledMutationCardsFromTranscript([
      {
        mutations: [
          {
            id: "mut-old",
            summary: "Add task",
            affectedStageIds: ["scan"],
            artifacts: [{ path: "scan.stage.yaml", kind: "added" }],
            status: "accepted",
          },
        ],
      },
    ]);
    expect(cards.get("mut-old")?.proposal.baseDraft).toEqual(emptyDraft());
    expect(cards.get("mut-old")?.proposal.nextDraft).toEqual(emptyDraft());
    expect(cards.get("mut-old")?.proposal.baseFingerprint).toBe("mut-old");
  });

  it("catalogSaveBindingFromRelativePath splits folder and filename", () => {
    expect(
      catalogSaveBindingFromRelativePath(
        "workshop/demo/demo.pipeline.yaml",
        "demo",
      ),
    ).toEqual({
      savedPipelinePath: "workshop/demo/demo.pipeline.yaml",
      saveDestination: {
        directory: "workshop/demo",
        pipelineFilename: "demo.pipeline.yaml",
      },
    });
    expect(catalogSaveBindingFromRelativePath("", "demo")).toBeNull();
  });

  it("always opens a dialog when saving to an existing destination", () => {
    expect(saveIntent({ hasDestination: true, errorCount: 0 })).toEqual({
      kind: "dialog",
      mode: "overwrite",
      allowInvalidInitial: false,
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
      saveIntent({ hasDestination: true, errorCount: 0, invalid: true }),
    ).toEqual({
      kind: "dialog",
      mode: "overwrite",
      allowInvalidInitial: true,
    });
    expect(saveAsIntent()).toEqual({
      kind: "dialog",
      mode: "create",
      allowInvalidInitial: false,
    });
  });

  it("plans a save against the folder and omits default workspace project_root", () => {
    const draft = emptyDraft();
    expect(
      planDraftInput({
        destination: { folder: "fanout-fanin-temp", pipelineId: "demo" },
        draft,
        mode: "create",
        projectRoot: "workspace",
        defaultWriteWireId: "workspace",
      }),
    ).toEqual({
      directory: "fanout-fanin-temp",
      draft: { ...draft, pipeline: { ...draft.pipeline, id: "demo" } },
      pipelineFilename: "demo.pipeline.yaml",
      mode: "create",
    });
    expect(
      planDraftInput({
        destination: { folder: "workshop/demo", pipelineId: "demo" },
        draft: { ...draft, pipeline: { ...draft.pipeline, id: "demo" } },
        mode: "overwrite",
        projectRoot: "/data/catalog",
        defaultWriteWireId: "workspace",
        filename: "demo.pipeline.yaml",
      }),
    ).toMatchObject({
      directory: "workshop/demo",
      mode: "overwrite",
      project_root: "/data/catalog",
    });
  });

  it("normalizes task filenames in draft packages", () => {
    expect(
      draftWithCatalogFilenames({
        pipeline: { id: "p", stages: [] },
        task: { filename: "p.yaml", body: { id: "p", goal: "g" } },
      }).task?.filename,
    ).toBe("p.task.yaml");
  });

  it("loads the active build task before save when the studio draft lags", async () => {
    const local = emptyDraft();
    const authoritative: DraftPackagePayload = {
      pipeline: { id: "demo", stages: [{ id: "a" }] },
      task: { filename: "demo.task.yaml", body: { id: "demo", goal: "g" } },
    };
    const loadBuild = vi.fn(async () => ({
      ok: true as const,
      build: { draft: authoritative },
    }));
    const resolved = await draftForWorkshopSave({
      draft: local,
      buildId: null,
      loadBuild,
      resolveActiveBuildId: async () => "build-9",
    });
    expect(loadBuild).toHaveBeenCalledWith("build-9");
    expect(resolved.mergedTaskFromServer).toBe(true);
    expect(resolved.adoptedBuildId).toBe("build-9");
    expect(resolved.draft.task).toEqual(authoritative.task);
  });

  it("builds the fix prompt, drawer default, and escape action", () => {
    expect(CREATE_TASK_PREFILL).toBe("Create a task for this pipeline: ");
    expect(askAgentToFixPrompt("plan.verify", "command missing")).toBe(
      "Fix this validation error in plan.verify: command missing",
    );
    expect(initialDrawerTab(emptyDraft())).toBe("task");
    expect(initialDrawerTab({ pipeline: { stages: [{ id: "a" }] } })).toBe("problems");
    expect(escapeWorkshopAction({ bannerVisible: true, selectedStageId: "a" })).toBe(
      "dismiss-banner",
    );
  });

  it("round-trips attachment chip metadata through autosave artifacts", () => {
    const chips = [{ name: "notes.md", size: 12, mediaType: "text/markdown" }];
    const artifacts = autosaveArtifactsForAttachments(chips);
    expect(attachmentChipsFromAutosave({ artifacts })).toEqual(chips);
    expect(savedFileCount({ stagePaths: ["a.yaml"], taskPath: "t.yaml" })).toBe(3);
    expect(
      seedTranscriptFromAutosave([{ role: "user", text: "hello", artifacts }]),
    ).toEqual([{ role: "user", text: "hello", attachments: chips }]);
  });

  it("merges a task from the authoritative draft when the local draft has none", () => {
    const local = emptyDraft();
    const authoritative: DraftPackagePayload = {
      pipeline: { id: "demo", stages: [{ id: "a" }] },
      task: { filename: "demo.task.yaml", body: { id: "demo", goal: "g" } },
    };
    expect(mergeTaskFromAuthoritativeDraft(local, authoritative).task).toEqual(
      authoritative.task,
    );
  });

  it("keeps an existing filename when the pipeline id is unchanged", () => {
    expect(pipelineFilenameFor("other", { id: "demo", filename: "demo.pipeline.yaml" })).toBe(
      "other.pipeline.yaml",
    );
    expect(pipelineFilenameFor("demo", { id: "demo", filename: "demo.yaml" })).toBe(
      "demo.pipeline.yaml",
    );
  });
});
