import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG_FILE_LIST_MAX, isListableExtension, listCatalogFiles } from "../src/config/listCatalogFiles.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-list-files-"));
  roots.push(root);
  return root;
}

describe("listCatalogFiles", () => {
  it("lists matching files sorted, skipping node_modules, .git and symbolic links", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await mkdir(path.join(root, "a/b"), { recursive: true });
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, "z.json"), "{}");
    await writeFile(path.join(root, "a/b/c.JSON"), "{}");
    await writeFile(path.join(root, "a/notes.md"), "");
    await writeFile(path.join(root, "node_modules/x.json"), "{}");
    await writeFile(path.join(root, ".git/y.json"), "{}");
    await writeFile(path.join(outside, "secret.json"), "{}");
    await symlink(path.join(outside, "secret.json"), path.join(root, "link.json"));
    await symlink(outside, path.join(root, "linked-dir"));
    expect(await listCatalogFiles(root, ".json")).toEqual({ files: ["a/b/c.JSON", "z.json"], truncated: false });
  });

  it("caps the number of paths and says so", async () => {
    const root = await tempRoot();
    await Promise.all(Array.from({ length: CATALOG_FILE_LIST_MAX + 3 }, (_, i) => writeFile(path.join(root, `f${i}.json`), "{}")));
    const listed = await listCatalogFiles(root, ".json");
    expect(listed.files).toHaveLength(CATALOG_FILE_LIST_MAX);
    expect(listed.truncated).toBe(true);
  });

  it("stops a wide walk after the entry budget and says so", async () => {
    const root = await tempRoot();
    await Promise.all(Array.from({ length: 50 }, (_, i) => writeFile(path.join(root, `n${String(i).padStart(2, "0")}.txt`), "")));
    await writeFile(path.join(root, "zz.json"), "{}");
    const listed = await listCatalogFiles(root, ".json", { maxEntries: 10 });
    expect(listed).toEqual({ files: [], truncated: true });
    expect((await listCatalogFiles(root, ".json")).files).toEqual(["zz.json"]);
  });

  it("stops a tree with many directories after the directory budget and says so", async () => {
    const root = await tempRoot();
    for (let i = 0; i < 12; i += 1) {
      const dir = path.join(root, `d${String(i).padStart(2, "0")}`);
      await mkdir(dir);
      await writeFile(path.join(dir, "f.json"), "{}");
    }
    const listed = await listCatalogFiles(root, ".json", { maxDirectories: 4 });
    expect(listed.truncated).toBe(true);
    expect(listed.files).toEqual(["d00/f.json", "d01/f.json", "d02/f.json"]);
  });

  it("stops when the time budget is spent", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "a.json"), "{}");
    expect(await listCatalogFiles(root, ".json", { timeBudgetMs: -1 })).toEqual({ files: [], truncated: true });
  });

  it("keeps the truncated set equal to the head of the full sorted list", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "a"));
    await mkdir(path.join(root, "a-b"));
    await writeFile(path.join(root, "a/x.json"), "{}");
    await writeFile(path.join(root, "a.json"), "{}");
    await writeFile(path.join(root, "a-b/y.json"), "{}");
    await writeFile(path.join(root, "b.json"), "{}");
    const full = (await listCatalogFiles(root, ".json")).files;
    expect(full).toEqual([...full].sort());
    const head = await listCatalogFiles(root, ".json", { maxEntries: 3 });
    expect(head.truncated).toBe(true);
    expect(head.files).toEqual(full.slice(0, head.files.length));
  });

  it("accepts only simple extensions", () => {
    expect(isListableExtension(".json")).toBe(true);
    expect(isListableExtension("json")).toBe(false);
    expect(isListableExtension("../x")).toBe(false);
    expect(isListableExtension("")).toBe(false);
  });
});
