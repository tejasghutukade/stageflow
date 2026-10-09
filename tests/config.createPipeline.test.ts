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
  const bareStringError = (id: string) =>
    `stages[0]: bare string stage refs are not supported; use { id: "${id}", uses: "./${id}.yaml" } or inline body`;

  it.each([
    {
      name: "object stage entries",
      body: {
        directory: "pipelines",
        id: "plan-review-proving",
        stages: [stageRef("plan-review"), stageRef("plan-review-followup")],
      },
    },
    {
      name: "DAG-shaped stage entries",
      body: {
        directory: "pipelines",
        id: "fan-out",
        stages: [stageRef("a"), stageRef("b", "a")],
      },
    },
  ])("passes through $name unchanged", ({ body }) => {
    expect(parseCreatePipelineBody(body)).toEqual(body);
  });

  it.each([
    { name: "a non-object body", body: null, error: "Request body must be an object" },
    { name: "a missing directory", body: { id: "ok", stages: [] }, error: "directory is required" },
    {
      name: "an empty stages array",
      body: { directory: "pipelines", id: "ok", stages: [] },
      error: "stages must be a non-empty array",
    },
    {
      name: "a non-object stage entry",
      body: { directory: "pipelines", id: "ok", stages: [1] },
      error: "stages[0] must be an object with id",
    },
    {
      name: "a bad id format",
      body: { directory: "pipelines", id: "Bad", stages: [stageRef("a")] },
      error: "id must be lowercase kebab-case",
    },
    {
      name: "bare string stage refs",
      body: { directory: "pipelines", id: "linear", stages: ["plan-review"] },
      error: bareStringError("plan-review"),
    },
    {
      name: "mixed string and object stage arrays",
      body: {
        directory: "pipelines",
        id: "mixed",
        stages: ["a", { id: "b", uses: "./b.yaml" }],
      },
      error: bareStringError("a"),
    },
    {
      name: "an object entry missing id",
      body: { directory: "pipelines", id: "bad-object", stages: [{}] },
      error: "stages[0].id is required",
    },
    {
      name: "non-string needs",
      body: {
        directory: "pipelines",
        id: "bad-needs",
        stages: [{ id: "a", uses: "./a.yaml", needs: 1 }],
      },
      error: "stages[0].needs must be a non-empty string or a non-empty array",
    },
    {
      name: "HTTP needs items that include if",
      body: {
        directory: "pipelines",
        id: "gated",
        stages: [
          { id: "triage", uses: "./triage.yaml" },
          {
            id: "page",
            uses: "./page.yaml",
            needs: [
              { id: "triage", on: ["succeeded"], if: { field: "ok", op: "eq", value: true } },
            ],
          },
        ],
      },
      error: 'stages[1].needs item: unknown key "if"',
    },
    {
      name: "an empty inline model",
      body: {
        directory: "pipelines",
        id: "hello",
        stages: [{ id: "hello", system_prompt: "Say hello.", model: "" }],
      },
      error: "stages[0].model must be a non-empty string",
    },
    {
      name: "a whitespace-only inline model",
      body: {
        directory: "pipelines",
        id: "hello",
        stages: [{ id: "hello", system_prompt: "Say hello.", model: "   " }],
      },
      error: "stages[0].model must be a non-empty string",
    },
  ])("rejects $name", ({ body, error }) => {
    expect(parseCreatePipelineBody(body)).toEqual({ ok: false, status: 400, error });
  });

  it("normalizes a single-string needs array to an on: [succeeded] edge", () => {
    expect(
      parseCreatePipelineBody({
        directory: "pipelines",
        id: "one-parent-array",
        stages: [{ id: "a", uses: "./a.yaml", needs: ["b"] }],
      }),
    ).toMatchObject({
      directory: "pipelines",
      id: "one-parent-array",
      stages: [{ id: "a", uses: "./a.yaml", needs: [{ id: "b", on: ["succeeded"] }] }],
    });
  });

  it("accepts an inline stage without model", () => {
    expect(
      parseCreatePipelineBody({
        directory: "pipelines",
        id: "hello",
        stages: [{ id: "hello", system_prompt: "Say hello." }],
      }),
    ).toEqual({
      directory: "pipelines",
      id: "hello",
      stages: [{ id: "hello", inline: { system_prompt: "Say hello." } }],
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

  it("quotes string if values so YAML reload keeps string type", () => {
    expect(
      pipelineConfigToYaml(
        {
          id: "gated-page",
          stages: [
            { id: "triage", uses: "./triage.yaml" },
            {
              id: "page",
              uses: "./page.yaml",
              needs: [
                {
                  id: "triage",
                  on: ["succeeded"],
                  if: { field: "ok", op: "eq", value: "true" },
                },
              ],
            },
          ],
        },
        { format: "dag" },
      ),
    ).toContain('          value: "true"');
  });

  it("writes if only on the gated outbound entry among always-run siblings", () => {
    expect(
      pipelineConfigToYaml(
        {
          id: "gated-page",
          stages: [
            { id: "triage", uses: "./triage.yaml" },
            {
              id: "page",
              uses: "./page.yaml",
              needs: [
                {
                  id: "triage",
                  on: ["succeeded"],
                  if: { field: "ok", op: "eq", value: true },
                },
              ],
            },
            { id: "notify", uses: "./notify.yaml", needs: "triage" },
          ],
        },
        { format: "dag" },
      ),
    ).toBe(
      [
        "id: gated-page",
        "stages:",
        "  - id: triage",
        "    entry: true",
        "    route:",
        "      - to: page",
        "        if:",
        "          field: ok",
        "          op: eq",
        "          value: true",
        "      - to: notify",
        "    uses: ./triage.yaml",
        "  - id: page",
        "    uses: ./page.yaml",
        "  - id: notify",
        "    uses: ./notify.yaml",
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
