import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCacheMountArgs,
  buildContainerName,
  buildContainerRunArgs,
  sanitizeContainerNameSegment,
  StageProcessLauncher,
  STAGE_CONTAINER_IMAGE_ENV,
  STAGE_CONTAINER_DOCKER_BIN_ENV,
  DEFAULT_STAGE_CONTAINER_FORWARD_ENV_VARS,
} from "../src/runtime/stageProcessLauncher.js";
import { SF_STAGE_WORKER } from "../src/runtime/stageWorkerProtocol.js";

const mockDockerBin = fileURLToPath(
  new URL("./fixtures/mockDockerBin.mjs", import.meta.url),
);

describe("sanitizeContainerNameSegment", () => {
  it("passes through already-safe characters", () => {
    expect(sanitizeContainerNameSegment("run-123_abc.def")).toBe(
      "run-123_abc.def",
    );
  });

  it("replaces unsafe characters with a dash", () => {
    expect(sanitizeContainerNameSegment("2026-09-13T05:57:10.857Z/stage id")).toBe(
      "2026-09-13T05-57-10.857Z-stage-id",
    );
  });
});

describe("buildContainerName", () => {
  it("combines run id, stage id, attempt, and a caller-provided suffix", () => {
    const name = buildContainerName(
      { runId: "run-1", stageId: "implement", attempt: 4 },
      "suffix1",
    );
    expect(name).toBe("stageflow-run-1-implement-4-suffix1");
  });

  it("defaults attempt to 1 when not provided", () => {
    const name = buildContainerName(
      { runId: "run-1", stageId: "plan" },
      "abc",
    );
    expect(name).toBe("stageflow-run-1-plan-1-abc");
  });

  it("sanitizes run id and stage id so the name is docker-safe", () => {
    const name = buildContainerName(
      { runId: "run/1:2026", stageId: "review~1", attempt: 1 },
      "xyz",
    );
    expect(name).toBe("stageflow-run-1-2026-review-1-1-xyz");
  });
});

