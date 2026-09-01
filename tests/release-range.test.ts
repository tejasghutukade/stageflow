import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractChangelogRange,
  includedVersionsFromChangelog,
  pickPreviousVersion,
  resolvePreviousVersion,
} from "../scripts/release-range.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

const sample = `# Changelog

## [Unreleased]

## [0.8.0] - 2026-09-01

- eight

## [0.7.0] - 2026-09-01

- seven

## [0.3.0] - 2026-08-26

- three

[Unreleased]: https://example.com
[0.8.0]: https://example.com
`;

describe("release-range", () => {
  it("picks the highest published semver strictly below current", () => {
    expect(pickPreviousVersion(["v0.2.0", "v0.3.0", "v0.8.0"], "0.8.0")).toBe(
      "0.3.0",
    );
    expect(pickPreviousVersion(["0.7.0", "v0.3.0"], "0.8.0")).toBe("0.7.0");
    expect(pickPreviousVersion(["v0.8.0"], "0.8.0")).toBe("");
    expect(pickPreviousVersion(["not-a-version", "v1.0.0"], "0.8.0")).toBe("");
  });

  it("prefers GitHub Release tags over later unreleased git tags", () => {
    const resolved = resolvePreviousVersion("0.8.0", {
      githubTags: { ok: true, tags: ["v0.2.0", "v0.3.0"] },
      gitTags: ["v0.2.0", "v0.3.0", "v0.7.0"],
    });
    expect(resolved).toEqual({ previous: "0.3.0", source: "github-release" });
  });

  it("falls back to git tags when GitHub listing is unavailable", () => {
    const resolved = resolvePreviousVersion("0.8.0", {
      githubTags: { ok: false, tags: [] },
      gitTags: ["v0.2.0", "v0.3.0", "v0.7.0"],
    });
    expect(resolved).toEqual({ previous: "0.7.0", source: "git-tag" });
  });

  it("extracts every CHANGELOG version after previous through current", () => {
    const slice = extractChangelogRange(sample, {
      after: "0.3.0",
      through: "0.8.0",
    });
    expect(includedVersionsFromChangelog(slice)).toEqual(["0.8.0", "0.7.0"]);
    expect(slice).toContain("eight");
    expect(slice).toContain("seven");
    expect(slice).not.toContain("three");
    expect(slice).not.toContain("Unreleased");
  });

  it("covers the 0.3.0 to 0.8.0 gap from the repo CHANGELOG", () => {
    const slice = extractChangelogRange(changelog, {
      after: "0.3.0",
      through: "0.8.0",
    });
    expect(includedVersionsFromChangelog(slice)).toEqual([
      "0.8.0",
      "0.7.0",
      "0.6.0",
      "0.5.0",
      "0.4.0",
    ]);
  });
});
