import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPipeline,
  normalizeCreatePipelineStages,
  parseCreatePipelineBody,
  pipelineConfigToYaml,
} from "../src/config/createPipeline.js";
import { loadPipeline } from "../src/config/loadPipeline.js";

describe("parseCreatePipelineBody", () => {
  it("accepts valid input and rejects invalid shape", () => {
    expect(
      parseCreatePipelineBody({
        id: "plan-review-proving",
        stages: ["plan-review", "plan-review-followup"],
      }),
    ).toEqual({
      id: "plan-review-proving",
      stages: ["plan-review", "plan-review-followup"],
    });

    expect(parseCreatePipelineBody(null)).toEqual({
      ok: false,
      status: 400,
      error: "Request body must be an object",
    });
    expect(parseCreatePipelineBody({ id: "ok", stages: [] })).toEqual({
      ok: false,
      status: 400,
      error: "stages must be a non-empty array",
    });
    expect(parseCreatePipelineBody({ id: "ok", stages: [1] })).toEqual({
      ok: false,
      status: 400,
      error: "stages must be an array of strings",
    });
    expect(parseCreatePipelineBody({ id: "Bad", stages: ["a"] })).toEqual({
      ok: false,
      status: 400,
      error: "id must be lowercase kebab-case",
    });
  });

  it("accepts DAG-shaped stage entries", () => {
    expect(
      parseCreatePipelineBody({
        id: "fan-out",
        stages: [{ id: "a" }, { id: "b", needs: "a" }],
      }),
    ).toEqual({
      id: "fan-out",
      stages: [{ id: "a" }, { id: "b", needs: "a" }],
    });
  });

  it("rejects mixed string and object stage arrays", () => {
    expect(
      parseCreatePipelineBody({
        id: "mixed",
        stages: ["a", { id: "b" }],
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "stages must be either all strings or all objects",
    });
  });

  it("rejects object entries missing id or with non-string needs", () => {
    expect(
      parseCreatePipelineBody({
        id: "bad-object",
        stages: [{}],
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "stages[0].id is required",
    });

    expect(
      parseCreatePipelineBody({
        id: "bad-needs",
        stages: [{ id: "a", needs: 1 }],
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "stages[0].needs must be a string",
    });
  });
});

describe("normalizeCreatePipelineStages", () => {
  it("maps string arrays to stage refs without needs", () => {
    expect(normalizeCreatePipelineStages(["a", "b"])).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
  });
});

describe("pipelineConfigToYaml", () => {
  it("writes sparse YAML with ordered stages", () => {
    expect(
      pipelineConfigToYaml(
        {
          id: "single",
          stages: [{ id: "clarify" }],
        },
        { format: "linear" },
      ),
    ).toBe(["id: single", "stages:", "  - clarify", ""].join("\n"));

    expect(
      pipelineConfigToYaml(
        {
          id: "plan-review-proving",
          stages: [{ id: "plan-review" }, { id: "plan-review-followup" }],
        },
        { format: "linear" },
      ),
    ).toBe(
      [
        "id: plan-review-proving",
        "stages:",
        "  - plan-review",
        "  - plan-review-followup",
        "",
      ].join("\n"),
    );
  });

  it("writes object-form DAG YAML with per-stage needs", () => {
    expect(
      pipelineConfigToYaml(
        {
          id: "recon-review",
          stages: [
            { id: "recon" },
            { id: "improve-a", needs: "recon" },
            { id: "improve-b", needs: "recon" },
            { id: "improve-c", needs: "recon" },
          ],
        },
        { format: "dag" },
      ),
    ).toBe(
      [
        "id: recon-review",
        "stages:",
        "  - id: recon",
        "  - id: improve-a",
        "    needs: recon",
        "  - id: improve-b",
        "    needs: recon",
        "  - id: improve-c",
        "    needs: recon",
        "",
      ].join("\n"),
    );
  });
});

describe("createPipeline", () => {
  async function writeStage(
    cwd: string,
    id: string,
    extra = "",
  ): Promise<void> {
    await mkdir(path.join(cwd, "stages"), { recursive: true });
    await writeFile(
      path.join(cwd, "stages", `${id}.yaml`),
      [
        `id: ${id}`,
        "system_prompt: Do the thing.",
        "model: cursor/auto",
        extra,
        "",
      ].join("\n"),
    );
  }

  it("creates pipeline file, rejects collisions, and round-trips through loadPipeline", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-create-pipeline-"));

    try {
      await writeStage(cwd, "alpha");
      await writeStage(cwd, "beta", "gate_kinds:\n  - confirm");

      const created = await createPipeline(cwd, {
        id: "new-pipeline",
        stages: ["alpha", "beta"],
      });
      expect(created).toEqual({
        ok: true,
        pipeline: {
          path: "pipelines/new-pipeline.yaml",
          id: "new-pipeline",
          stages: [{ id: "alpha" }, { id: "beta", gate_kinds: ["confirm"] }],
        },
      });

      const yaml = await readFile(path.join(cwd, "pipelines", "new-pipeline.yaml"), "utf8");
      expect(yaml).toBe(
        ["id: new-pipeline", "stages:", "  - alpha", "  - beta", ""].join("\n"),
      );
      await expect(loadPipeline(path.join(cwd, "pipelines", "new-pipeline.yaml"), { cwd })).resolves.toMatchObject({
        pipeline: { id: "new-pipeline", stages: ["alpha", "beta"] },
      });

      const pathCollision = await createPipeline(cwd, {
        id: "new-pipeline",
        stages: ["alpha"],
      });
      expect(pathCollision).toEqual({
        ok: false,
        status: 409,
        error: "Pipeline id already exists (pipelines/new-pipeline.yaml)",
      });

      await writeFile(
        path.join(cwd, "pipelines", "alias.yaml"),
        ["id: other-id", "stages:", "  - alpha", ""].join("\n"),
      );
      const yamlIdCollision = await createPipeline(cwd, {
        id: "other-id",
        stages: ["alpha"],
      });
      expect(yamlIdCollision).toEqual({
        ok: false,
        status: 409,
        error: "Pipeline id already exists (pipelines/alias.yaml)",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns 422 for duplicate or missing stage references", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-create-pipeline-422-"));

    try {
      await writeStage(cwd, "alpha");

      const duplicate = await createPipeline(cwd, {
        id: "dup-stages",
        stages: ["alpha", "alpha"],
      });
      expect(duplicate).toEqual({
        ok: false,
        status: 422,
        error: "Pipeline stages must not contain duplicates",
      });

      const missing = await createPipeline(cwd, {
        id: "missing-stage",
        stages: ["alpha", "gone"],
      });
      expect(missing).toEqual({
        ok: false,
        status: 422,
        error: "one or more selected Stages no longer exist",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("creates pipelines directory when missing", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-create-pipeline-empty-"));

    try {
      await writeStage(cwd, "only");

      const created = await createPipeline(cwd, {
        id: "first",
        stages: ["only"],
      });
      expect(created.ok).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("creates fan-out DAG pipeline with object-form YAML (AE1)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-create-pipeline-dag-"));

    try {
      await writeStage(cwd, "recon");
      await writeStage(cwd, "improve-a");
      await writeStage(cwd, "improve-b");
      await writeStage(cwd, "improve-c");

      const created = await createPipeline(cwd, {
        id: "recon-review",
        stages: [
          { id: "recon" },
          { id: "improve-a", needs: "recon" },
          { id: "improve-b", needs: "recon" },
          { id: "improve-c", needs: "recon" },
        ],
      });
      expect(created.ok).toBe(true);

      const yaml = await readFile(path.join(cwd, "pipelines", "recon-review.yaml"), "utf8");
      expect(yaml).toBe(
        [
          "id: recon-review",
          "stages:",
          "  - id: recon",
          "  - id: improve-a",
          "    needs: recon",
          "  - id: improve-b",
          "    needs: recon",
          "  - id: improve-c",
          "    needs: recon",
          "",
        ].join("\n"),
      );

      const loaded = await loadPipeline(path.join(cwd, "pipelines", "recon-review.yaml"), { cwd });
      expect(loaded.dag.roots).toEqual(["recon"]);
      expect(loaded.pipeline.stages).toEqual([
        "recon",
        "improve-a",
        "improve-b",
        "improve-c",
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects dependency cycles without writing a file (AE2)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-create-pipeline-cycle-"));

    try {
      await writeStage(cwd, "a");
      await writeStage(cwd, "b");

      const result = await createPipeline(cwd, {
        id: "cycle",
        stages: [{ id: "a", needs: "b" }, { id: "b", needs: "a" }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(422);
      expect(result.error).toContain("dependency cycle detected");

      await expect(
        access(path.join(cwd, "pipelines", "cycle.yaml")),
      ).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects needs targeting a stage not in the pipeline (AE3)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-create-pipeline-bad-needs-"));

    try {
      await writeStage(cwd, "a");
      await writeStage(cwd, "b");

      const result = await createPipeline(cwd, {
        id: "bad-needs",
        stages: [{ id: "a" }, { id: "b", needs: "missing" }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(422);
      expect(result.error).toContain("unknown needs");

      await expect(
        access(path.join(cwd, "pipelines", "bad-needs.yaml")),
      ).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("creates linear pipeline from string list with implicit chain (AE4)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-create-pipeline-linear-"));

    try {
      await writeStage(cwd, "alpha");
      await writeStage(cwd, "beta");
      await writeStage(cwd, "gamma");

      const created = await createPipeline(cwd, {
        id: "linear-chain",
        stages: ["alpha", "beta", "gamma"],
      });
      expect(created.ok).toBe(true);

      const yaml = await readFile(path.join(cwd, "pipelines", "linear-chain.yaml"), "utf8");
      expect(yaml).toBe(
        ["id: linear-chain", "stages:", "  - alpha", "  - beta", "  - gamma", ""].join("\n"),
      );

      const loaded = await loadPipeline(path.join(cwd, "pipelines", "linear-chain.yaml"), { cwd });
      expect(loaded.pipeline.stages).toEqual(["alpha", "beta", "gamma"]);
      const betaNode = loaded.dag.nodes.find((node) => node.id === "beta");
      expect(betaNode?.needs).toBe("alpha");
      const gammaNode = loaded.dag.nodes.find((node) => node.id === "gamma");
      expect(gammaNode?.needs).toBe("beta");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
