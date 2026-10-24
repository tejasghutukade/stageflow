import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CatalogPathError } from "../src/config/catalogRelativePath.js";
import { EvalsWriteError, FileChangedError } from "../src/config/atomicWrite.js";
import { datasetContentHash } from "../src/config/datasetHash.js";
import { loadDatasetFile } from "../src/config/loadDataset.js";
import {
  appendOrReplaceCases,
  applyCaseOps,
  convertDatasetToJsonl,
  createDatasetFile,
  renderDatasetJsonl,
} from "../src/config/writeDataset.js";

const roots: string[] = [];

async function project(manifestExtra = "", files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-writeds-"));
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

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;

const SEED = [
  { id: "c001", title: "one", input: { n: 1 }, tags: ["a"] },
  { id: "c002", input: { n: 2 } },
  { id: "c003", input: { n: 3 }, expected: { x: 1 } },
  { id: "c004", input: { n: 4 } },
  { id: "c005", input: { n: 5 } },
];
const SEED_TEXT = SEED.map(line).join("");
const SEED_HASH = datasetContentHash(SEED);

async function seeded() {
  const root = await project("", { "datasets/seed.dataset.jsonl": SEED_TEXT });
  const file = path.join(root, "datasets", "seed.dataset.jsonl");
  return { root, file };
}

describe("renderDatasetJsonl", () => {
  it("writes compact lines in stable key order with a trailing newline", () => {
    const text = renderDatasetJsonl([
      { metadata: { m: 1 }, goal: "g", tags: ["t"], expected: 1, input: { a: 1 }, title: "T", id: "c001" },
    ]);
    expect(text).toBe('{"id":"c001","title":"T","input":{"a":1},"expected":1,"tags":["t"],"goal":"g","metadata":{"m":1}}\n');
  });
});

describe("createDatasetFile", () => {
  it("writes JSONL into the default datasets root and assigns ids", async () => {
    const root = await project();
    const result = await createDatasetFile({
      projectRoot: root,
      name: "fresh",
      cases: [{ input: { a: 1 } }, { id: "custom", input: { a: 2 } }, { input: { a: 3 } }],
    });
    expect(result.relPath).toBe("datasets/fresh.dataset.jsonl");
    expect(result.cases.map((c) => c.id)).toEqual(["c001", "custom", "c002"]);
    expect(await readFile(result.path, "utf8")).toBe(result.text);
    expect(result.hash).toBe(datasetContentHash(result.cases));
  });

  it("refuses an existing name, an invalid name and invalid cases", async () => {
    const { root } = await seeded();
    await expect(createDatasetFile({ projectRoot: root, name: "seed", cases: [{ input: {} }] })).rejects.toMatchObject({
      code: "DATASET_EXISTS",
    });
    await expect(createDatasetFile({ projectRoot: root, name: "Bad Name", cases: [{ input: {} }] })).rejects.toMatchObject({
      code: "DATASET_NAME_INVALID",
    });
    const err = await createDatasetFile({
      projectRoot: root,
      name: "bad",
      cases: [{ input: {}, bogus: 1 } as never],
    }).catch((e) => e);
    expect(err.code).toBe("DATASET_INVALID");
    await expect(readFile(path.join(root, "datasets", "bad.dataset.jsonl"))).rejects.toThrow();
  });

  it("rejects path escapes through name or directory", async () => {
    const root = await project();
    await expect(
      createDatasetFile({ projectRoot: root, name: "../../evil", cases: [{ input: {} }] }),
    ).rejects.toBeInstanceOf(CatalogPathError);
    await expect(
      createDatasetFile({ projectRoot: root, name: "x", cases: [{ input: {} }], directory: "../out" }),
    ).rejects.toBeInstanceOf(CatalogPathError);
    await expect(readdir(path.join(root, ".."))).resolves.not.toContain("evil.dataset.jsonl");
  });

  it("registers an explicit directory with explicit datasets roots", async () => {
    const root = await project("  datasets: [data/one]\n");
    await createDatasetFile({ projectRoot: root, name: "x", cases: [{ input: {} }], directory: "data/two" });
    expect(await readFile(path.join(root, "stageflow.yaml"), "utf8")).toContain("data/two");
  });
});

describe("applyCaseOps", () => {
  it("applies add, update, delete and set_tags together", async () => {
    const { root, file } = await seeded();
    const result = await applyCaseOps({
      projectRoot: root,
      id: "seed",
      baseHash: SEED_HASH,
      ops: [
        { op: "add", case: { input: { n: 6 } } },
        { op: "update", id: "c002", case: { input: { n: 22 }, title: "two" } },
        { op: "delete", id: "c004" },
        { op: "set_tags", id: "c003", tags: ["x", "y"] },
        { op: "set_tags", id: "c001", tags: [] },
      ],
    });
    expect(result.cases.map((c) => c.id)).toEqual(["c001", "c002", "c003", "c005", "c006"]);
    expect(result.cases[0]).toEqual({ id: "c001", title: "one", input: { n: 1 } });
    expect(result.cases[1]).toEqual({ id: "c002", title: "two", input: { n: 22 } });
    expect(result.cases[2]!.tags).toEqual(["x", "y"]);
    const loaded = await loadDatasetFile(file);
    expect(loaded.contentHash).toBe(result.hash);
    expect(await readFile(file, "utf8")).toBe(result.text);
  });

  it("applies nothing when one op in the batch is bad", async () => {
    const { root, file } = await seeded();
    for (const bad of [
      { op: "delete", id: "nope" },
      { op: "update", id: "nope", case: { input: {} } },
      { op: "add", case: { id: "c001", input: {} } },
      { op: "update", id: "c001", case: { id: "c009", input: {} } },
      { op: "set_tags", id: "c001", tags: ["Bad Tag"] },
    ] as const) {
      const err = await applyCaseOps({
        projectRoot: root,
        id: "seed",
        baseHash: SEED_HASH,
        ops: [{ op: "add", case: { input: { n: 9 } } }, bad],
      }).catch((e) => e);
      expect(err).toBeInstanceOf(EvalsWriteError);
      expect(["DATASET_CASE_OP_INVALID", "DATASET_INVALID"]).toContain(err.code);
      expect(await readFile(file, "utf8")).toBe(SEED_TEXT);
    }
  });

  it("assigns ids continuing after the highest cNNN even across deletes in the same batch", async () => {
    const { root } = await seeded();
    const result = await applyCaseOps({
      projectRoot: root,
      id: "seed",
      baseHash: SEED_HASH,
      ops: [
        { op: "delete", id: "c005" },
        { op: "add", case: { input: {} } },
        { op: "add", case: { input: {} } },
      ],
    });
    expect(result.cases.map((c) => c.id)).toEqual(["c001", "c002", "c003", "c004", "c005", "c006"]);
  });

  it("fails with FILE_CHANGED on a stale hash and leaves the file untouched", async () => {
    const { root, file } = await seeded();
    const err = await applyCaseOps({
      projectRoot: root,
      id: "seed",
      baseHash: "stale",
      ops: [{ op: "delete", id: "c001" }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FileChangedError);
    expect(err.currentHash).toBe(SEED_HASH);
    expect(await readFile(file, "utf8")).toBe(SEED_TEXT);
  });

  it("refuses .json and .csv with DATASET_READ_ONLY", async () => {
    const root = await project("", {
      "datasets/j.dataset.json": JSON.stringify(SEED),
      "datasets/c.dataset.csv": "id,input.n:json\nc001,1\n",
    });
    for (const id of ["j", "c"]) {
      await expect(
        applyCaseOps({ projectRoot: root, id, baseHash: "x", ops: [{ op: "delete", id: "c001" }] }),
      ).rejects.toMatchObject({ code: "DATASET_READ_ONLY" });
    }
  });

  it("returns DATASET_NOT_FOUND for an unknown dataset", async () => {
    const root = await project();
    await expect(
      applyCaseOps({ projectRoot: root, id: "nope", baseHash: "x", ops: [] }),
    ).rejects.toMatchObject({ code: "DATASET_NOT_FOUND" });
  });

  it("refuses to delete every case", async () => {
    const { root, file } = await seeded();
    const err = await applyCaseOps({
      projectRoot: root,
      id: "seed",
      baseHash: SEED_HASH,
      ops: SEED.map((c) => ({ op: "delete" as const, id: c.id })),
    }).catch((e) => e);
    expect(err.code).toBe("DATASET_INVALID");
    expect(await readFile(file, "utf8")).toBe(SEED_TEXT);
  });
});

describe("appendOrReplaceCases", () => {
  it("append continues ids after the highest cNNN", async () => {
    const { root } = await seeded();
    const result = await appendOrReplaceCases({
      projectRoot: root,
      id: "seed",
      baseHash: SEED_HASH,
      mode: "append",
      cases: [{ input: { n: 6 } }, { input: { n: 7 } }],
    });
    expect(result.cases.map((c) => c.id)).toEqual(["c001", "c002", "c003", "c004", "c005", "c006", "c007"]);
  });

  it("append rejects duplicate ids", async () => {
    const { root, file } = await seeded();
    const err = await appendOrReplaceCases({
      projectRoot: root,
      id: "seed",
      baseHash: SEED_HASH,
      mode: "append",
      cases: [{ id: "c002", input: {} }],
    }).catch((e) => e);
    expect(err.code).toBe("DATASET_CASE_OP_INVALID");
    expect(await readFile(file, "utf8")).toBe(SEED_TEXT);
  });

  it("replace discards existing cases and restarts numbering", async () => {
    const { root } = await seeded();
    const result = await appendOrReplaceCases({
      projectRoot: root,
      id: "seed",
      baseHash: SEED_HASH,
      mode: "replace",
      cases: [{ input: { n: 1 } }, { input: { n: 2 } }, { input: { n: 3 } }, { input: { n: 4 } }, { input: { n: 5 } }],
    });
    expect(result.cases.map((c) => c.id)).toEqual(["c001", "c002", "c003", "c004", "c005"]);
    expect(result.cases[0]!.input).toEqual({ n: 1 });
  });
});

describe("convertDatasetToJsonl", () => {
  it("converts json and csv next to the original, keeping the original and the content hash", async () => {
    const root = await project("", {
      "datasets/j.dataset.json": JSON.stringify(SEED),
      "datasets/c.dataset.csv": "id,input.n:json\nc001,1\nc002,2\nc003,3\nc004,4\nc005,5\n",
    });
    const before = (await loadDatasetFile(path.join(root, "datasets", "j.dataset.json"))).contentHash;
    const result = await convertDatasetToJsonl({ projectRoot: root, id: "j", baseHash: before });
    expect(result.relPath).toBe("datasets/j.dataset.jsonl");
    expect(result.hash).toBe(before);
    expect((await loadDatasetFile(result.path)).contentHash).toBe(before);
    expect(await readFile(path.join(root, "datasets", "j.dataset.json"), "utf8")).toBe(JSON.stringify(SEED));

    const csvHash = (await loadDatasetFile(path.join(root, "datasets", "c.dataset.csv"))).contentHash;
    const csv = await convertDatasetToJsonl({ projectRoot: root, id: "c", baseHash: csvHash });
    expect(csv.hash).toBe(csvHash);
    expect(csv.cases).toHaveLength(5);
  });

  it("refuses when the jsonl target exists, on a stale hash and for a jsonl dataset", async () => {
    const root = await project("", {
      "datasets/j.dataset.json": JSON.stringify(SEED),
      "datasets/j.dataset.jsonl": SEED_TEXT,
      "datasets/seed.dataset.jsonl": SEED_TEXT,
    });
    const hash = (await loadDatasetFile(path.join(root, "datasets", "j.dataset.json"))).contentHash;
    await expect(convertDatasetToJsonl({ projectRoot: root, id: "j.json", baseHash: hash })).rejects.toMatchObject({
      code: "DATASET_EXISTS",
    });
    await expect(convertDatasetToJsonl({ projectRoot: root, id: "j.json", baseHash: "stale" })).rejects.toBeInstanceOf(
      FileChangedError,
    );
    await expect(convertDatasetToJsonl({ projectRoot: root, id: "seed", baseHash: SEED_HASH })).rejects.toMatchObject({
      code: "DATASET_INVALID",
    });
  });
});
