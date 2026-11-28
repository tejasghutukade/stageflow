import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { open, readFile, readdir, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createOwnerOnlyDirectory, globalStageflowHome } from "../project/globalHome.js";
import { isInsideDir } from "../runstore/workspaceLayout.js";
import {
  PATH_DENIED_MESSAGE,
  resolveContainedRelativePath,
  type ContainedPathMessages,
} from "../runread/readArtifact.js";

const STORE_MESSAGES: ContainedPathMessages = {
  relativeRequired: "path must be relative to the artifact store",
  escapes: "path escapes the artifact store",
  notFound: (relativePath) => `Artifact not found: ${relativePath}`,
  denied: PATH_DENIED_MESSAGE,
};

let failNextWrite = false;
let failNextPromote = false;
let failAfterRename = false;

export const STALE_STAGING_DIRECTORY_MS = 10 * 60 * 1000;

export function setPublishWriteFailureForTests(enabled: boolean): void {
  failNextWrite = enabled;
}

export function setPublishRenameFailureForTests(enabled: boolean): void {
  failNextPromote = enabled;
}

export function setPublishCommitFailureForTests(enabled: boolean): void {
  failAfterRename = enabled;
}

export function artifactStoreRoot(): string {
  return path.join(globalStageflowHome(), "artifacts");
}

export function artifactKeyHash(storageKey: string): string {
  return createHash("sha256").update(storageKey).digest("hex").slice(0, 32);
}

export function containedStorePath(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
      throw new Error("path escapes the artifact store");
    }
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path escapes the artifact store");
  }
  return target;
}

export async function readStoredArtifactFile(
  storageKey: string,
  version: number,
  fileName: string,
): Promise<Buffer> {
  const root = artifactStoreRoot();
  createOwnerOnlyDirectory(root);
  const relative = path.posix.join(artifactKeyHash(storageKey), `v${version}`, fileName);
  const absolute = await resolveContainedRelativePath(root, relative, STORE_MESSAGES);
  return readFile(absolute);
}

