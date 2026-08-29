import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentDir,
  artifactsDir,
  attemptAgentDir,
  attemptArtifactsDir,
  attemptEnvelopePath,
  attemptLogPath,
  attemptSessionPath,
  attemptWorkspaceDir,
  envelopePath,
  isInsideDir,
  listArtifactNames,
  resolveArtifactTarget,
  stageArtifactsDir,
  stageDir,
  stageLogPath,
} from "../src/runstore/workspaceLayout.js";

describe("RunWorkspaceLayout", () => {
  it("attempt 1 paths live under attempts/1", () => {
    const ws = "/tmp/run-1";
    expect(attemptWorkspaceDir(ws, "clarify", 1)).toBe(
      path.join(ws, "stages", "clarify", "attempts", "1"),
    );
    expect(attemptLogPath(ws, "clarify", 1)).toBe(
      path.join(ws, "stages", "clarify", "attempts", "1", "log.jsonl"),
    );
    expect(attemptEnvelopePath(ws, "clarify", 1)).toBe(
      path.join(ws, "stages", "clarify", "attempts", "1", "envelope.json"),
    );
    expect(attemptSessionPath(ws, "clarify", 1)).toBe(
      path.join(ws, "stages", "clarify", "attempts", "1", "pi-session.jsonl"),
    );
    expect(attemptArtifactsDir(ws, "clarify", 1)).toBe(
      path.join(ws, "stages", "clarify", "attempts", "1", "artifacts"),
    );
    expect(attemptAgentDir(ws, "clarify", 1)).toBe(
      path.join(ws, "stages", "clarify", "attempts", "1", ".pi-agent"),
    );
  });

  it("deprecated root helpers shim to attempt 1 paths", () => {
    const ws = "/tmp/run-1";
    expect(artifactsDir(ws, "clarify")).toBe(attemptArtifactsDir(ws, "clarify", 1));
    expect(agentDir(ws, "clarify")).toBe(attemptAgentDir(ws, "clarify", 1));
    expect(envelopePath(ws, "clarify")).toBe(
      attemptEnvelopePath(ws, "clarify", 1),
    );
    expect(stageLogPath(ws, "clarify")).toBe(attemptLogPath(ws, "clarify", 1));
  });

  it("attempt 2 and 3 paths use attempts subtree", () => {
    const ws = "/tmp/run-1";
    expect(attemptWorkspaceDir(ws, "clarify", 2)).toBe(
      path.join(ws, "stages", "clarify", "attempts", "2"),
    );
    expect(attemptLogPath(ws, "clarify", 2)).toBe(
      path.join(ws, "stages", "clarify", "attempts", "2", "log.jsonl"),
    );
    expect(attemptArtifactsDir(ws, "clarify", 3)).toBe(
      path.join(ws, "stages", "clarify", "attempts", "3", "artifacts"),
    );
    expect(attemptSessionPath(ws, "clarify", 3)).toBe(
      path.join(ws, "stages", "clarify", "attempts", "3", "pi-session.jsonl"),
    );
  });

  it("attempt path helpers reject invalid attempt numbers", () => {
    const ws = "/tmp/run-1";
    expect(() => attemptWorkspaceDir(ws, "clarify", 0)).toThrow(/positive integer/);
    expect(() => attemptWorkspaceDir(ws, "clarify", -1)).toThrow(/positive integer/);
    expect(() => attemptWorkspaceDir(ws, "clarify", 1.5)).toThrow(/positive integer/);
  });

  it("attempt path helpers reject path traversal in stageId", () => {
    const ws = "/tmp/run-1";
    expect(() => attemptLogPath(ws, "../x", 1)).toThrow(/stageId/);
    expect(() => attemptWorkspaceDir(ws, "a/b", 2)).toThrow(/stageId/);
    expect(() => stageDir(ws, "a/b")).toThrow(/stageId/);
  });

  it("clone instance ids get distinct attempt workspaces", () => {
    const ws = "/tmp/run-1";
    expect(attemptWorkspaceDir(ws, "author-diagrams~1", 1)).toBe(
      path.join(ws, "stages", "author-diagrams~1", "attempts", "1"),
    );
    expect(attemptWorkspaceDir(ws, "author-diagrams~2", 1)).toBe(
      path.join(ws, "stages", "author-diagrams~2", "attempts", "1"),
    );
    expect(attemptWorkspaceDir(ws, "author-diagrams~1", 1)).not.toBe(
      attemptWorkspaceDir(ws, "author-diagrams~2", 1),
    );
  });

  it("resolveArtifactTarget rejects escapes and accepts nested paths", () => {
    const ws = "/tmp/run-1";
    expect(() => resolveArtifactTarget(ws, "clarify", 1, "../x.md")).toThrow(
      /escape/,
    );
    expect(() => resolveArtifactTarget(ws, "a/b", 1, "x.md")).toThrow(/stageId/);
    const nested = resolveArtifactTarget(ws, "clarify", 1, "nested/doc.md");
    expect(nested.runRelativePath).toBe(
      "stages/clarify/attempts/1/artifacts/nested/doc.md",
    );
    const retry = resolveArtifactTarget(ws, "clarify", 2, "doc.md");
    expect(retry.runRelativePath).toBe(
      "stages/clarify/attempts/2/artifacts/doc.md",
    );
  });

  it("isInsideDir distinguishes contained paths", () => {
    expect(isInsideDir("/a/b/c", "/a/b")).toBe(true);
    expect(isInsideDir("/a/b", "/a/b")).toBe(true);
    expect(isInsideDir("/a/other", "/a/b")).toBe(false);
  });

  it("listArtifactNames walks nested files", async () => {
    const ws = await mkdtemp(path.join(tmpdir(), "sf-layout-"));
    const dir = attemptArtifactsDir(ws, "clarify", 1);
    await mkdir(path.join(dir, "nested"), { recursive: true });
    await writeFile(path.join(dir, "top.md"), "a");
    await writeFile(path.join(dir, "nested", "deep.md"), "b");

    const names = await listArtifactNames(ws, "clarify", 1);
    expect(names).toEqual([
      "stages/clarify/attempts/1/artifacts/nested/deep.md",
      "stages/clarify/attempts/1/artifacts/top.md",
    ]);
  });

  it("listArtifactNames includes stage-root artifacts folder", async () => {
    const ws = await mkdtemp(path.join(tmpdir(), "sf-layout-stage-"));
    const attemptDir = attemptArtifactsDir(ws, "hamilton-weather", 1);
    const stageDir = stageArtifactsDir(ws, "hamilton-weather");
    await mkdir(attemptDir, { recursive: true });
    await mkdir(stageDir, { recursive: true });
    await writeFile(path.join(attemptDir, "attempt-only.md"), "a");
    await writeFile(path.join(stageDir, "weather.md"), "b");

    const names = await listArtifactNames(ws, "hamilton-weather", 1);
    expect(names).toEqual([
      "stages/hamilton-weather/artifacts/weather.md",
      "stages/hamilton-weather/attempts/1/artifacts/attempt-only.md",
    ]);
  });

  it("listArtifactNames returns stage-root files when attempt artifacts are empty", async () => {
    const ws = await mkdtemp(path.join(tmpdir(), "sf-layout-unbound-"));
    const stageDir = stageArtifactsDir(ws, "hamilton-weather");
    await mkdir(stageDir, { recursive: true });
    await writeFile(path.join(stageDir, "weather.md"), "report");

    const names = await listArtifactNames(ws, "hamilton-weather", 1);
    expect(names).toEqual(["stages/hamilton-weather/artifacts/weather.md"]);
  });
});
