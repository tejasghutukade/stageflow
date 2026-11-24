import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { DiskBreakdown } from "../runstore/diskUsage.js";
import { STALE_STAGING_DIRECTORY_MS, artifactKeyHash, artifactStoreRoot } from "./store.js";

export const PUBLISHED_VERSION_DIR = /^v\d+$/;

/** Health reuses a store report for this long instead of walking the tree again. */
export const PUBLISHED_ARTIFACT_REPORT_TTL_MS = 60_000;

/** Yield to the event loop once a report slice has run about this long. */
const REPORT_YIELD_MS = 20;

let artifactKeyHashCalls = 0;

export function artifactKeyHashCallCount(): number {
  return artifactKeyHashCalls;
}

export function resetArtifactKeyHashCallCount(): void {
  artifactKeyHashCalls = 0;
}

function hashArtifactKey(key: string): string {
  artifactKeyHashCalls += 1;
  return artifactKeyHash(key);
}

function yieldSlice(sliceStarted: number): Promise<number> {
  if (Date.now() - sliceStarted < REPORT_YIELD_MS) return Promise.resolve(sliceStarted);
  return new Promise((resolve) => {
    setImmediate(() => resolve(Date.now()));
  });
}

export function isPublishedArtifactStagingName(name: string): boolean {
  return name.startsWith(".staging-");
}

export function isUnderPublishedArtifactStore(relative: string): boolean {
  return relative === "artifacts" || relative.startsWith("artifacts/");
}

export function publishedArtifactArchiveSkip(relative: string): string | undefined {
  if (!isUnderPublishedArtifactStore(relative)) return undefined;
  const segments = relative.split("/");
  if (segments.some((segment) => isPublishedArtifactStagingName(segment))) {
    return "publish staging directory";
  }
  return undefined;
}

export function publishedArtifactBackupSkipChildName(name: string): boolean {
  return isPublishedArtifactStagingName(name) || !PUBLISHED_VERSION_DIR.test(name);
}

export type ArtifactBackupMember = {
  name: string;
  filePath: string;
  mode: number;
};

export async function collectPublishedArtifactBackupMembers(
  homeDir: string,
): Promise<ArtifactBackupMember[]> {
  const root = path.join(homeDir, "artifacts");
  const members: ArtifactBackupMember[] = [];
  let keyHashes: string[];
  try {
    keyHashes = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return members;
    throw err;
  }
  for (const keyHash of keyHashes.sort()) {
    if (keyHash.length === 0 || keyHash === "." || keyHash === "..") continue;
    const keyDir = path.join(root, keyHash);
    let children: string[];
    try {
      children = await readdir(keyDir);
    } catch {
      continue;
    }
    for (const child of children) {
      if (publishedArtifactBackupSkipChildName(child)) continue;
      const versionDir = path.join(keyDir, child);
      await walkBackupTree(`artifacts/${keyHash}/${child}`, versionDir, members);
    }
  }
  return members;
}

async function walkBackupTree(
  relativePrefix: string,
  absoluteDir: string,
  members: ArtifactBackupMember[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(absoluteDir);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
  if (name.length === 0 || name === "." || name === "..") continue;
  const absolute = path.join(absoluteDir, name);
  const relative = `${relativePrefix}/${name}`;
  let st;
  try {
    st = await lstat(absolute);
  } catch {
    continue;
  }
  if (st.isSymbolicLink()) continue;
  if (st.isDirectory()) {
    await walkBackupTree(relative, absolute, members);
    continue;
  }
  if (!st.isFile()) continue;
  members.push({ name: relative, filePath: absolute, mode: st.mode });
  }
}

export type PublishedArtifactVersionRow = {
  key: string;
  version: number;
  content_hash: string | null;
  relative_path: string | null;
};

export type PublishedArtifactDriftIssue =
  | { kind: "missing_content"; key: string; version: number; path: string }
  | { kind: "hash_mismatch"; key: string; version: number; path: string; expected: string; actual: string }
  | { kind: "orphan_directory"; path: string }
  | { kind: "stale_staging"; path: string };

export type PublishedArtifactStoreReport = {
  artifact_count: number;
  version_count: number;
  bytes: number;
  missing_content: PublishedArtifactDriftIssue[];
  hash_mismatches: PublishedArtifactDriftIssue[];
  orphan_directories: PublishedArtifactDriftIssue[];
  stale_staging: PublishedArtifactDriftIssue[];
};

function hasArtifactTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'`,
    )
    .get() as { ok: number } | undefined;
  return row?.ok === 1;
}

