#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED = ["dist/cli.js", "dist/ui/index.html", "skills/stageflow/SKILL.md"] as const;

function normalizePackPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^package\//, "");
}

function filesFromJson(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object") {
      const files = (parsed[0] as { files?: { path?: string }[] }).files;
      if (Array.isArray(files)) {
        return files
          .map((f) => (typeof f?.path === "string" ? normalizePackPath(f.path) : ""))
          .filter(Boolean);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function parsePackPaths(stdout: string, stderr: string): string[] {
  const fromStdout = filesFromJson(stdout);
  if (fromStdout) return fromStdout;

  const combined = `${stdout}\n${stderr}`;
  const jsonStart = combined.indexOf("[");
  if (jsonStart >= 0) {
    const fromCombined = filesFromJson(combined.slice(jsonStart));
    if (fromCombined) return fromCombined;
  }

  const paths: string[] = [];
  for (const line of combined.split("\n")) {
    const notice = line.match(/npm notice\s+\S+\s+(.+)$/);
    if (notice?.[1] && !notice[1].includes("Tarball") && !notice[1].startsWith("📦")) {
      const candidate = notice[1].trim();
      if (candidate && !candidate.includes(" ")) {
        paths.push(normalizePackPath(candidate));
      } else if (candidate) {
        const parts = candidate.split(/\s+/);
        const last = parts[parts.length - 1];
        if (last.includes("/") || last.endsWith(".md") || last.endsWith(".js")) {
          paths.push(normalizePackPath(last));
        }
      }
    }
  }
  return paths;
}

function isForbidden(normalized: string): string | null {
  if (normalized === "ui/src" || normalized.startsWith("ui/src/")) {
    return "ui/src/";
  }
  if (normalized === "src" || normalized.startsWith("src/")) {
    return "src/";
  }
  if (
    !normalized.startsWith("dist/") &&
    (normalized.includes("/src/") || normalized.endsWith("/src"))
  ) {
    return "src/";
  }
  if (
    normalized === "tests" ||
    normalized.startsWith("tests/") ||
    normalized.includes("/tests/")
  ) {
    return "tests/";
  }
  if (
    normalized === "docs" ||
    normalized.startsWith("docs/") ||
    normalized.includes("/docs/")
  ) {
    return "docs/";
  }
  if (
    normalized === ".cursor" ||
    normalized.startsWith(".cursor/") ||
    normalized.includes("/.cursor/")
  ) {
    return ".cursor/";
  }
  return null;
}

function main(): void {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.error(`Failed to run npm pack: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0 && !(result.stdout ?? "").trim().startsWith("[")) {
    console.error("npm pack --dry-run failed");
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(1);
  }

  const paths = parsePackPaths(result.stdout ?? "", result.stderr ?? "");
  if (paths.length === 0) {
    console.error("Could not parse file list from `npm pack --dry-run --json`");
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(1);
  }

  const errors: string[] = [];
  const pathSet = new Set(paths);

  for (const required of REQUIRED) {
    const found = [...pathSet].some(
      (p) => p === required || p.endsWith(`/${required}`),
    );
    if (!found) {
      errors.push(`missing required path: ${required}`);
    }
  }

  for (const p of paths) {
    const reason = isForbidden(p);
    if (reason) {
      errors.push(`forbidden path (${reason}): ${p}`);
    }
  }

  if (errors.length > 0) {
    console.error("verify-pack failed:");
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    console.error(`file count: ${paths.length}`);
    process.exit(1);
  }

  console.log(`verify-pack ok (${paths.length} files)`);
}

main();
