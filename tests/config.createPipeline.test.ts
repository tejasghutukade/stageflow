import { describe, expect, it } from "vitest";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
      error: "stages[0].needs must be a non-empty string or a non-empty array",
    });

    expect(
      parseCreatePipelineBody({
        directory: "pipelines",
        id: "one-parent-array",
        stages: [{ id: "a", uses: "./a.yaml", needs: ["b"] }],
      }),
    ).toMatchObject({
      directory: "pipelines",
      id: "one-parent-array",
      stages: [
        {
          id: "a",
          uses: "./a.yaml",
          needs: [{ id: "b", on: ["succeeded"] }],
        },
      ],
    });
  });

  it("accepts inline stage without model", () => {
    expect(
      parseCreatePipelineBody({
        directory: "pipelines",
        id: "hello",
        stages: [
          {
            id: "hello",
            system_prompt: "Say hello.",
          },
        ],
      }),
    ).toEqual({
      directory: "pipelines",
      id: "hello",
      stages: [
        {
          id: "hello",
          inline: {
            system_prompt: "Say hello.",
          },
        },
      ],
    });
  });

  it("rejects present-but-empty inline model", () => {
    expect(
      parseCreatePipelineBody({
        directory: "pipelines",
        id: "hello",
        stages: [
          {
            id: "hello",
            system_prompt: "Say hello.",
            model: "",
          },
        ],
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "stages[0].model must be a non-empty string",
    });

    expect(
      parseCreatePipelineBody({
        directory: "pipelines",
        id: "hello",
        stages: [
          {
            id: "hello",
            system_prompt: "Say hello.",
            model: "   ",
          },
        ],
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "stages[0].model must be a non-empty string",
    });
  });

  it("accepts mixed multi-parent needs arrays", () => {
    expect(
      parseCreatePipelineBody({
        directory: "pipelines",
        id: "diamond",
        stages: [
          { id: "research", uses: "./research.yaml" },
          { id: "validation", uses: "./validation.yaml" },
          {
            id: "synthesize",
            uses: "./synthesize.yaml",
            needs: [
              "research",
              { id: "validation", on: ["succeeded", "failed"] },
            ],
          },
        ],
      }),
    ).toEqual({
      directory: "pipelines",
      id: "diamond",
      stages: [
        { id: "research", uses: "./research.yaml" },
        { id: "validation", uses: "./validation.yaml" },
        {
          id: "synthesize",
          uses: "./synthesize.yaml",
          needs: [
            { id: "research", on: ["succeeded"] },
            { id: "validation", on: ["succeeded", "failed"] },
          ],
        },
      ],
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

  it("writes empty inline gate_kinds as [] and omits the key when undefined (KTD1)", () => {
    expect(
      pipelineConfigToYaml(
        {
          id: "no-hitl",
          stages: [
            {
              id: "implement",
              inline: {
                system_prompt: "Implement only.",
                model: "anthropic/claude-sonnet-4-5",
                gate_kinds: [],
              },
            },
          ],
        },
        { format: "dag" },
      ),
    ).toBe(
      [
        "id: no-hitl",
        "stages:",
        "  - id: implement",
        "    gate_kinds: []",
        "    system_prompt: Implement only.",
        "    model: anthropic/claude-sonnet-4-5",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    );

    const omitted = pipelineConfigToYaml(
      {
        id: "compat",
        stages: [
          {
            id: "clarify",
            inline: {
              system_prompt: "Ask if needed.",
              model: "anthropic/claude-sonnet-4-5",
            },
          },
        ],
      },
      { format: "dag" },
    );
    expect(omitted).not.toMatch(/gate_kinds/);
  });

  it("omits inline model when unset", () => {
    const yaml = pipelineConfigToYaml(
      {
        id: "inherit",
        stages: [
          {
            id: "hello",
            inline: {
              system_prompt: "Say hello.",
            },
          },
        ],
      },
      { format: "dag" },
    );
    expect(yaml).toBe(
      [
        "id: inherit",
        "stages:",
        "  - id: hello",
        "    system_prompt: Say hello.",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    );
    expect(yaml).not.toMatch(/^    model:/m);
  });

  it("writes object-form DAG YAML with per-stage route/entry inverted from needs", () => {
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
        "    entry: true",
        "    route:",
        "      - to: improve-a",
        "    uses: ./recon.yaml",
        "  - id: improve-a",
        "    uses: ./improve-a.yaml",
        "",
      ].join("\n"),
    );
  });

  it("writes mixed multi-parent needs arrays inverted into per-source route entries", () => {
    expect(
      pipelineConfigToYaml(
        {
          id: "diamond",
          stages: [
            { id: "research", uses: "./research.yaml" },
            { id: "validation", uses: "./validation.yaml" },
            {
              id: "synthesize",
              uses: "./synthesize.yaml",
              needs: [
                { id: "research", on: ["succeeded"] },
                { id: "validation", on: ["succeeded", "failed"] },
              ],
            },
          ],
        },
        { format: "dag" },
      ),
    ).toBe(
      [
        "id: diamond",
        "stages:",
        "  - id: research",
        "    entry: true",
        "    route:",
        "      - to: synthesize",
        "    uses: ./research.yaml",
        "  - id: validation",
        "    entry: true",
        "    route:",
        "      - to: synthesize",
        "        on:",
        "          - succeeded",
        "          - failed",
        "    uses: ./validation.yaml",
        "  - id: synthesize",
        "    uses: ./synthesize.yaml",
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
        "io:",
        "  input:",
        "    schema:",
        "      type: object",
        "  output:",
        "    schema:",
        "      type: object",
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

  it("writes route/entry YAML (not needs) for a needs-chain and loads it back", async () => {
    const { root, cleanup } = await initTempGitRepo();
    const directory = "pipelines";

    try {
      await writeStage(root, directory, "alpha");
      await writeStage(root, directory, "beta");
      await writeStage(root, directory, "gamma");

      const created = await createPipeline(root, {
        directory,
        id: "chain-pipeline",
        stages: [
          stageRef("alpha"),
          stageRef("beta", "alpha"),
          stageRef("gamma", "beta"),
        ],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const yaml = await readFile(
        path.join(root, directory, "chain-pipeline.pipeline.yaml"),
        "utf8",
      );
      expect(yaml).not.toMatch(/needs:/);
      expect(yaml).toContain("entry: true");
      expect(yaml).toContain("route:");
      expect(yaml).toContain("- to: beta");
      expect(yaml).toContain("- to: gamma");

      await expect(
        loadPipeline(path.join(root, directory, "chain-pipeline.pipeline.yaml"), {
          cwd: root,
        }),
      ).resolves.toMatchObject({
        pipeline: { id: "chain-pipeline", stages: ["alpha", "beta", "gamma"] },
      });
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

  it("creates inline stage without model when global default exists", async () => {
    const { root, cleanup } = await initTempGitRepo();

    try {
      await writeFile(
        path.join(root, "stageflow.yaml"),
        [
          "version: 1",
          "model: anthropic/claude-sonnet-4-5",
          "catalog:",
          "  pipelines:",
          "    - pipelines",
          "  tasks:",
          "    - tasks",
          "",
        ].join("\n"),
      );

      const created = await createPipeline(root, {
        directory: "pipelines",
        id: "hello",
        stages: [
          {
            id: "hello",
            inline: {
              system_prompt: "Say hello.",
            },
          },
        ],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const yaml = await readFile(
        path.join(root, "pipelines/hello.pipeline.yaml"),
        "utf8",
      );
      expect(yaml).not.toMatch(/^    model:/m);

      await expect(
        loadPipeline(path.join(root, "pipelines/hello.pipeline.yaml"), { cwd: root }),
      ).resolves.toMatchObject({
        pipeline: { id: "hello", stages: ["hello"] },
      });
    } finally {
      await cleanup();
    }
  });

  it("rejects inline stage without model when no defaults exist", async () => {
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
            },
          },
        ],
      });
      expect(created.ok).toBe(false);
      if (created.ok) return;
      expect(created.status).toBe(422);
      expect(created.error).toMatch(/model is required/i);

      await expect(
        access(path.join(root, "pipelines/hello.pipeline.yaml")),
      ).rejects.toMatchObject({ code: "ENOENT" });
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
