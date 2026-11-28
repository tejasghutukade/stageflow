import path from "node:path";
import type Database from "better-sqlite3";
import { artifactSearchPendingCount } from "../artifacts/search.js";
import {
  readPublishedArtifactStoreReport,
  type PublishedArtifactStoreReport,
} from "../artifacts/storeInventory.js";

const EXAMPLE_LIMIT = 5;

function formatExamples(paths: string[]): string {
  const slice = paths.slice(0, EXAMPLE_LIMIT);
  const suffix = paths.length > EXAMPLE_LIMIT ? ` (+${paths.length - EXAMPLE_LIMIT} more)` : "";
  return slice.length === 0 ? "" : `: ${slice.join(", ")}${suffix}`;
}

export type ArtifactStoreDoctorIssue = {
  code: string;
  count: number;
  examples: string[];
};

export type ArtifactStoreDoctorLine = {
  id: string;
  status: "pass" | "warn";
  message: string;
  code?: string;
  issues?: ArtifactStoreDoctorIssue[];
};

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = [
    ["KiB", 1024],
    ["MiB", 1024 * 1024],
    ["GiB", 1024 * 1024 * 1024],
  ] as const;
  let chosen: (typeof units)[number] = units[0];
  for (const unit of units) {
    if (bytes >= unit[1]) chosen = unit;
  }
  const value = bytes / chosen[1];
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${chosen[0]}`;
}

function issue(code: string, paths: string[]): (ArtifactStoreDoctorIssue & { paths: string[] }) | undefined {
  if (paths.length === 0) return undefined;
  return { code, count: paths.length, examples: paths.slice(0, EXAMPLE_LIMIT), paths };
}

function countPhrase(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export async function publishedArtifactStoreDoctorCheck(
  connection: Database.Database,
  homeDir: string,
): Promise<ArtifactStoreDoctorLine> {
  const report = await readPublishedArtifactStoreReport(connection, homeDir);
  const id = "published_artifact_store";
  const base = `${report.artifact_count} artifacts, ${report.version_count} versions, ${formatByteSize(report.bytes)} under ${path.join(homeDir, "artifacts")}`;

  const classes = [
    issue("artifact_hash_mismatch", report.hash_mismatches.map((item) => item.path)),
    issue("artifact_missing_content", report.missing_content.map((item) => item.path)),
    issue("artifact_orphan_directory", report.orphan_directories.map((item) => item.path)),
    issue("artifact_stale_staging", report.stale_staging.map((item) => item.path)),
  ].filter((item): item is ArtifactStoreDoctorIssue & { paths: string[] } => item !== undefined);

  const nouns: Record<string, [string, string]> = {
    artifact_hash_mismatch: ["hash mismatch", "hash mismatches"],
    artifact_missing_content: ["version missing content", "versions missing content"],
    artifact_orphan_directory: ["orphan directory", "orphan directories"],
    artifact_stale_staging: ["stale staging directory", "stale staging directories"],
  };

  if (classes.length === 0) {
    return { id, status: "pass", message: base };
  }
  const detail = classes
    .map((item) => {
      const [singular, plural] = nouns[item.code] ?? ["issue", "issues"];
      return `${countPhrase(item.count, singular, plural)}${formatExamples(item.paths)}`;
    })
    .join("; ");
  return {
    id,
    status: "warn",
    code: classes[0]!.code,
    issues: classes.map(({ code, count, examples }) => ({ code, count, examples })),
    message: `${base}; ${detail}`,
  };
}

export function artifactSearchDoctorCheck(connection: Database.Database): ArtifactStoreDoctorLine {
  const pending = artifactSearchPendingCount(connection);
  return {
    id: "artifact_search_index",
    status: pending > 0 ? "warn" : "pass",
    message: `search index: ${pending} artifacts pending`,
  };
}

export function publishedArtifactStoreReportForApi(
  connection: Database.Database,
  homeDir: string,
): Promise<PublishedArtifactStoreReport> {
  return readPublishedArtifactStoreReport(connection, homeDir);
}