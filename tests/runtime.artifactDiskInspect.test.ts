import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectArtifactUnderRoot } from "../src/runtime/artifactDiskInspect.js";

describe("inspectArtifactUnderRoot", () => {
  it("classifies a regular file with size", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-disk-file-"));
    await writeFile(path.join(root, "report.md"), "hello\n");
    const presence = await inspectArtifactUnderRoot(root, "report.md");
    expect(presence).toMatchObject({
      file_type: "file",
      size_bytes: 6,
      absolutePath: path.join(root, "report.md"),
    });
  });

  it("classifies missing, directory, and escape as missing/directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-disk-kinds-"));
    await mkdir(path.join(root, "dir"));
    expect(await inspectArtifactUnderRoot(root, "gone.md")).toEqual({
      file_type: "missing",
    });
    expect(await inspectArtifactUnderRoot(root, "dir")).toMatchObject({
      file_type: "directory",
    });
    expect(await inspectArtifactUnderRoot(root, "../escape.md")).toEqual({
      file_type: "missing",
    });
  });

  it("rejects symlink leaves and symlink ancestors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-disk-link-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sf-disk-out-"));
    await writeFile(path.join(outside, "secret.txt"), "secret\n");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "linked.md"));
    expect(await inspectArtifactUnderRoot(root, "linked.md")).toMatchObject({
      file_type: "symlink",
    });

    await symlink(outside, path.join(root, "via"));
    expect(await inspectArtifactUnderRoot(root, "via/secret.txt")).toMatchObject({
      file_type: "symlink",
    });
  });
});
