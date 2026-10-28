import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SANDBOX_CONTAINER_DOCKER_BIN_ENV,
  SANDBOX_CONTAINER_IMAGE_ENV,
} from "../src/runtime/sandboxContainer.js";
import { openStageSandbox } from "../src/runtime/stageSandbox.js";
import type { StageRoots } from "../src/runtime/stageRoots.js";

const fakeDockerBin = fileURLToPath(
  new URL("./fixtures/fakeSandboxDocker.mjs", import.meta.url),
);

const previousImage = process.env[SANDBOX_CONTAINER_IMAGE_ENV];
const previousDockerBin = process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV];
const previousState = process.env.FAKE_DOCKER_STATE_DIR;

afterEach(() => {
  if (previousImage === undefined) delete process.env[SANDBOX_CONTAINER_IMAGE_ENV];
  else process.env[SANDBOX_CONTAINER_IMAGE_ENV] = previousImage;
  if (previousDockerBin === undefined) {
    delete process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV];
  } else {
    process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] = previousDockerBin;
  }
  if (previousState === undefined) delete process.env.FAKE_DOCKER_STATE_DIR;
  else process.env.FAKE_DOCKER_STATE_DIR = previousState;
});

function rootsFor(attemptDir: string): StageRoots {
  return {
    mode: "unbound",
    cwd: attemptDir,
    runWorkspaceDir: path.dirname(attemptDir),
    agentDir: path.join(attemptDir, ".pi-agent"),
  };
}

describe("openStageSandbox", () => {
  it("is a no-op without a container image (unbound)", async () => {
    delete process.env[SANDBOX_CONTAINER_IMAGE_ENV];
    delete process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV];
    const attemptDir = await mkdtemp(path.join(tmpdir(), "sf-sandbox-unbound-"));
    const roots = rootsFor(attemptDir);
    const grant = path.join(attemptDir, "parent-report.md");
    await writeFile(grant, "parent\n");

    const sandbox = await openStageSandbox({
      env: process.env,
      roots,
      runId: "run-1",
      stageId: "child",
      attempt: 1,
      attemptDir,
      grants: [
        {
          listedPath: "stages/parent/attempts/1/artifacts/parent-report.md",
          hostPath: grant,
          containerPath: "/workspace/grants/parent/parent-report.md",
          kind: "file",
        },
      ],
    });

    expect(sandbox.roots).toBe(roots);
    expect(sandbox.roots.containerName).toBeUndefined();
    expect(sandbox.beforeVerify).toBeUndefined();
    expect(sandbox.failure).toBeUndefined();
    await sandbox.close();
  });

  it("mounts granted prior artifact files under /workspace/grants and excludes parent attempt roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-stage-sandbox-"));
    const stateDir = path.join(root, "docker-state");
    const attemptDir = path.join(root, "child-attempt");
    const parentArtifacts = path.join(
      root,
      "stages",
      "parent",
      "attempts",
      "1",
      "artifacts",
    );
    const report = path.join(parentArtifacts, "report.md");
    const sibling = path.join(parentArtifacts, "other.md");
    await mkdir(path.join(attemptDir, "artifacts"), { recursive: true });
    await mkdir(parentArtifacts, { recursive: true });
    await writeFile(report, "report\n");
    await writeFile(sibling, "sibling\n");
    await writeFile(path.join(attemptDir, "pi-session.jsonl"), "session\n");

    process.env[SANDBOX_CONTAINER_IMAGE_ENV] = "stageflow-bash:v1";
    process.env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] = fakeDockerBin;
    process.env.FAKE_DOCKER_STATE_DIR = stateDir;

    const sandbox = await openStageSandbox({
      env: process.env,
      roots: rootsFor(attemptDir),
      runId: "run-1",
      stageId: "child",
      attempt: 1,
      attemptDir,
      grants: [
        {
          listedPath: "stages/parent/attempts/1/artifacts/report.md",
          hostPath: report,
          containerPath: "/workspace/grants/parent/report.md",
          kind: "file",
        },
      ],
    });
    expect(sandbox.failure).toBeUndefined();
    expect(sandbox.roots.containerName).toBeTruthy();

    const workspace = path.join(stateDir, sandbox.roots.containerName!);
    expect(await readFile(path.join(workspace, "grants", "parent", "report.md"), "utf8")).toBe(
      "report\n",
    );
    expect((await stat(path.join(workspace, "grants", "parent", "report.md"))).isFile()).toBe(true);
    await expect(readFile(path.join(workspace, "grants", "parent", "other.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(workspace, "pi-session.jsonl"), "utf8")).rejects.toThrow();
    await expect(
      readFile(path.join(workspace, "stages", "parent", "attempts", "1", "artifacts", "report.md"), "utf8"),
    ).rejects.toThrow();

    await sandbox.close();
  });
});
