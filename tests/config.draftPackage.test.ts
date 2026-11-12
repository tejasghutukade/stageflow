import { describe, expect, it } from "vitest";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import {
  createDraftPackage,
  hoistUsesWrapperSkills,
  loadDraftPackage,
  loadTaskArtifact,
  overwriteDraftPackage,
  validateDraftPackage,
  type DraftPackage,
} from "../src/config/draftPackage.js";
import { createPipeline } from "../src/config/createPipeline.js";
import { createStage } from "../src/config/createStage.js";
import { publishDraftPackage } from "../src/config/publishDraftPackage.js";
import {
  ensureWorkspaceCatalog,
  resetWorkspaceProvisionForTests,
  workspaceCatalogPath,
} from "../src/project/workspaceCatalog.js";
import { initTempGitRepo, withIsolatedHome } from "./helpers/projectContext.js";

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

async function withRepo(fn: (root: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = await initTempGitRepo();
  try {
    await fn(root);
  } finally {
    await cleanup();
  }
}

async function validate(root: string, draft: DraftPackage) {
  return validateDraftPackage(draft, { cwd: root, projectRoot: root, strict: true });
}

async function seedPackage(
  root: string,
  options: {
    prompts?: Record<string, string>;
    stages?: Parameters<typeof createPipeline>[1]["stages"];
  } = {},
): Promise<string> {
  const dir = path.join(root, "pipelines");
  await mkdir(dir, { recursive: true });
  const prompts = options.prompts ?? { clarify: "Clarify the task", decide: "Decide next steps" };
  for (const [id, system_prompt] of Object.entries(prompts)) {
    const created = await createStage(root, {
      pipeline_directory: "pipelines",
      filename: `${id}.yaml`,
      id,
      system_prompt,
      model: MODEL,
    });
    expect(created.ok).toBe(true);
  }
  const pipeline = await createPipeline(root, {
    directory: "pipelines",
    id: "demo",
    stages: options.stages ?? [
      { id: "clarify", uses: "./clarify.yaml" },
      { id: "decide", uses: "./decide.yaml", needs: "clarify" },
    ],
  });
  expect(pipeline.ok).toBe(true);
  return dir;
}

function withBrokenClarify(): DraftPackage {
  const draft = validFilePackageDraft();
  draft.stages![0]!.body = {
    id: "clarify",
    system_prompt: "Clarify the task",
    model: MODEL,
  };
  return draft;
}

describe("validateDraftPackage", () => {
  it.each([
    { name: "a fully-inline draft", draft: validInlineDraft() },
    { name: "a multi-file package draft", draft: validFilePackageDraft() },
    {
      name: "a valid optional task alongside a valid pipeline",
      draft: {
        ...validInlineDraft(),
        task: { filename: "sample.task.yaml", body: { id: "sample", goal: "Ship the demo" } },
      },
    },
  ])("accepts $name", ({ draft }) =>
    withRepo(async (root) => {
      const result = await validate(root, draft);
      expect(result.ok).toBe(true);
      expect(result.scope).toBe("pipeline");
      expect(result.summary.errors).toBe(0);
    }));

  it("reports catalog-shaped findings for an invalid inline draft", () =>
    withRepo(async (root) => {
      const result = await validate(root, {
        pipeline: {
          id: "broken",
          stages: [{ id: "plan", system_prompt: "Do work", model: MODEL }],
        },
      });
      expect(result.ok).toBe(false);
      expect(result.findings.some((f) => f.code === "stage.invalid_io")).toBe(true);
      for (const finding of result.findings) {
        expect(["error", "warning"]).toContain(finding.severity);
        expect(typeof finding.path).toBe("string");
        expect(typeof finding.category).toBe("string");
      }
    }));

  it("fails multi-file package validation when a stage body is invalid", () =>
    withRepo(async (root) => {
      const result = await validate(root, withBrokenClarify());
      expect(result.ok).toBe(false);
      expect(result.findings.some((f) => f.code === "stage.invalid_io")).toBe(true);
    }));

  it("includes task findings when an optional task is invalid", () =>
    withRepo(async (root) => {
      const result = await validate(root, {
        ...validInlineDraft(),
        task: { filename: "sample.task.yaml", body: { id: "sample" } },
      });
      expect(result.ok).toBe(false);
      expect(
        result.findings.some((f) => f.category === "task" && f.code === "task.invalid_shape"),
      ).toBe(true);
    }));
});

describe("overwriteDraftPackage", () => {
  it("overwrites an existing package after successful validate-then-write", () =>
    withRepo(async (root) => {
      const dir = await seedPackage(root, {
        prompts: { clarify: "Old clarify", decide: "Old decide" },
      });

      const draft = validFilePackageDraft();
      draft.stages![0]!.body.system_prompt = "New clarify prompt";
      draft.stages![1]!.body.system_prompt = "New decide prompt";
      draft.task = {
        filename: "demo-task.task.yaml",
        body: { id: "demo-task", goal: "Run the demo package" },
      };

      const result = await overwriteDraftPackage(root, { directory: "pipelines", draft });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.pipelinePath).toBe("pipelines/demo.pipeline.yaml");
      expect(result.stagePaths).toEqual(
        expect.arrayContaining(["pipelines/clarify.yaml", "pipelines/decide.yaml"]),
      );
      expect(result.taskPath).toBe("pipelines/demo-task.task.yaml");

      expect(await readFile(path.join(dir, "clarify.yaml"), "utf8")).toContain(
        "New clarify prompt",
      );
      expect(await readFile(path.join(dir, "decide.yaml"), "utf8")).toContain(
        "New decide prompt",
      );
      expect(await readFile(path.join(dir, "demo-task.task.yaml"), "utf8")).toContain(
        "Run the demo package",
      );
      const pipelineYaml = await readFile(path.join(dir, "demo.pipeline.yaml"), "utf8");
      expect(pipelineYaml).toContain("id: demo");
      expect(pipelineYaml).toContain("clarify");
    }));

  it("refuses invalid overwrite and leaves existing files unchanged", () =>
    withRepo(async (root) => {
      const dir = await seedPackage(root, {
        prompts: { clarify: "Keep me", decide: "Keep decide" },
      });
      const beforeClarify = await readFile(path.join(dir, "clarify.yaml"), "utf8");
      const beforePipeline = await readFile(path.join(dir, "demo.pipeline.yaml"), "utf8");

      const result = await overwriteDraftPackage(root, {
        directory: "pipelines",
        draft: withBrokenClarify(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(422);
      expect(result.findings?.some((f) => f.code === "stage.invalid_io")).toBe(true);

      expect(await readFile(path.join(dir, "clarify.yaml"), "utf8")).toBe(beforeClarify);
      expect(await readFile(path.join(dir, "demo.pipeline.yaml"), "utf8")).toBe(beforePipeline);
    }));

  it.each([
    { name: "the pipeline does not already exist", directory: "pipelines", status: 404 },
    { name: "directory is outside the project root", directory: "../outside", status: 400 },
  ])("returns $status when $name", ({ directory, status }) =>
    withRepo(async (root) => {
      await mkdir(path.join(root, "pipelines"), { recursive: true });
      const result = await overwriteDraftPackage(root, {
        directory,
        draft: validFilePackageDraft(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(status);
    }));

  it("returns 400 when a stage path escapes the project root", () =>
    withRepo(async (root) => {
      await mkdir(path.join(root, "pipelines"), { recursive: true });
      const seed = await createDraftPackage(root, {
        directory: "pipelines",
        draft: validFilePackageDraft(),
        allowInvalid: true,
      });
      expect(seed.ok).toBe(true);

      const normalized = await createDraftPackage(root, {
        directory: "workshop",
        pipelineFilename: "fanout-fanin-temp.yaml",
        draft: {
          pipeline: { id: "fanout-fanin-temp", stages: [{ id: "start", entry: true }] },
          task: {
            filename: "fanout-fanin-temp.yaml",
            body: { id: "fanout-fanin-temp", goal: "Try fanout" },
          },
        },
        allowInvalid: true,
      });
      expect(normalized.ok).toBe(true);
      if (!normalized.ok) return;
      expect(normalized.pipelinePath).toBe("workshop/fanout-fanin-temp.pipeline.yaml");
      expect(normalized.taskPath).toBe("workshop/fanout-fanin-temp.task.yaml");
      await access(path.join(root, "workshop/fanout-fanin-temp.pipeline.yaml"));
      await access(path.join(root, "workshop/fanout-fanin-temp.task.yaml"));

      const outsideRoot = path.join(path.dirname(root), `sf-escape-${path.basename(root)}`);
      await mkdir(outsideRoot, { recursive: true });
      const escapePath = path.join(outsideRoot, "escape.yaml");
      const escapeRel = path
        .relative(path.join(root, "pipelines"), escapePath)
        .replace(/\\/g, "/");

      const escaped: DraftPackage = {
        pipeline: {
          id: "demo",
          stages: [{ id: "clarify", uses: escapeRel, entry: true }],
        },
        stages: [
          {
            path: escapeRel,
            body: {
              id: "clarify",
              system_prompt: "Escape",
              model: MODEL,
              ...REQUIRED_IO,
            },
          },
        ],
      };
      const result = await overwriteDraftPackage(root, {
        directory: "pipelines",
        draft: escaped,
        allowInvalid: true,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/escapes project root/i);
      await expect(readFile(escapePath, "utf8")).rejects.toThrow();
      await rm(outsideRoot, { recursive: true, force: true });
    }));

  it("allowInvalid writes without validate gate (escape for Save invalid anyway)", () =>
    withRepo(async (root) => {
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

      const refused = await overwriteDraftPackage(root, { directory: "pipelines", draft });
      expect(refused.ok).toBe(false);

      const forced = await overwriteDraftPackage(root, {
        directory: "pipelines",
        draft,
        allowInvalid: true,
      });
      expect(forced.ok).toBe(true);
      const written = await readFile(path.join(dir, "broken.pipeline.yaml"), "utf8");
      expect(written).toContain("Still broken");
    }));
});

describe("loadDraftPackage", () => {
  it("loads pipeline + referenced stage files; task absent by default", () =>
    withRepo(async (root) => {
      const dir = await seedPackage(root);
      await writeFile(
        path.join(dir, "demo.task.yaml"),
        "id: demo-task\ngoal: Should not load unless attached\n",
        "utf8",
      );

      const loaded = await loadDraftPackage(root, "pipelines/demo.pipeline.yaml");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      expect(loaded.pipelinePath).toBe("pipelines/demo.pipeline.yaml");
      expect(loaded.destination).toEqual({
        directory: "pipelines",
        pipelineFilename: "demo.pipeline.yaml",
      });
      expect(loaded.draft.pipeline.id).toBe("demo");
      expect(loaded.draft.pipeline.stages).toHaveLength(2);
      expect(loaded.draft.stages).toHaveLength(2);
      expect(loaded.draft.stages?.[0]?.body.system_prompt).toBe("Clarify the task");
      expect(loaded.draft.task).toBeUndefined();
      expect(loaded.taskPath).toBeUndefined();
    }));

  it("optionally attaches a task when taskPath is provided", () =>
    withRepo(async (root) => {
      const dir = await seedPackage(root, {
        prompts: { clarify: "Clarify" },
        stages: [{ id: "clarify", uses: "./clarify.yaml" }],
      });
      await writeFile(
        path.join(dir, "demo.task.yaml"),
        "id: demo-task\ngoal: Attached brief\n",
        "utf8",
      );

      const loaded = await loadDraftPackage(root, "pipelines/demo.pipeline.yaml", {
        taskPath: "pipelines/demo.task.yaml",
      });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.draft.task?.filename).toBe("demo.task.yaml");
      expect(loaded.draft.task?.body.goal).toBe("Attached brief");
      expect(loaded.taskPath).toBe("pipelines/demo.task.yaml");
    }));

  it("loadTaskArtifact reads a task without loading the pipeline", () =>
    withRepo(async (root) => {
      const dir = path.join(root, "pipelines");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "solo.task.yaml"),
        "id: solo\ngoal: Standalone attach\n",
        "utf8",
      );
      const loaded = await loadTaskArtifact(root, "pipelines/solo.task.yaml");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.taskPath).toBe("pipelines/solo.task.yaml");
      expect(loaded.task.filename).toBe("solo.task.yaml");
      expect(loaded.task.body.id).toBe("solo");
      expect(loaded.task.body.goal).toBe("Standalone attach");
    }));

  it("returns 404 when the pipeline is missing", () =>
    withRepo(async (root) => {
      const loaded = await loadDraftPackage(root, "pipelines/missing.pipeline.yaml");
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.status).toBe(404);
    }));

  it("hoists uses-wrapper skill onto the stage body on load", () =>
    withRepo(async (root) => {
      const dir = path.join(root, "pipelines");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "clarify.yaml"),
        [
          "id: clarify",
          "system_prompt: Clarify",
          "model: anthropic/claude-sonnet-4-5",
          "io:",
          "  input:",
          "    schema:",
          "      type: object",
          "  output:",
          "    schema:",
          "      type: object",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(dir, "demo.pipeline.yaml"),
        [
          "id: demo",
          "stages:",
          "  - id: clarify",
          "    uses: ./clarify.yaml",
          "    skill: archify",
          "",
        ].join("\n"),
        "utf8",
      );

      const loaded = await loadDraftPackage(root, "pipelines/demo.pipeline.yaml");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.draft.pipeline.stages[0]?.skill).toBeUndefined();
      expect(loaded.draft.stages?.[0]?.body.skill).toBe("archify");
    }));
});

