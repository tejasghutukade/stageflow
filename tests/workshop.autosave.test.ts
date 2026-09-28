import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyDiskChangeDecision,
  clearWorkshopAutosave,
  detectDiskChange,
  draftPackageDiskRelativePaths,
  fingerprintPackageFiles,
  readWorkshopAutosave,
  resolveWorkshopAutosaveStoreRoot,
  workshopAutosaveSlotKey,
  WORKSHOP_UNTITLED_AUTOSAVE_KEY,
  writeWorkshopAutosave,
  type WorkshopAutosaveRecord,
} from "../src/workshop/autosave.js";
import { initTempGitRepo, withIsolatedHome } from "./helpers/projectContext.js";

function sampleRecord(
  overrides?: Partial<WorkshopAutosaveRecord>,
): WorkshopAutosaveRecord {
  return {
    version: 1,
    key: WORKSHOP_UNTITLED_AUTOSAVE_KEY,
    updatedAt: "2026-01-01T00:00:00.000Z",
    draft: {
      pipeline: { id: "demo", stages: [{ id: "a", system_prompt: "x" }] },
    },
    messages: [
      { id: "m1", role: "assistant", text: "hello" },
      { id: "m2", role: "user", text: "build it" },
    ],
    autoApply: true,
    sessionModelOverride: "anthropic/claude-sonnet-4-5",
    ...overrides,
  };
}

describe("workshop autosave", () => {
  it("keys untitled New separately from pipeline paths", () => {
    expect(workshopAutosaveSlotKey(undefined)).toBe(
      WORKSHOP_UNTITLED_AUTOSAVE_KEY,
    );
    expect(workshopAutosaveSlotKey("")).toBe(WORKSHOP_UNTITLED_AUTOSAVE_KEY);
    expect(workshopAutosaveSlotKey("pipelines/demo.pipeline.yaml")).toBe(
      "pipelines/demo.pipeline.yaml",
    );
  });

  it("round-trips draft, transcript, auto-apply, and session model override", async () => {
    await withIsolatedHome(async () => {
      const { root, cleanup } = await initTempGitRepo();
      try {
        const storeRoot = resolveWorkshopAutosaveStoreRoot({
          projectRoot: root,
          isGitProject: true,
        });
        expect(storeRoot).toBe(path.join(root, ".stageflow"));

        const written = writeWorkshopAutosave(
          storeRoot,
          sampleRecord({
            key: "pipelines/demo.pipeline.yaml",
            destination: {
              directory: "pipelines",
              pipelineFilename: "demo.pipeline.yaml",
            },
            savedPath: "pipelines/demo.pipeline.yaml",
            diskFingerprints: { "pipelines/demo.pipeline.yaml": "10:1" },
          }),
        );
        expect(written.key).toBe("pipelines/demo.pipeline.yaml");

        const loaded = readWorkshopAutosave(
          storeRoot,
          "pipelines/demo.pipeline.yaml",
        );
        expect(loaded).toEqual(written);
        expect(loaded?.autoApply).toBe(true);
        expect(loaded?.sessionModelOverride).toBe(
          "anthropic/claude-sonnet-4-5",
        );
        expect(loaded?.messages).toHaveLength(2);
        expect(loaded?.draft.pipeline.id).toBe("demo");
      } finally {
        await cleanup();
      }
    });
  });

  it("clears the slot on save/discard and isolates the untitled New slot", async () => {
    await withIsolatedHome(async (home) => {
      const globalStore = resolveWorkshopAutosaveStoreRoot({
        projectRoot: null,
      });
      expect(globalStore).toBe(path.join(home, ".stageflow"));

      writeWorkshopAutosave(globalStore, sampleRecord());
      writeWorkshopAutosave(
        globalStore,
        sampleRecord({
          key: "pipelines/other.pipeline.yaml",
          draft: { pipeline: { id: "other", stages: [] } },
        }),
      );

      expect(clearWorkshopAutosave(globalStore, WORKSHOP_UNTITLED_AUTOSAVE_KEY)).toBe(
        true,
      );
      expect(readWorkshopAutosave(globalStore, WORKSHOP_UNTITLED_AUTOSAVE_KEY)).toBeNull();
      expect(
        readWorkshopAutosave(globalStore, "pipelines/other.pipeline.yaml")
          ?.draft.pipeline.id,
      ).toBe("other");

      expect(
        clearWorkshopAutosave(globalStore, "pipelines/other.pipeline.yaml"),
      ).toBe(true);
      expect(
        readWorkshopAutosave(globalStore, "pipelines/other.pipeline.yaml"),
      ).toBeNull();
      expect(
        clearWorkshopAutosave(globalStore, "pipelines/other.pipeline.yaml"),
      ).toBe(false);
    });
  });

  it("detects on-disk package changes and Reload vs Keep decisions", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const pipelineRel = "pipelines/demo.pipeline.yaml";
      const stageRel = "pipelines/stage.yaml";
      await mkdir(path.join(root, "pipelines"), { recursive: true });
      await writeFile(path.join(root, pipelineRel), "id: demo\nstages: []\n");
      await writeFile(path.join(root, stageRel), "id: stage\n");

      const paths = draftPackageDiskRelativePaths({
        pipelinePath: pipelineRel,
        draft: {
          pipeline: {
            id: "demo",
            stages: [{ id: "stage", uses: "./stage.yaml" }],
          },
          stages: [{ path: "./stage.yaml", body: { id: "stage" } }],
        },
      });
      expect(paths).toEqual([pipelineRel, stageRel]);

      const baseline = fingerprintPackageFiles(root, paths);
      expect(baseline[pipelineRel]).toMatch(/^\d+:\d+$/);

      expect(
        detectDiskChange({ baseline, current: baseline }).changed,
      ).toBe(false);

      await writeFile(
        path.join(root, pipelineRel),
        "id: demo\nstages: []\n# edited\n",
      );
      const current = fingerprintPackageFiles(root, paths);
      const detection = detectDiskChange({ baseline, current });
      expect(detection.changed).toBe(true);
      expect(detection.changedPaths).toEqual([pipelineRel]);

      expect(
        applyDiskChangeDecision({
          decision: "reload",
          currentFingerprints: current,
        }),
      ).toEqual({
        clearAutosave: true,
        nextFingerprints: current,
      });
      expect(
        applyDiskChangeDecision({
          decision: "keep",
          currentFingerprints: current,
        }),
      ).toEqual({
        clearAutosave: false,
        nextFingerprints: current,
      });
    } finally {
      await cleanup();
    }
  });
});
