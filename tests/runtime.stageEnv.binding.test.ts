import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import {
  buildStageBindingEnv,
  overlayStageBindingEnv,
  resolveEffectiveGitIdentity,
  STAGEFLOW_BASE_SHA,
  STAGEFLOW_CHECKOUT,
  STAGEFLOW_REF,
  STAGEFLOW_REPOSITORY,
  STAGEFLOW_RUN_BRANCH,
  STAGEFLOW_RUN_WORKSPACE,
} from "../src/runtime/stageRoots.js";

const mockWorker = fileURLToPath(
  new URL("./fixtures/mockStageWorker.mjs", import.meta.url),
);

function repositoryBindingEnv() {
  return buildStageBindingEnv({
    kind: "repository",
    runWorkspaceDir: "/ws/run-1",
    checkoutRoot: "/data/worktrees/run-1",
    repository: "acme/api",
    ref: "main",
    resolvedSha: "a".repeat(40),
    runBranch: "stageflow/run-run-1",
    gitIdentity: resolveEffectiveGitIdentity({}),
  });
}

describe("stage binding env (U6)", () => {
  it("repository launch map has all six Stageflow vars + identity + safe.directory", () => {
    const map = repositoryBindingEnv();

    expect(map[STAGEFLOW_CHECKOUT]).toBe("/data/worktrees/run-1");
    expect(map[STAGEFLOW_RUN_WORKSPACE]).toBe("/ws/run-1");
    expect(map[STAGEFLOW_REPOSITORY]).toBe("acme/api");
    expect(map[STAGEFLOW_REF]).toBe("main");
    expect(map[STAGEFLOW_BASE_SHA]).toBe("a".repeat(40));
    expect(map[STAGEFLOW_RUN_BRANCH]).toBe("stageflow/run-run-1");
    expect(map.GIT_AUTHOR_NAME).toBe("Stageflow");
    expect(map.GIT_AUTHOR_EMAIL).toBe("stageflow@localhost");
    expect(map.GIT_COMMITTER_NAME).toBe("Stageflow");
    expect(map.GIT_COMMITTER_EMAIL).toBe("stageflow@localhost");
    expect(map.GIT_CONFIG_COUNT).toBe("1");
    expect(map.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(map.GIT_CONFIG_VALUE_0).toBe("/data/worktrees/run-1");
    expect(map).not.toHaveProperty("GIT_ASKPASS");
    expect(map).not.toHaveProperty("GIT_TERMINAL_PROMPT");
  });

  it("path launch has checkout + workspace only; repository vars absent; omits askpass", () => {
    const map = buildStageBindingEnv({
      kind: "checkout",
      runWorkspaceDir: "/ws/run-2",
      checkoutRoot: "/Users/me/acme-api",
      gitIdentity: resolveEffectiveGitIdentity({}),
    });

    expect(map[STAGEFLOW_CHECKOUT]).toBe("/Users/me/acme-api");
    expect(map[STAGEFLOW_RUN_WORKSPACE]).toBe("/ws/run-2");
    expect(Object.hasOwn(map, STAGEFLOW_REPOSITORY)).toBe(false);
    expect(Object.hasOwn(map, STAGEFLOW_REF)).toBe(false);
    expect(Object.hasOwn(map, STAGEFLOW_BASE_SHA)).toBe(false);
    expect(Object.hasOwn(map, STAGEFLOW_RUN_BRANCH)).toBe(false);
    expect(map.GIT_CONFIG_VALUE_0).toBe("/Users/me/acme-api");
    expect(Object.hasOwn(map, "GIT_ASKPASS")).toBe(false);
    expect(Object.hasOwn(map, "GIT_TERMINAL_PROMPT")).toBe(false);

    const overlaid = overlayStageBindingEnv(
      {
        STAGEFLOW_REPOSITORY: "stale/repo",
        STAGEFLOW_REF: "stale",
        STAGEFLOW_BASE_SHA: "deadbeef",
        STAGEFLOW_RUN_BRANCH: "stale-branch",
        HOME: "",
        PATH: "/usr/bin",
      },
      map,
      "checkout",
    );
    expect(overlaid[STAGEFLOW_REPOSITORY]).toBeUndefined();
    expect(overlaid[STAGEFLOW_REF]).toBeUndefined();
    expect(overlaid[STAGEFLOW_BASE_SHA]).toBeUndefined();
    expect(overlaid[STAGEFLOW_RUN_BRANCH]).toBeUndefined();
    expect(overlaid[STAGEFLOW_CHECKOUT]).toBe("/Users/me/acme-api");
    expect(overlaid.GIT_AUTHOR_NAME).toBe("Stageflow");
    expect(overlaid.HOME).toBe("");
  });

  it("task git_identity and host STAGEFLOW_GIT_* override defaults", () => {
    const fromHost = resolveEffectiveGitIdentity({
      STAGEFLOW_GIT_AUTHOR_NAME: "Host Author",
      STAGEFLOW_GIT_AUTHOR_EMAIL: "host@example.com",
    });
    expect(fromHost).toEqual({
      name: "Host Author",
      email: "host@example.com",
    });

    const fromTask = resolveEffectiveGitIdentity(
      {
        STAGEFLOW_GIT_AUTHOR_NAME: "Host Author",
        STAGEFLOW_GIT_AUTHOR_EMAIL: "host@example.com",
      },
      { name: "Task Bot", email: "task@example.com" },
    );
    expect(fromTask).toEqual({ name: "Task Bot", email: "task@example.com" });

    const map = buildStageBindingEnv({
      kind: "unbound",
      runWorkspaceDir: "/ws/unbound",
      gitIdentity: fromHost,
      hostEnv: {
        STAGEFLOW_GIT_COMMITTER_NAME: "Host Committer",
        STAGEFLOW_GIT_COMMITTER_EMAIL: "committer@example.com",
      },
    });
    expect(map[STAGEFLOW_RUN_WORKSPACE]).toBe("/ws/unbound");
    expect(Object.hasOwn(map, STAGEFLOW_CHECKOUT)).toBe(false);
    expect(Object.hasOwn(map, "GIT_CONFIG_COUNT")).toBe(false);
    expect(map.GIT_AUTHOR_NAME).toBe("Host Author");
    expect(map.GIT_COMMITTER_NAME).toBe("Host Committer");
    expect(map.GIT_COMMITTER_EMAIL).toBe("committer@example.com");
  });

  it("empty HOME still carries commit identity via env overlay", () => {
    const map = repositoryBindingEnv();
    const overlaid = overlayStageBindingEnv(
      { HOME: "", PATH: "/bin" },
      map,
      "repository",
    );
    expect(overlaid.HOME).toBe("");
    expect(overlaid.GIT_AUTHOR_NAME).toBe("Stageflow");
    expect(overlaid.GIT_AUTHOR_EMAIL).toBe("stageflow@localhost");
    expect(overlaid.GIT_COMMITTER_NAME).toBe("Stageflow");
    expect(overlaid.GIT_COMMITTER_EMAIL).toBe("stageflow@localhost");
  });

  it("forked launcher overlays the binding map onto the child env", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-env-"));
    const dumpPath = path.join(rootDir, "child-env.json");
    const bindingEnv = repositoryBindingEnv();

    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      env: {
        MOCK_DELAY: "20",
        MOCK_EXIT_CODE: "0",
        MOCK_DUMP_ENV: dumpPath,
        MOCK_DUMP_KEYS: [
          STAGEFLOW_CHECKOUT,
          STAGEFLOW_RUN_WORKSPACE,
          STAGEFLOW_REPOSITORY,
          STAGEFLOW_REF,
          STAGEFLOW_BASE_SHA,
          STAGEFLOW_RUN_BRANCH,
          "GIT_AUTHOR_NAME",
          "GIT_AUTHOR_EMAIL",
          "GIT_COMMITTER_NAME",
          "GIT_COMMITTER_EMAIL",
          "GIT_CONFIG_COUNT",
          "GIT_CONFIG_KEY_0",
          "GIT_CONFIG_VALUE_0",
          "GIT_ASKPASS",
          "GIT_TERMINAL_PROMPT",
        ].join(","),
        // seed stale repo vars on the launcher base env to prove deletes work
        STAGEFLOW_REPOSITORY: "stale/should-be-replaced",
      },
    });

    const result = await launcher.launch({
      runId: "r-env",
      stageId: "echo",
      rootDir,
      env: bindingEnv,
      bindingKind: "repository",
    });
    expect(result).toEqual({ type: "succeeded" });

    const dumped = JSON.parse(await readFile(dumpPath, "utf8")) as Record<
      string,
      string | null
    >;
    expect(dumped[STAGEFLOW_CHECKOUT]).toBe("/data/worktrees/run-1");
    expect(dumped[STAGEFLOW_RUN_WORKSPACE]).toBe("/ws/run-1");
    expect(dumped[STAGEFLOW_REPOSITORY]).toBe("acme/api");
    expect(dumped[STAGEFLOW_REF]).toBe("main");
    expect(dumped[STAGEFLOW_BASE_SHA]).toBe("a".repeat(40));
    expect(dumped[STAGEFLOW_RUN_BRANCH]).toBe("stageflow/run-run-1");
    expect(dumped.GIT_AUTHOR_NAME).toBe("Stageflow");
    expect(dumped.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(dumped.GIT_ASKPASS).toBeNull();
    expect(dumped.GIT_TERMINAL_PROMPT).toBeNull();
  });

  it("path fork deletes inherited repository-only vars", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-env-path-"));
    const dumpPath = path.join(rootDir, "child-env.json");
    const bindingEnv = buildStageBindingEnv({
      kind: "checkout",
      runWorkspaceDir: "/ws/path",
      checkoutRoot: "/Users/me/repo",
      gitIdentity: resolveEffectiveGitIdentity({}),
    });

    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      env: {
        MOCK_DELAY: "20",
        MOCK_EXIT_CODE: "0",
        MOCK_DUMP_ENV: dumpPath,
        MOCK_DUMP_KEYS: [
          STAGEFLOW_CHECKOUT,
          STAGEFLOW_RUN_WORKSPACE,
          STAGEFLOW_REPOSITORY,
          STAGEFLOW_REF,
          STAGEFLOW_BASE_SHA,
          STAGEFLOW_RUN_BRANCH,
          "GIT_ASKPASS",
          "GIT_TERMINAL_PROMPT",
        ].join(","),
        STAGEFLOW_REPOSITORY: "should/go",
        STAGEFLOW_REF: "gone",
        STAGEFLOW_BASE_SHA: "gone",
        STAGEFLOW_RUN_BRANCH: "gone",
      },
    });

    const result = await launcher.launch({
      runId: "r-path",
      stageId: "echo",
      rootDir,
      env: bindingEnv,
      bindingKind: "checkout",
    });
    expect(result).toEqual({ type: "succeeded" });

    const dumped = JSON.parse(await readFile(dumpPath, "utf8")) as Record<
      string,
      string | null
    >;
    expect(dumped[STAGEFLOW_CHECKOUT]).toBe("/Users/me/repo");
    expect(dumped[STAGEFLOW_RUN_WORKSPACE]).toBe("/ws/path");
    expect(dumped[STAGEFLOW_REPOSITORY]).toBeNull();
    expect(dumped[STAGEFLOW_REF]).toBeNull();
    expect(dumped[STAGEFLOW_BASE_SHA]).toBeNull();
    expect(dumped[STAGEFLOW_RUN_BRANCH]).toBeNull();
    expect(dumped.GIT_ASKPASS).toBeNull();
    expect(dumped.GIT_TERMINAL_PROMPT).toBeNull();
  });

  it("inprocess bootstrap receives the same map as the forked path", async () => {
    const forkedMap = repositoryBindingEnv();

    const { openStageAttempt } = await import(
      "../src/runtime/stageAttemptBootstrap.js"
    );

    const agent = {
      openStage: () => ({
        stageId: "s1",
        next: async () => ({
          status: "completed" as const,
          result: {
            ok: true as const,
            envelope: {
              status: "success" as const,
              summary: "ok",
              artifacts: [],
            },
          },
        }),
        deliverAnswer: () => {},
        close: async () => {},
      }),
    };

    const store = {
      listStageEvents: async () => [],
      listVerificationCheckResults: async () => [],
      getWorkspaceDir: () => "/ws/run-1",
    };

    const opened = await openStageAttempt({
      agent: agent as never,
      store: store as never,
      runId: "run-same",
      stage: {
        id: "s1",
        model: "openai/gpt-4",
        system_prompt: "hi",
      } as never,
      task: { id: "t1", goal: "g" },
      dag: {
        nodes: [
          {
            id: "s1",
            needs: null,
            needsEdges: [],
            ancestors: [],
            stageIndex: 0,
          },
        ],
        roots: ["s1"],
        childrenOf: {},
      } as never,
      workspaceDir: "/ws/run-1",
      checkoutRoot: "/data/worktrees/run-1",
      stageEnv: forkedMap,
      completedEnvelopes: new Map(),
      streamLogWriterFactory: () => ({
        write: () => {},
        close: async () => {},
      }),
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.stageEnv).toEqual(forkedMap);
    expect(Object.hasOwn(opened.stageEnv ?? {}, "GIT_ASKPASS")).toBe(false);
    expect(Object.hasOwn(opened.stageEnv ?? {}, "GIT_TERMINAL_PROMPT")).toBe(
      false,
    );
  });
});
