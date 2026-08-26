import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bindPiAgentDirEnv,
  buildStageRoots,
  PI_CODING_AGENT_DIR_ENV,
  resolveAndValidateCheckout,
  rootsForStageWorker,
  withResolvedAuthPath,
} from "../src/runtime/stageRoots.js";
import {
  ensureSfOwnedAuthStore,
  resolveCredentialBinding,
} from "../src/runtime/credentialBinding.js";
import { writeCredentialSourceToFile } from "../src/runtime/settingsFile.js";
import { runWorkspaceDir, storeRootFor } from "../src/runstore/paths.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

describe("StageRoots", () => {
  it("buildStageRoots unbound uses run workspace as cwd", () => {
    const roots = buildStageRoots("/tmp/run", "clarify");
    expect(roots).toEqual({
      mode: "unbound",
      cwd: "/tmp/run",
      runWorkspaceDir: "/tmp/run",
      agentDir: "/tmp/run/stages/clarify/attempts/1/.pi-agent",
      attempt: 1,
    });
  });

  it("buildStageRoots bound uses checkout as cwd", () => {
    const roots = buildStageRoots("/tmp/run", "clarify", "/tmp/checkout");
    expect(roots).toEqual({
      mode: "bound",
      cwd: "/tmp/checkout",
      runWorkspaceDir: "/tmp/run",
      checkoutRoot: "/tmp/checkout",
      agentDir: "/tmp/run/stages/clarify/attempts/1/.pi-agent",
      attempt: 1,
    });
  });

  it("resolveAndValidateCheckout accepts a real directory", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-roots-"));
    const resolved = await resolveAndValidateCheckout(
      { id: "t", goal: "g", checkout },
      undefined,
      "/factory",
    );
    expect(resolved).toBe(checkout);
  });

  it("rootsForStageWorker isolates cursor unbound cwd to stage dir", () => {
    const roots = rootsForStageWorker("/tmp/run", "branch-a", "cursor/auto");
    expect(roots.cwd).toBe("/tmp/run/stages/branch-a");
    expect(roots.agentDir).toBe(
      "/tmp/run/stages/branch-a/attempts/1/.pi-agent",
    );
  });

  it("rootsForStageWorker keeps bound checkout cwd for cursor", () => {
    const roots = rootsForStageWorker(
      "/tmp/run",
      "branch-a",
      "cursor/auto",
      "/tmp/checkout",
    );
    expect(roots.cwd).toBe("/tmp/checkout");
    expect(roots.mode).toBe("bound");
  });

  it("rootsForStageWorker leaves non-cursor cwd on run workspace", () => {
    const roots = rootsForStageWorker("/tmp/run", "clarify", "openai/gpt-4");
    expect(roots.cwd).toBe("/tmp/run");
  });

  it("bindPiAgentDirEnv sets PI_CODING_AGENT_DIR and restores", () => {
    delete process.env[PI_CODING_AGENT_DIR_ENV];
    const unbind = bindPiAgentDirEnv(
      "/tmp/run/stages/a/attempts/1/.pi-agent",
    );
    expect(process.env[PI_CODING_AGENT_DIR_ENV]).toBe(
      "/tmp/run/stages/a/attempts/1/.pi-agent",
    );
    unbind();
    expect(process.env[PI_CODING_AGENT_DIR_ENV]).toBeUndefined();
  });

  it("sf_owned preference binds authPath without copying Pi-home into attempt dir", async () => {
    await withIsolatedHome(async (home) => {
      const piHome = path.join(home, "global-auth.json");
      writeFileSync(
        piHome,
        JSON.stringify({ cursor: { type: "api_key", key: "test-key" } }),
      );
      writeCredentialSourceToFile(home, "sf_owned");
      const sfAuth = ensureSfOwnedAuthStore();
      writeFileSync(
        sfAuth,
        JSON.stringify({ anthropic: { type: "api_key", key: "sf" } }),
      );

      const workspaceDir = runWorkspaceDir(storeRootFor(home), "r1");
      const roots = withResolvedAuthPath(
        rootsForStageWorker(workspaceDir, "a", "openai/gpt-4"),
        home,
      );
      const binding = resolveCredentialBinding(home, { piHomeAuthPath: piHome });

      expect(roots.authPath).toBe(sfAuth);
      expect(binding.authPath).toBe(sfAuth);
      expect(existsSync(path.join(roots.agentDir, "auth.json"))).toBe(false);
      mkdirSync(roots.agentDir, { recursive: true });
      expect(existsSync(path.join(roots.agentDir, "auth.json"))).toBe(false);
    });
  });
});