describe("hoistUsesWrapperSkills", () => {
  it("copies wrapper skill to body when body lacks skill, then clears wrapper", () => {
    const next = hoistUsesWrapperSkills({
      pipeline: {
        id: "demo",
        stages: [{ id: "clarify", uses: "./clarify.yaml", skill: "archify" }],
      },
      stages: [
        {
          path: "./clarify.yaml",
          body: { id: "clarify", system_prompt: "Clarify" },
        },
      ],
    });
    expect(next.pipeline.stages[0]?.skill).toBeUndefined();
    expect(next.stages?.[0]?.body.skill).toBe("archify");
  });

  it("does not overwrite an existing body skill", () => {
    const next = hoistUsesWrapperSkills({
      pipeline: {
        id: "demo",
        stages: [{ id: "clarify", uses: "./clarify.yaml", skill: "from-wrapper" }],
      },
      stages: [
        {
          path: "./clarify.yaml",
          body: { id: "clarify", skill: "from-file" },
        },
      ],
    });
    expect(next.pipeline.stages[0]?.skill).toBeUndefined();
    expect(next.stages?.[0]?.body.skill).toBe("from-file");
  });

  it("overwrite migrates wrapper skill onto the stage file", () =>
    withRepo(async (root) => {
      const draft: DraftPackage = {
        pipeline: {
          id: "demo",
          stages: [{ id: "clarify", uses: "./clarify.yaml", skill: "archify" }],
        },
        stages: [
          {
            path: "./clarify.yaml",
            body: {
              id: "clarify",
              system_prompt: "Clarify",
              model: MODEL,
              ...REQUIRED_IO,
            },
          },
        ],
      };
      const created = await createDraftPackage(root, {
        directory: "pipelines",
        draft,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const pipelineYaml = await readFile(
        path.join(root, "pipelines/demo.pipeline.yaml"),
        "utf8",
      );
      expect(pipelineYaml).not.toMatch(/skill:\s*archify/);
      const stageYaml = await readFile(path.join(root, "pipelines/clarify.yaml"), "utf8");
      expect(stageYaml).toMatch(/^skill: archify$/m);
    }));
});

describe("open → edit → overwrite (draft/catalog seam)", () => {
  it("loads a package, applies live draft edits, and overwrites known paths", () =>
    withRepo(async (root) => {
      const dir = await seedPackage(root, {
        prompts: { clarify: "Old prompt", decide: "Decide" },
        stages: [
          { id: "clarify", uses: "./clarify.yaml", entry: true, route: [{ to: "decide" }] },
          { id: "decide", uses: "./decide.yaml" },
        ],
      });

      const opened = await loadDraftPackage(root, "pipelines/demo.pipeline.yaml");
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;

      const draft: DraftPackage = {
        ...opened.draft,
        stages: [
          ...(opened.draft.stages ?? []).map((stage) =>
            stage.body.id === "clarify"
              ? {
                  ...stage,
                  body: { ...stage.body, system_prompt: "Inspector-edited clarify prompt" },
                }
              : stage,
          ),
          {
            path: "./ship.yaml",
            body: { id: "ship", system_prompt: "Ship it", model: MODEL, ...REQUIRED_IO },
          },
        ],
        pipeline: {
          ...opened.draft.pipeline,
          stages: [
            { id: "clarify", uses: "./clarify.yaml", entry: true, route: [{ to: "decide" }] },
            { id: "decide", uses: "./decide.yaml", route: [{ to: "ship" }] },
            { id: "ship", uses: "./ship.yaml" },
          ],
        },
      };

      expect((await validate(root, draft)).ok).toBe(true);

      const saved = await overwriteDraftPackage(root, {
        directory: opened.destination.directory,
        draft,
        pipelineFilename: opened.destination.pipelineFilename,
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;

      expect(saved.pipelinePath).toBe("pipelines/demo.pipeline.yaml");
      expect(await readFile(path.join(dir, "clarify.yaml"), "utf8")).toContain(
        "Inspector-edited clarify prompt",
      );
      expect(await readFile(path.join(dir, "ship.yaml"), "utf8")).toContain("Ship it");
      const pipelineYaml = await readFile(path.join(dir, "demo.pipeline.yaml"), "utf8");
      expect(pipelineYaml).toContain("to: ship");
    }));

  it("strips skill from uses wrappers on overwrite", () =>
    withRepo(async (root) => {
      const dir = await seedPackage(root, {
        prompts: { clarify: "Clarify" },
        stages: [{ id: "clarify", uses: "./clarify.yaml", entry: true }],
      });
      const opened = await loadDraftPackage(root, "pipelines/demo.pipeline.yaml");
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;

      const draft: DraftPackage = {
        ...opened.draft,
        stages: (opened.draft.stages ?? []).map((stage) =>
          stage.body.id === "clarify"
            ? { ...stage, body: { ...stage.body, skill: "archify" } }
            : stage,
        ),
        pipeline: {
          ...opened.draft.pipeline,
          stages: [
            {
              id: "clarify",
              uses: "./clarify.yaml",
              entry: true,
              skill: "should-not-persist",
            },
          ],
        },
      };

      const saved = await overwriteDraftPackage(root, {
        directory: opened.destination.directory,
        draft,
        pipelineFilename: opened.destination.pipelineFilename,
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;

      const pipelineYaml = await readFile(path.join(dir, "demo.pipeline.yaml"), "utf8");
      expect(pipelineYaml).not.toContain("should-not-persist");
      expect(pipelineYaml).not.toMatch(/skill:\s/);
      expect(await readFile(path.join(dir, "clarify.yaml"), "utf8")).toContain(
        "skill: archify",
      );
    }));
});

function useStageflowHome(home: string): string {
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  resetWorkspaceProvisionForTests();
  return home;
}

describe("publishDraftPackage workspace catalog", () => {
  it("writes under a slug directory without editing stageflow.yaml", async () =>
    withIsolatedHome(async (home) => {
      const sfHome = useStageflowHome(home);
      expect(ensureWorkspaceCatalog(sfHome).ok).toBe(true);
      const ws = workspaceCatalogPath(sfHome);
      const manifestBefore = await readFile(path.join(ws, "stageflow.yaml"), "utf8");
      const published = await publishDraftPackage(
        ws,
        {
          directory: "ws-slug",
          draft: validInlineDraft({ id: "ws-slug" }),
        },
        "create",
        { catalogRootKind: "workspace" },
      );
      expect(published.write.ok).toBe(true);
      expect(published.catalogChanged).toBe(false);
      expect(await readFile(path.join(ws, "stageflow.yaml"), "utf8")).toBe(
        manifestBefore,
      );
      await access(path.join(ws, "ws-slug", "ws-slug.pipeline.yaml"));
    }));
});

describe("Workshop Author save tool facade", () => {
  it("save tool validate-then-writes and defaults an omitted directory", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await mkdir(path.join(root, "pipelines"), { recursive: true });
      const {
        createSaveTool,
        createWorkshopDraftContext,
        emptyDraftPackage,
      } = await import("../src/operatorAgent/index.js");

      const save = createSaveTool({ projectRoot: root });
      let context: unknown = createWorkshopDraftContext(
        emptyDraftPackage("tool-save"),
        { projectRoot: root },
      );
      const ctx = {
        getContext: () => context,
        setContext: (next: unknown) => {
          context = next;
        },
        emitProposal: () => {},
      };

      const missing = await save.handler({}, ctx);
      expect(missing.ok).toBe(false);
      expect(missing.error).toMatch(/stages must be non-empty/i);

      const draft: DraftPackage = {
        pipeline: {
          id: "tool-save",
          stages: [{ id: "clarify", uses: "./clarify.yaml", entry: true }],
        },
        stages: [
          {
            path: "./clarify.yaml",
            body: {
              id: "clarify",
              system_prompt: "Clarify",
              model: MODEL,
              ...REQUIRED_IO,
            },
          },
        ],
      };
      context = createWorkshopDraftContext(draft, {
        destination: { directory: "pipelines" },
        projectRoot: root,
      });

      const written = await save.handler({ mode: "create" }, ctx);
      expect(written.ok).toBe(true);
      const yaml = await readFile(
        path.join(root, "pipelines", "tool-save.pipeline.yaml"),
        "utf8",
      );
      expect(yaml).toContain("tool-save");

      context = createWorkshopDraftContext(
        {
          pipeline: {
            id: "tool-save-bad",
            stages: [{ id: "plan", system_prompt: "x", model: MODEL }],
          },
        },
        {
          destination: { directory: "pipelines" },
          projectRoot: root,
        },
      );
      const blocked = await save.handler({ mode: "create" }, ctx);
      expect(blocked.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("save ignores LLM projectRoot / project_root args and uses host-bound context only", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await mkdir(path.join(root, "pipelines"), { recursive: true });
      const outsider = await initTempGitRepo();
      try {
        const {
          createSaveTool,
          createWorkshopDraftContext,
        } = await import("../src/operatorAgent/index.js");

        const draft: DraftPackage = {
          pipeline: {
            id: "bound-root",
            stages: [{ id: "clarify", uses: "./clarify.yaml", entry: true }],
          },
          stages: [
            {
              path: "./clarify.yaml",
              body: {
                id: "clarify",
                system_prompt: "Clarify",
                model: MODEL,
                ...REQUIRED_IO,
              },
            },
          ],
        };

        const save = createSaveTool();
        let context: unknown = createWorkshopDraftContext(draft, {
          destination: { directory: "pipelines" },
          projectRoot: root,
        });
        const ctx = {
          getContext: () => context,
          setContext: (next: unknown) => {
            context = next;
          },
          emitProposal: () => {},
        };

        const written = await save.handler(
          {
            mode: "create",
            projectRoot: outsider.root,
            project_root: outsider.root,
          },
          ctx,
        );
        expect(written.ok).toBe(true);
        const yaml = await readFile(
          path.join(root, "pipelines", "bound-root.pipeline.yaml"),
          "utf8",
        );
        expect(yaml).toContain("bound-root");
        await expect(
          readFile(
            path.join(outsider.root, "pipelines", "bound-root.pipeline.yaml"),
            "utf8",
          ),
        ).rejects.toThrow();
      } finally {
        await outsider.cleanup();
      }
    } finally {
      await cleanup();
    }
  });

  it("save without a bound projectRoot uses the workspace catalog", async () =>
    withIsolatedHome(async (home) => {
      const sfHome = useStageflowHome(home);
      expect(ensureWorkspaceCatalog(sfHome).ok).toBe(true);
      const ws = workspaceCatalogPath(sfHome);
      const { createSaveTool, createWorkshopDraftContext } = await import(
        "../src/operatorAgent/index.js"
      );
      const save = createSaveTool();
      const draft = validInlineDraft({ id: "ws-save" });
      let context: unknown = createWorkshopDraftContext(draft);
      const ctx = {
        getContext: () => context,
        setContext: (next: unknown) => {
          context = next;
        },
        emitProposal: () => {},
      };
      const written = await save.handler({ mode: "create" }, ctx);
      expect(written.ok).toBe(true);
      await access(path.join(ws, "ws-save", "ws-save.pipeline.yaml"));
    }));
});

describe("comment-preserving overwrite", () => {
  const pipelineYaml = [
    "# hand-written note",
    "id: demo",
    "independence: persistent",
    "include:",
    "  - local: ./fragment.yaml",
    "stages:",
    "  - id: plan",
    '    system_prompt: "Do the work"',
    `    model: ${MODEL}`,
    "    io:",
    "      input:",
    "        schema:",
    "          type: object",
    "      output:",
    "        schema:",
    "          type: object",
    "",
  ].join("\n");

  async function seedHandWritten(root: string): Promise<string> {
    const dir = path.join(root, "pipelines");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "fragment.yaml"), "stages: []\n", "utf8");
    await writeFile(path.join(dir, "demo.pipeline.yaml"), pipelineYaml, "utf8");
    return dir;
  }

  function draftWithPrompt(prompt: string): DraftPackage {
    return {
      pipeline: {
        id: "demo",
        stages: [
          {
            id: "plan",
            system_prompt: prompt,
            model: MODEL,
            ...REQUIRED_IO,
          },
        ],
      },
    };
  }

  it("keeps a comment and unknown top-level keys when one field is saved", () =>
    withRepo(async (root) => {
      const dir = await seedHandWritten(root);
      const file = path.join(dir, "demo.pipeline.yaml");
      const before = await readFile(file, "utf8");
      const loaded = await loadDraftPackage(root, "pipelines/demo.pipeline.yaml");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      const untouched = await overwriteDraftPackage(root, {
        directory: "pipelines",
        pipelineFilename: "demo.pipeline.yaml",
        draft: draftWithPrompt("Do the work"),
        baseHashes: loaded.fileHashes,
      });
      expect(untouched.ok).toBe(true);
      if (!untouched.ok) return;
      expect(await readFile(file, "utf8")).toBe(before);

      const saved = await overwriteDraftPackage(root, {
        directory: "pipelines",
        pipelineFilename: "demo.pipeline.yaml",
        draft: draftWithPrompt("Edited prompt"),
        baseHashes: untouched.fileHashes,
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      const written = await readFile(file, "utf8");
      expect(written).toContain("# hand-written note");
      expect(written).toContain("independence: persistent");
      expect(written).toContain("include:");
      expect(written).toContain("local: ./fragment.yaml");
      expect(written).toContain("Edited prompt");
      expect(written).not.toContain("Do the work");
    }));

  it("refuses the save when the file changed on disk", () =>
    withRepo(async (root) => {
      const dir = await seedHandWritten(root);
      const file = path.join(dir, "demo.pipeline.yaml");
      const loaded = await loadDraftPackage(root, "pipelines/demo.pipeline.yaml");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      const external = pipelineYaml.replace("Do the work", "Edited elsewhere");
      await writeFile(file, external, "utf8");
      const saved = await overwriteDraftPackage(root, {
        directory: "pipelines",
        pipelineFilename: "demo.pipeline.yaml",
        draft: draftWithPrompt("From the editor"),
        baseHashes: loaded.fileHashes,
      });
      expect(saved.ok).toBe(false);
      if (saved.ok) return;
      expect(saved.status).toBe(409);
      expect(saved.code).toBe("FILE_CHANGED");
      expect(saved.fileHashes).toBeDefined();
      const pipelineKey = Object.keys(saved.fileHashes!.files).find((key) =>
        key.endsWith("demo.pipeline.yaml"),
      );
      expect(pipelineKey).toBeDefined();
      expect(saved.fileHashes!.files[pipelineKey!]).not.toBe(
        loaded.fileHashes.files[pipelineKey!],
      );
      expect(await readFile(file, "utf8")).toBe(external);
    }));
});

describe("pipeline-level channels survive the draft round trip", () => {
  it("loads root channels and writes them back on overwrite", () =>
    withRepo(async (root) => {
      const dir = await seedPackage(root, { prompts: { clarify: "Clarify", decide: "Decide" } });
      const file = path.join(dir, "demo.pipeline.yaml");
      const original = await readFile(file, "utf8");
      await writeFile(
        file,
        `${original.trimEnd()}\nchannels:\n  - connection: ops\n    to: C0123ABCD\n    operations: [send]\n`,
        "utf8",
      );

      const loaded = await loadDraftPackage(root, "pipelines/demo.pipeline.yaml");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.draft.pipeline.channels).toEqual([{ connection: "ops", to: "C0123ABCD", operations: ["send"] }]);

      const result = await overwriteDraftPackage(root, { directory: "pipelines", draft: loaded.draft, allowInvalid: true });
      expect(result.ok).toBe(true);
      const written = await readFile(file, "utf8");
      expect(written).toContain("channels:");
      expect(written).toContain("connection: ops");
    }));
});

describe("atomic package overwrite", () => {
  it("refuses overwrite when baseHashes omit an existing target file", () =>
    withRepo(async (root) => {
      await seedPackage(root);
      const loaded = await loadDraftPackage(root, "pipelines/demo.pipeline.yaml");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      const partial = { files: { [loaded.pipelinePath]: loaded.fileHashes.files[loaded.pipelinePath]! } };
      const saved = await overwriteDraftPackage(root, {
        directory: "pipelines",
        draft: loaded.draft,
        baseHashes: partial,
      });
      expect(saved.ok).toBe(false);
      if (saved.ok) return;
      expect(saved.status).toBe(409);
      expect(saved.code).toBe("FILE_CHANGED");
    }));
});

describe("stage paths stay inside the project", () => {
  it("allows ../stages/ when the resolved file is still in the project", () =>
    withRepo(async (root) => {
      const stagesDir = path.join(root, "stages");
      await mkdir(stagesDir, { recursive: true });
      await writeFile(
        path.join(stagesDir, "shared.yaml"),
        [
          "id: shared",
          "system_prompt: Shared stage",
          `model: ${MODEL}`,
          "io:",
          "  input:",
          "    schema:",
          "      type: object",
          "  output:",
          "    schema:",
          "      type: object",
          "",
        ].join("\n"),
        "utf8",
      );
      const pipelinesDir = path.join(root, "pipelines");
      await mkdir(pipelinesDir, { recursive: true });
      await writeFile(
        path.join(pipelinesDir, "pool.pipeline.yaml"),
        [
          "id: pool",
          "stages:",
          "  - id: shared",
          "    uses: ../stages/shared.yaml",
          "    entry: true",
          "",
        ].join("\n"),
        "utf8",
      );

      const draft: DraftPackage = {
        pipeline: {
          id: "pool",
          stages: [{ id: "shared", uses: "../stages/shared.yaml", entry: true }],
        },
        stages: [
          {
            path: "../stages/shared.yaml",
            body: {
              id: "shared",
              system_prompt: "Shared stage updated",
              model: MODEL,
              ...REQUIRED_IO,
            },
          },
        ],
      };
      const saved = await overwriteDraftPackage(root, {
        directory: "pipelines",
        pipelineFilename: "pool.pipeline.yaml",
        draft,
      });
      expect(saved.ok).toBe(true);
      const reloaded = await loadDraftPackage(root, "pipelines/pool.pipeline.yaml");
      expect(reloaded.ok).toBe(true);
      if (!reloaded.ok) return;
      expect(reloaded.draft.stages?.[0]?.body.system_prompt).toContain("updated");
    }));

  it("refuses a symlink that escapes the project", () =>
    withRepo(async (root) => {
      const outsideRoot = path.join(path.dirname(root), `sf-outside-${path.basename(root)}`);
      await mkdir(outsideRoot, { recursive: true });
      await writeFile(
        path.join(outsideRoot, "escape.yaml"),
        [
          "id: escape",
          "system_prompt: Outside",
          `model: ${MODEL}`,
          "io:",
          "  input:",
          "    schema:",
          "      type: object",
          "  output:",
          "    schema:",
          "      type: object",
          "",
        ].join("\n"),
        "utf8",
      );
      const pkg = path.join(root, "pipelines");
      await mkdir(pkg, { recursive: true });
      await writeFile(
        path.join(pkg, "demo.pipeline.yaml"),
        "id: demo\nstages:\n  - id: plan\n    uses: ./clarify.yaml\n    entry: true\n",
        "utf8",
      );
      await symlink(path.join(outsideRoot, "escape.yaml"), path.join(pkg, "clarify.yaml"));

      const draft: DraftPackage = {
        pipeline: {
          id: "demo",
          stages: [{ id: "plan", uses: "./clarify.yaml", entry: true }],
        },
        stages: [
          {
            path: "./clarify.yaml",
            body: {
              id: "escape",
              system_prompt: "Nope",
              model: MODEL,
              ...REQUIRED_IO,
            },
          },
        ],
      };
      const result = await overwriteDraftPackage(root, {
        directory: "pipelines",
        draft,
        allowInvalid: true,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/escapes project root/i);
      await expect(readFile(path.join(outsideRoot, "escape.yaml"), "utf8")).resolves.toContain(
        "Outside",
      );
      await rm(outsideRoot, { recursive: true, force: true });
    }));

  it("refuses pipeline.id with a path separator", () =>
    withRepo(async (root) => {
      await mkdir(path.join(root, "pipelines"), { recursive: true });
      const result = await createDraftPackage(root, {
        directory: "pipelines",
        draft: validInlineDraft({ id: "nested/id" }),
        allowInvalid: true,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/path separators/i);
    }));
});

describe("include-aware validation", () => {
  async function seedIncludePackage(root: string, fragmentStages: string): Promise<void> {
    const dir = path.join(root, "pipelines");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "fragment.yaml"), `stages:\n${fragmentStages}`, "utf8");
    await writeFile(
      path.join(dir, "demo.pipeline.yaml"),
      [
        "id: demo",
        "include:",
        "  - local: ./fragment.yaml",
        "stages:",
        "  - id: plan",
        `    system_prompt: "Plan"`,
        `    model: ${MODEL}`,
        "    entry: true",
        "    route:",
        "      - to: from-frag",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  it("accepts a route to a stage that exists only in an included fragment", () =>
    withRepo(async (root) => {
      await seedIncludePackage(root, [
        "  - id: from-frag",
        `    system_prompt: Fragment stage`,
        `    model: ${MODEL}`,
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
      ].join("\n"));
      const loaded = await loadDraftPackage(root, "pipelines/demo.pipeline.yaml");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.hasInclude).toBe(true);

      const draft: DraftPackage = {
        ...loaded.draft,
        pipeline: {
          ...loaded.draft.pipeline,
          stages: [
            {
              id: "plan",
              system_prompt: "Plan edited",
              model: MODEL,
              entry: true,
              route: [{ to: "from-frag" }],
              ...REQUIRED_IO,
            },
          ],
        },
      };
      const saved = await overwriteDraftPackage(root, {
        directory: "pipelines",
        pipelineFilename: "demo.pipeline.yaml",
        draft,
        baseHashes: loaded.fileHashes,
      });
      expect(saved.ok).toBe(true);
    }));

  it("refuses a route to a missing stage from an include", () =>
    withRepo(async (root) => {
      await seedIncludePackage(root, "");
      await writeFile(path.join(root, "pipelines", "fragment.yaml"), "stages: []\n", "utf8");
      const loaded = await loadDraftPackage(root, "pipelines/demo.pipeline.yaml");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      const draft: DraftPackage = {
        ...loaded.draft,
        pipeline: {
          ...loaded.draft.pipeline,
          stages: [
            {
              id: "plan",
              system_prompt: "Plan",
              model: MODEL,
              entry: true,
              route: [{ to: "from-frag" }],
              ...REQUIRED_IO,
            },
          ],
        },
      };
      const saved = await overwriteDraftPackage(root, {
        directory: "pipelines",
        pipelineFilename: "demo.pipeline.yaml",
        draft,
        allowInvalid: false,
      });
      expect(saved.ok).toBe(false);
      if (saved.ok) return;
      expect(saved.status).toBe(422);
    }));
});

describe("Workshop save passes package hashes", () => {
  it("sends baseHashes from context and returns refreshed hashes on success", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedPackage(root);
      const loaded = await loadDraftPackage(root, "pipelines/demo.pipeline.yaml");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      const {
        createSaveTool,
        createWorkshopDraftContext,
      } = await import("../src/operatorAgent/index.js");
      const { isWorkshopDraftContext } = await import("../src/operatorAgent/draftContext.js");

      const draft = validFilePackageDraft();
      draft.stages![0]!.body.system_prompt = "Workshop hash save";
      const save = createSaveTool({ projectRoot: root });
      let context: unknown = createWorkshopDraftContext(draft, {
        destination: { directory: "pipelines", pipelineFilename: "demo.pipeline.yaml" },
        projectRoot: root,
        fileHashes: loaded.fileHashes,
      });
      const ctx = {
        getContext: () => context,
        setContext: (next: unknown) => {
          context = next;
        },
        emitProposal: () => {},
      };

      const written = await save.handler({ mode: "overwrite" }, ctx);
      expect(written.ok).toBe(true);
      const content = written.content as { fileHashes?: { files: Record<string, string> } };
      expect(content.fileHashes?.files).toBeDefined();
      expect(isWorkshopDraftContext(context)).toBe(true);
      if (isWorkshopDraftContext(context)) {
        expect(context.fileHashes?.files).toBeDefined();
      }
    } finally {
      await cleanup();
    }
  });
});
