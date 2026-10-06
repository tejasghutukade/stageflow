import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { loadPipelineFromObjectOutcome } from "../src/config/loadPipeline.js";
import {
  collectEffectiveRequires,
  mergeToolRequires,
  parseToolRequires,
} from "../src/config/toolRequires.js";
import { validateCatalog } from "../src/config/validateCatalog.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

describe("parseToolRequires", () => {
  it("accepts tool and optional version", () => {
    const outcome = parseToolRequires(
      [{ tool: "node", version: ">=20" }, { tool: "git" }],
      "pipeline test",
      { code: "pipeline.invalid_requires", category: "pipeline" },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual([
      { tool: "node", version: ">=20" },
      { tool: "git" },
    ]);
  });

  it("rejects unknown sub-key with named load error", () => {
    const outcome = parseToolRequires(
      [{ tool: "node", extra: "x" }],
      "pipeline test",
      { code: "pipeline.invalid_requires", category: "pipeline" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0].code).toBe("pipeline.invalid_requires");
    expect(outcome.issues[0].message).toMatch(/unknown key "extra"/);
  });

  it("rejects invalid semver range", () => {
    const outcome = parseToolRequires(
      [{ tool: "node", version: "not-a-range!!!" }],
      "stage test",
      { code: "stage.invalid_requires", category: "stage" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0].code).toBe("stage.invalid_requires");
  });
});

describe("mergeToolRequires intersection", () => {
  it("intersects same tool to stricter combined range", () => {
    const outcome = mergeToolRequires(
      [[{ tool: "pnpm", version: ">=9" }], [{ tool: "pnpm", version: ">=9.5" }]],
      { pipelineId: "p" },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual([{ tool: "pnpm", version: ">=9 >=9.5" }]);
  });

  it("fails when ranges do not intersect", () => {
    const outcome = mergeToolRequires(
      [[{ tool: "node", version: "<18" }], [{ tool: "node", version: ">=22" }]],
      { pipelineId: "p" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0].code).toBe("pipeline.requires_conflict");
  });
});

describe("pipeline/stage requires load", () => {
  it("loads requires-demo with pipeline+stage intersection", async () => {
    const outcome = await loadPipelineOutcome(
      path.join(fixtures, "pipelines/requires-demo.pipeline.yaml"),
      { cwd: fixtures },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pipeline.requires).toEqual([
      { tool: "node", version: ">=20" },
      { tool: "pnpm", version: ">=9" },
    ]);
    const clarify = outcome.value.stages.find((s) => s.id === "clarify");
    expect(clarify?.requires).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "pnpm", version: ">=9.5" }),
        expect.objectContaining({ tool: "git" }),
      ]),
    );
    const effective = collectEffectiveRequires({
      pipelineRequires: outcome.value.pipeline.requires,
      stageRequires: outcome.value.stages.map((s) => s.requires),
      pipelineId: outcome.value.pipeline.id,
    });
    expect(effective.ok).toBe(true);
    if (!effective.ok) return;
    const pnpm = effective.value.find((r) => r.tool === "pnpm");
    expect(pnpm?.version).toBe(">=9 >=9.5");
  });

  it("unknown requires sub-key fails load", async () => {
    const outcome = await loadPipelineOutcome(
      path.join(fixtures, "pipelines/requires-bad-key.pipeline.yaml"),
      { cwd: fixtures },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "stage.invalid_requires")).toBe(
      true,
    );
  });

  it("sf validate reports invalid requires", async () => {
    const result = await validateCatalog({
      scope: "pipeline",
      cwd: fixtures,
      pipeline: "pipelines/requires-bad-key.pipeline.yaml",
    });
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => f.code === "stage.invalid_requires"),
    ).toBe(true);
  });

  it("inline pipeline root requires parses", async () => {
    const outcome = await loadPipelineFromObjectOutcome({
      id: "inline-req",
      requires: [{ tool: "node", version: ">=20" }],
      stages: [
        {
          id: "a",
          system_prompt: "hi",
          model: "anthropic/claude-sonnet-4-5",
          io: {
            input: { schema: { type: "object" } },
            output: { schema: { type: "object" } },
          },
        },
      ],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pipeline.requires).toEqual([
      { tool: "node", version: ">=20" },
    ]);
  });
});
