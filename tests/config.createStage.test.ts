import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createStage,
  parseCreateStageBody,
  stageConfigToYaml,
} from "../src/config/createStage.js";
import { loadStage } from "../src/config/loadStage.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

describe("parseCreateStageBody", () => {
  it("accepts valid input and rejects payload_schema", () => {
    expect(
      parseCreateStageBody({
        pipeline_directory: "pipelines",
        filename: "plan-review.yaml",
        id: "plan-review",
        system_prompt: "Review the plan.",
        model: "anthropic/claude-sonnet-4-5",
        gate_kinds: ["confirm"],
      }),
    ).toEqual({
      pipeline_directory: "pipelines",
      filename: "plan-review.yaml",
      id: "plan-review",
      system_prompt: "Review the plan.",
      model: "anthropic/claude-sonnet-4-5",
      gate_kinds: ["confirm"],
    });

    expect(
      parseCreateStageBody({
        pipeline_directory: "pipelines",
        filename: "no-hitl.yaml",
        id: "no-hitl",
        system_prompt: "Implement only.",
        model: "anthropic/claude-sonnet-4-5",
        gate_kinds: [],
      }),
    ).toEqual({
      pipeline_directory: "pipelines",
      filename: "no-hitl.yaml",
      id: "no-hitl",
      system_prompt: "Implement only.",
      model: "anthropic/claude-sonnet-4-5",
      gate_kinds: [],
    });

    expect(
      parseCreateStageBody({
        id: "clarify",
        system_prompt: "Clarify.",
        model: "cursor/auto",
        payload_schema: { type: "object" },
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "payload_schema is not supported",
    });
  });

  it("accepts omitted model and rejects empty or non-string model", () => {
    expect(
      parseCreateStageBody({
        pipeline_directory: "pipelines",
        filename: "inherit-model.yaml",
        id: "inherit-model",
        system_prompt: "Use pipeline or global default.",
      }),
    ).toEqual({
      pipeline_directory: "pipelines",
      filename: "inherit-model.yaml",
      id: "inherit-model",
      system_prompt: "Use pipeline or global default.",
    });

    expect(
      parseCreateStageBody({
        pipeline_directory: "pipelines",
        filename: "empty-model.yaml",
        id: "empty-model",
        system_prompt: "x",
        model: "",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "model must be a non-empty string",
    });

    expect(
      parseCreateStageBody({
        pipeline_directory: "pipelines",
        filename: "ws-model.yaml",
        id: "ws-model",
        system_prompt: "x",
        model: "   ",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "model must be a non-empty string",
    });

    expect(
      parseCreateStageBody({
        pipeline_directory: "pipelines",
        filename: "bad-model.yaml",
        id: "bad-model",
        system_prompt: "x",
        model: 1,
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "model must be a non-empty string",
    });
  });

  it("rejects invalid ids and required fields", () => {
    expect(parseCreateStageBody(null)).toEqual({
      ok: false,
      status: 400,
      error: "Request body must be an object",
    });
    expect(
      parseCreateStageBody({
        pipeline_directory: "pipelines",
        filename: "bad.yaml",
        id: "Bad_Id",
        system_prompt: "x",
        model: "m",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "id must be lowercase kebab-case",
    });
  });
});

describe("stageConfigToYaml", () => {
  it("writes sparse YAML with inline and block system_prompt", () => {
    expect(
      stageConfigToYaml({
        id: "clarify",
        system_prompt: "Clarify the task into crisp requirements.",
        model: "anthropic/claude-sonnet-4-5",
      }),
    ).toBe(
      [
        "id: clarify",
        "system_prompt: Clarify the task into crisp requirements.",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
    );
  });

  it("writes empty gate_kinds as [] and omits the key when undefined (KTD1)", () => {
    expect(
      stageConfigToYaml({
        id: "no-hitl",
        system_prompt: "Implement only.",
        model: "anthropic/claude-sonnet-4-5",
        gate_kinds: [],
      }),
    ).toBe(
      [
        "id: no-hitl",
        "gate_kinds: []",
        "system_prompt: Implement only.",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
    );

    expect(
      stageConfigToYaml({
        id: "compat",
        system_prompt: "Ask if needed.",
        model: "anthropic/claude-sonnet-4-5",
      }),
    ).not.toMatch(/gate_kinds/);
  });

  it("omits model when unset", () => {
    expect(
      stageConfigToYaml({
        id: "inherit",
        system_prompt: "Use default model.",
      }),
    ).toBe(
      ["id: inherit", "system_prompt: Use default model.", ""].join("\n"),
    );
    expect(
      stageConfigToYaml({
        id: "inherit",
        system_prompt: "Use default model.",
      }),
    ).not.toMatch(/^model:/m);
  });
});

describe("createStage", () => {
  it("creates stage file beside pipeline directory", async () => {
    const { root, cleanup } = await initTempGitRepo();

    try {
      const created = await createStage(root, {
        pipeline_directory: "pipelines",
        filename: "new-stage.yaml",
        id: "new-stage",
        system_prompt: "Do the thing.",
        model: "cursor/auto",
      });
      expect(created).toEqual({
        ok: true,
        stage: {
          path: "pipelines/new-stage.yaml",
          id: "new-stage",
        },
      });

      await expect(loadStage(path.join(root, "pipelines/new-stage.yaml"))).resolves.toEqual({
        id: "new-stage",
        system_prompt: "Do the thing.",
        model: "cursor/auto",
      });

      const emptyHitl = await createStage(root, {
        pipeline_directory: "pipelines",
        filename: "no-hitl.yaml",
        id: "no-hitl",
        system_prompt: "Implement only.",
        model: "cursor/auto",
        gate_kinds: [],
      });
      expect(emptyHitl).toEqual({
        ok: true,
        stage: {
          path: "pipelines/no-hitl.yaml",
          id: "no-hitl",
          gate_kinds: [],
        },
      });
      await expect(loadStage(path.join(root, "pipelines/no-hitl.yaml"))).resolves.toEqual({
        id: "no-hitl",
        system_prompt: "Implement only.",
        model: "cursor/auto",
        gate_kinds: [],
      });
      const emptyYaml = await readFile(path.join(root, "pipelines/no-hitl.yaml"), "utf8");
      expect(emptyYaml).toMatch(/^gate_kinds: \[\]$/m);

      const pathCollision = await createStage(root, {
        pipeline_directory: "pipelines",
        filename: "new-stage.yaml",
        id: "new-stage",
        system_prompt: "Again.",
        model: "cursor/auto",
      });
      expect(pathCollision.ok).toBe(false);
      if (pathCollision.ok) return;
      expect(pathCollision.status).toBe(409);
    } finally {
      await cleanup();
    }
  });

  it("creates stage YAML without model when global default exists", async () => {
    const { root, cleanup } = await initTempGitRepo();

    try {
      await mkdir(path.join(root, "pipelines"), { recursive: true });
      await writeFile(
        path.join(root, "stageflow.yaml"),
        [
          "version: 1",
          "model: cursor/auto",
          "catalog:",
          "  pipelines:",
          "    - pipelines",
          "",
        ].join("\n"),
      );

      const created = await createStage(root, {
        pipeline_directory: "pipelines",
        filename: "inherit-model.yaml",
        id: "inherit-model",
        system_prompt: "Use the global default.",
      });
      expect(created).toEqual({
        ok: true,
        stage: {
          path: "pipelines/inherit-model.yaml",
          id: "inherit-model",
        },
      });

      const yaml = await readFile(path.join(root, "pipelines/inherit-model.yaml"), "utf8");
      expect(yaml).not.toMatch(/^model:/m);

      await expect(loadStage(path.join(root, "pipelines/inherit-model.yaml"))).resolves.toEqual({
        id: "inherit-model",
        system_prompt: "Use the global default.",
      });
    } finally {
      await cleanup();
    }
  });

  it("rejects pipeline_directory outside project root", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const result = await createStage(root, {
        pipeline_directory: "../outside",
        filename: "x.yaml",
        id: "x",
        system_prompt: "x",
        model: "m",
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: "pipeline_directory must be inside the project root",
      });
    } finally {
      await cleanup();
    }
  });
});
