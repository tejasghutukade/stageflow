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
