import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkDatasetAgainstStage } from "../src/config/datasetStageCheck.js";
import { installEvalSample } from "../src/config/installEvalSample.js";
import { loadDatasetFile } from "../src/config/loadDataset.js";
import { loadEvalOutcome, resolveEvalPaths } from "../src/config/loadEval.js";
import { resolveEvalTarget } from "../src/config/resolveEvalTarget.js";
import { validateEval } from "../src/config/validateEval.js";
import { REPO_ROOT } from "./helpers/fixturePaths.js";

const SAMPLE_DIR = path.join(REPO_ROOT, "examples", "evals");
const EVAL_PATH = path.join(SAMPLE_DIR, "critique-sample.eval.yaml");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function loadSample(evalPath: string, projectRoot: string) {
  const outcome = await loadEvalOutcome(evalPath, projectRoot);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues));
  return outcome;
}

describe("examples/evals sample", () => {
  it("loads the eval with no issues and four graders", async () => {
    const outcome = await loadSample(EVAL_PATH, REPO_ROOT);
    expect(outcome.issues).toBeUndefined();
    expect(outcome.value.id).toBe("critique-sample");
    expect(outcome.value.graders.map((g) => [g.id, g.type])).toEqual([
      ["output-schema", "schema"],
      ["valid-verdict", "field"],
      ["finds-expected-issues", "reference"],
      ["no-false-alarms", "code"],
    ]);
    expect(outcome.value.graders.some((g) => g.type === "rubric")).toBe(false);
  });

  it("has 8 valid dataset cases that match the stage input schema", async () => {
    const outcome = await loadSample(EVAL_PATH, REPO_ROOT);
    const paths = resolveEvalPaths(outcome.value.file, EVAL_PATH);
    const dataset = await loadDatasetFile(paths.datasetPath, { root: REPO_ROOT });
    expect(dataset.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(dataset.cases.map((c) => c.id)).toEqual([
      "c001", "c002", "c003", "c004", "c005", "c006", "c007", "c008",
    ]);
    const target = await resolveEvalTarget(outcome.value.file, EVAL_PATH, REPO_ROOT);
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const checks = checkDatasetAgainstStage(dataset.cases, target.value.inputSchema);
    expect(checks.filter((c) => !c.valid)).toEqual([]);
    const clean = dataset.cases.filter((c) => c.tags?.includes("no-issue")).map((c) => c.id);
    expect(clean).toEqual(["c003", "c008"]);
  });

  it("validates with no findings", async () => {
    const outcome = await loadSample(EVAL_PATH, REPO_ROOT);
    const paths = resolveEvalPaths(outcome.value.file, EVAL_PATH);
    const dataset = await loadDatasetFile(paths.datasetPath, { root: REPO_ROOT });
    const findings = await validateEval(outcome.value, {
      projectRoot: REPO_ROOT,
      datasetReport: dataset,
    });
    expect(findings).toEqual([]);
  });

  it("installs into a temp project with paths that resolve and a valid eval", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sf-example-evals-"));
    roots.push(root);
    await writeFile(
      path.join(root, "stageflow.yaml"),
      "version: 1\nmodel: test/default-model\ncatalog:\n  pipelines: [pipelines]\n  tasks: [tasks]\n",
    );
    await installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR });
    const evalPath = path.join(root, "evals", "critique-sample.eval.yaml");
    const outcome = await loadSample(evalPath, root);
    const paths = resolveEvalPaths(outcome.value.file, evalPath);
    expect(await readFile(paths.pipelinePath!, "utf8")).toContain("id: eval-sample");
    const dataset = await loadDatasetFile(paths.datasetPath, { root });
    expect(dataset.cases).toHaveLength(8);
    const findings = await validateEval(outcome.value, { projectRoot: root, datasetReport: dataset });
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });
});
