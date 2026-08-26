import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadStageflowManifestOutcome,
  parseStageflowManifestOutcome,
} from "../src/config/loadStageflowManifest.js";

const manifestCatalog = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/manifest-catalog",
);

describe("loadStageflowManifest", () => {
  it("parses valid minimal manifest", async () => {
    const outcome = await loadStageflowManifestOutcome(manifestCatalog);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.manifest.version).toBe(1);
    expect(outcome.value.patterns.pipeline).toBe("*.pipeline.yaml");
    expect(outcome.value.patterns.task).toBe("*.task.yaml");
    expect(outcome.value.manifest.catalog.pipelines).toContain("pipelines");
  });

  it("rejects version 2", () => {
    const outcome = parseStageflowManifestOutcome(
      "version: 2\ncatalog:\n  pipelines: [a]\n  tasks: [b]\n",
      "stageflow.yaml",
      manifestCatalog,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "catalog.manifest_invalid")).toBe(true);
  });

  it("rejects missing catalog.pipelines", () => {
    const outcome = parseStageflowManifestOutcome(
      "version: 1\ncatalog:\n  tasks: [tasks]\n",
      "stageflow.yaml",
      manifestCatalog,
    );
    expect(outcome.ok).toBe(false);
  });

  it("accepts empty pipelines array", () => {
    const outcome = parseStageflowManifestOutcome(
      "version: 1\ncatalog:\n  pipelines: []\n  tasks: [tasks]\n",
      "stageflow.yaml",
      manifestCatalog,
    );
    expect(outcome.ok).toBe(true);
  });

  it("preserves custom patterns", () => {
    const outcome = parseStageflowManifestOutcome(
      [
        "version: 1",
        "catalog:",
        "  pipelines: [pipelines]",
        "  tasks: [tasks]",
        "  patterns:",
        "    task: '*.yaml'",
        "",
      ].join("\n"),
      "stageflow.yaml",
      manifestCatalog,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.patterns.task).toBe("*.yaml");
  });

  it("returns manifest_load_error for missing file", async () => {
    const outcome = await loadStageflowManifestOutcome(
      path.join(manifestCatalog, "missing-root"),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("catalog.manifest_load_error");
  });
});
