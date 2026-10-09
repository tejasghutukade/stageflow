import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentAdapter } from "../src/agent/piAdapter.js";
import type { StageRunInput } from "../src/agent/port.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import {
  STAGEFLOW_AGENT_AUTH_PATH_ENV,
  sfOwnedAuthPath,
  stageflowAgentAuthPath,
} from "../src/runtime/credentialBinding.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import {
  rootsForStageWorker,
  withResolvedAuthPath,
  type StageRoots,
} from "../src/runtime/stageRoots.js";
import { SF_STAGE_WORKER } from "../src/runtime/stageWorkerProtocol.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

const saved = process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV];

afterEach(() => {
  if (saved === undefined) delete process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV];
  else process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = saved;
});

function launchCapturingChildEnv(): Promise<Record<string, string>> {
  let captured: Record<string, string> = {};
  const forkFn = ((_entry: string, _args: readonly string[], options: { env: Record<string, string> }) => {
    captured = { ...options.env };
    const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null; pid: undefined };
    child.stdout = null;
    child.stderr = null;
    child.pid = undefined;
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  }) as never;
  const launcher = new StageProcessLauncher({ forkFn, cliEntry: "unused" });
  return launcher
    .launch({ runId: "r1", stageId: "s1", rootDir: process.cwd(), attemptHome: path.join(os.tmpdir(), "sf-empty-attempt-home") })
    .then(() => captured);
}

describe("Stageflow agent auth path in a stage worker", () => {
  it("gives the worker the Host SF-owned auth path when HOME is an empty attempt dir", async () => {
    await withIsolatedHome(async () => {
      delete process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV];
      const childEnv = await launchCapturingChildEnv();
      expect(childEnv[STAGEFLOW_AGENT_AUTH_PATH_ENV]).toBe(sfOwnedAuthPath());
    });
  });

  it("still lets an explicit override win", () => {
    process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = "/real/home/.stageflow/agent/auth.json";
    expect(stageflowAgentAuthPath("/custom/auth.json")).toBe("/custom/auth.json");
  });
});

type EnvSnap = {
  HOME: string | undefined;
  USERPROFILE: string | undefined;
  STAGEFLOW_HOME: string | undefined;
  STAGEFLOW_CREDENTIAL_HOME: string | undefined;
  auth: string | undefined;
  worker: string | undefined;
};

function snapEnv(): EnvSnap {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    STAGEFLOW_HOME: process.env.STAGEFLOW_HOME,
    STAGEFLOW_CREDENTIAL_HOME: process.env.STAGEFLOW_CREDENTIAL_HOME,
    auth: process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV],
    worker: process.env[SF_STAGE_WORKER],
  };
}

function restoreEnv(prev: EnvSnap): void {
  if (prev.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = prev.HOME;
  if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prev.USERPROFILE;
  if (prev.STAGEFLOW_HOME === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = prev.STAGEFLOW_HOME;
  if (prev.STAGEFLOW_CREDENTIAL_HOME === undefined) {
    delete process.env.STAGEFLOW_CREDENTIAL_HOME;
  } else {
    process.env.STAGEFLOW_CREDENTIAL_HOME = prev.STAGEFLOW_CREDENTIAL_HOME;
  }
  if (prev.auth === undefined) delete process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV];
  else process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = prev.auth;
  if (prev.worker === undefined) delete process.env[SF_STAGE_WORKER];
  else process.env[SF_STAGE_WORKER] = prev.worker;
  resetGlobalStageflowHomeForTests();
}

function enterWorker(attempt: string, stamp: string | undefined): void {
  process.env.HOME = attempt;
  process.env.USERPROFILE = attempt;
  delete process.env.STAGEFLOW_CREDENTIAL_HOME;
  resetGlobalStageflowHomeForTests();
  process.env[SF_STAGE_WORKER] = "1";
  if (stamp === undefined) delete process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV];
  else process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = stamp;
}

async function withSplitCredentialRoot<T>(
  fn: (dirs: {
    data: string;
    creds: string;
    attempt: string;
    hostAuth: string;
  }) => Promise<T>,
): Promise<T> {
  const data = await mkdtemp(path.join(os.tmpdir(), "sf-u2-data-"));
  const creds = await mkdtemp(path.join(os.tmpdir(), "sf-u2-creds-"));
  const attempt = await mkdtemp(path.join(os.tmpdir(), "sf-u2-attempt-"));
  const prev = snapEnv();
  process.env.STAGEFLOW_HOME = data;
  process.env.STAGEFLOW_CREDENTIAL_HOME = creds;
  resetGlobalStageflowHomeForTests();
  const hostAuth = sfOwnedAuthPath();
  try {
    return await fn({ data, creds, attempt, hostAuth });
  } finally {
    restoreEnv(prev);
    await rm(data, { recursive: true, force: true });
    await rm(creds, { recursive: true, force: true });
    await rm(attempt, { recursive: true, force: true });
  }
}

function stageInput(roots: StageRoots): StageRunInput {
  return {
    roots,
    stage: {
      id: "clarify",
      system_prompt: "x",
      model: "anthropic/claude-sonnet-4-5",
    },
    task: { id: "t", goal: "g" },
    priorEnvelope: null,
  };
}

function workerRoots(data: string): StageRoots {
  const workspace = path.join(data, "runs", "r1");
  mkdirSync(workspace, { recursive: true });
  return withResolvedAuthPath(
    rootsForStageWorker(workspace, "clarify", "anthropic/claude-sonnet-4-5"),
    data,
  );
}

