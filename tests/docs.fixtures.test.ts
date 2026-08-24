import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadStage } from "../src/config/loadStage.js";
import { loadTask } from "../src/config/loadTask.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const provingStageIds = ["plan-review", "plan-review-followup"] as const;
const fourKindsStageIds = ["hitl-four-kinds"] as const;
const liveStyleModel = "cursor/composer-2-5";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function materializeLiveStyleStages(
  tmpRoot: string,
  stageIds: readonly string[],
): Promise<void> {
  for (const stageId of stageIds) {
    const raw = await readFile(
      path.join(fixtures, "stages", `${stageId}.yaml`),
      "utf8",
    );
    const rewritten = raw.replace(/^model:\s*.+$/m, `model: ${liveStyleModel}`);
    await writeFile(path.join(tmpRoot, "stages", `${stageId}.yaml`), rewritten);
  }
}

async function materializeLiveStyleCatalog(tmpRoot: string): Promise<void> {
  await mkdir(path.join(tmpRoot, "pipelines"), { recursive: true });
  await mkdir(path.join(tmpRoot, "tasks"), { recursive: true });
  await mkdir(path.join(tmpRoot, "stages"), { recursive: true });

  await writeFile(
    path.join(tmpRoot, "pipelines", "plan-review-proving.yaml"),
    await readFile(
      path.join(fixtures, "pipelines", "plan-review-proving.yaml"),
      "utf8",
    ),
  );
  await writeFile(
    path.join(tmpRoot, "tasks", "prove-plan-review.yaml"),
    await readFile(path.join(fixtures, "tasks", "prove-plan-review.yaml"), "utf8"),
  );
  await materializeLiveStyleStages(tmpRoot, provingStageIds);
}

async function materializeFourKindsLiveStyleCatalog(
  tmpRoot: string,
): Promise<void> {
  await mkdir(path.join(tmpRoot, "pipelines"), { recursive: true });
  await mkdir(path.join(tmpRoot, "tasks"), { recursive: true });
  await mkdir(path.join(tmpRoot, "stages"), { recursive: true });

  await writeFile(
    path.join(tmpRoot, "pipelines", "hitl-four-kinds-proving.yaml"),
    await readFile(
      path.join(fixtures, "pipelines", "hitl-four-kinds-proving.yaml"),
      "utf8",
    ),
  );
  await writeFile(
    path.join(tmpRoot, "tasks", "prove-hitl-four-kinds.yaml"),
    await readFile(
      path.join(fixtures, "tasks", "prove-hitl-four-kinds.yaml"),
      "utf8",
    ),
  );
  await materializeLiveStyleStages(tmpRoot, fourKindsStageIds);
}

describe("docs-only proving fixtures", () => {
  it("loads fixture stages/pipelines/tasks without error", async () => {
    const task = await loadTask(path.join(fixtures, "tasks", "sample.yaml"));
    expect(task.id).toBe("sample");

    const loaded = await loadPipeline("docs-only", {
      cwd: fixtures,
      stagesDir: path.join(fixtures, "stages"),
    });
    expect(loaded.stages.map((s) => s.id)).toEqual([
      "clarify",
      "design-doc",
      "implementation-plan",
    ]);
    expect(loaded.dag.nodes).toHaveLength(3);
  });
});

