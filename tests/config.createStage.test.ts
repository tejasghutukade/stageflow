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

describe("parseCreateStageBody", () => {
  it("accepts valid input and rejects payload_schema", () => {
    expect(
      parseCreateStageBody({
        id: "plan-review",
        system_prompt: "Review the plan.",
        model: "anthropic/claude-sonnet-4-5",
        gate_kinds: ["confirm"],
      }),
    ).toEqual({
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

    expect(
      parseCreateStageBody({
        id: "clarify",
        system_prompt: "Clarify.",
        model: "cursor/auto",
        skill: "improve-codebase-architecture",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "skill is not supported",
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
        id: "Bad_Id",
        system_prompt: "x",
        model: "m",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "id must be lowercase kebab-case",
    });
    expect(
      parseCreateStageBody({
        id: "a".repeat(65),
        system_prompt: "x",
        model: "m",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "id must be 1-64 characters",
    });
    expect(
      parseCreateStageBody({
        id: "ok",
        system_prompt: "",
        model: "m",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "system_prompt is required",
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

    expect(
      stageConfigToYaml({
        id: "plan-review",
        gate_kinds: ["artifact_backed"],
        system_prompt: "Line one\nLine two",
        model: "anthropic/claude-sonnet-4-5",
      }),
    ).toBe(
      [
        "id: plan-review",
        "gate_kinds:",
        "  - artifact_backed",
        "system_prompt: |",
        "  Line one",
        "  Line two",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
    );
  });
});

describe("createStage", () => {
  it("creates stage file, rejects collisions, and round-trips through loadStage", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-create-stage-"));

    try {
      const created = await createStage(cwd, {
        id: "new-stage",
        system_prompt: "Do the thing.",
        model: "cursor/auto",
      });
      expect(created).toEqual({
        ok: true,
        stage: {
          path: "stages/new-stage.yaml",
          id: "new-stage",
          used_by_pipeline_ids: [],
        },
      });

      const yaml = await readFile(path.join(cwd, "stages", "new-stage.yaml"), "utf8");
      expect(yaml).toBe(
        [
          "id: new-stage",
          "system_prompt: Do the thing.",
          "model: cursor/auto",
          "",
        ].join("\n"),
      );
      await expect(loadStage(path.join(cwd, "stages", "new-stage.yaml"))).resolves.toEqual({
        id: "new-stage",
        system_prompt: "Do the thing.",
        model: "cursor/auto",
      });

      const pathCollision = await createStage(cwd, {
        id: "new-stage",
        system_prompt: "Again.",
        model: "cursor/auto",
      });
      expect(pathCollision).toEqual({
        ok: false,
        status: 409,
        error: "Stage id already exists (stages/new-stage.yaml)",
      });

      await writeFile(
        path.join(cwd, "stages", "alias.yaml"),
        ["id: other-id", "system_prompt: x", "model: m", ""].join("\n"),
      );
      const yamlIdCollision = await createStage(cwd, {
        id: "other-id",
        system_prompt: "Again.",
        model: "cursor/auto",
      });
      expect(yamlIdCollision).toEqual({
        ok: false,
        status: 409,
        error: "Stage id already exists (stages/alias.yaml)",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("creates stages directory when missing", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-create-stage-empty-"));

    try {
      const created = await createStage(cwd, {
        id: "first",
        system_prompt: "First stage.",
        model: "cursor/auto",
      });
      expect(created.ok).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