describe("buildContainerRunArgs", () => {
  const baseInput = {
    runId: "run-1",
    stageId: "implement",
    rootDir: "/Users/tejas/project",
  };

  it("mounts rootDir at the same absolute path inside the container and runs the entrypoint image with the given cli args", () => {
    const args = buildContainerRunArgs({
      input: baseInput,
      cliArgs: ["internal", "run-stage", "--run-id", "run-1"],
      container: { image: "stageflow-agent:v1" },
      env: {},
      containerName: "stageflow-run-1-implement-1-abc",
    });

    expect(args).toEqual([
      "run",
      "--rm",
      "--name",
      "stageflow-run-1-implement-1-abc",
      "-v",
      "/Users/tejas/project:/Users/tejas/project",
      "-w",
      "/Users/tejas/project",
      "-e",
      SF_STAGE_WORKER,
      "stageflow-agent:v1",
      "internal",
      "run-stage",
      "--run-id",
      "run-1",
    ]);
  });

  it("uses the same host path on both sides of the mount, since the run store records absolute host paths the worker resolves verbatim in-container", () => {
    const args = buildContainerRunArgs({
      input: { runId: "run-1", stageId: "implement", rootDir: "/home/dev/some project" },
      cliArgs: ["internal", "run-stage"],
      container: { image: "stageflow-agent:v1" },
      env: {},
      containerName: "name-1",
    });

    const mountIndex = args.indexOf("-v") + 1;
    const workdirIndex = args.indexOf("-w") + 1;
    expect(args[mountIndex]).toBe("/home/dev/some project:/home/dev/some project");
    expect(args[workdirIndex]).toBe("/home/dev/some project");
  });

  it("forwards only the default credential env vars that are actually set", () => {
    const args = buildContainerRunArgs({
      input: baseInput,
      cliArgs: ["internal", "run-stage"],
      container: { image: "stageflow-agent:v1" },
      env: { ANTHROPIC_API_KEY: "sk-test", OTHER_VAR: "ignored" },
      containerName: "name-1",
    });

    const forwarded = args.filter((_, i) => args[i - 1] === "-e");
    expect(forwarded).toEqual([SF_STAGE_WORKER, "ANTHROPIC_API_KEY"]);
    expect(args).not.toContain("OTHER_VAR");
    // bare -e form: never puts the secret value in argv
    expect(args.join(" ")).not.toContain("sk-test");
  });

  it("forwards GH_TOKEN and GITHUB_TOKEN when present, in addition to the model credential", () => {
    const args = buildContainerRunArgs({
      input: baseInput,
      cliArgs: ["internal", "run-stage"],
      container: { image: "stageflow-agent:v1" },
      env: {
        ANTHROPIC_API_KEY: "sk-test",
        GH_TOKEN: "gh-test",
        GITHUB_TOKEN: "gh-test-2",
      },
      containerName: "name-1",
    });

    const forwarded = args.filter((_, i) => args[i - 1] === "-e");
    expect(forwarded).toEqual([
      SF_STAGE_WORKER,
      "ANTHROPIC_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ]);
  });

  it("respects a custom forwardEnvVars list on the container options", () => {
    const args = buildContainerRunArgs({
      input: baseInput,
      cliArgs: ["internal", "run-stage"],
      container: {
        image: "stageflow-agent:v1",
        forwardEnvVars: ["CUSTOM_TOKEN"],
      },
      env: { CUSTOM_TOKEN: "x", ANTHROPIC_API_KEY: "sk-test" },
      containerName: "name-1",
    });

    const forwarded = args.filter((_, i) => args[i - 1] === "-e");
    expect(forwarded).toEqual([SF_STAGE_WORKER, "CUSTOM_TOKEN"]);
  });

  it("exposes the default forward list for reuse/inspection", () => {
    expect(DEFAULT_STAGE_CONTAINER_FORWARD_ENV_VARS).toEqual([
      "ANTHROPIC_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ]);
  });

  it("includes cache mount args (scoped per run+stage) when the container options declare them", () => {
    const args = buildContainerRunArgs({
      input: baseInput,
      cliArgs: ["internal", "run-stage"],
      container: {
        image: "stageflow-agent:v1",
        cacheRoot: "/Users/tejas/.stageflow-cache",
        cacheMounts: [
          { label: "node_modules", containerPath: "/Users/tejas/project/node_modules" },
        ],
      },
      env: {},
      containerName: "name-1",
    });

    const mountIndex = args.indexOf(
      "/Users/tejas/.stageflow-cache/run-1/implement/node_modules:/Users/tejas/project/node_modules",
    );
    expect(mountIndex).toBeGreaterThan(-1);
    expect(args[mountIndex - 1]).toBe("-v");
  });

  it("omits cache mounts entirely when the container options declare none (today's default)", () => {
    const args = buildContainerRunArgs({
      input: baseInput,
      cliArgs: ["internal", "run-stage"],
      container: { image: "stageflow-agent:v1" },
      env: {},
      containerName: "name-1",
    });
    const mountFlags = args.filter((a) => a === "-v");
    expect(mountFlags).toHaveLength(1); // only the rootDir mount
  });
});

describe("buildCacheMountArgs", () => {
  it("scopes each cache mount's host path by run id and stage id", () => {
    const args = buildCacheMountArgs({
      runId: "run-1",
      stageId: "review~1",
      cacheRoot: "/cache",
      cacheMounts: [
        { label: "node_modules", containerPath: "/workspace/node_modules" },
        { label: "npm", containerPath: "/root/.npm" },
      ],
    });
    expect(args).toEqual([
      "-v",
      "/cache/run-1/review-1/node_modules:/workspace/node_modules",
      "-v",
      "/cache/run-1/review-1/npm:/root/.npm",
    ]);
  });

  it("gives concurrent fan-out clones (different stage ids) distinct host cache paths", () => {
    const argsOne = buildCacheMountArgs({
      runId: "run-1",
      stageId: "review~1",
      cacheRoot: "/cache",
      cacheMounts: [{ label: "node_modules", containerPath: "/workspace/node_modules" }],
    });
    const argsTwo = buildCacheMountArgs({
      runId: "run-1",
      stageId: "review~2",
      cacheRoot: "/cache",
      cacheMounts: [{ label: "node_modules", containerPath: "/workspace/node_modules" }],
    });
    expect(argsOne[1]).not.toBe(argsTwo[1]);
  });

  it("returns no args when there are no cache mounts configured", () => {
    expect(
      buildCacheMountArgs({
        runId: "run-1",
        stageId: "implement",
        cacheRoot: "/cache",
        cacheMounts: [],
      }),
    ).toEqual([]);
  });
});

describe("container env constants", () => {
  it("names the env vars used to opt into container execution", () => {
    expect(STAGE_CONTAINER_IMAGE_ENV).toBe("STAGEFLOW_STAGE_CONTAINER_IMAGE");
    expect(STAGE_CONTAINER_DOCKER_BIN_ENV).toBe(
      "STAGEFLOW_STAGE_CONTAINER_DOCKER_BIN",
    );
  });
});

describe("StageProcessLauncher in container mode (end to end, via a fake docker binary)", () => {
  it("respects the same concurrency cap as host-process mode", async () => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), "sf-container-launcher-"),
    );
    const launcher = new StageProcessLauncher({
      maxActiveStageProcesses: 2,
      container: { image: "unused:test", dockerBin: mockDockerBin },
      env: { MOCK_DELAY: "150" },
    });

    const p1 = launcher.launch({ runId: "r1", stageId: "a", rootDir });
    const p2 = launcher.launch({ runId: "r1", stageId: "b", rootDir });
    const p3 = launcher.launch({ runId: "r1", stageId: "c", rootDir });

    await vi.waitFor(() => {
      expect(launcher.activeCount()).toBe(2);
    });
    expect(
      launcher
        .getActiveStageProcesses()
        .map((entry) => entry.stageId)
        .sort(),
    ).toEqual(["a", "b"]);

    await Promise.race([p1, p2]);

    await vi.waitFor(
      () => {
        expect(
          launcher.getActiveStageProcesses().some((e) => e.stageId === "c"),
        ).toBe(true);
      },
      { timeout: 2000 },
    );

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual([
      { type: "succeeded" },
      { type: "succeeded" },
      { type: "succeeded" },
    ]);
    expect(launcher.activeCount()).toBe(0);
  });

  it("translates a non-zero exit from the fake docker binary into a failed result", async () => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), "sf-container-launcher-fail-"),
    );
    const launcher = new StageProcessLauncher({
      container: { image: "unused:test", dockerBin: mockDockerBin },
      env: { MOCK_EXIT_CODE: "1" },
    });

    const result = await launcher.launch({
      runId: "r1",
      stageId: "will-fail",
      rootDir,
    });
    expect(result).toEqual({ type: "failed", reason: "stage failed" });
  });

  it("uses the captured stderr tail as the failure reason, since container mode has no IPC channel to carry the worker's real reason", async () => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), "sf-container-launcher-reason-"),
    );
    const launcher = new StageProcessLauncher({
      container: { image: "unused:test", dockerBin: mockDockerBin },
      env: {
        MOCK_EXIT_CODE: "1",
        MOCK_STDERR: "Stage research failed: No API key for anthropic/claude-sonnet-4-5",
      },
    });

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const result = await launcher.launch({
      runId: "r1",
      stageId: "will-fail-with-reason",
      rootDir,
    });

    stderrSpy.mockRestore();

    expect(result).toEqual({
      type: "failed",
      reason: "Stage research failed: No API key for anthropic/claude-sonnet-4-5",
    });
  });

  it("prefixes stderr the same way for a container-spawned attempt", async () => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), "sf-container-launcher-stderr-"),
    );
    const launcher = new StageProcessLauncher({
      container: { image: "unused:test", dockerBin: mockDockerBin },
      env: { MOCK_STDERR: "container-worker-error", MOCK_EXIT_CODE: "0" },
    });

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await launcher.launch({ runId: "r1", stageId: "stderr-stage", rootDir });

    const combined = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(combined).toContain("[stage:stderr-stage] container-worker-error");

    stderrSpy.mockRestore();
  });
});

describe("container option validation", () => {
  it("rejects a programmatic container override with an empty image, instead of silently spawning docker with an invalid reference", () => {
    expect(
      () => new StageProcessLauncher({ container: { image: "" } }),
    ).toThrow(/image/i);
    expect(
      () => new StageProcessLauncher({ container: { image: "   " } }),
    ).toThrow(/image/i);
  });
});
