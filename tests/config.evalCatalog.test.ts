import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listDatasetFiles, listEvalFiles } from "../src/config/evalCatalog.js";
import {
  loadStageflowManifestOutcome,
  parseStageflowManifestOutcome,
} from "../src/config/loadStageflowManifest.js";
import { scanCatalogPaths } from "../src/config/scanCatalogPaths.js";

const roots: string[] = [];

async function project(files: Record<string, string>, catalogExtra = ""): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-evalcat-"));
  roots.push(root);
  const manifest = `version: 1\ncatalog:\n  pipelines: [pipelines]\n  tasks: [tasks]\n${catalogExtra}`;
  await writeFile(path.join(root, "stageflow.yaml"), manifest);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }
  return root;
}

async function load(root: string) {
  const outcome = await loadStageflowManifestOutcome(root);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues));
  return outcome.value;
}

function parse(catalogExtra: string) {
  return parseStageflowManifestOutcome(
    `version: 1\ncatalog:\n  pipelines: [p]\n  tasks: [t]\n${catalogExtra}`,
    "stageflow.yaml",
    "/tmp/x",
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("manifest evals and datasets", () => {
  it("parses catalog.evals, catalog.datasets and patterns", () => {
    const outcome = parse(
      "  evals: [e]\n  datasets: [d]\n  patterns:\n    eval: '*.e.yaml'\n    dataset: ['*.a.json', '*.b.csv']\n",
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.manifest.catalog.evals).toEqual(["e"]);
    expect(outcome.value.manifest.catalog.datasets).toEqual(["d"]);
    expect(outcome.value.patterns.eval).toBe("*.e.yaml");
    expect(outcome.value.patterns.dataset).toEqual(["*.a.json", "*.b.csv"]);
  });

  it("accepts a string dataset pattern", () => {
    const outcome = parse("  patterns:\n    dataset: '*.d.json'\n");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.patterns.dataset).toEqual(["*.d.json"]);
  });

  it("applies default patterns", () => {
    const outcome = parse("");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.patterns.eval).toBe("*.eval.yaml");
    expect(outcome.value.patterns.dataset).toEqual([
      "*.dataset.jsonl",
      "*.dataset.json",
      "*.dataset.csv",
    ]);
  });

  it.each([
    ["  evals: nope\n", "catalog.evals"],
    ["  datasets: [1]\n", "catalog.datasets"],
    ["  evals: ['/abs']\n", "catalog.evals"],
    ["  patterns:\n    eval: 3\n", "catalog.patterns.eval"],
    ["  patterns:\n    dataset: ['']\n", "catalog.patterns.dataset"],
    ["  patterns:\n    dataset: [1]\n", "catalog.patterns.dataset"],
    ["  patterns:\n    dataset: []\n", "catalog.patterns.dataset"],
    ["  patterns:\n    dataset: 5\n", "catalog.patterns.dataset"],
  ])("rejects invalid shape %j", (extra, field) => {
    const outcome = parse(extra);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const issue = outcome.issues.find((i) => i.code === "catalog.manifest_invalid");
    expect(issue?.message).toContain(field);
  });
});

describe("eval and dataset scanning", () => {
  it("scans evals/ and datasets/ by default and returns sorted dataset files only", async () => {
    const root = await project({
      "evals/b.eval.yaml": "",
      "evals/a.eval.yaml": "",
      "evals/notes.md": "",
      "datasets/z.dataset.jsonl": "",
      "datasets/y.dataset.json": "",
      "datasets/x.dataset.csv": "",
      "datasets/readme.md": "",
      "datasets/other.json": "",
    });
    const manifest = await load(root);
    const evals = await listEvalFiles(manifest);
    expect(evals.map((f) => f.relPath)).toEqual(["evals/a.eval.yaml", "evals/b.eval.yaml"]);
    expect(evals[0]?.absPath).toBe(path.join(root, "evals/a.eval.yaml"));
    const datasets = await listDatasetFiles(manifest);
    expect(datasets.map((f) => f.relPath)).toEqual([
      "datasets/x.dataset.csv",
      "datasets/y.dataset.json",
      "datasets/z.dataset.jsonl",
    ]);
  });

  it("returns nothing without error when default directories are absent", async () => {
    const manifest = await load(await project({}));
    expect(await scanCatalogPaths(manifest, "eval")).toEqual([]);
    expect(await scanCatalogPaths(manifest, "dataset")).toEqual([]);
  });

  it("present keys replace the defaults", async () => {
    const root = await project(
      {
        "evals/a.eval.yaml": "",
        "custom/b.eval.yaml": "",
        "datasets/a.dataset.json": "",
        "data/b.dataset.csv": "",
      },
      "  evals: [custom]\n  datasets: [data]\n",
    );
    const manifest = await load(root);
    expect((await listEvalFiles(manifest)).map((f) => f.relPath)).toEqual([
      "custom/b.eval.yaml",
    ]);
    expect((await listDatasetFiles(manifest)).map((f) => f.relPath)).toEqual([
      "data/b.dataset.csv",
    ]);
  });

  it("exclude removes matching eval and dataset files", async () => {
    const root = await project(
      {
        "evals/a.eval.yaml": "",
        "evals/skip/b.eval.yaml": "",
        "datasets/a.dataset.json": "",
        "datasets/skip/b.dataset.json": "",
      },
      "  exclude: [evals/skip, datasets/skip]\n",
    );
    const manifest = await load(root);
    expect((await listEvalFiles(manifest)).map((f) => f.relPath)).toEqual(["evals/a.eval.yaml"]);
    expect((await listDatasetFiles(manifest)).map((f) => f.relPath)).toEqual([
      "datasets/a.dataset.json",
    ]);
  });

  it("lists a dataset that sits beside its eval", async () => {
    const root = await project({
      "evals/beside.eval.yaml": `version: 1
id: beside
target:
  kind: stage
  file: stages/review.stage.yaml
dataset: ./beside.dataset.jsonl
graders:
  - id: output-schema
    type: schema
    must_pass: true
`,
      "evals/beside.dataset.jsonl": "",
      "datasets/listed.dataset.jsonl": "",
    });
    const manifest = await load(root);
    expect((await listDatasetFiles(manifest)).map((f) => f.relPath)).toEqual([
      "datasets/listed.dataset.jsonl",
      "evals/beside.dataset.jsonl",
    ]);
  });

  it("matches a custom dataset pattern array on any entry", async () => {
    const root = await project(
      {
        "datasets/a.cases.json": "",
        "datasets/b.rows.csv": "",
        "datasets/c.dataset.json": "",
      },
      "  patterns:\n    dataset: ['*.cases.json', '*.rows.csv']\n",
    );
    const manifest = await load(root);
    expect((await listDatasetFiles(manifest)).map((f) => f.relPath)).toEqual([
      "datasets/a.cases.json",
      "datasets/b.rows.csv",
    ]);
  });
});
