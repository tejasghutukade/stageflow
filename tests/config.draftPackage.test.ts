import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  overwriteDraftPackage,
  validateDraftPackage,
  type DraftPackage,
} from "../src/config/draftPackage.js";
import { createPipeline } from "../src/config/createPipeline.js";
import { createStage } from "../src/config/createStage.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

const MODEL = "anthropic/claude-sonnet-4-5";

function validInlineDraft(overrides?: Partial<DraftPackage["pipeline"]>): DraftPackage {
  return {
    pipeline: {
      id: "inline-demo",
      stages: [
        {
          id: "plan",
          system_prompt: "Do work",
          model: MODEL,
          ...REQUIRED_IO,
        },
      ],
      ...overrides,
    },
  };
}

function validFilePackageDraft(): DraftPackage {
  return {
    pipeline: {
      id: "demo",
      stages: [
        {
          id: "clarify",
          uses: "./clarify.yaml",
          entry: true,
          route: [{ to: "decide" }],
        },
        { id: "decide", uses: "./decide.yaml" },
      ],
    },
    stages: [
      {
        path: "./clarify.yaml",
        body: {
          id: "clarify",
          system_prompt: "Clarify the task",
          model: MODEL,
          ...REQUIRED_IO,
        },
      },
      {
        path: "./decide.yaml",
        body: {
          id: "decide",
          system_prompt: "Decide next steps",
          model: MODEL,
          ...REQUIRED_IO,
        },
      },
    ],
  };
}

