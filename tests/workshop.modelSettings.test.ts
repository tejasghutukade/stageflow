import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSHOP_MODEL,
  parseWorkshopModel,
  resolveWorkshopModel,
} from "../src/workshop/modelSettings.js";
import {
  readFactorySettings,
  writeFactorySettings,
} from "../src/runtime/settingsFile.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDraftPackage,
  overwriteDraftPackage,
  type DraftPackage,
} from "../src/config/draftPackage.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const MODEL = "anthropic/claude-sonnet-4-5";
const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

function validPackage(id: string): DraftPackage {
  return {
    pipeline: {
      id,
      stages: [{ id: "clarify", uses: "./clarify.yaml", entry: true }],
    },
    stages: [
      {
        path: "./clarify.yaml",
        body: {
          id: "clarify",
          system_prompt: `Clarify for ${id}`,
          model: MODEL,
          ...REQUIRED_IO,
        },
      },
    ],
  };
}

describe("resolveWorkshopModel", () => {
  it("resolves session override → settings default → profile → hard default", () => {
    expect(
      resolveWorkshopModel({
        sessionOverride: "openai/gpt-5",
        settingsDefault: "anthropic/claude-opus-4",
        profileDefault: "google/gemini-2.5-pro",
      }),
    ).toBe("openai/gpt-5");
    expect(
      resolveWorkshopModel({
        sessionOverride: null,
        settingsDefault: "openai/gpt-4.1",
      }),
    ).toBe("openai/gpt-4.1");
    expect(
      resolveWorkshopModel({
        settingsDefault: "  ",
        profileDefault: "google/gemini-2.5-flash",
      }),
    ).toBe("google/gemini-2.5-flash");
    expect(resolveWorkshopModel({})).toBe(DEFAULT_WORKSHOP_MODEL);
    expect(parseWorkshopModel("  ")).toBeUndefined();
    expect(parseWorkshopModel("openai/gpt-5")).toBe("openai/gpt-5");
  });
});

describe("FactorySettings workshopModel", () => {
  it("persists workshopModel alongside other settings without secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-workshop-model-"));
    writeFactorySettings(root, {
      maxConcurrent: 2,
      workshopModel: "openai/gpt-5",
    });
    expect(readFactorySettings(root).workshopModel).toBe("openai/gpt-5");
    writeFactorySettings(root, { maxConcurrent: 3 });
    expect(readFactorySettings(root)).toEqual({
      maxConcurrent: 3,
      workshopModel: "openai/gpt-5",
    });
    const raw = await readFile(
      path.join(storeRootFor(root), "settings.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual({
      maxConcurrent: 3,
      workshopModel: "openai/gpt-5",
    });
    expect(raw).not.toMatch(/api[_-]?key|sk-|token/i);
  });
});

describe("Save As destination behavior", () => {
  it("forks to a new destination then treats those paths as overwrite targets", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await mkdir(path.join(root, "pipelines"), { recursive: true });
      await mkdir(path.join(root, "variants"), { recursive: true });

      const original = validPackage("original");
      const created = await createDraftPackage(root, {
        directory: "pipelines",
        draft: original,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const forked: DraftPackage = {
        ...original,
        pipeline: { ...original.pipeline, id: "variant" },
        stages: original.stages!.map((s) => ({
          ...s,
          body: { ...s.body, system_prompt: "Forked clarify" },
        })),
      };
      const saveAs = await createDraftPackage(root, {
        directory: "variants",
        draft: forked,
      });
      expect(saveAs.ok).toBe(true);
      if (!saveAs.ok) return;
      expect(saveAs.pipelinePath).toBe("variants/variant.pipeline.yaml");

      const originalYaml = await readFile(
        path.join(root, "pipelines", "clarify.yaml"),
        "utf8",
      );
      expect(originalYaml).toContain("Clarify for original");
      expect(originalYaml).not.toContain("Forked clarify");

      const forkedEdit: DraftPackage = {
        ...forked,
        stages: forked.stages!.map((s) => ({
          ...s,
          body: { ...s.body, system_prompt: "After Save As overwrite" },
        })),
      };
      const overwritten = await overwriteDraftPackage(root, {
        directory: "variants",
        draft: forkedEdit,
      });
      expect(overwritten.ok).toBe(true);
      if (!overwritten.ok) return;
      expect(overwritten.pipelinePath).toBe("variants/variant.pipeline.yaml");

      const variantStage = await readFile(
        path.join(root, "variants", "clarify.yaml"),
        "utf8",
      );
      expect(variantStage).toContain("After Save As overwrite");
      const stillOriginal = await readFile(
        path.join(root, "pipelines", "clarify.yaml"),
        "utf8",
      );
      expect(stillOriginal).toContain("Clarify for original");
    } finally {
      await cleanup();
    }
  });

  it("Save As with allowInvalid writes invalid package to the new destination", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await mkdir(path.join(root, "pipelines"), { recursive: true });
      const invalid: DraftPackage = {
        pipeline: {
          id: "wip",
          stages: [{ id: "plan", system_prompt: "incomplete", model: MODEL }],
        },
      };
      const refused = await createDraftPackage(root, {
        directory: "pipelines",
        draft: invalid,
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.status).toBe(422);

      const forced = await createDraftPackage(root, {
        directory: "pipelines",
        draft: invalid,
        allowInvalid: true,
      });
      expect(forced.ok).toBe(true);
      if (!forced.ok) return;
      expect(forced.pipelinePath).toBe("pipelines/wip.pipeline.yaml");
      const yaml = await readFile(
        path.join(root, "pipelines", "wip.pipeline.yaml"),
        "utf8",
      );
      expect(yaml).toContain("incomplete");
    } finally {
      await cleanup();
    }
  });
});
