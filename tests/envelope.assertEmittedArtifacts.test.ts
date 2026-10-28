import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertEmittedArtifactsOnDisk } from "../src/envelope/assertEmittedArtifacts.js";
import { EnvelopeError } from "../src/types/envelope.js";

describe("assertEmittedArtifactsOnDisk", () => {
  async function presence(stageId = "plan", attempt = 1) {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-assert-emit-"));
    return { runWorkspaceDir, stageId, attempt };
  }

  it("accepts a file written under the current attempt", async () => {
    const ctx = await presence();
    const abs = path.join(
      ctx.runWorkspaceDir,
      "stages",
      "plan",
      "attempts",
      "1",
      "artifacts",
      "notes.md",
    );
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "ok\n");
    await expect(
      assertEmittedArtifactsOnDisk(
        ["stages/plan/attempts/1/artifacts/notes.md"],
        ctx,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertEmittedArtifactsOnDisk(["notes.md"], ctx),
    ).resolves.toBeUndefined();
  });

  it("hard-fails missing and foreign-stage paths", async () => {
    const ctx = await presence();
    await expect(
      assertEmittedArtifactsOnDisk(
        ["stages/plan/attempts/1/artifacts/missing.md"],
        ctx,
      ),
    ).rejects.toBeInstanceOf(EnvelopeError);

    const other = path.join(
      ctx.runWorkspaceDir,
      "stages",
      "other",
      "attempts",
      "1",
      "artifacts",
      "report.md",
    );
    await mkdir(path.dirname(other), { recursive: true });
    await writeFile(other, "x\n");
    await expect(
      assertEmittedArtifactsOnDisk(
        ["stages/other/attempts/1/artifacts/report.md"],
        ctx,
      ),
    ).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("no-ops for empty artifacts or missing presence", async () => {
    const ctx = await presence();
    await expect(assertEmittedArtifactsOnDisk([], ctx)).resolves.toBeUndefined();
    await expect(
      assertEmittedArtifactsOnDisk(["notes.md"], undefined),
    ).resolves.toBeUndefined();
  });
});
