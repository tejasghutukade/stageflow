import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStageFromObjectOutcome, loadStageOutcome } from "../src/config/loadStage.js";
import { planMigrateYaml } from "../src/config/migrateYaml.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nameSuggestion = path.join(repoRoot, "tests/fixtures/stages/name-suggestion.yaml");

const ORIGINAL_LEGACY_YAML = process.env.STAGEFLOW_LEGACY_YAML;

afterEach(() => {
  if (ORIGINAL_LEGACY_YAML === undefined) {
    delete process.env.STAGEFLOW_LEGACY_YAML;
  } else {
    process.env.STAGEFLOW_LEGACY_YAML = ORIGINAL_LEGACY_YAML;
  }
});

describe("legacy YAML dual-read adapter", () => {
  it("loads name-suggestion.yaml with catalog.legacy_yaml by default", async () => {
    const outcome = await loadStageOutcome(nameSuggestion);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.issues?.some((issue) => issue.code === "catalog.legacy_yaml")).toBe(true);
    expect(outcome.value.payload_schema).toMatchObject({
      type: "object",
      required: ["boy_names", "girl_names"],
    });
  });

  it("fails load of that file when STAGEFLOW_LEGACY_YAML=0", async () => {
    process.env.STAGEFLOW_LEGACY_YAML = "0";
    const outcome = await loadStageOutcome(nameSuggestion);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "catalog.legacy_yaml")).toBe(true);
    expect(outcome.issues[0]?.message).toMatch(/dual-read is disabled/);
    expect(outcome.issues[0]?.message).toMatch(/sf migrate-yaml/);
  });

  it("fails load of equivalent inline YAML when STAGEFLOW_LEGACY_YAML=0", () => {
    process.env.STAGEFLOW_LEGACY_YAML = "0";
    const outcome = loadStageFromObjectOutcome(
      {
        id: "name-suggestion",
        system_prompt: "Suggest names",
        model: "anthropic/claude-sonnet-4-5",
        payload_schema: { type: "object" },
      },
      { entryId: "name-suggestion", declaringPath: nameSuggestion },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "catalog.legacy_yaml")).toBe(true);
  });

  it("planMigrateYaml still plans a rewrite when STAGEFLOW_LEGACY_YAML=0", async () => {
    process.env.STAGEFLOW_LEGACY_YAML = "0";
    const plan = await planMigrateYaml(nameSuggestion, { cwd: repoRoot });
    expect(plan.errors).toEqual([]);
    expect(
      plan.writes.some((write) => write.file.includes("name-suggestion.yaml")),
    ).toBe(true);
  });
});
