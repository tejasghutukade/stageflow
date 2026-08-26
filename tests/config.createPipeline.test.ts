import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPipeline,
  normalizeCreatePipelineStages,
  parseCreatePipelineBody,
  pipelineConfigToYaml,
} from "../src/config/createPipeline.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

function stageRef(id: string, needs?: string) {
  return needs
    ? { id, uses: `./${id}.yaml`, needs }
    : { id, uses: `./${id}.yaml` };
}

describe("parseCreatePipelineBody", () => {
  it("accepts valid object stage entries and rejects invalid shape", () => {
    expect(
      parseCreatePipelineBody({
        directory: "pipelines",
        id: "plan-review-proving",
        stages: [stageRef("plan-review"), stageRef("plan-review-followup")],
      }),
    ).toEqual({
      directory: "pipelines",
      id: "plan-review-proving",
      stages: [stageRef("plan-review"), stageRef("plan-review-followup")],
    });

    expect(parseCreatePipelineBody(null)).toEqual({
      ok: false,
      status: 400,
      error: "Request body must be an object",
    });
    expect(parseCreatePipelineBody({ id: "ok", stages: [] })).toEqual({
      ok: false,
      status: 400,
      error: "directory is required",
    });
    expect(parseCreatePipelineBody({ directory: "pipelines", id: "ok", stages: [] })).toEqual({
      ok: false,
      status: 400,
      error: "stages must be a non-empty array",
    });
    expect(parseCreatePipelineBody({ directory: "pipelines", id: "ok", stages: [1] })).toEqual({
      ok: false,
      status: 400,
      error: "stages[0] must be an object with id",
    });
    expect(parseCreatePipelineBody({ directory: "pipelines", id: "Bad", stages: [stageRef("a")] })).toEqual({
      ok: false,
      status: 400,
      error: "id must be lowercase kebab-case",
    });
  });

  it("rejects bare string stage refs", () => {
    expect(
      parseCreatePipelineBody({
        directory: "pipelines",
        id: "linear",
        stages: ["plan-review"],
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error:
        'stages[0]: bare string stage refs are not supported; use { id: "plan-review", uses: "./plan-review.yaml" } or inline body',
    });
  });

  it("accepts DAG-shaped stage entries", () => {
    expect(
      parseCreatePipelineBody({
        directory: "pipelines",
        id: "fan-out",
        stages: [{ id: "a", uses: "./a.yaml" }, { id: "b", uses: "./b.yaml", needs: "a" }],
      }),
    ).toEqual({
      directory: "pipelines",
      id: "fan-out",
      stages: [{ id: "a", uses: "./a.yaml" }, { id: "b", uses: "./b.yaml", needs: "a" }],
    });
  });

  it("rejects mixed string and object stage arrays", () => {
    expect(
      parseCreatePipelineBody({
        directory: "pipelines",
        id: "mixed",
        stages: ["a", { id: "b", uses: "./b.yaml" }],
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error:
        'stages[0]: bare string stage refs are not supported; use { id: "a", uses: "./a.yaml" } or inline body',
    });
  });

  it("rejects object entries missing id or with non-string needs", () => {
    expect(
      parseCreatePipelineBody({
        directory: "pipelines",
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
        directory: "pipelines",
        id: "bad-needs",
        stages: [{ id: "a", uses: "./a.yaml", needs: 1 }],
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "stages[0].needs must be a string",
    });
  });
});

describe("normalizeCreatePipelineStages", () => {
  it("defaults uses paths for object refs without inline bodies", () => {
    expect(normalizeCreatePipelineStages([{ id: "a" }, { id: "b" }])).toEqual([
      { id: "a", uses: "./a.yaml" },
      { id: "b", uses: "./b.yaml" },
    ]);
  });
});

describe("pipelineConfigToYaml", () => {
  it("writes pipeline-owned YAML with uses refs", () => {
    expect(
      pipelineConfigToYaml(
        {
          id: "single",
          stages: [{ id: "clarify", uses: "./clarify.yaml" }],
        },
        { format: "linear" },
      ),
    ).toBe(
      ["id: single", "stages:", "  - id: clarify", "    uses: ./clarify.yaml", ""].join("\n"),
    );
  });

  it("writes object-form DAG YAML with per-stage needs", () => {
    expect(
      pipelineConfigToYaml(
        {
          id: "recon-review",
          stages: [
            { id: "recon", uses: "./recon.yaml" },
            { id: "improve-a", uses: "./improve-a.yaml", needs: "recon" },
          ],
        },
        { format: "dag" },
      ),
    ).toBe(
      [
        "id: recon-review",
        "stages:",
        "  - id: recon",
        "    uses: ./recon.yaml",
        "  - id: improve-a",
        "    needs: recon",
        "    uses: ./improve-a.yaml",
        "",
      ].join("\n"),
    );
  });
});

describe("createPipeline", () => {
  async function writeStage(
    projectRoot: string,
    directory: string,
    id: string,
    extra = "",
  ): Promise<void> {
    const dir = path.join(projectRoot, directory);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${id}.yaml`),
      [
        `id: ${id}`,
        "system_prompt: Do the thing.",
        "model: cursor/auto",
        extra,
        "",
      ].join("\n"),
    );
  }

  it("creates pipeline file with uses refs and rejects collisions", async () => {
    const { root, cleanup } = await initTempGitRepo();
    const directory = "pipelines";

    try {
      await writeStage(root, directory, "alpha");
      await writeStage(root, directory, "beta", "gate_kinds:\n  - confirm");

      const created = await createPipeline(root, {
        directory,
        id: "new-pipeline",
        stages: [stageRef("alpha"), stageRef("beta")],
      });
      expect(created).toEqual({
        ok: true,
        pipeline: {
          path: "pipelines/new-pipeline.pipeline.yaml",
          id: "new-pipeline",
          stages: [
            { id: "alpha", uses_path: "pipelines/alpha.yaml" },
            { id: "beta", gate_kinds: ["confirm"], uses_path: "pipelines/beta.yaml" },
          ],
        },
      });

      const yaml = await readFile(
        path.join(root, directory, "new-pipeline.pipeline.yaml"),
        "utf8",
      );
      expect(yaml).toContain("uses: ./alpha.yaml");
      expect(yaml).toContain("uses: ./beta.yaml");

      const pathCollision = await createPipeline(root, {
        directory,
        id: "new-pipeline",
        stages: [stageRef("alpha")],
      });
      expect(pathCollision.ok).toBe(false);
      if (pathCollision.ok) return;
      expect(pathCollision.status).toBe(409);
    } finally {
      await cleanup();
    }
  });

  it("returns 422 for duplicate or missing stage files", async () => {
    const { root, cleanup } = await initTempGitRepo();
    const directory = "pipelines";

    try {
      await writeStage(root, directory, "alpha");

      const duplicate = await createPipeline(root, {
        directory,
        id: "dup-stages",
        stages: [stageRef("alpha"), stageRef("alpha")],
      });
      expect(duplicate.ok).toBe(false);
      if (duplicate.ok) return;
      expect(duplicate.status).toBe(422);
      expect(duplicate.error).toContain('Duplicate stage id "alpha"');

      const missing = await createPipeline(root, {
        directory,
        id: "missing-stage",
        stages: [stageRef("alpha"), stageRef("gone")],
      });
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.status).toBe(422);
      expect(missing.error).toContain("missing stage file");
    } finally {
      await cleanup();
    }
  });

  it("supports inline single-stage scaffold", async () => {
    const { root, cleanup } = await initTempGitRepo();

    try {
      const created = await createPipeline(root, {
        directory: "pipelines",
        id: "hello",
        stages: [
          {
            id: "hello",
            inline: {
              system_prompt: "Say hello.",
              model: "anthropic/claude-sonnet-4-5",
            },
          },
        ],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.pipeline.stages[0]?.inline).toBe(true);
      await expect(
        loadPipeline(path.join(root, "pipelines/hello.pipeline.yaml"), { cwd: root }),
      ).resolves.toMatchObject({
        pipeline: { id: "hello", stages: ["hello"] },
      });
    } finally {
      await cleanup();
    }
  });

  it("rejects directory outside project root", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const result = await createPipeline(root, {
        directory: "../outside",
        id: "nope",
        stages: [stageRef("a")],
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: "directory must be inside the project root",
      });
    } finally {
      await cleanup();
    }
  });
});
