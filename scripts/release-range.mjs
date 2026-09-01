#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const HEADING_RE = /^## \[(\d+\.\d+\.\d+)\](?:\s+-.*)?$/;

export function parseVersionTag(tag) {
  const match = String(tag ?? "").trim().match(VERSION_RE);
  if (!match) return null;
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function pickPreviousVersion(candidates, current) {
  const currentVersion = parseVersionTag(current);
  if (!currentVersion) {
    throw new Error(`invalid current version '${current}'; expected x.y.z`);
  }
  let best = null;
  for (const candidate of candidates) {
    const version = parseVersionTag(candidate);
    if (!version) continue;
    if (compareSemver(version, currentVersion) >= 0) continue;
    if (!best || compareSemver(version, best) > 0) best = version;
  }
  return best?.raw ?? "";
}

export function extractChangelogRange(markdown, { after, through }) {
  const throughVersion = parseVersionTag(through);
  if (!throughVersion) {
    throw new Error(`invalid through version '${through}'; expected x.y.z`);
  }
  const afterVersion = after ? parseVersionTag(after) : null;
  if (after && !afterVersion) {
    throw new Error(`invalid after version '${after}'; expected x.y.z`);
  }

  const lines = String(markdown).split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(HEADING_RE);
    if (heading) {
      if (current) sections.push(current);
      current = { version: heading[1], lines: [line] };
      continue;
    }
    if (line.startsWith("## ") || /^\[[^\]]+\]:\s+\S+/.test(line)) {
      if (current) sections.push(current);
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);

  const kept = sections.filter((section) => {
    const version = parseVersionTag(section.version);
    if (!version) return false;
    if (compareSemver(version, throughVersion) > 0) return false;
    if (afterVersion && compareSemver(version, afterVersion) <= 0) return false;
    return true;
  });

  return kept
    .map((section) => section.lines.join("\n").replace(/\n+$/, ""))
    .filter(Boolean)
    .join("\n\n");
}

export function includedVersionsFromChangelog(markdown) {
  const versions = [];
  for (const line of String(markdown).split(/\r?\n/)) {
    const heading = line.match(HEADING_RE);
    if (heading) versions.push(heading[1]);
  }
  return versions;
}

function listGithubReleaseTags() {
  const result = spawnSync(
    "gh",
    ["release", "list", "--limit", "100", "--json", "tagName,isDraft,isPrerelease"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    return { ok: false, tags: [] };
  }
  try {
    const rows = JSON.parse(result.stdout || "[]");
    if (!Array.isArray(rows)) return { ok: false, tags: [] };
    return {
      ok: true,
      tags: rows
        .filter((row) => row && row.isDraft !== true && row.isPrerelease !== true)
        .map((row) => String(row.tagName ?? "")),
    };
  } catch {
    return { ok: false, tags: [] };
  }
}

function listGitTags() {
  const result = spawnSync("git", ["tag", "-l", "v*"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function resolvePreviousVersion(current, { githubTags, gitTags } = {}) {
  const github = githubTags ?? listGithubReleaseTags();
  const candidates = github.ok ? github.tags : (gitTags ?? listGitTags());
  const source = github.ok ? "github-release" : "git-tag";
  return { previous: pickPreviousVersion(candidates, current), source };
}

function printUsage() {
  process.stderr.write(`Usage:
  node scripts/release-range.mjs previous --current <x.y.z>
  node scripts/release-range.mjs changelog --through <x.y.z> [--after <x.y.z>] [--file CHANGELOG.md]
`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument '${token}'`);
    }
    const key = token.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    flags[key] = value;
    i += 1;
  }
  return { command, flags };
}

function main(argv) {
  const { command, flags } = parseArgs(argv);
  if (command === "previous") {
    const current = flags.current;
    if (!current) throw new Error("--current is required");
    const resolved = resolvePreviousVersion(current);
    if (resolved.previous) {
      process.stderr.write(
        `release-range: previous ${resolved.previous} (${resolved.source})\n`,
      );
    } else {
      process.stderr.write(
        `release-range: no previous ${resolved.source} before ${current}\n`,
      );
    }
    process.stdout.write(resolved.previous ? `${resolved.previous}\n` : "\n");
    return;
  }
  if (command === "changelog") {
    const through = flags.through;
    if (!through) throw new Error("--through is required");
    const file = path.resolve(flags.file ?? "CHANGELOG.md");
    const markdown = readFileSync(file, "utf8");
    const slice = extractChangelogRange(markdown, {
      after: flags.after,
      through,
    });
    process.stdout.write(slice);
    if (slice && !slice.endsWith("\n")) process.stdout.write("\n");
    return;
  }
  printUsage();
  throw new Error(`unknown command '${command ?? ""}'`);
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`release-range: ${error.message}\n`);
    process.exit(1);
  }
}
