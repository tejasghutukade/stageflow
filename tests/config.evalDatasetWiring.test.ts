import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEvalCatalog } from "../src/config/evalCatalog.js";
import { loadStageflowManifestOutcome } from "../src/config/loadStageflowManifest.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

let root: string;

async function setup(datasetFixture: string, extraLines = ""): Promise<void> {
  for (const dir of ["pipelines", "stages", "evals", "datasets"]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await cp(path.join(FIXTURES_ROOT, "pipelines", "feature-ship.pipeline.yaml"), path.join(root, "pipelines", "feature-ship.pipeline.yaml"));
  await cp(path.join(FIXTURES_ROOT, "stages", "review.yaml"), path.join(root, "stages", "review.yaml"));
  await cp(path.join(FIXTURES_ROOT, "evals", "valid.eval.yaml"), path.join(root, "evals", "valid.eval.yaml"));
  const text = await readFile(path.join(FIXTURES_ROOT, "datasets", datasetFixture), "utf8");
  await writeFile(path.join(root, "datasets", "review-diffs.dataset.jsonl"), text + extraLines);
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks: []\n",
  );
}

async function findings() {
  const manifest = await loadStageflowManifestOutcome(root);
  if (!manifest.ok) throw new Error("manifest");
  return (await loadEvalCatalog(manifest.value, { isKnownModel: async () => true }))[0]?.findings ?? [];
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-eval-wiring-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadEvalCatalog with the real dataset loader", () => {
  it("a valid fixture dataset yields no eval or dataset errors", async () => {
    await setup("six.dataset.jsonl");
    const f = await findings();
    expect(f.filter((x) => x.severity === "error")).toEqual([]);
    expect(f.map((x) => x.code)).not.toContain("eval.cases_skipped");
  });

  it("cases failing io.input.schema give eval.cases_skipped and one dataset.input_mismatch each", async () => {
    await setup(
      "six.dataset.jsonl",
      `${JSON.stringify({ id: "bad1", input: { diff: 1 } })}\n${JSON.stringify({ id: "bad2", input: {} })}\n`,
    );
    const f = await findings();
    const skipped = f.find((x) => x.code === "eval.cases_skipped");
    expect(skipped?.message).toContain("2 case(s)");
    expect(skipped?.message).toContain("bad1");
    const mismatches = f.filter((x) => x.code === "dataset.input_mismatch");
    expect(mismatches).toHaveLength(2);
    expect(mismatches[0]).toMatchObject({
      severity: "warning",
      category: "dataset",
      path: "datasets/review-diffs.dataset.jsonl",
    });
    expect(mismatches[0]?.message).toContain("bad1");
  });

  it("a dataset whose cases all fail the schema gives eval.no_valid_cases", async () => {
    await setup("few-cases.dataset.jsonl");
    const codes = (await findings()).map((x) => x.code);
    expect(codes).toContain("eval.no_valid_cases");
    expect(codes).toContain("dataset.few_cases");
  });

  it("dataset file errors surface as eval.dataset_invalid and the dataset's own finding", async () => {
    await setup("invalid-missing-id.dataset.jsonl");
    const f = await findings();
    expect(f.map((x) => x.code)).toContain("eval.dataset_invalid");
    expect(f.some((x) => x.category === "dataset" && x.severity === "error")).toBe(true);
  });
});
