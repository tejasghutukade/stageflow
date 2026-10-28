import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EnvelopeFields,
  formatEnvelopeSubtitle,
  isArtifactClaimOnDisk,
  resolveDiskArtifactPath,
} from "./EnvelopeFields";

describe("formatEnvelopeSubtitle", () => {
  const labelFor = (id: string) => (id === "work~1" ? "work · 1" : id);

  it.each([
    { name: "formatted labels joined by an arrow", from: "work~1", to: "collect", label: labelFor, expected: "work · 1 → collect" },
    { name: "no target stage", from: "work~1", to: undefined, label: labelFor, expected: "work · 1" },
    { name: "no labelFor falls back to ids", from: "a", to: "b", label: undefined, expected: "a → b" },
    { name: "no labelFor and no target", from: "a", to: undefined, label: undefined, expected: "a" },
  ])("$name", ({ from, to, label, expected }) => {
    expect(formatEnvelopeSubtitle(from, to, label)).toBe(expected);
  });
});

const disk = [
  "stages/review/attempts/1/artifacts/report.md",
  "stages/review/attempts/1/artifacts/notes.json",
];

describe("resolveDiskArtifactPath", () => {
  it("matches an exact run-relative path", () => {
    expect(resolveDiskArtifactPath(disk[0]!, disk)).toBe(disk[0]);
  });

  it("falls back to a unique basename when forms diverge", () => {
    expect(resolveDiskArtifactPath("report.md", disk)).toBe(disk[0]);
    expect(
      resolveDiskArtifactPath("stages/other/attempts/9/artifacts/notes.json", disk),
    ).toBe(disk[1]);
  });

  it("returns null when the claim is absent", () => {
    expect(resolveDiskArtifactPath("missing.json", disk)).toBeNull();
  });

  it("returns null when basename matches more than one disk path", () => {
    const dup = [
      "stages/a/attempts/1/artifacts/report.md",
      "stages/b/attempts/1/artifacts/report.md",
    ];
    expect(resolveDiskArtifactPath("report.md", dup)).toBeNull();
  });
});

describe("isArtifactClaimOnDisk", () => {
  it("is true for present claims and false for missing", () => {
    expect(isArtifactClaimOnDisk(disk[0]!, disk)).toBe(true);
    expect(isArtifactClaimOnDisk("ghost.md", disk)).toBe(false);
  });
});

describe("EnvelopeFields artifact chips", () => {
  const envelope = {
    status: "success",
    summary: "done",
    artifacts: [
      "stages/review/attempts/1/artifacts/report.md",
      "stages/review/attempts/1/artifacts/ghost.md",
    ],
  };

  function text(html: string): string {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  it("labels missing claims and keeps present claims unlabeled", () => {
    const html = renderToStaticMarkup(
      createElement(EnvelopeFields, {
        variant: "redesign",
        envelope,
        diskArtifacts: disk,
        onArtifactClick: () => undefined,
      }),
    );
    const out = text(html);
    expect(out).toContain("report.md");
    expect(out).not.toContain("report.md · missing");
    expect(out).toContain("ghost.md · missing");
  });

  it("marks missing chips muted via aria-disabled", () => {
    const html = renderToStaticMarkup(
      createElement(EnvelopeFields, {
        variant: "redesign",
        envelope,
        diskArtifacts: disk,
        onArtifactClick: () => undefined,
      }),
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("ghost.md · missing");
    expect(html).toContain('title="stages/review/attempts/1/artifacts/ghost.md (not on disk)"');
  });

  it("does not label claims when diskArtifacts is omitted", () => {
    const html = renderToStaticMarkup(
      createElement(EnvelopeFields, {
        variant: "redesign",
        envelope,
        onArtifactClick: () => undefined,
      }),
    );
    expect(text(html)).not.toContain("missing");
  });
});
