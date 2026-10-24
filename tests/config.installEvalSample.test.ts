import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { installEvalSample } from "../src/config/installEvalSample.js";
import { loadDatasetFile } from "../src/config/loadDataset.js";
import { loadEvalOutcome, resolveEvalPaths } from "../src/config/loadEval.js";
import { CatalogPathError } from "../src/config/catalogRelativePath.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

const SAMPLE_DIR = path.join(FIXTURES_ROOT, "evals", "sample");
const roots: string[] = [];

async function project(manifest = "version: 1\ncatalog:\n  pipelines: [pipelines]\n  tasks: [tasks]\n"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-sample-"));
  roots.push(root);
  await writeFile(path.join(root, "stageflow.yaml"), manifest);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("installEvalSample", () => {
  it("sets a pipeline-level model on the sample when the project has no default model", async () => {
    const root = await project();
    await installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR });
    const pipeline = parseYaml(await readFile(path.join(root, "pipelines", "eval-sample.pipeline.yaml"), "utf8"));
    expect(typeof pipeline.model).toBe("string");
  });

  it("leaves the pipeline model unset when the project manifest has a default model", async () => {
    const root = await project(
      "version: 1\nmodel: anthropic/claude-sonnet-4-5\ncatalog:\n  pipelines: [pipelines]\n  tasks: [tasks]\n",
    );
    await installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR });
    const pipeline = parseYaml(await readFile(path.join(root, "pipelines", "eval-sample.pipeline.yaml"), "utf8"));
    expect(pipeline.model).toBeUndefined();
  });

  it("copies the three files into the default roots, rewriting the eval's paths", async () => {
    const root = await project();
    const result = await installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR });
    expect(result).toEqual({ evalId: "critique-sample" });
    expect(await readdir(path.join(root, "pipelines"))).toEqual(["eval-sample.pipeline.yaml"]);
    expect(await readdir(path.join(root, "evals"))).toEqual(["critique-sample.eval.yaml"]);
    expect(await readdir(path.join(root, "datasets"))).toEqual(["critique-sample.dataset.jsonl"]);

    const evalPath = path.join(root, "evals", "critique-sample.eval.yaml");
    const text = await readFile(evalPath, "utf8");
    const doc = parseYaml(text);
    expect(doc.target.pipeline).toBe("../pipelines/eval-sample.pipeline.yaml");
    expect(doc.dataset).toBe("../datasets/critique-sample.dataset.jsonl");
    expect(text).toContain("# Sample eval installed by the console");

    const outcome = await loadEvalOutcome(evalPath, root);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const paths = resolveEvalPaths(outcome.value.file, evalPath);
    expect(await readFile(paths.pipelinePath!, "utf8")).toContain("id: eval-sample");
    expect((await loadDatasetFile(paths.datasetPath)).cases).toHaveLength(2);
  });

  it("keeps the source paths when every directory is the same", async () => {
    const root = await project(
      "version: 1\ncatalog:\n  pipelines: [all]\n  tasks: [tasks]\n  evals: [all]\n  datasets: [all]\n",
    );
    await installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR });
    const doc = parseYaml(await readFile(path.join(root, "all", "critique-sample.eval.yaml"), "utf8"));
    expect(doc.target.pipeline).toBe("./eval-sample.pipeline.yaml");
    expect(doc.dataset).toBe("./critique-sample.dataset.jsonl");
  });

  it("uses the first configured roots", async () => {
    const root = await project(
      "version: 1\ncatalog:\n  pipelines: [p/one]\n  tasks: [tasks]\n  evals: [q/evals]\n  datasets: [q/data]\n",
    );
    await installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR });
    const doc = parseYaml(await readFile(path.join(root, "q/evals", "critique-sample.eval.yaml"), "utf8"));
    expect(doc.target.pipeline).toBe("../../p/one/eval-sample.pipeline.yaml");
    expect(doc.dataset).toBe("../data/critique-sample.dataset.jsonl");
  });

  it("copies once; the second call throws SAMPLE_EXISTS and changes nothing", async () => {
    const root = await project();
    await installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR });
    const evalPath = path.join(root, "evals", "critique-sample.eval.yaml");
    await writeFile(evalPath, `${await readFile(evalPath, "utf8")}# edited\n`);
    const before = await readFile(evalPath, "utf8");
    await expect(installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR })).rejects.toMatchObject({
      code: "SAMPLE_EXISTS",
    });
    expect(await readFile(evalPath, "utf8")).toBe(before);
  });

  it("never overwrites an existing file and leaves the others uncreated", async () => {
    const root = await project();
    await mkdir(path.join(root, "datasets"), { recursive: true });
    await writeFile(path.join(root, "datasets", "critique-sample.dataset.jsonl"), "mine\n");
    await expect(installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR })).rejects.toMatchObject({
      code: "SAMPLE_EXISTS",
    });
    expect(await readFile(path.join(root, "datasets", "critique-sample.dataset.jsonl"), "utf8")).toBe("mine\n");
    await expect(readdir(path.join(root, "evals"))).rejects.toThrow();
    await expect(readdir(path.join(root, "pipelines"))).rejects.toThrow();
  });

  it("reports a missing source directory", async () => {
    const root = await project();
    await expect(
      installEvalSample({ projectRoot: root, sourceDir: path.join(root, "nope") }),
    ).rejects.toMatchObject({ code: "SAMPLE_SOURCE_MISSING" });
  });

  it("works without a manifest, using the default roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sf-sample-"));
    roots.push(root);
    await installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR });
    expect(await readdir(path.join(root, "evals"))).toEqual(["critique-sample.eval.yaml"]);
  });

  it("refuses roots that escape the project", async () => {
    const root = await project(
      "version: 1\ncatalog:\n  pipelines: [pipelines]\n  tasks: [tasks]\n  evals: [../outside]\n",
    );
    await expect(installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR })).rejects.toBeInstanceOf(
      CatalogPathError,
    );
  });
});