describe("stage worker opens the host-stamped auth file", () => {
  it("stamps the host binding and ignores an ambient auth path", async () => {
    await withSplitCredentialRoot(async ({ data, creds, hostAuth }) => {
      process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = path.join(
        data,
        "agent",
        "auth.json",
      );
      const childEnv = await launchCapturingChildEnv();
      expect(childEnv[STAGEFLOW_AGENT_AUTH_PATH_ENV]).toBe(hostAuth);
      expect(hostAuth).toBe(path.join(creds, "agent", "auth.json"));
      expect(childEnv.STAGEFLOW_CREDENTIAL_HOME).toBeUndefined();
    });
  });

  it("creates ModelRuntime with the stamp when HOME is an attempt directory", async () => {
    await withSplitCredentialRoot(async ({ data, attempt, hostAuth }) => {
      await mkdir(path.dirname(hostAuth), { recursive: true });
      await writeFile(
        hostAuth,
        JSON.stringify({ anthropic: { type: "api_key", key: "k" } }),
      );
      enterWorker(attempt, hostAuth);
      const roots = workerRoots(data);
      expect(roots.authPath).toBe(hostAuth);
      expect(existsSync(path.join(attempt, ".stageflow", "agent", "auth.json"))).toBe(
        false,
      );

      const spy = vi
        .spyOn(ModelRuntime, "create")
        .mockRejectedValue(new Error("halt-after-create"));
      try {
        const result = await new PiAgentAdapter().runStage(stageInput(roots));
        expect(spy).toHaveBeenCalledWith({
          authPath: hostAuth,
          modelsPath: path.join(path.dirname(hostAuth), "models.json"),
        });
        expect(result).toMatchObject({ ok: false, reason: "halt-after-create" });
      } finally {
        spy.mockRestore();
      }
      expect(existsSync(path.join(attempt, "agent", "auth.json"))).toBe(false);
    });
  });

  it("does not create an auth file when the worker has no stamp", async () => {
    await withSplitCredentialRoot(async ({ data, creds, attempt, hostAuth }) => {
      enterWorker(attempt, undefined);
      const roots = workerRoots(data);
      const attemptAuth = path.join(attempt, ".stageflow", "agent", "auth.json");
      const credentialAuth = path.join(creds, "agent", "auth.json");
      expect(roots.authPath).toBeUndefined();
      expect(existsSync(attemptAuth)).toBe(false);
      expect(existsSync(credentialAuth)).toBe(false);
      expect(existsSync(hostAuth)).toBe(false);

      const spy = vi.spyOn(ModelRuntime, "create").mockImplementation(async (opts) => {
        const authPath =
          opts?.authPath ?? path.join(attempt, "default-agent", "auth.json");
        await mkdir(path.dirname(authPath), { recursive: true });
        await writeFile(authPath, "{}\n");
        throw new Error("halt-after-create");
      });
      try {
        const result = await new PiAgentAdapter().runStage(stageInput(roots));
        expect(spy).not.toHaveBeenCalled();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toContain("STAGEFLOW_AGENT_AUTH_PATH");
        }
      } finally {
        spy.mockRestore();
      }
      expect(existsSync(attemptAuth)).toBe(false);
      expect(existsSync(credentialAuth)).toBe(false);
      expect(existsSync(path.join(attempt, "default-agent", "auth.json"))).toBe(false);
      expect(existsSync(path.join(roots.agentDir, "auth.json"))).toBe(false);
    });
  });

  it("does not create an auth file when the stamped file is missing", async () => {
    await withSplitCredentialRoot(async ({ data, attempt, hostAuth }) => {
      enterWorker(attempt, hostAuth);
      const roots = workerRoots(data);
      const attemptAuth = path.join(attempt, ".stageflow", "agent", "auth.json");
      expect(roots.authPath).toBe(hostAuth);
      expect(existsSync(hostAuth)).toBe(false);
      expect(existsSync(attemptAuth)).toBe(false);

      const spy = vi.spyOn(ModelRuntime, "create").mockImplementation(async (opts) => {
        const authPath = opts?.authPath;
        if (authPath !== undefined) {
          await mkdir(path.dirname(authPath), { recursive: true });
          await writeFile(authPath, "{}\n");
        }
        throw new Error("halt-after-create");
      });
      try {
        const result = await new PiAgentAdapter().runStage(stageInput(roots));
        expect(spy).not.toHaveBeenCalled();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain(hostAuth);
      } finally {
        spy.mockRestore();
      }
      expect(existsSync(hostAuth)).toBe(false);
      expect(existsSync(attemptAuth)).toBe(false);
    });
  });

  it.each(["", "   ", "{}"])(
    "fails before ModelRuntime when the stamped auth file is %j",
    async (content) => {
      await withSplitCredentialRoot(async ({ data, attempt, hostAuth }) => {
        await mkdir(path.dirname(hostAuth), { recursive: true });
        await writeFile(hostAuth, content);
        enterWorker(attempt, hostAuth);
        const roots = workerRoots(data);
        expect(roots.authPath).toBe(hostAuth);

        const spy = vi
          .spyOn(ModelRuntime, "create")
          .mockRejectedValue(new Error("halt-after-create"));
        try {
          const result = await new PiAgentAdapter().runStage(stageInput(roots));
          expect(spy).not.toHaveBeenCalled();
          expect(result.ok).toBe(false);
        } finally {
          spy.mockRestore();
        }
        expect(existsSync(path.join(attempt, ".stageflow", "agent", "auth.json"))).toBe(
          false,
        );
        expect(await readFile(hostAuth, "utf8")).toBe(content);
      });
    },
  );
});
