import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { CatalogPathError } from "../src/config/catalogRelativePath.js";
import { EvalsWriteError, FileChangedError, contentHash } from "../src/config/atomicWrite.js";
import { createEvalFile, previewEvalUpdate, renderEvalYaml, updateEvalFile } from "../src/config/writeEval.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

const roots: string[] = [];

async function project(manifestExtra = "", files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-writeeval-"));
  roots.push(root);
  await writeFile(
    path.join(root, "stageflow.yaml"),
    `version: 1\ncatalog:\n  pipelines: [pipelines]\n  tasks: [tasks]\n${manifestExtra}`,
  );
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const GOLDEN_PATH = path.join(FIXTURES_ROOT, "evals", "write", "review-findings.eval.yaml");

async function goldenText(): Promise<string> {
  return readFile(GOLDEN_PATH, "utf8");
}

async function goldenDefinition(): Promise<Record<string, any>> {
  return parseYaml(await goldenText()) as Record<string, any>;
}

const COMMENTED = `# top-level comment
version: 1
id: commented
name: Commented
target:
  kind: stage
  file: ../stages/review.yaml # target comment
dataset: ../datasets/commented.dataset.jsonl
defaults:
  # defaults comment
  repeats: 3 # repeats comment
  pass_threshold: 0.8
graders:
  # first grader comment
  - id: output-schema
    type: schema
    must_pass: true # must pass comment
  # second grader comment
  - id: quality
    type: rubric
    # rubric comment
    rubric: |
      Pass if the review is useful.
    scale: pass_fail
  # third grader comment
  - id: cites
    type: field
    checks:
      - { path: "payload.findings[*].file", op: not_empty } # check comment
`;

const COMMENTS = [
  "# top-level comment",
  "# target comment",
  "# defaults comment",
  "# repeats comment",
  "# first grader comment",
  "# must pass comment",
  "# second grader comment",
  "# rubric comment",
  "# third grader comment",
  "# check comment",
];

function missingComments(text: string, removed: string[] = []): string[] {
  return COMMENTS.filter((c) => !removed.includes(c) && !text.includes(c));
}

describe("renderEvalYaml", () => {
  it("renders the schema doc example exactly", async () => {
    expect(renderEvalYaml(await goldenDefinition())).toBe(await goldenText());
  });

  it("orders keys canonically whatever the input order", () => {
    const text = renderEvalYaml({
      graders: [{ type: "schema", must_pass: true, id: "s" }],
      dataset: "d.dataset.jsonl",
      target: { stage: "a", pipeline: "p", kind: "stage" },
      id: "x",
      version: 1,
    });
    expect(text).toBe(
      [
        "version: 1",
        "id: x",
        "target:",
        "  kind: stage",
        "  pipeline: p",
        "  stage: a",
        "dataset: d.dataset.jsonl",
        "graders:",
        "  - id: s",
        "    type: schema",
        "    must_pass: true",
        "",
      ].join("\n"),
    );
  });
});

describe("createEvalFile", () => {
  it("writes the canonical YAML into the default evals root", async () => {
    const root = await project();
    const definition = await goldenDefinition();
    const result = await createEvalFile({ projectRoot: root, definition: definition as never });
    expect(result.relPath).toBe("evals/review-findings.eval.yaml");
    expect(await readFile(path.join(root, result.relPath), "utf8")).toBe(await goldenText());
    expect(result.fileHash).toBe(contentHash(await goldenText()));
  });

  it("writes defaults.repeats, pass_threshold and max_cost_usd explicitly when creating", async () => {
    const root = await project();
    const definition = {
      version: 1,
      id: "min",
      target: { kind: "stage", file: "../stages/review.yaml" },
      dataset: "../datasets/min.dataset.jsonl",
      graders: [{ id: "s", type: "schema" }],
    };
    const result = await createEvalFile({ projectRoot: root, definition: definition as never });
    expect(parseYaml(result.text).defaults).toEqual({ repeats: 3, pass_threshold: 0.8, max_cost_usd: 2 });
  });

  it("uses the first configured evals root and registers an explicit root only when missing", async () => {
    const root = await project("  evals: [quality/evals]\n");
    const result = await createEvalFile({ projectRoot: root, definition: await goldenDefinition() as never });
    expect(result.relPath).toBe("quality/evals/review-findings.eval.yaml");
    const manifest = await readFile(path.join(root, "stageflow.yaml"), "utf8");
    expect(manifest.match(/quality\/evals/g)).toHaveLength(1);
  });

  it("adds an explicit directory to explicit evals roots", async () => {
    const root = await project("  evals: [quality/evals]\n");
    await createEvalFile({
      projectRoot: root,
      definition: await goldenDefinition() as never,
      directory: "other/evals",
    });
    const manifest = parseYaml(await readFile(path.join(root, "stageflow.yaml"), "utf8"));
    expect(manifest.catalog.evals).toEqual(["quality/evals", "other/evals"]);
  });

  it("refuses an existing id with EVAL_EXISTS and leaves the file alone", async () => {
    const root = await project();
    const definition = await goldenDefinition();
    const first = await createEvalFile({ projectRoot: root, definition: definition as never });
    const before = await readFile(first.path, "utf8");
    await expect(createEvalFile({ projectRoot: root, definition: { ...definition, name: "Other" } as never })).rejects.toMatchObject({
      code: "EVAL_EXISTS",
    });
    expect(await readFile(first.path, "utf8")).toBe(before);
  });

  it("refuses an invalid definition with findings and writes nothing", async () => {
    const root = await project();
    const definition = { ...(await goldenDefinition()), graders: [] };
    const err = await createEvalFile({ projectRoot: root, definition: definition as never }).catch((e) => e);
    expect(err).toBeInstanceOf(EvalsWriteError);
    expect(err.code).toBe("EVAL_INVALID");
    expect(err.findings.length).toBeGreaterThan(0);
    expect(err.findings[0].category).toBe("eval");
    await expect(readdir(path.join(root, "evals"))).rejects.toThrow();
  });

  it("rejects a path escape through directory or id with CatalogPathError", async () => {
    const root = await project();
    const definition = await goldenDefinition();
    await expect(
      createEvalFile({ projectRoot: root, definition: definition as never, directory: "../outside" }),
    ).rejects.toBeInstanceOf(CatalogPathError);
    await expect(
      createEvalFile({ projectRoot: root, definition: definition as never, directory: "/tmp/abs" }),
    ).rejects.toBeInstanceOf(CatalogPathError);
    await expect(
      createEvalFile({ projectRoot: root, definition: { ...definition, id: "../../evil" } as never }),
    ).rejects.toBeInstanceOf(CatalogPathError);
  });
});

describe("updateEvalFile", () => {
  async function seeded(text = COMMENTED) {
    const root = await project("", { "evals/commented.eval.yaml": text });
    const file = path.join(root, "evals", "commented.eval.yaml");
    return { root, file, hash: contentHash(text), definition: parseYaml(text) as Record<string, any> };
  }

  it("fails with FILE_CHANGED on a stale base hash and leaves the file untouched", async () => {
    const { root, file, definition } = await seeded();
    const err = await updateEvalFile({
      projectRoot: root,
      id: "commented",
      definition,
      baseHash: "0".repeat(64),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FileChangedError);
    expect(err.code).toBe("FILE_CHANGED");
    expect(err.currentHash).toBe(contentHash(COMMENTED));
    expect(await readFile(file, "utf8")).toBe(COMMENTED);
  });

  it("returns EVAL_NOT_FOUND for an unknown id", async () => {
    const root = await project();
    await expect(
      updateEvalFile({ projectRoot: root, id: "nope", definition: {}, baseHash: "x" }),
    ).rejects.toMatchObject({ code: "EVAL_NOT_FOUND" });
  });

  it("a no-op definition leaves the text byte-identical", async () => {
    const { root, file, hash, definition } = await seeded();
    const result = await updateEvalFile({ projectRoot: root, id: "commented", definition, baseHash: hash });
    expect(result.text).toBe(COMMENTED);
    expect(await readFile(file, "utf8")).toBe(COMMENTED);
  });

  async function edit(mutate: (d: Record<string, any>) => void): Promise<{ text: string; preview: string; onDisk: string }> {
    const { root, file, hash, definition } = await seeded();
    mutate(definition);
    const preview = previewEvalUpdate(COMMENTED, definition);
    const result = await updateEvalFile({ projectRoot: root, id: "commented", definition, baseHash: hash });
    return { text: result.text, preview, onDisk: await readFile(file, "utf8") };
  }

  it("changing defaults.repeats keeps every comment; preview equals what is written", async () => {
    const { text, preview, onDisk } = await edit((d) => {
      d.defaults.repeats = 5;
    });
    expect(parseYaml(text).defaults.repeats).toBe(5);
    expect(missingComments(text)).toEqual([]);
    expect(text).toContain("repeats: 5 # repeats comment");
    expect(onDisk).toBe(text);
    expect(preview).toBe(text);
  });

  it("editing a rubric keeps the comments and the block scalar", async () => {
    const { text } = await edit((d) => {
      d.graders[1].rubric = "Pass if the review is useful.\nFail if it is vague.\n";
    });
    expect(missingComments(text)).toEqual([]);
    expect(text).toContain("rubric: |\n      Pass if the review is useful.\n      Fail if it is vague.\n");
    expect(parseYaml(text).graders[1].rubric).toBe("Pass if the review is useful.\nFail if it is vague.\n");
  });

  it("adding a grader keeps the comments and appends canonical YAML", async () => {
    const { text } = await edit((d) => {
      d.graders.push({ id: "extra", type: "code", code: "return true;\nreturn false;" });
    });
    expect(missingComments(text)).toEqual([]);
    const graders = parseYaml(text).graders;
    expect(graders.map((g: { id: string }) => g.id)).toEqual(["output-schema", "quality", "cites", "extra"]);
    expect(text).toContain("code: |-\n      return true;\n      return false;");
  });

  it("reordering two graders keeps the comments", async () => {
    const { text } = await edit((d) => {
      d.graders = [d.graders[0], d.graders[2], d.graders[1]];
    });
    expect(missingComments(text)).toEqual([]);
    expect(parseYaml(text).graders.map((g: { id: string }) => g.id)).toEqual(["output-schema", "cites", "quality"]);
  });

  it("removing a grader keeps the other comments", async () => {
    const { text } = await edit((d) => {
      d.graders.splice(1, 1);
    });
    expect(missingComments(text, ["# second grader comment", "# rubric comment"])).toEqual([]);
    expect(parseYaml(text).graders.map((g: { id: string }) => g.id)).toEqual(["output-schema", "cites"]);
  });

  it("changing target.stage keeps the comments", async () => {
    const { text } = await edit((d) => {
      d.target = { kind: "stage", pipeline: "../pipelines/p.pipeline.yaml", stage: "review" };
    });
    expect(parseYaml(text).target).toEqual({ kind: "stage", pipeline: "../pipelines/p.pipeline.yaml", stage: "review" });
    expect(text).toContain("# top-level comment");
    expect(text).toContain("# defaults comment");
    expect(text).toContain("# first grader comment");
    expect(text).toContain("# third grader comment");
  });

  it("does not add a key that equals its default when it was absent", async () => {
    const { text } = await edit((d) => {
      d.type = "capability";
      d.defaults.concurrency = 4;
      d.graders[0].weight = 1;
    });
    expect(text).not.toContain("type: capability");
    expect(text).not.toContain("concurrency");
    expect(text).not.toContain("weight");
  });

  it("inserts a new top-level key in canonical position", async () => {
    const { text } = await edit((d) => {
      d.description = "A description";
      d.budget = { cost_usd: 1 };
    });
    const keys = Object.keys(parseYaml(text));
    expect(keys).toEqual(["version", "id", "name", "description", "target", "dataset", "defaults", "graders", "budget"]);
  });

  it("writes nothing when the definition is invalid", async () => {
    const { root, file, hash, definition } = await seeded();
    definition.graders = [];
    const err = await updateEvalFile({ projectRoot: root, id: "commented", definition, baseHash: hash }).catch((e) => e);
    expect(err.code).toBe("EVAL_INVALID");
    expect(await readFile(file, "utf8")).toBe(COMMENTED);
  });

  it("rejects a definition whose id differs from the file", async () => {
    const { root, file, hash, definition } = await seeded();
    definition.id = "renamed";
    const err = await updateEvalFile({ projectRoot: root, id: "commented", definition, baseHash: hash }).catch((e) => e);
    expect(err.code).toBe("EVAL_INVALID");
    expect(await readFile(file, "utf8")).toBe(COMMENTED);
  });

  it("accepts a YAML text update and validates it", async () => {
    const { root, file, hash } = await seeded();
    const next = COMMENTED.replace("repeats: 3", "repeats: 4");
    const result = await updateEvalFile({ projectRoot: root, id: "commented", yaml: next, baseHash: hash });
    expect(await readFile(file, "utf8")).toBe(next);
    expect(result.fileHash).toBe(contentHash(next));
  });

  it("invalid YAML text or findings with errors write nothing", async () => {
    const { root, file, hash } = await seeded();
    for (const yaml of ["a: [unclosed", "just a string", COMMENTED.replace("version: 1", "version: 2")]) {
      const err = await updateEvalFile({ projectRoot: root, id: "commented", yaml, baseHash: hash }).catch((e) => e);
      expect(err.code).toBe("EVAL_INVALID");
      expect(await readFile(file, "utf8")).toBe(COMMENTED);
    }
  });

  it("requires exactly one of definition and yaml", async () => {
    const { root, hash, definition } = await seeded();
    await expect(
      updateEvalFile({ projectRoot: root, id: "commented", baseHash: hash }),
    ).rejects.toMatchObject({ code: "EVAL_INVALID" });
    await expect(
      updateEvalFile({ projectRoot: root, id: "commented", baseHash: hash, definition, yaml: COMMENTED }),
    ).rejects.toMatchObject({ code: "EVAL_INVALID" });
  });
});
