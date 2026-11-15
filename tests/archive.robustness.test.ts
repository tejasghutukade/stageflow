import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildArchive, planArchive, type ArchiveManifest } from "../src/archive/build.js";
import { detectArchive, scanArchive } from "../src/archive/restoreArchive.js";
import { readTarGz } from "../src/archive/tarReader.js";
import { USTAR_MAX_SIZE, header, paxBody, paxRecord } from "../src/archive/tarStream.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import type { RunStore } from "../src/runstore/port.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeHome(): Promise<{ home: string; store: RunStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-robust-"));
  const { store } = createRunStoreWithConnection({ rootDir: root, openerMode: "migrate" });
  cleanups.push(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { home: storeRootFor(root), store };
}

function put(home: string, relative: string, content: string | Buffer): void {
  const file = path.join(home, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const fakeStore = (store: RunStore, listRuns: () => Promise<never[]> = async () => []) => ({ snapshotInto: store.snapshotInto.bind(store), listRuns, getWorkspaceDir: () => "" });

describe("files of 8 GiB or more", () => {
  it("carry their size in a PAX record, because the ustar size field cannot hold it", () => {
    expect(USTAR_MAX_SIZE).toBe(8 ** 11 - 1);
    expect(paxBody("small.txt", "", 10)).toBeUndefined();
    expect(paxBody("small.txt", "", USTAR_MAX_SIZE)).toBeUndefined();
    const big = 9 * 2 ** 30;
    const body = paxBody("big.bin", "", big)!.toString("utf8");
    expect(body).toContain(`size=${big}\n`);
    const block = header("big.bin", big, "0", { mode: 0o644, mtimeSeconds: 0 });
    expect(block.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim()).toBe("0".repeat(11));
    const atLimit = header("edge.bin", USTAR_MAX_SIZE, "0", { mode: 0o644, mtimeSeconds: 0 });
    expect(Number.parseInt(atLimit.subarray(124, 135).toString("ascii"), 8)).toBe(USTAR_MAX_SIZE);
  });

  it("are read back with the PAX size, not the empty ustar field", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-pax-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "pax.tar.gz");
    const content = Buffer.from("hello");
    const body = paxRecord("size", String(content.length));
    const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512, 0);
    const gzip = createGzip();
    const writing = pipeline(gzip, createWriteStream(file));
    gzip.write(header("PaxHeader", body.length, "x", { mode: 0o644, mtimeSeconds: 0 }));
    gzip.write(body);
    gzip.write(pad(body.length));
    gzip.write(header("file.txt", 0, "0", { mode: 0o644, mtimeSeconds: 0 }));
    gzip.write(content);
    gzip.write(pad(content.length));
    gzip.write(header("after.txt", 3, "0", { mode: 0o644, mtimeSeconds: 0 }));
    gzip.write(Buffer.from("abc"));
    gzip.write(pad(3));
    gzip.write(Buffer.alloc(1024, 0));
    gzip.end();
    await writing;
    const seen: Array<[string, number, string]> = [];
    await readTarGz(file, async (entry, data) => {
      const chunks: Buffer[] = [];
      for await (const chunk of data) chunks.push(chunk);
      seen.push([entry.name, entry.size, Buffer.concat(chunks).toString()]);
    });
    expect(seen).toEqual([["file.txt", 5, "hello"], ["after.txt", 3, "abc"]]);
  });
});

describe("a Host that keeps changing while the archive is built", () => {
  it("skips a file that was removed after the walk, records it, and still writes a valid archive", async () => {
    const { home, store } = await makeHome();
    put(home, "workspace/stays.md", "stays");
    put(home, "workspace/goes.md", "goes");
    const listRuns = async () => {
      rmSync(path.join(home, "workspace", "goes.md"));
      return [] as never[];
    };
    const result = await buildArchive({ store: fakeStore(store, listRuns), homeDir: home });
    let manifest: ArchiveManifest | undefined;
    const names: string[] = [];
    await readTarGz(result.path, async (entry, data) => {
      names.push(entry.name);
      const chunks: Buffer[] = [];
      for await (const chunk of data) chunks.push(chunk);
      if (entry.name === "manifest.json") manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ArchiveManifest;
    });
    expect(names).toContain("workspace/stays.md");
    expect(names).not.toContain("workspace/goes.md");
    expect(manifest!.left_out).toContainEqual({ path: "workspace/goes.md", reason: "removed while the archive was being built" });
    await expect(scanArchive(result.path)).resolves.toMatchObject({ marker: { archive_version: 1 } });
  });

  it("walks the data directory without holding the event loop", async () => {
    const { home } = await makeHome();
    for (let folder = 0; folder < 30; folder += 1) for (let file = 0; file < 100; file += 1) put(home, `workspace/f${folder}/file-${file}.md`, "x");
    let ticks = 0;
    let running = true;
    const spin = (): void => {
      if (!running) return;
      ticks += 1;
      setImmediate(spin);
    };
    spin();
    const plan = await planArchive(home, { includeSecrets: false, includeA2a: false });
    running = false;
    expect(plan.entries.filter((entry) => entry.kind === "file").length).toBeGreaterThanOrEqual(3000);
    expect(ticks).toBeGreaterThan(200);
  });
});

describe("reading an archive that turns out to be bad", () => {
  const openFiles = (): number => {
    for (const dir of ["/proc/self/fd", "/dev/fd"]) {
      try { return readdirSync(dir).length; } catch { /* try the next */ }
    }
    return -1;
  };

  it("closes the file when a check throws midway, instead of leaking a descriptor each time", async () => {
    if (openFiles() < 0) return;
    const { home, store } = await makeHome();
    put(home, "workspace/a.md", "first");
    put(home, "workspace/big.bin", randomBytes(6 * 1024 * 1024));
    const { path: archive } = await buildArchive({ store: fakeStore(store), homeDir: home });
    await scanArchive(archive);
    const before = openFiles();
    for (let i = 0; i < 150; i += 1) {
      await expect(readTarGz(archive, async (entry) => { if (entry.name === "workspace/a.md") throw new Error("stop"); })).rejects.toThrow("stop");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(openFiles() - before).toBeLessThan(15);
  });
});

describe("recognising an archive", () => {
  it("needs only the first member: a big archive cut short is still recognised, and a full scan of it fails", async () => {
    const { home, store } = await makeHome();
    put(home, "workspace/big.bin", randomBytes(6 * 1024 * 1024));
    const { path: archive } = await buildArchive({ store: fakeStore(store), homeDir: home });
    const whole = readFileSync(archive);
    const cut = `${archive}.cut.tar.gz`;
    writeFileSync(cut, whole.subarray(0, 60_000));
    expect(await detectArchive(cut)).toMatchObject({ archive_version: 1 });
    await expect(scanArchive(cut)).rejects.toBeDefined();
    expect(existsSync(cut)).toBe(true);
  });
});
