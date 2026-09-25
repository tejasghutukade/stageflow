import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import {
  resolveCredentialBinding,
  sfOwnedAuthPath,
} from "../src/runtime/credentialBinding.js";
import {
  bindPiAgentDirEnv,
  PI_CODING_AGENT_DIR_ENV,
} from "../src/runtime/stageRoots.js";
import { bootstrapStageflowHost } from "../src/server/bootstrap.js";
import { initTempGitRepo, withIsolatedHome } from "./helpers/projectContext.js";

const createJiti = vi.hoisted(() =>
  vi.fn((_id: string, _opts?: { fsCache?: boolean | string }) => ({
    import: vi.fn(async () => ({
      createMcpAdapter: vi.fn(() => () => {}),
    })),
  })),
);

vi.mock("pi-mcp-adapter", () => ({
  notCreateMcpAdapter: true,
}));

vi.mock("jiti/static", () => ({
  createJiti,
}));

const {
  attachIsolatedMcp,
  jitiFsCacheDir,
  resetCreateMcpAdapterCacheForTests,
} = await import("../src/agent/piIsolatedMcp.js");

async function withStageflowHome<T>(
  fn: (stageflowHome: string) => Promise<T>,
): Promise<T> {
  const stageflowHome = await mkdtemp(path.join(tmpdir(), "sf-durable-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevStageflowHome = process.env.STAGEFLOW_HOME;
  const prevPiAgentDir = process.env[PI_CODING_AGENT_DIR_ENV];
  process.env.HOME = stageflowHome;
  process.env.USERPROFILE = stageflowHome;
  process.env.STAGEFLOW_HOME = stageflowHome;
  delete process.env[PI_CODING_AGENT_DIR_ENV];
  resetGlobalStageflowHomeForTests();
  try {
    return await fn(stageflowHome);
  } finally {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    if (prevUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = prevUserProfile;
    }
    if (prevStageflowHome === undefined) {
      delete process.env.STAGEFLOW_HOME;
    } else {
      process.env.STAGEFLOW_HOME = prevStageflowHome;
    }
    if (prevPiAgentDir === undefined) {
      delete process.env[PI_CODING_AGENT_DIR_ENV];
    } else {
      process.env[PI_CODING_AGENT_DIR_ENV] = prevPiAgentDir;
    }
    resetGlobalStageflowHomeForTests();
  }
}

describe("durable root Host Pi and jiti", () => {
  it("jitiFsCacheDir resolves under STAGEFLOW_HOME/cache/jiti", async () => {
    await withStageflowHome(async (stageflowHome) => {
      expect(jitiFsCacheDir()).toBe(path.join(stageflowHome, "cache", "jiti"));
    });
  });

  it("jiti fallback constructs fsCache under STAGEFLOW_HOME/cache/jiti", async () => {
    await withStageflowHome(async (stageflowHome) => {
      resetCreateMcpAdapterCacheForTests();
      createJiti.mockClear();
      await attachIsolatedMcp({
        github: { command: "npx", lifecycle: "lazy", directTools: false },
      });
      expect(createJiti).toHaveBeenCalled();
      const opts = createJiti.mock.calls[0]?.[1] as
        | { fsCache?: boolean | string }
        | undefined;
      expect(opts?.fsCache).toBe(path.join(stageflowHome, "cache", "jiti"));
    });
  });

  it("Host sets PI_CODING_AGENT_DIR to STAGEFLOW_HOME/agent; worker overrides per attempt", async () => {
    await withStageflowHome(async (stageflowHome) => {
      const { root, cleanup } = await initTempGitRepo();
      try {
        const boot = await bootstrapStageflowHost({
          agent: scriptedFakeAgent([]),
          cwd: root,
        });
        await boot.mcpHandler.close();

        const hostAgentDir = path.join(stageflowHome, "agent");
        expect(process.env[PI_CODING_AGENT_DIR_ENV]).toBe(hostAgentDir);

        const attemptDir = path.join(
          stageflowHome,
          "runs",
          "run1",
          "stages",
          "clarify",
          "attempts",
          "1",
          ".pi-agent",
        );
        const unbind = bindPiAgentDirEnv(attemptDir);
        expect(process.env[PI_CODING_AGENT_DIR_ENV]).toBe(attemptDir);
        unbind();
        expect(process.env[PI_CODING_AGENT_DIR_ENV]).toBe(hostAgentDir);
      } finally {
        await cleanup();
      }
    });
  });

  it("usable ~/.pi auth with no saved setting still selects pi_home", async () => {
    await withIsolatedHome(async (home) => {
      const piHome = path.join(home, ".pi", "agent", "auth.json");
      await mkdir(path.dirname(piHome), { recursive: true });
      await writeFile(
        piHome,
        JSON.stringify({ openai: { type: "api_key", key: "x" } }),
      );

      const binding = resolveCredentialBinding(home);
      expect(binding).toEqual({
        source: "pi_home",
        authPath: piHome,
        provisional: true,
      });
    });
  });

  it("no usable Pi auth selects agent/auth.json under the durable root", async () => {
    await withStageflowHome(async (stageflowHome) => {
      const binding = resolveCredentialBinding(stageflowHome, {
        piHomeAuthPath: path.join(stageflowHome, "missing-pi", "auth.json"),
      });
      expect(binding.source).toBe("sf_owned");
      expect(binding.provisional).toBe(true);
      expect(binding.authPath).toBe(sfOwnedAuthPath());
      expect(binding.authPath).toBe(
        path.join(stageflowHome, "agent", "auth.json"),
      );
    });
  });
});
