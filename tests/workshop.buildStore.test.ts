import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadStageflowManifestOutcome } from "../src/config/loadStageflowManifest.js";
import { listPipelines } from "../src/config/listConfig.js";
import {
  createWorkshopBuild,
  focusUnboundWorkshopBuild,
  getWorkshopBuild,
  listWorkshopBuilds,
  listWorkshopPickerRows,
  resolvePickerCatalogPipelines,
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

const SHARED_PIPELINE = `id: shared-flow
stages:
  - id: step
    system_prompt: ok
    model: cursor/auto
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
`;

async function writePickerFixture(): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-picker-"));
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks: []\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "pipelines", "one.pipeline.yaml"),
    SHARED_PIPELINE,
    "utf8",
  );
  await writeFile(
    path.join(root, "pipelines", "two.pipeline.yaml"),
    SHARED_PIPELINE,
    "utf8",
  );
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function listFixturePipelines(projectRoot: string) {
  const manifest = await loadStageflowManifestOutcome(projectRoot);
  if (!manifest.ok) {
    throw new Error(manifest.issues[0]?.message ?? "manifest failed");
  }
  return listPipelines({ projectRoot, manifest: manifest.value });
}

describe("workshop picker", () => {
  it("lists an untitled build and each catalog path once, keeping a tied build id", async () => {
    await withIsolatedHome(async () => {
      const fixture = await writePickerFixture();
      try {
        const pipelines = await listFixturePipelines(fixture.root);
        expect(pipelines.map((pipeline) => pipeline.id)).toEqual([
          "shared-flow",
          "shared-flow",
        ]);
        expect(new Set(pipelines.map((pipeline) => pipeline.path)).size).toBe(2);

        const [tiedPipeline, unboundPipeline] = [...pipelines].sort((a, b) =>
          a.path.localeCompare(b.path),
        );
        expect(tiedPipeline).toBeDefined();
        expect(unboundPipeline).toBeDefined();

        const storeRoot = resolveWorkshopBuildStoreRoot();
        const untitled = createWorkshopBuild(storeRoot, {
          id: "build-untitled",
          draft: {
            pipeline: {
              id: "notes",
              stages: [{ id: "scratch" }],
            },
          },
        });
        const tied = createWorkshopBuild(storeRoot, {
          id: "build-tied-file",
          draft: {
            pipeline: {
              id: "shared-flow",
              stages: [{ id: "workshop-copy" }],
            },
          },
          projectRoot: fixture.root,
          relativePath: tiedPipeline!.path,
        });

        const rows = listWorkshopPickerRows(
          storeRoot,
          pipelines.map((pipeline) => ({
            project_root: fixture.root,
            path: pipeline.path,
            id: pipeline.id,
          })),
        );

        expect(rows).toContainEqual({
          id: untitled.id,
          name: "notes",
          projectRoot: null,
          relativePath: null,
        });
        expect(
          rows.filter(
            (row) =>
              row.projectRoot === fixture.root &&
              row.relativePath === tiedPipeline!.path,
          ),
        ).toEqual([
          {
            id: tied.id,
            name: "shared-flow",
            projectRoot: fixture.root,
            relativePath: tiedPipeline!.path,
          },
        ]);
        expect(rows).toContainEqual({
          id: null,
          name: "shared-flow",
          projectRoot: fixture.root,
          relativePath: unboundPipeline!.path,
        });
        expect(
          rows
            .filter((row) => row.name === "shared-flow")
            .map((row) => row.relativePath)
            .sort(),
        ).toEqual([tiedPipeline!.path, unboundPipeline!.path].sort());
        expect(rows).toHaveLength(3);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("reuses one build id for an unbound path and keeps the stored draft", async () => {
    await withIsolatedHome(async () => {
      const fixture = await writePickerFixture();
      try {
        const pipelines = await listFixturePipelines(fixture.root);
        const unbound = pipelines.find((pipeline) =>
          pipeline.path.endsWith("two.pipeline.yaml"),
        );
        expect(unbound).toBeDefined();
        const storeRoot = resolveWorkshopBuildStoreRoot();

        const other = createWorkshopBuild(storeRoot, {
          id: "build-other-project",
          draft: {
            pipeline: {
              id: "remote-flow",
              stages: [{ id: "kept" }],
            },
          },
          projectRoot: "/other/project",
          relativePath: "pipelines/elsewhere.pipeline.yaml",
        });
        const listed = listWorkshopPickerRows(storeRoot, [
          {
            project_root: fixture.root,
            path: unbound!.path,
            id: unbound!.id,
          },
        ]);
        expect(listed).toContainEqual({
          id: other.id,
          name: "remote-flow",
          projectRoot: "/other/project",
          relativePath: "pipelines/elsewhere.pipeline.yaml",
        });

        const fromOther = await focusUnboundWorkshopBuild(storeRoot, {
          projectRoot: "/other/project",
          relativePath: "pipelines/elsewhere.pipeline.yaml",
        });
        expect(fromOther.ok).toBe(true);
        if (!fromOther.ok) return;
        expect(fromOther.build.id).toBe(other.id);
        expect(fromOther.build.draft).toEqual(other.draft);
        expect(fromOther.created).toBe(false);

        const first = await focusUnboundWorkshopBuild(storeRoot, {
          projectRoot: fixture.root,
          relativePath: unbound!.path,
        });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.created).toBe(true);
        expect(first.build.projectRoot).toBe(fixture.root);
        expect(first.build.relativePath).toBe(unbound!.path);
        expect(first.build.draft.pipeline.id).toBe("shared-flow");
        expect(first.build.draft.pipeline.stages[0]?.id).toBe("step");

        const mutated = {
          pipeline: {
            id: "shared-flow",
            stages: [{ id: "edited-in-workshop" }],
          },
        };
        updateWorkshopBuild(storeRoot, first.build.id, { draft: mutated });
        await writeFile(
          path.join(fixture.root, unbound!.path),
          SHARED_PIPELINE.replace("id: step", "id: on-disk"),
          "utf8",
        );

        const second = await focusUnboundWorkshopBuild(storeRoot, {
          projectRoot: fixture.root,
          relativePath: `./${unbound!.path}`,
        });
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.created).toBe(false);
        expect(second.build.id).toBe(first.build.id);
        expect(second.build.draft).toEqual(mutated);
        expect(
          listWorkshopBuilds(storeRoot).filter(
            (build) => build.relativePath === unbound!.path,
          ),
        ).toHaveLength(1);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("does not create a build when the pipeline file cannot be opened", async () => {
    await withIsolatedHome(async () => {
      const fixture = await writePickerFixture();
      try {
        const storeRoot = resolveWorkshopBuildStoreRoot();
        const before = listWorkshopBuilds(storeRoot);
        const failed = await focusUnboundWorkshopBuild(storeRoot, {
          projectRoot: fixture.root,
          relativePath: "pipelines/missing.pipeline.yaml",
        });
        expect(failed.ok).toBe(false);
        if (failed.ok) return;
        expect(failed.status).toBe(404);
        expect(listWorkshopBuilds(storeRoot)).toEqual(before);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("lists a seeded catalog root once after it is tied to the filesystem path", async () => {
    await withIsolatedHome(async () => {
      const examples = "/tmp/stageflow-examples";
      const pipelines = resolvePickerCatalogPipelines(
        [
          {
            project_root: "examples",
            path: "ci-validate/ci-demo.pipeline.yaml",
            id: "ci-demo",
          },
        ],
        [{ project_root: "examples", path: examples }],
      );
      expect(pipelines[0]?.project_root).toBe(examples);
      const storeRoot = resolveWorkshopBuildStoreRoot();
      const tied = createWorkshopBuild(storeRoot, {
        draft,
        projectRoot: "examples",
        relativePath: "ci-validate/ci-demo.pipeline.yaml",
      });
      const rows = listWorkshopPickerRows(storeRoot, pipelines, [
        { project_root: "examples", path: examples },
      ]);
      const matches = rows.filter(
        (row) => row.relativePath === "ci-validate/ci-demo.pipeline.yaml",
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.id).toBe(tied.id);
    });
  });
});
