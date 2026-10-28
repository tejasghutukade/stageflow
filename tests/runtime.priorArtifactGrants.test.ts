import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  artifactGrantsFromPriors,
  assignGrantContainerPaths,
  isGrantableArtifactPath,
} from "../src/runtime/priorArtifactGrants.js";
import type { ResolvePriorEnvelopeResult } from "../src/runtime/envelopeRouting.js";

describe("isGrantableArtifactPath", () => {
  it("accepts run-relative artifact files under stages/.../artifacts", () => {
    expect(
      isGrantableArtifactPath("stages/read/attempts/1/artifacts/report.md"),
    ).toBe(true);
  });

  it("rejects work, session, absolute, escape, and attempt-root paths", () => {
    expect(isGrantableArtifactPath("stages/read/attempts/1/work/scratch.txt")).toBe(
      false,
    );
    expect(isGrantableArtifactPath("stages/read/attempts/1/pi-session.jsonl")).toBe(
      false,
    );
    expect(isGrantableArtifactPath("stages/read/attempts/1/artifacts")).toBe(false);
    expect(isGrantableArtifactPath("/abs/stages/read/attempts/1/artifacts/a.md")).toBe(
      false,
    );
    expect(
      isGrantableArtifactPath("stages/read/attempts/1/artifacts/../work/x.txt"),
    ).toBe(false);
    expect(isGrantableArtifactPath("")).toBe(false);
  });
});

describe("assignGrantContainerPaths", () => {
  it("places a file at /workspace/grants/<stage>/<name>", () => {
    const listed = "stages/review-pr/attempts/1/artifacts/verified-findings.json";
    expect(assignGrantContainerPaths([listed]).get(listed)).toBe(
      "/workspace/grants/review-pr/verified-findings.json",
    );
  });

  it("keeps a nested artifact path and disambiguates the same name from another attempt", () => {
    const first = "stages/review-pr/attempts/1/artifacts/notes/a.md";
    const second = "stages/review-pr/attempts/2/artifacts/verified-findings.json";
    const third = "stages/review-pr/attempts/1/artifacts/verified-findings.json";
    const assigned = assignGrantContainerPaths([first, second, third]);
    expect(assigned.get(first)).toBe("/workspace/grants/review-pr/notes/a.md");
    expect(assigned.get(second)).toBe(
      "/workspace/grants/review-pr/attempt-2/verified-findings.json",
    );
    expect(assigned.get(third)).toBe(
      "/workspace/grants/review-pr/attempt-1/verified-findings.json",
    );
  });
});

describe("artifactGrantsFromPriors", () => {
  it("maps existing prior artifact files and skips missing ones", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "sf-prior-grants-"));
    const presentRel = "stages/parent/attempts/1/artifacts/report.md";
    const missingRel = "stages/parent/attempts/1/artifacts/missing.md";
    const presentAbs = path.join(workspace, presentRel);
    await mkdir(path.dirname(presentAbs), { recursive: true });
    await writeFile(presentAbs, "ok\n");

    const prior: Extract<ResolvePriorEnvelopeResult, { ok: true }> = {
      ok: true,
      prior: {
        status: "success",
        summary: "done",
        artifacts: [presentRel, missingRel],
      },
    };

    const grants = await artifactGrantsFromPriors(workspace, prior);
    expect(grants).toEqual([
      {
        listedPath: presentRel,
        hostPath: presentAbs,
        containerPath: "/workspace/grants/parent/report.md",
        kind: "file",
      },
    ]);
  });

  it("unions join priors and never grants work or session paths", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "sf-prior-join-"));
    const aRel = "stages/a/attempts/1/artifacts/a.md";
    const bRel = "stages/b/attempts/2/artifacts/b.md";
    const workRel = "stages/a/attempts/1/work/scratch.txt";
    const aAbs = path.join(workspace, aRel);
    const bAbs = path.join(workspace, bRel);
    const workAbs = path.join(workspace, workRel);
    await mkdir(path.dirname(aAbs), { recursive: true });
    await mkdir(path.dirname(bAbs), { recursive: true });
    await mkdir(path.dirname(workAbs), { recursive: true });
    await writeFile(aAbs, "a\n");
    await writeFile(bAbs, "b\n");
    await writeFile(workAbs, "work\n");

    const prior: Extract<ResolvePriorEnvelopeResult, { ok: true }> = {
      ok: true,
      prior: null,
      priorEnvelopesByStage: {
        a: {
          status: "success",
          summary: "a",
          artifacts: [aRel, workRel],
        },
        b: {
          status: "success",
          summary: "b",
          artifacts: [bRel],
        },
      },
    };

    const grants = await artifactGrantsFromPriors(workspace, prior);
    expect(grants.map((grant) => grant.hostPath)).toEqual([aAbs, bAbs]);
    expect(grants.map((grant) => grant.containerPath)).toEqual([
      "/workspace/grants/a/a.md",
      "/workspace/grants/b/b.md",
    ]);
    expect(grants.map((grant) => grant.hostPath)).not.toContain(workAbs);
  });

  it("returns no grants when prior artifacts are empty", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "sf-prior-empty-"));
    const prior: Extract<ResolvePriorEnvelopeResult, { ok: true }> = {
      ok: true,
      prior: { status: "success", summary: "empty", artifacts: [] },
    };
    expect(await artifactGrantsFromPriors(workspace, prior)).toEqual([]);
  });

  it("rejects symlink leaves and symlink ancestors under artifacts", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "sf-prior-symlink-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sf-prior-outside-"));
    const secret = path.join(outside, "secret.txt");
    await writeFile(secret, "secret\n");

    const leafRel = "stages/parent/attempts/1/artifacts/linked.md";
    const leafAbs = path.join(workspace, leafRel);
    await mkdir(path.dirname(leafAbs), { recursive: true });
    await symlink(secret, leafAbs);

    const ancestorArtifacts = path.join(
      workspace,
      "stages/parent/attempts/2/artifacts",
    );
    await mkdir(path.dirname(ancestorArtifacts), { recursive: true });
    await symlink(outside, ancestorArtifacts);
    const viaAncestorRel = "stages/parent/attempts/2/artifacts/secret.txt";

    const prior: Extract<ResolvePriorEnvelopeResult, { ok: true }> = {
      ok: true,
      prior: {
        status: "success",
        summary: "symlink",
        artifacts: [leafRel, viaAncestorRel],
      },
    };

    expect(await artifactGrantsFromPriors(workspace, prior)).toEqual([]);
  });
});