export async function readPublishedArtifactStoreReport(
  db: Database.Database,
  homeDir: string = artifactStoreRoot().replace(/[/\\]artifacts$/, ""),
  now = Date.now(),
): Promise<PublishedArtifactStoreReport> {
  const root = path.join(homeDir, "artifacts");
  const empty: PublishedArtifactStoreReport = {
    artifact_count: 0,
    version_count: 0,
    bytes: 0,
    missing_content: [],
    hash_mismatches: [],
    orphan_directories: [],
    stale_staging: [],
  };
  if (!hasArtifactTables(db)) return empty;

  const artifact_count = (
    db.prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE deleted_at IS NULL`).get() as {
      c: number;
    }
  ).c;

  const versionRows = db
    .prepare(
      `SELECT key, version, content_hash, relative_path, storage
       FROM artifact_versions
       WHERE COALESCE(storage, 'store') = 'store'`,
    )
    .all() as PublishedArtifactVersionRow[];

  const version_count = versionRows.length;
  const keyedVersions = new Map<string, Set<number>>();
  const hashToKey = new Map<string, string>();
  let bytes = 0;
  let slice = Date.now();

  for (const row of versionRows) {
    slice = await yieldSlice(slice);
    let keyHash = hashToKey.get(row.key);
    if (keyHash === undefined) {
      keyHash = hashArtifactKey(row.key);
      hashToKey.set(row.key, keyHash);
    }
    if (!row.relative_path) {
      empty.missing_content.push({
        kind: "missing_content",
        key: row.key,
        version: row.version,
        path: `artifacts/${keyHash}/v${row.version}`,
      });
      continue;
    }
    const relative = path.posix.join(keyHash, `v${row.version}`, row.relative_path);
    keyedVersions.set(row.key, (keyedVersions.get(row.key) ?? new Set()).add(row.version));
    const absolute = path.join(root, ...relative.split("/"));
    try {
      const buf = await readFile(absolute);
      bytes += buf.length;
      if (row.content_hash) {
        const actual = createHash("sha256").update(buf).digest("hex");
        if (actual !== row.content_hash) {
          empty.hash_mismatches.push({
            kind: "hash_mismatch",
            key: row.key,
            version: row.version,
            path: `artifacts/${relative}`,
            expected: row.content_hash,
            actual,
          });
        }
      }
    } catch {
      empty.missing_content.push({
        kind: "missing_content",
        key: row.key,
        version: row.version,
        path: `artifacts/${relative}`,
      });
    }
  }

  const versionsByHash = new Map<string, { key: string; versions: Set<number> }>();
  for (const [key, versions] of keyedVersions) {
    const keyHash = hashToKey.get(key) ?? hashArtifactKey(key);
    versionsByHash.set(keyHash, { key, versions });
  }

  await scanOrphansAndStaging(root, versionsByHash, empty, now);
  return { ...empty, artifact_count, version_count, bytes };
}

async function scanOrphansAndStaging(
  root: string,
  versionsByHash: Map<string, { key: string; versions: Set<number> }>,
  report: PublishedArtifactStoreReport,
  now: number,
): Promise<void> {
  let keyHashes: string[];
  try {
    keyHashes = await readdir(root);
  } catch {
    return;
  }
  let slice = Date.now();
  for (const keyHash of keyHashes) {
    slice = await yieldSlice(slice);
    const keyDir = path.join(root, keyHash);
    let children: string[];
    try {
      children = await readdir(keyDir);
    } catch {
      continue;
    }
    if (children.length === 0) {
      report.orphan_directories.push({ kind: "orphan_directory", path: `artifacts/${keyHash}` });
      continue;
    }
    const known = versionsByHash.get(keyHash);
    for (const child of children) {
      const childPath = path.join(keyDir, child);
      const relative = `artifacts/${keyHash}/${child}`;
      if (isPublishedArtifactStagingName(child)) {
        try {
          const st = await lstat(childPath);
          if (now - st.mtimeMs > STALE_STAGING_DIRECTORY_MS) {
            report.stale_staging.push({ kind: "stale_staging", path: relative });
          }
        } catch {
          // ignore
        }
        continue;
      }
      if (PUBLISHED_VERSION_DIR.test(child)) {
        const version = Number.parseInt(child.slice(1), 10);
        if (known === undefined || !known.versions.has(version)) {
          report.orphan_directories.push({ kind: "orphan_directory", path: relative });
        }
        continue;
      }
      report.orphan_directories.push({ kind: "orphan_directory", path: relative });
    }
  }
}

export type RestoreIntegrityFinding = {
  code: "missing_content" | "hash_mismatch";
  key: string;
  version: number;
  path: string;
  detail?: string;
};

export async function verifyPublishedArtifactIntegrityAfterRestore(
  db: Database.Database,
  homeDir: string,
): Promise<RestoreIntegrityFinding[]> {
  const report = await readPublishedArtifactStoreReport(db, homeDir);
  const findings: RestoreIntegrityFinding[] = [];
  for (const issue of report.missing_content) {
    if (issue.kind !== "missing_content") continue;
    findings.push({
      code: "missing_content",
      key: issue.key,
      version: issue.version,
      path: issue.path,
    });
  }
  for (const issue of report.hash_mismatches) {
    if (issue.kind !== "hash_mismatch") continue;
    findings.push({
      code: "hash_mismatch",
      key: issue.key,
      version: issue.version,
      path: issue.path,
      detail: `expected ${issue.expected}, got ${issue.actual}`,
    });
  }
  return findings;
}

export function enrichDiskBreakdownWithPublishedArtifactCounts(
  breakdown: DiskBreakdown,
  report: PublishedArtifactStoreReport,
): DiskBreakdown {
  return {
    ...breakdown,
    published_artifact_count: report.artifact_count,
    published_version_count: report.version_count,
    artifacts_bytes: Math.max(breakdown.artifacts_bytes, report.bytes),
  };
}

export async function sha256FileAsync(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}