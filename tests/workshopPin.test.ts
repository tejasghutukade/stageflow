import { describe, expect, it } from "vitest";
import type { DraftPackage } from "../src/config/draftPackage.js";
import {
  createWorkshopBuild,
  getWorkshopBuild,
  listWorkshopBuilds,
} from "../src/workshop/buildStore.js";
import {
  focusWorkshopBuildPointer,
  pinWorkshopBuildOnCreate,
  recordPinnedWorkshopSave,
  registerLiveWorkshopSession,
  resetWorkshopPinStateForTests,
  resolvePinnedSaveDestination,
  type WorkshopPinRegistry,
  type WorkshopPointerChange,
} from "../src/workshop/workshopPin.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

const draft: DraftPackage = {
  pipeline: { id: "demo", stages: [] },
};

function mockRegistry(
  sessionId: string,
  opts: {
    pinnedBuildId?: string | null;
    liveTurn?: boolean;
    onPointerChange?: (frame: WorkshopPointerChange) => void;
  } = {},
): WorkshopPinRegistry & {
  pinnedBuildId: string | null;
  context: unknown;
} {
  const state = {
    pinnedBuildId:
      opts.pinnedBuildId === undefined ? ("build-1" as string | null) : opts.pinnedBuildId,
    context: {
      draft,
      chatSessionId: sessionId,
      buildId: opts.pinnedBuildId === undefined ? "build-1" : opts.pinnedBuildId,
    } as unknown,
  };
  return {
    get pinnedBuildId() {
      return state.pinnedBuildId;
    },
    get context() {
      return state.context;
    },
    get: () => ({
      getContext: () => state.context,
      setContext: (next: unknown) => {
        state.context = next;
      },
    }),
    getPinnedBuildId: () => state.pinnedBuildId,
    setPinnedBuildId: (_sessionId: string, buildId: string | null) => {
      state.pinnedBuildId = buildId;
    },
    getLiveTurn: () =>
      opts.liveTurn
        ? { onPointerChange: opts.onPointerChange }
        : undefined,
  };
}

describe("workshop pin save tie", () => {
  it("resolvePinnedSaveDestination ignores tie when write root differs", async () => {
    await withIsolatedHome(async (home) => {
      const storeRoot = home;
      createWorkshopBuild(storeRoot, {
        id: "build-1",
        draft,
        projectRoot: "/opt/stageflow",
        relativePath: "examples/demo.pipeline.yaml",
      });
      const sessionId = "sess-1";
      registerLiveWorkshopSession(sessionId, {
        storeRoot,
        registry: mockRegistry(sessionId),
      });
      const pinned = resolvePinnedSaveDestination(
        {
          draft,
          chatSessionId: sessionId,
          buildId: "build-1",
          projectRoot: "/opt/stageflow",
        },
        "/catalog",
      );
      expect(pinned).toBeNull();
      const sameRoot = resolvePinnedSaveDestination(
        {
          draft,
          chatSessionId: sessionId,
          buildId: "build-1",
          projectRoot: "/opt/stageflow",
        },
        "/opt/stageflow",
      );
      expect(sameRoot).toEqual({
        directory: "examples",
        pipelineFilename: "demo.pipeline.yaml",
      });
    });
  });

  it("recordPinnedWorkshopSave replaces an existing stale tie", async () => {
    await withIsolatedHome(async (home) => {
      resetWorkshopPinStateForTests();
      const storeRoot = home;
      createWorkshopBuild(storeRoot, {
        id: "build-1",
        draft,
        projectRoot: "/opt/stageflow",
        relativePath: "examples/demo.pipeline.yaml",
      });
      const sessionId = "sess-1";
      registerLiveWorkshopSession(sessionId, {
        storeRoot,
        registry: mockRegistry(sessionId),
      });
      recordPinnedWorkshopSave(
        {
          draft,
          chatSessionId: sessionId,
          buildId: "build-1",
        },
        {
          directory: "workshop/demo",
          projectRoot: "/catalog",
          draft,
          relativePath: "workshop/demo.pipeline.yaml",
        },
      );
      const build = getWorkshopBuild(storeRoot, "build-1");
      expect(build.projectRoot).toBe("/catalog");
      expect(build.relativePath).toBe("workshop/demo.pipeline.yaml");
    });
  });
});

describe("workshop pin focus and create", () => {
  it("mid-turn focus moves an existing pin onto the focused build", async () => {
    await withIsolatedHome(async (home) => {
      resetWorkshopPinStateForTests();
      const storeRoot = home;
      createWorkshopBuild(storeRoot, {
        id: "build-a",
        draft: { pipeline: { id: "alpha", stages: [] } },
      });
      createWorkshopBuild(storeRoot, {
        id: "build-b",
        draft: { pipeline: { id: "beta", stages: [] } },
      });
      const pointerFrames: string[] = [];
      const registry = mockRegistry("sess-focus", {
        pinnedBuildId: "build-a",
        liveTurn: true,
        onPointerChange: (frame) => pointerFrames.push(frame.buildId),
      });
      registerLiveWorkshopSession("sess-focus", { storeRoot, registry });
      const focus = focusWorkshopBuildPointer({
        sessionId: "sess-focus",
        buildId: "build-b",
        registry,
        storeRoot,
      });
      expect(focus.pinMoved).toBe(true);
      expect(focus.activeBuildId).toBe("build-b");
      expect(registry.getPinnedBuildId("sess-focus")).toBe("build-b");
      expect(
        (registry.context as { draft: DraftPackage }).draft.pipeline.id,
      ).toBe("beta");
      expect(pointerFrames).toEqual(["build-b"]);
    });
  });

  it("create_build reuses the pinned build instead of creating Untitled", async () => {
    await withIsolatedHome(async (home) => {
      resetWorkshopPinStateForTests();
      const storeRoot = home;
      createWorkshopBuild(storeRoot, {
        id: "build-open",
        draft: { pipeline: { id: "alpha", stages: [] } },
      });
      const registry = mockRegistry("sess-create", {
        pinnedBuildId: "build-open",
        liveTurn: true,
      });
      registerLiveWorkshopSession("sess-create", { storeRoot, registry });
      const build = pinWorkshopBuildOnCreate({
        sessionId: "sess-create",
        draft: { pipeline: { id: "untitled", stages: [] } },
        registry,
        storeRoot,
      });
      expect(build.id).toBe("build-open");
      expect(build.draft.pipeline.id).toBe("alpha");
      expect(listWorkshopBuilds(storeRoot).map((row) => row.id)).toEqual([
        "build-open",
      ]);
    });
  });

  it("create_build creates Untitled when no pin exists", async () => {
    await withIsolatedHome(async (home) => {
      resetWorkshopPinStateForTests();
      const storeRoot = home;
      const registry = mockRegistry("sess-blank", {
        pinnedBuildId: null,
        liveTurn: true,
      });
      registerLiveWorkshopSession("sess-blank", { storeRoot, registry });
      const build = pinWorkshopBuildOnCreate({
        sessionId: "sess-blank",
        draft: { pipeline: { id: "untitled", stages: [] } },
        registry,
        storeRoot,
      });
      expect(build.draft.pipeline.id).toBe("untitled");
      expect(registry.getPinnedBuildId("sess-blank")).toBe(build.id);
      expect(listWorkshopBuilds(storeRoot)).toHaveLength(1);
    });
  });
});