describe("validateDraftPackage", () => {
  it("accepts a fully-inline draft with the same finding class as path-based validate", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const result = await validateDraftPackage(validInlineDraft(), {
        cwd: root,
        projectRoot: root,
        strict: true,
      });
      expect(result.ok).toBe(true);
      expect(result.scope).toBe("pipeline");
      expect(result.summary.errors).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("reports catalog-shaped errors for an invalid inline draft", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const result = await validateDraftPackage(
        {
          pipeline: {
            id: "broken",
            stages: [{ id: "plan", system_prompt: "Do work", model: MODEL }],
          },
        },
        { cwd: root, projectRoot: root, strict: true },
      );
      expect(result.ok).toBe(false);
      expect(result.findings.some((f) => f.code === "stage.invalid_io")).toBe(true);
      expect(result.findings.every((f) => f.severity === "error" || f.severity === "warning")).toBe(
        true,
      );
      expect(result.findings.every((f) => typeof f.path === "string")).toBe(true);
      expect(result.findings.every((f) => typeof f.category === "string")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("validates a multi-file package draft via temp materialization", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const result = await validateDraftPackage(validFilePackageDraft(), {
        cwd: root,
        projectRoot: root,
        strict: true,
      });
      expect(result.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("fails multi-file package validation when a stage body is invalid", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const draft = validFilePackageDraft();
      draft.stages![0]!.body = {
        id: "clarify",
        system_prompt: "Clarify the task",
        model: MODEL,
      };
      const result = await validateDraftPackage(draft, {
        cwd: root,
        projectRoot: root,
        strict: true,
      });
      expect(result.ok).toBe(false);
      expect(result.findings.some((f) => f.code === "stage.invalid_io")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("includes task findings when an optional task is invalid", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const draft = validInlineDraft();
      draft.task = {
        filename: "sample.task.yaml",
        body: { id: "sample" },
      };
      const result = await validateDraftPackage(draft, {
        cwd: root,
        projectRoot: root,
        strict: true,
      });
      expect(result.ok).toBe(false);
      expect(result.findings.some((f) => f.category === "task")).toBe(true);
      expect(result.findings.some((f) => f.code === "task.invalid_shape")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("accepts a valid optional task alongside a valid pipeline", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const draft = validInlineDraft();
      draft.task = {
        filename: "sample.task.yaml",
        body: { id: "sample", goal: "Ship the demo" },
      };
      const result = await validateDraftPackage(draft, {
        cwd: root,
        projectRoot: root,
        strict: true,
      });
      expect(result.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe("overwriteDraftPackage", () => {
  it("overwrites an existing package after successful validate-then-write", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const dir = path.join(root, "pipelines");
      await mkdir(dir, { recursive: true });

      const createdClarify = await createStage(root, {
        pipeline_directory: "pipelines",
        filename: "clarify.yaml",
        id: "clarify",
        system_prompt: "Old clarify",
        model: MODEL,
      });
      expect(createdClarify.ok).toBe(true);

      const createdDecide = await createStage(root, {
        pipeline_directory: "pipelines",
        filename: "decide.yaml",
        id: "decide",
        system_prompt: "Old decide",
        model: MODEL,
      });
      expect(createdDecide.ok).toBe(true);

      const created = await createPipeline(root, {
        directory: "pipelines",
        id: "demo",
        stages: [
          { id: "clarify", uses: "./clarify.yaml" },
          { id: "decide", uses: "./decide.yaml", needs: "clarify" },
        ],
      });
      expect(created.ok).toBe(true);

      const draft = validFilePackageDraft();
      draft.stages![0]!.body.system_prompt = "New clarify prompt";
      draft.stages![1]!.body.system_prompt = "New decide prompt";
      draft.task = {
        filename: "demo.task.yaml",
        body: { id: "demo-task", goal: "Run the demo package" },
      };

      const result = await overwriteDraftPackage(root, {
        directory: "pipelines",
        draft,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.pipelinePath).toBe("pipelines/demo.pipeline.yaml");
      expect(result.stagePaths).toEqual(
        expect.arrayContaining(["pipelines/clarify.yaml", "pipelines/decide.yaml"]),
      );
      expect(result.taskPath).toBe("pipelines/demo.task.yaml");

      const clarifyYaml = await readFile(path.join(dir, "clarify.yaml"), "utf8");
      expect(clarifyYaml).toContain("New clarify prompt");
      const decideYaml = await readFile(path.join(dir, "decide.yaml"), "utf8");
      expect(decideYaml).toContain("New decide prompt");
      const taskYaml = await readFile(path.join(dir, "demo.task.yaml"), "utf8");
      expect(taskYaml).toContain("Run the demo package");
      const pipelineYaml = await readFile(path.join(dir, "demo.pipeline.yaml"), "utf8");
      expect(pipelineYaml).toContain("id: demo");
      expect(pipelineYaml).toContain("clarify");
    } finally {
      await cleanup();
    }
  });

  it("refuses invalid overwrite and leaves existing files unchanged", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const dir = path.join(root, "pipelines");
      await mkdir(dir, { recursive: true });

      expect(
        (
          await createStage(root, {
            pipeline_directory: "pipelines",
            filename: "clarify.yaml",
            id: "clarify",
            system_prompt: "Keep me",
            model: MODEL,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await createStage(root, {
            pipeline_directory: "pipelines",
            filename: "decide.yaml",
            id: "decide",
            system_prompt: "Keep decide",
            model: MODEL,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await createPipeline(root, {
            directory: "pipelines",
            id: "demo",
            stages: [
              { id: "clarify", uses: "./clarify.yaml" },
              { id: "decide", uses: "./decide.yaml", needs: "clarify" },
            ],
          })
        ).ok,
      ).toBe(true);

      const beforeClarify = await readFile(path.join(dir, "clarify.yaml"), "utf8");
      const beforePipeline = await readFile(path.join(dir, "demo.pipeline.yaml"), "utf8");

      const draft = validFilePackageDraft();
      draft.stages![0]!.body = {
        id: "clarify",
        system_prompt: "Broken clarify",
        model: MODEL,
      };

      const result = await overwriteDraftPackage(root, {
        directory: "pipelines",
        draft,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(422);
      expect(result.findings?.some((f) => f.code === "stage.invalid_io")).toBe(true);

      expect(await readFile(path.join(dir, "clarify.yaml"), "utf8")).toBe(beforeClarify);
      expect(await readFile(path.join(dir, "demo.pipeline.yaml"), "utf8")).toBe(beforePipeline);
    } finally {
      await cleanup();
    }
  });

  it("returns 404 when the pipeline does not already exist", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await mkdir(path.join(root, "pipelines"), { recursive: true });
      const result = await overwriteDraftPackage(root, {
        directory: "pipelines",
        draft: validFilePackageDraft(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(404);
    } finally {
      await cleanup();
    }
  });

  it("returns 400 when directory is outside the project root", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const result = await overwriteDraftPackage(root, {
        directory: "../outside",
        draft: validFilePackageDraft(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
    } finally {
      await cleanup();
    }
  });

  it("allowInvalid writes without validate gate (escape for Save invalid anyway)", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const dir = path.join(root, "pipelines");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "broken.pipeline.yaml"),
        "id: broken\nstages:\n  - id: plan\n    system_prompt: x\n    model: anthropic/claude-sonnet-4-5\n    io:\n      input:\n        schema:\n          type: object\n      output:\n        schema:\n          type: object\n",
        "utf8",
      );

      const draft: DraftPackage = {
        pipeline: {
          id: "broken",
          stages: [{ id: "plan", system_prompt: "Still broken", model: MODEL }],
        },
      };

      const refused = await overwriteDraftPackage(root, {
        directory: "pipelines",
        draft,
      });
      expect(refused.ok).toBe(false);

      const forced = await overwriteDraftPackage(root, {
        directory: "pipelines",
        draft,
        allowInvalid: true,
      });
      expect(forced.ok).toBe(true);
      const written = await readFile(path.join(dir, "broken.pipeline.yaml"), "utf8");
      expect(written).toContain("Still broken");
    } finally {
      await cleanup();
    }
  });
});
