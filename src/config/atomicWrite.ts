import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "../evals/canonical.js";
import type { ValidationFinding } from "./validateCatalog.js";

export type EvalsWriteErrorCode =
  | "EVAL_EXISTS"
  | "EVAL_NOT_FOUND"
  | "EVAL_INVALID"
  | "EVAL_DEFINITION_ID_MISMATCH"
  | "DATASET_EXISTS"
  | "DATASET_NOT_FOUND"
  | "DATASET_INVALID"
  | "DATASET_READ_ONLY"
  | "DATASET_CASE_OP_INVALID"
  | "DATASET_NAME_INVALID"
  | "SAMPLE_EXISTS"
  | "SAMPLE_SOURCE_MISSING"
  | "SAMPLE_NO_DEFAULT_MODEL"
  | "SAMPLE_AGENTS_UNAVAILABLE";

export class EvalsWriteError extends Error {
  readonly code: EvalsWriteErrorCode;
  readonly findings: ValidationFinding[];

  constructor(code: EvalsWriteErrorCode, message: string, findings: ValidationFinding[] = []) {
    super(message);
    this.name = "EvalsWriteError";
    this.code = code;
    this.findings = findings;
  }
}

export class FileChangedError extends Error {
  readonly code = "FILE_CHANGED" as const;
  readonly currentHash: string;

  constructor(currentHash: string) {
    super("The file changed on disk since it was loaded");
    this.name = "FileChangedError";
    this.currentHash = currentHash;
  }
}

export function contentHash(bytes: string | Uint8Array): string {
  return sha256Hex(bytes);
}

export async function assertBaseHash(filePath: string, baseHash: string): Promise<string> {
  const current = contentHash(await readFile(filePath));
  if (current !== baseHash) throw new FileChangedError(current);
  return current;
}

export async function writeFileAtomic(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export type PackageFileCommit = {
  absPath: string;
  content: string;
};

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function restoreCommitted(
  committed: ReadonlyArray<{ target: string; previous: string | null }>,
): Promise<void> {
  for (const entry of committed) {
    if (entry.previous === null) {
      await rm(entry.target, { force: true });
    } else {
      await mkdir(path.dirname(entry.target), { recursive: true });
      await writeFile(entry.target, entry.previous, "utf8");
    }
  }
}

/**
 * Write every changed file via a temp in the target directory, then rename.
 * On rename failure, restores targets that were already renamed from in-memory originals.
 */
export async function commitPackageFiles(
  files: readonly PackageFileCommit[],
): Promise<void> {
  const pending: PackageFileCommit[] = [];
  const originals = new Map<string, string | null>();
  for (const file of files) {
    const previous = await readTextOrNull(file.absPath);
    originals.set(file.absPath, previous);
    if (previous === file.content) continue;
    pending.push(file);
  }
  if (pending.length === 0) return;

  const temps: Array<{ tmp: string; target: string }> = [];
  const tag = `${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    for (let index = 0; index < pending.length; index += 1) {
      const file = pending[index]!;
      await mkdir(path.dirname(file.absPath), { recursive: true });
      const tmp = `${file.absPath}.tmp-${tag}-${index}`;
      await writeFile(tmp, file.content, "utf8");
      temps.push({ tmp, target: file.absPath });
    }

    const committed: Array<{ target: string; previous: string | null }> = [];
    for (const { tmp, target } of temps) {
      try {
        await rename(tmp, target);
        committed.push({ target, previous: originals.get(target) ?? null });
      } catch (err) {
        await restoreCommitted(committed);
        await Promise.all(
          temps.map((entry) => rm(entry.tmp, { force: true }).catch(() => {})),
        );
        throw err;
      }
    }
  } catch (err) {
    await Promise.all(
      temps.map((entry) => rm(entry.tmp, { force: true }).catch(() => {})),
    );
    throw err;
  }
}

const packageDirChains = new Map<string, Promise<void>>();

async function packageDirKey(packageDirectory: string): Promise<string> {
  try {
    return await realpath(packageDirectory);
  } catch {
    return path.resolve(packageDirectory);
  }
}

export async function withPackageDirLock<T>(
  packageDirectory: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = await packageDirKey(packageDirectory);
  const prior = packageDirChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prior.then(() => gate);
  packageDirChains.set(key, chained);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (packageDirChains.get(key) === chained) {
      packageDirChains.delete(key);
    }
  }
}
