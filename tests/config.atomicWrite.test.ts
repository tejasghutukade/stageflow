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
  commitPackageFiles,
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

describe("commitPackageFiles", () => {
  it("restores the first file when the second rename fails", async () => {
    const dir = await tmp();
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    await writeFile(a, "before-a");
    await writeFile(b, "before-b");
    let renameCalls = 0;
    vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error("rename failed");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return actual.rename(from as string, to as string);
    });
    await expect(
      commitPackageFiles([
        { absPath: a, content: "after-a" },
        { absPath: b, content: "after-b" },
      ]),
    ).rejects.toThrow("rename failed");
    expect(await readFile(a, "utf8")).toBe("before-a");
    expect(await readFile(b, "utf8")).toBe("before-b");
  });
});

describe("commitPackageFiles keeps what it does not change", () => {
  it("keeps the file mode and writes a symlinked file through to its target", async () => {
    const dir = await tmp();
    const a = path.join(dir, "a.yaml");
    await writeFile(a, "before", { mode: 0o640 });
    await fsp.chmod(a, 0o640);
    const target = path.join(dir, "real.yaml");
    const link = path.join(dir, "link.yaml");
    await writeFile(target, "before-link");
    await fsp.symlink(target, link);
    await commitPackageFiles([
      { absPath: a, content: "after" },
      { absPath: link, content: "after-link" },
    ]);
    expect((await fsp.stat(a)).mode & 0o777).toBe(0o640);
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("after-link");
  });

  it("refuses to commit, and deletes nothing, when an existing file cannot be read", async () => {
    const dir = await tmp();
    const a = path.join(dir, "a.yaml");
    await writeFile(a, "secret");
    await fsp.chmod(a, 0o000);
    try {
      await expect(commitPackageFiles([{ absPath: a, content: "after" }])).rejects.toBeTruthy();
    } finally {
      await fsp.chmod(a, 0o600);
    }
    expect(await readFile(a, "utf8")).toBe("secret");
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