async function writeAtomicFile(directory: string, name: string, bytes: Buffer): Promise<void> {
  const tmp = path.join(directory, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (failNextWrite) {
    failNextWrite = false;
    await unlink(tmp).catch(() => undefined);
    throw new Error("injected publish failure");
  }
  const target = containedStorePath(directory, name);
  await rename(tmp, target);
}

function writeAtomicFileSync(directory: string, name: string, bytes: Buffer): void {
  const tmp = path.join(directory, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const target = containedStorePath(directory, name);
  renameSync(tmp, target);
}

function keyDirectory(storageKey: string): { root: string; keyDir: string } {
  const root = artifactStoreRoot();
  createOwnerOnlyDirectory(root);
  const keyDir = containedStorePath(root, artifactKeyHash(storageKey));
  return { root, keyDir };
}

export async function stageStoredContent(input: {
  storageKey: string;
  fileName: string;
  bytes: Buffer;
}): Promise<string> {
  const { root, keyDir } = keyDirectory(input.storageKey);
  createOwnerOnlyDirectory(keyDir);
  const stagingName = `.staging-${randomBytes(8).toString("hex")}`;
  const stagingDir = containedStorePath(keyDir, stagingName);
  createOwnerOnlyDirectory(stagingDir);
  try {
    await writeAtomicFile(stagingDir, input.fileName, input.bytes);
    const rootReal = await realpath(root);
    const written = await realpath(path.join(stagingDir, input.fileName));
    if (!isInsideDir(written, rootReal)) {
      throw new Error("path escapes the artifact store");
    }
    return stagingName;
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    await removeIfEmpty(keyDir);
    throw error;
  }
}

export function promoteStagedVersionSync(input: {
  storageKey: string;
  stagingName: string;
  version: number;
  manifest: unknown;
}): string {
  const { keyDir } = keyDirectory(input.storageKey);
  const stagingDir = containedStorePath(keyDir, input.stagingName);
  const versionName = `v${input.version}`;
  const versionDir = containedStorePath(keyDir, versionName);
  if (failNextPromote) {
    failNextPromote = false;
    throw new Error("injected publish rename failure");
  }
  if (lstatIfExists(versionDir)) {
    throw Object.assign(new Error("version directory already exists"), { code: "ARTIFACT_VERSION_CONFLICT" });
  }
  renameSync(stagingDir, versionDir);
  try {
    writeAtomicFileSync(versionDir, "manifest.json", Buffer.from(JSON.stringify(input.manifest), "utf8"));
  } catch (error) {
    rmSync(versionDir, { recursive: true, force: true });
    throw error;
  }
  if (failAfterRename) {
    failAfterRename = false;
    throw new Error("injected publish commit failure");
  }
  return versionName;
}

export async function writeStoredVersion(input: {
  storageKey: string;
  version: number;
  fileName: string;
  bytes: Buffer;
  manifest: unknown;
}): Promise<void> {
  const stagingName = await stageStoredContent(input);
  try {
    promoteStagedVersionSync({
      storageKey: input.storageKey,
      stagingName,
      version: input.version,
      manifest: input.manifest,
    });
  } catch (error) {
    await removeStoredDirectory(input.storageKey, stagingName);
    throw error;
  }
}

export async function removeStoredDirectory(storageKey: string, directoryName: string): Promise<void> {
  const root = artifactStoreRoot();
  const keyDir = containedStorePath(root, artifactKeyHash(storageKey));
  const target = containedStorePath(keyDir, directoryName);
  await rm(target, { recursive: true, force: true });
  await removeIfEmpty(keyDir);
}

export async function removeStoredVersion(storageKey: string, version: number): Promise<void> {
  await removeStoredDirectory(storageKey, `v${version}`);
}

export function versionDirectoryExistsSync(storageKey: string, version: number): boolean {
  const { keyDir } = keyDirectory(storageKey);
  return lstatIfExists(containedStorePath(keyDir, `v${version}`)) !== undefined;
}

export function removeOrphanVersionSync(storageKey: string, version: number): void {
  const { keyDir } = keyDirectory(storageKey);
  removeContainedEntrySync(keyDir, containedStorePath(keyDir, `v${version}`));
}

export function sweepStaleStagingDirectoriesSync(storageKey: string, now = Date.now()): void {
  const { keyDir } = keyDirectory(storageKey);
  const rootStat = lstatIfExists(keyDir);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;
  let names: string[];
  try {
    names = readdirSync(keyDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(".staging-")) continue;
    let child: string;
    try {
      child = containedStorePath(keyDir, name);
    } catch {
      continue;
    }
    const childStat = lstatIfExists(child);
    if (!childStat) continue;
    if (now - childStat.mtimeMs <= STALE_STAGING_DIRECTORY_MS) continue;
    try {
      removeContainedEntrySync(keyDir, child);
    } catch {
      // best effort: a leftover staging directory must not fail the publish
    }
  }
}

export async function removeStoredArtifact(storageKey: string): Promise<void> {
  const root = artifactStoreRoot();
  const keyDir = containedStorePath(root, artifactKeyHash(storageKey));
  await rm(keyDir, { recursive: true, force: true });
}

function isEnoent(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "ENOENT";
}

function lstatIfExists(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

function assertInsideKeyDir(keyDir: string, target: string): void {
  const relative = path.relative(keyDir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path escapes the artifact store");
  }
}

function removeContainedEntrySync(keyDir: string, target: string): void {
  assertInsideKeyDir(keyDir, target);
  const stat = lstatIfExists(target);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    unlinkSync(target);
    return;
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(target)) {
      if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
        throw new Error("path escapes the artifact store");
      }
      removeContainedEntrySync(keyDir, containedStorePath(target, name));
    }
    rmdirSync(target);
    return;
  }
  unlinkSync(target);
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir);
    if (entries.length === 0) await rmdir(dir);
  } catch {
    // already gone
  }
}
