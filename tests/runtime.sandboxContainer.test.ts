import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStartContainerArgs,
  execInSandboxContainer,
  resolveSandboxContainerOptions,
  SANDBOX_CONTAINER_DOCKER_BIN_ENV,
  SANDBOX_CONTAINER_IMAGE_ENV,
  startSandboxContainer,
  stopSandboxContainer,
} from "../src/runtime/sandboxContainer.js";

const fakeDockerBin = fileURLToPath(
  new URL("./fixtures/fakeSandboxDocker.mjs", import.meta.url),
);

describe("sandbox container env constants", () => {
  it("intentionally reuses v1's env var names (see comment in sandboxContainer.ts)", () => {
    expect(SANDBOX_CONTAINER_IMAGE_ENV).toBe("STAGEFLOW_STAGE_CONTAINER_IMAGE");
    expect(SANDBOX_CONTAINER_DOCKER_BIN_ENV).toBe(
      "STAGEFLOW_STAGE_CONTAINER_DOCKER_BIN",
    );
  });
});

describe("resolveSandboxContainerOptions", () => {
  it("returns undefined when no image is configured", () => {
    expect(resolveSandboxContainerOptions({})).toBeUndefined();
  });

  it("reads image + dockerBin from env vars", () => {
    expect(
      resolveSandboxContainerOptions({
        [SANDBOX_CONTAINER_IMAGE_ENV]: "stageflow-bash:v1",
        [SANDBOX_CONTAINER_DOCKER_BIN_ENV]: "/usr/local/bin/docker",
      }),
    ).toEqual({ image: "stageflow-bash:v1", dockerBin: "/usr/local/bin/docker" });
  });

  it("defaults dockerBin to 'docker' when only the image env var is set", () => {
    expect(
      resolveSandboxContainerOptions({
        [SANDBOX_CONTAINER_IMAGE_ENV]: "stageflow-bash:v1",
      }),
    ).toEqual({ image: "stageflow-bash:v1", dockerBin: "docker" });
  });

  it("prefers a programmatic override over env vars", () => {
    expect(
      resolveSandboxContainerOptions(
        { [SANDBOX_CONTAINER_IMAGE_ENV]: "from-env:v1" },
        { image: "from-override:v1" },
      ),
    ).toEqual({ image: "from-override:v1", dockerBin: "docker" });
  });

  it("throws on a blank override image instead of silently spawning docker with an invalid reference", () => {
    expect(() => resolveSandboxContainerOptions({}, { image: "" })).toThrow(/image/i);
    expect(() => resolveSandboxContainerOptions({}, { image: "   " })).toThrow(/image/i);
  });
});

describe("buildStartContainerArgs", () => {
  it("mounts rootDir at the same absolute path and runs sleep infinity", () => {
    const args = buildStartContainerArgs({
      rootDir: "/Users/tejas/project",
      image: "stageflow-bash:v1",
      containerName: "stageflow-run-1-implement-1-abc",
    });
    expect(args).toEqual([
      "run",
      "-d",
      "--name",
      "stageflow-run-1-implement-1-abc",
      "-v",
      "/Users/tejas/project:/Users/tejas/project",
      "-w",
      "/Users/tejas/project",
      "stageflow-bash:v1",
      "sleep",
      "infinity",
    ]);
  });
});

describe("startSandboxContainer / stopSandboxContainer (via fake docker binary)", () => {
  it("starts a container named per run id + stage id + attempt, and stops it", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-sandbox-container-"));
    const logFile = path.join(rootDir, "docker.log");

    const previousLogFile = process.env.FAKE_DOCKER_LOG_FILE;
    process.env.FAKE_DOCKER_LOG_FILE = logFile;
    try {
      const { containerName } = await startSandboxContainer({
        rootDir,
        image: "stageflow-bash:v1",
        runId: "run-1",
        stageId: "implement",
        attempt: 2,
        dockerBin: fakeDockerBin,
      });

      expect(containerName).toMatch(/^stageflow-run-1-implement-2-[0-9a-f]{8}$/);

      await stopSandboxContainer({ containerName, dockerBin: fakeDockerBin });

      const log = await readFile(logFile, "utf8");
      expect(log).toContain(`start ${containerName}`);
      expect(log).toContain(`stop ${containerName}`);
    } finally {
      if (previousLogFile === undefined) {
        delete process.env.FAKE_DOCKER_LOG_FILE;
      } else {
        process.env.FAKE_DOCKER_LOG_FILE = previousLogFile;
      }
    }
  });

  it("gives distinct containers on repeated calls for the same attempt (random suffix)", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-sandbox-container-dup-"));
    const first = await startSandboxContainer({
      rootDir,
      image: "stageflow-bash:v1",
      runId: "run-1",
      stageId: "review~1",
      attempt: 1,
      dockerBin: fakeDockerBin,
    });
    const second = await startSandboxContainer({
      rootDir,
      image: "stageflow-bash:v1",
      runId: "run-1",
      stageId: "review~2",
      attempt: 1,
      dockerBin: fakeDockerBin,
    });
    expect(first.containerName).not.toBe(second.containerName);
  });

  it("stopSandboxContainer swallows a 'no such container' style error instead of throwing", async () => {
    await expect(
      stopSandboxContainer({
        containerName: "definitely-not-a-real-container",
        dockerBin: fileURLToPath(new URL("./fixtures/fakeSandboxDockerNoSuchContainer.mjs", import.meta.url)),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("execInSandboxContainer (via fake docker binary)", () => {
  it("runs the command inside the named container via `docker exec <name> bash -c <command>` and relays stdout/exit code", async () => {
    const result = await execInSandboxContainer({
      containerName: "some-container",
      command: "echo hello-from-sandbox",
      dockerBin: fakeDockerBin,
    });
    expect(result.stdout.trim()).toBe("hello-from-sandbox");
    expect(result.exitCode).toBe(0);
  });

  it("does not throw on a non-zero exit — reports it as a normal result", async () => {
    const result = await execInSandboxContainer({
      containerName: "some-container",
      command: "exit 3",
      dockerBin: fakeDockerBin,
    });
    expect(result.exitCode).toBe(3);
  });

  it("relays stderr separately from stdout", async () => {
    const result = await execInSandboxContainer({
      containerName: "some-container",
      command: "echo out-line; echo err-line 1>&2",
      dockerBin: fakeDockerBin,
    });
    expect(result.stdout.trim()).toBe("out-line");
    expect(result.stderr.trim()).toBe("err-line");
  });

  it("passes the command as a single argv element rather than concatenating it into a shell string (argument-injection safe)", async () => {
    const result = await execInSandboxContainer({
      containerName: "some-container",
      command: 'echo "$(echo injected)"',
      dockerBin: fakeDockerBin,
    });
    // proves the fixture's bash -c received the whole string as one argument
    // (the substitution runs inside bash, not as an extra docker/host arg)
    expect(result.stdout.trim()).toBe("injected");
    expect(result.exitCode).toBe(0);
  });

  it("throws rather than reporting a fake exit code when the docker binary itself can't be spawned", async () => {
    await expect(
      execInSandboxContainer({
        containerName: "some-container",
        command: "echo hi",
        dockerBin: "/no/such/docker-binary-anywhere",
      }),
    ).rejects.toThrow(/failed to exec in sandbox container/);
  });
});
