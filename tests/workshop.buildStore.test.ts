import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  createWorkshopBuild,
  getWorkshopBuild,
  listWorkshopBuilds,
  resolveWorkshopBuildStoreRoot,
  updateWorkshopBuild,
  workshopBuildFilePath,
  WorkshopBuildStoreError,
} from "../src/workshop/buildStore.js";
import {
  createWorkshopSession,
  getWorkshopSession,
  resolveWorkshopSessionStoreRoot,
  updateWorkshopSessionActiveBuildId,
  WorkshopSessionStoreError,
} from "../src/workshop/sessionStore.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

const draft = {
  pipeline: {
    id: "release-checklist",
    stages: [{ id: "draft-stage" }],
  },
};

describe("workshop build store", () => {
  it("resolves the build store under the global Stageflow home beside sessions", async () => {
    await withIsolatedHome(async (home) => {
      const storeRoot = resolveWorkshopBuildStoreRoot();
      expect(storeRoot).toBe(path.join(home, ".stageflow"));
      expect(storeRoot).toBe(resolveWorkshopSessionStoreRoot());
      expect(workshopBuildFilePath(storeRoot, "build-1")).toBe(
        path.join(storeRoot, "workshop", "builds", "build-1.json"),
      );
      expect(listWorkshopBuilds(storeRoot)).toEqual([]);
    });
  });

  it("creating a build stores its draft under a new id and a second session can store the same id", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopBuildStoreRoot();
      const created = createWorkshopBuild(storeRoot, {
        id: "build-shared",
        now: new Date("2026-10-01T12:00:00.000Z"),
        draft,
      });

      expect(created.version).toBe(1);
      expect(created.id).toBe("build-shared");
      expect(created.draft).toEqual(draft);
      expect(created.projectRoot).toBeNull();
      expect(created.relativePath).toBeNull();

      const loaded = getWorkshopBuild(storeRoot, "build-shared");
      expect(loaded).toEqual(created);
      expect(listWorkshopBuilds(storeRoot).map((build) => build.id)).toEqual([
        "build-shared",
      ]);

      createWorkshopSession(storeRoot, { id: "chat-a" });
      createWorkshopSession(storeRoot, { id: "chat-b" });
      updateWorkshopSessionActiveBuildId(storeRoot, "chat-a", created.id);
      updateWorkshopSessionActiveBuildId(storeRoot, "chat-b", created.id);

      expect(getWorkshopSession(storeRoot, "chat-a").activeBuildId).toBe(
        "build-shared",
      );
      expect(getWorkshopSession(storeRoot, "chat-b").activeBuildId).toBe(
        "build-shared",
      );
      expect(listWorkshopBuilds(storeRoot)).toHaveLength(1);
    });
  });

  it("recording a project root and relative path on a build keeps the id and returns those fields on read", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopBuildStoreRoot();
      const created = createWorkshopBuild(storeRoot, {
        id: "build-tied",
        draft,
      });

      const updated = updateWorkshopBuild(
        storeRoot,
        created.id,
        {
          projectRoot: "/work/repo",
          relativePath: "pipelines/release.pipeline.yaml",
        },
        { now: new Date("2026-10-01T12:05:00.000Z") },
      );

      expect(updated.id).toBe(created.id);
      expect(updated.version).toBe(1);
      expect(updated.projectRoot).toBe("/work/repo");
      expect(updated.relativePath).toBe("pipelines/release.pipeline.yaml");
      expect(updated.draft).toEqual(draft);

      const loaded = getWorkshopBuild(storeRoot, created.id);
      expect(loaded.id).toBe("build-tied");
      expect(loaded.projectRoot).toBe("/work/repo");
      expect(loaded.relativePath).toBe("pipelines/release.pipeline.yaml");
      expect(loaded.draft).toEqual(draft);
      expect(workshopBuildFilePath(storeRoot, loaded.id)).toBe(
        path.join(storeRoot, "workshop", "builds", "build-tied.json"),
      );
    });
  });

  it("a missing build id returns the same not-found shape the session store uses for a missing chat", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopBuildStoreRoot();

      let sessionError: WorkshopSessionStoreError | undefined;
      try {
        getWorkshopSession(storeRoot, "missing-chat");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkshopSessionStoreError);
        sessionError = err as WorkshopSessionStoreError;
      }

      let buildError: WorkshopBuildStoreError | undefined;
      try {
        getWorkshopBuild(storeRoot, "missing-build");
        expect.unreachable("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkshopBuildStoreError);
        buildError = err as WorkshopBuildStoreError;
      }

      expect(sessionError?.code).toBe("workshop_session_not_found");
      expect(sessionError?.sessionId).toBe("missing-chat");
      expect(sessionError?.message).toBe(
        "workshop_session_not_found: missing-chat",
      );

      expect(buildError?.name).toBe("WorkshopBuildStoreError");
      expect(buildError?.code).toBe("workshop_build_not_found");
      expect(buildError?.buildId).toBe("missing-build");
      expect(buildError?.message).toBe(
        "workshop_build_not_found: missing-build",
      );

      expect(() =>
        updateWorkshopBuild(storeRoot, "missing-build", {
          projectRoot: "/work/repo",
          relativePath: "pipelines/release.pipeline.yaml",
        }),
      ).toThrow(WorkshopBuildStoreError);
    });
  });
});
