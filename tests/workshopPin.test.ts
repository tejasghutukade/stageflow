import { describe, expect, it } from "vitest";
import type { DraftPackage } from "../src/config/draftPackage.js";
import { createWorkshopBuild, getWorkshopBuild } from "../src/workshop/buildStore.js";
import {
  recordPinnedWorkshopSave,
  registerLiveWorkshopSession,
  resetWorkshopPinStateForTests,
  resolvePinnedSaveDestination,
  type WorkshopPinRegistry,
} from "../src/workshop/workshopPin.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

const draft: DraftPackage = {
  pipeline: { id: "demo", stages: [] },
};

function mockRegistry(sessionId: string): WorkshopPinRegistry {
  let context: unknown = {
    draft,
    chatSessionId: sessionId,
    buildId: "build-1",
  };
  return {
    get: () => ({
      getContext: () => context,
      setContext: (next: unknown) => {
        context = next;
      },
    }),
    getPinnedBuildId: () => "build-1",
    setPinnedBuildId: () => {},
    getLiveTurn: () => undefined,
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