describe("plan-review-proving catalog", () => {
  it("loads fixture pipeline with plan-review then plan-review-followup", async () => {
    const task = await loadTask(
      path.join(fixtures, "tasks", "prove-plan-review.yaml"),
    );
    expect(task.id).toBe("prove-plan-review");

    const loaded = await loadPipeline("plan-review-proving", {
      cwd: fixtures,
      stagesDir: path.join(fixtures, "stages"),
    });
    expect(loaded.pipeline.stages).toEqual([
      "plan-review",
      "plan-review-followup",
    ]);
    expect(loaded.stages.map((s) => s.id)).toEqual(loaded.pipeline.stages);
  });

  it("loads live-style catalog from temp materialization with the same stage ids", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "sf-live-catalog-"));
    try {
      await materializeLiveStyleCatalog(tmpRoot);

      const task = await loadTask(
        path.join(tmpRoot, "tasks", "prove-plan-review.yaml"),
      );
      expect(task.id).toBe("prove-plan-review");

      const loaded = await loadPipeline("plan-review-proving", {
        cwd: tmpRoot,
      });
      expect(loaded.pipeline.stages).toEqual([
        "plan-review",
        "plan-review-followup",
      ]);
      expect(loaded.stages.map((s) => s.id)).toEqual(loaded.pipeline.stages);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("keeps fixture↔live-style parity on HITL-critical fields", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "sf-live-parity-"));
    try {
      await materializeLiveStyleCatalog(tmpRoot);

      const fixturePipeline = await loadPipeline("plan-review-proving", {
        cwd: fixtures,
        stagesDir: path.join(fixtures, "stages"),
      });
      const livePipeline = await loadPipeline("plan-review-proving", {
        cwd: tmpRoot,
      });

      expect(fixturePipeline.pipeline.id).toBe(livePipeline.pipeline.id);
      expect(fixturePipeline.pipeline.stages).toEqual(livePipeline.pipeline.stages);

      for (const stageId of fixturePipeline.pipeline.stages) {
        const fixtureStage = await loadStage(
          path.join(fixtures, "stages", `${stageId}.yaml`),
        );
        const liveStage = await loadStage(
          path.join(tmpRoot, "stages", `${stageId}.yaml`),
        );
        expect(fixtureStage.id).toBe(liveStage.id);
        expect(fixtureStage.system_prompt).toBe(liveStage.system_prompt);
        expect(liveStage.model).toBe(liveStyleModel);
        expect(fixtureStage.model).not.toBe(liveStage.model);
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("encodes ask_operator artifact review and emit-after-confirm in plan-review prompts", async () => {
    const stage = await loadStage(
      path.join(fixtures, "stages", "plan-review.yaml"),
    );
    expect(stage.system_prompt).toMatch(/ask_operator/);
    expect(stage.system_prompt).toMatch(/artifact_backed/);
    expect(stage.system_prompt).toMatch(/write_stage_artifact/);
    expect(stage.system_prompt).toMatch(/Never emit before plan accept/);
    expect(stage.system_prompt).toMatch(/emit_stage_envelope/);

    const followup = await loadStage(
      path.join(fixtures, "stages", "plan-review-followup.yaml"),
    );
    expect(followup.system_prompt).toMatch(/emit_stage_envelope/);
    expect(followup.system_prompt).toMatch(/Do not call\s+ask_operator/);
  });

  it("soft-checks repo-root live catalog when present", async () => {
    const livePipelinePath = path.join(
      repoRoot,
      "pipelines",
      "plan-review-proving.yaml",
    );
    if (!(await pathExists(livePipelinePath))) {
      return;
    }

    const loaded = await loadPipeline("plan-review-proving", {
      cwd: repoRoot,
    });
    expect(loaded.pipeline.stages).toEqual([
      "plan-review",
      "plan-review-followup",
    ]);

    for (const stageId of provingStageIds) {
      const fixtureStage = await loadStage(
        path.join(fixtures, "stages", `${stageId}.yaml`),
      );
      const liveStage = await loadStage(
        path.join(repoRoot, "stages", `${stageId}.yaml`),
      );
      expect(fixtureStage.system_prompt).toBe(liveStage.system_prompt);
    }
  });
});

describe("hitl-four-kinds-proving catalog", () => {
  it("loads fixture pipeline with hitl-four-kinds", async () => {
    const task = await loadTask(
      path.join(fixtures, "tasks", "prove-hitl-four-kinds.yaml"),
    );
    expect(task.id).toBe("prove-hitl-four-kinds");

    const loaded = await loadPipeline("hitl-four-kinds-proving", {
      cwd: fixtures,
      stagesDir: path.join(fixtures, "stages"),
    });
    expect(loaded.pipeline.stages).toEqual(["hitl-four-kinds"]);
    expect(loaded.stages.map((s) => s.id)).toEqual(loaded.pipeline.stages);
  });

  it("loads live-style catalog from temp materialization with the same stage ids", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "sf-four-kinds-catalog-"));
    try {
      await materializeFourKindsLiveStyleCatalog(tmpRoot);

      const task = await loadTask(
        path.join(tmpRoot, "tasks", "prove-hitl-four-kinds.yaml"),
      );
      expect(task.id).toBe("prove-hitl-four-kinds");

      const loaded = await loadPipeline("hitl-four-kinds-proving", {
        cwd: tmpRoot,
      });
      expect(loaded.pipeline.stages).toEqual(["hitl-four-kinds"]);
      expect(loaded.stages.map((s) => s.id)).toEqual(loaded.pipeline.stages);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("keeps fixture↔live-style parity on HITL-critical fields", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "sf-four-kinds-parity-"));
    try {
      await materializeFourKindsLiveStyleCatalog(tmpRoot);

      const fixturePipeline = await loadPipeline("hitl-four-kinds-proving", {
        cwd: fixtures,
        stagesDir: path.join(fixtures, "stages"),
      });
      const livePipeline = await loadPipeline("hitl-four-kinds-proving", {
        cwd: tmpRoot,
      });

      expect(fixturePipeline.pipeline.id).toBe(livePipeline.pipeline.id);
      expect(fixturePipeline.pipeline.stages).toEqual(livePipeline.pipeline.stages);

      for (const stageId of fixturePipeline.pipeline.stages) {
        const fixtureStage = await loadStage(
          path.join(fixtures, "stages", `${stageId}.yaml`),
        );
        const liveStage = await loadStage(
          path.join(tmpRoot, "stages", `${stageId}.yaml`),
        );
        expect(fixtureStage.id).toBe(liveStage.id);
        expect(fixtureStage.system_prompt).toBe(liveStage.system_prompt);
        expect(liveStage.model).toBe(liveStyleModel);
        expect(fixtureStage.model).not.toBe(liveStage.model);
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("encodes all four ask_operator kinds in fixed order before emit", async () => {
    const stage = await loadStage(
      path.join(fixtures, "stages", "hitl-four-kinds.yaml"),
    );
    expect(stage.system_prompt).toMatch(/ask_operator/);
    expect(stage.system_prompt).toMatch(/free_text/);
    expect(stage.system_prompt).toMatch(/confirm/);
    expect(stage.system_prompt).toMatch(/multi_question/);
    expect(stage.system_prompt).toMatch(/artifact_backed/);
    expect(stage.system_prompt).toMatch(/write_stage_artifact/);
    expect(stage.system_prompt).toMatch(/emit_stage_envelope/);
    expect(stage.system_prompt).toMatch(
      /Never call emit_stage_envelope until all\s+four answers are received/,
    );

    const freeIdx = stage.system_prompt.indexOf("1. free_text");
    const confirmIdx = stage.system_prompt.indexOf("2. confirm");
    const multiIdx = stage.system_prompt.indexOf("3. multi_question");
    const artifactIdx = stage.system_prompt.indexOf("4. artifact_backed");
    expect(freeIdx).toBeGreaterThan(-1);
    expect(confirmIdx).toBeGreaterThan(freeIdx);
    expect(multiIdx).toBeGreaterThan(confirmIdx);
    expect(artifactIdx).toBeGreaterThan(multiIdx);
  });

  it("soft-checks repo-root live catalog when present", async () => {
    const livePipelinePath = path.join(
      repoRoot,
      "pipelines",
      "hitl-four-kinds-proving.yaml",
    );
    if (!(await pathExists(livePipelinePath))) {
      return;
    }

    const loaded = await loadPipeline("hitl-four-kinds-proving", {
      cwd: repoRoot,
    });
    expect(loaded.pipeline.stages).toEqual(["hitl-four-kinds"]);

    for (const stageId of fourKindsStageIds) {
      const fixtureStage = await loadStage(
        path.join(fixtures, "stages", `${stageId}.yaml`),
      );
      const liveStage = await loadStage(
        path.join(repoRoot, "stages", `${stageId}.yaml`),
      );
      expect(fixtureStage.system_prompt).toBe(liveStage.system_prompt);
    }
  });
});
