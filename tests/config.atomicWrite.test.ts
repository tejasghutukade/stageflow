import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, rename: vi.fn(actual.rename) };
});

import * as fsp from "node:fs/promises";
import {
  assertBaseHash,
  contentHash,
  FileChangedError,
  writeFileAtomic,
} from "../src/config/atomicWrite.js";

const dirs: string[] = [];

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sf-atomic-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.mocked(fsp.rename).mockClear();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("writeFileAtomic", () => {
  it("replaces the file and leaves no temp file", async () => {
    const dir = await tmp();
    const file = path.join(dir, "a.txt");
    await writeFile(file, "old");
    await writeFileAtomic(file, "new");
    expect(await readFile(file, "utf8")).toBe("new");
    expect(await readdir(dir)).toEqual(["a.txt"]);
  });

  it("keeps the original intact when the process fails between temp write and rename", async () => {
    const dir = await tmp();
    const file = path.join(dir, "a.txt");
    await writeFile(file, "original");
    vi.mocked(fsp.rename).mockRejectedValueOnce(new Error("crash"));
    await expect(writeFileAtomic(file, "replacement")).rejects.toThrow("crash");
    expect(await readFile(file, "utf8")).toBe("original");
    expect(await readdir(dir)).toEqual(["a.txt"]);
  });

  it("creates missing parent directories", async () => {
    const dir = await tmp();
    const file = path.join(dir, "deep", "er", "a.txt");
    await writeFileAtomic(file, "x");
    expect(await readFile(file, "utf8")).toBe("x");
  });
});

describe("assertBaseHash", () => {
  it("passes on a matching hash and raises FileChangedError with the current hash otherwise", async () => {
    const dir = await tmp();
    const file = path.join(dir, "a.txt");
    await writeFile(file, "content");
    await expect(assertBaseHash(file, contentHash("content"))).resolves.toBe(contentHash("content"));
    const err = await assertBaseHash(file, "other").catch((e) => e);
    expect(err).toBeInstanceOf(FileChangedError);
    expect(err.currentHash).toBe(contentHash("content"));
  });
});
