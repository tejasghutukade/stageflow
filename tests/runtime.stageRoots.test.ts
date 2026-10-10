import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  createDurableRootPathDenyExtension,
  STAGEFLOW_PATH_DENIED,
} from "../src/agent/piAdapter.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
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
  STAGEFLOW_AGENT_AUTH_PATH_ENV,
  sfOwnedAuthPath,
} from "../src/runtime/credentialBinding.js";
import { SF_STAGE_WORKER } from "../src/runtime/stageWorkerProtocol.js";
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

  it("uses the stamped auth path when HOME is an attempt directory", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "sf-roots-data-"));
    const creds = await mkdtemp(path.join(tmpdir(), "sf-roots-creds-"));
    const attempt = await mkdtemp(path.join(tmpdir(), "sf-roots-attempt-"));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevStageflow = process.env.STAGEFLOW_HOME;
    const prevCredential = process.env.STAGEFLOW_CREDENTIAL_HOME;
    const prevAuth = process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV];
    const prevWorker = process.env[SF_STAGE_WORKER];
    try {
      process.env.STAGEFLOW_HOME = data;
      process.env.STAGEFLOW_CREDENTIAL_HOME = creds;
      resetGlobalStageflowHomeForTests();
      const hostAuth = sfOwnedAuthPath();
      await mkdir(path.dirname(hostAuth), { recursive: true });
      await writeFile(
        hostAuth,
        JSON.stringify({ anthropic: { type: "api_key", key: "k" } }),
      );
      process.env.HOME = attempt;
      process.env.USERPROFILE = attempt;
      delete process.env.STAGEFLOW_CREDENTIAL_HOME;
      resetGlobalStageflowHomeForTests();
      process.env[SF_STAGE_WORKER] = "1";
      process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = hostAuth;

      const workspace = path.join(data, "runs", "r1");
      await mkdir(workspace, { recursive: true });
      const roots = withResolvedAuthPath(
        rootsForStageWorker(workspace, "clarify", "openai/gpt-4"),
        data,
      );
      expect(roots.authPath).toBe(hostAuth);
      expect(existsSync(path.join(attempt, ".stageflow", "agent", "auth.json"))).toBe(
        false,
      );
      expect(existsSync(path.join(attempt, "agent", "auth.json"))).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      if (prevStageflow === undefined) delete process.env.STAGEFLOW_HOME;
      else process.env.STAGEFLOW_HOME = prevStageflow;
      if (prevCredential === undefined) delete process.env.STAGEFLOW_CREDENTIAL_HOME;
      else process.env.STAGEFLOW_CREDENTIAL_HOME = prevCredential;
      if (prevAuth === undefined) delete process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV];
      else process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = prevAuth;
      if (prevWorker === undefined) delete process.env[SF_STAGE_WORKER];
      else process.env[SF_STAGE_WORKER] = prevWorker;
      resetGlobalStageflowHomeForTests();
      await rm(data, { recursive: true, force: true });
      await rm(creds, { recursive: true, force: true });
      await rm(attempt, { recursive: true, force: true });
    }
  });
});

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: { cwd: string },
) => Promise<{ block?: boolean; reason?: string } | void | undefined>;

async function stageFileTool(
  runWorkspaceDir: string,
  durableRoot: string,
  toolName: string,
  target: string,
): Promise<{ block?: boolean; reason?: string } | void | undefined> {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on(event: string, h: ToolCallHandler) {
      if (event === "tool_call") handler = h;
    },
  } as unknown as ExtensionAPI;
  const factory = createDurableRootPathDenyExtension({
    runWorkspaceDir,
    durableRoot,
  });
  await factory(pi);
  if (!handler) throw new Error("path deny extension did not register tool_call");
  return handler(
    {
      type: "tool_call",
      toolCallId: "1",
      toolName,
      input: { path: target },
    },
    { cwd: runWorkspaceDir },
  );
}

describe("credential root file-tool denial", () => {
  it("denies a stage read of the operator auth file when that root is outside the data directory", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "sf-deny-data-"));
    const creds = await mkdtemp(path.join(tmpdir(), "sf-deny-creds-"));
    const decoy = await mkdtemp(path.join(tmpdir(), "sf-deny-decoy-"));
    const prevStageflow = process.env.STAGEFLOW_HOME;
    const prevCredential = process.env.STAGEFLOW_CREDENTIAL_HOME;
    const prevAuth = process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV];
    const prevWorker = process.env[SF_STAGE_WORKER];
    try {
      process.env.STAGEFLOW_HOME = data;
      process.env.STAGEFLOW_CREDENTIAL_HOME = creds;
      delete process.env[SF_STAGE_WORKER];
      process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = path.join(
        decoy,
        "agent",
        "auth.json",
      );
      resetGlobalStageflowHomeForTests();
      const workspace = path.join(data, "runs", "r1");
      await mkdir(workspace, { recursive: true });
      const authFile = path.join(creds, "agent", "auth.json");
      await mkdir(path.dirname(authFile), { recursive: true });
      await writeFile(authFile, JSON.stringify({ anthropic: { type: "api_key", key: "k" } }));
      const decoyAuth = path.join(decoy, "agent", "auth.json");
      await mkdir(path.dirname(decoyAuth), { recursive: true });
      await writeFile(decoyAuth, "{}\n");

      const denied = await stageFileTool(workspace, data, "read", authFile);
      expect(denied).toEqual({ block: true, reason: STAGEFLOW_PATH_DENIED });
      const ambient = await stageFileTool(workspace, data, "read", decoyAuth);
      expect(ambient).toBeUndefined();
      expect(sfOwnedAuthPath()).toBe(authFile);
    } finally {
      if (prevStageflow === undefined) delete process.env.STAGEFLOW_HOME;
      else process.env.STAGEFLOW_HOME = prevStageflow;
      if (prevCredential === undefined) delete process.env.STAGEFLOW_CREDENTIAL_HOME;
      else process.env.STAGEFLOW_CREDENTIAL_HOME = prevCredential;
      if (prevAuth === undefined) delete process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV];
      else process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = prevAuth;
      if (prevWorker === undefined) delete process.env[SF_STAGE_WORKER];
      else process.env[SF_STAGE_WORKER] = prevWorker;
      resetGlobalStageflowHomeForTests();
      await rm(data, { recursive: true, force: true });
      await rm(creds, { recursive: true, force: true });
      await rm(decoy, { recursive: true, force: true });
    }
  });

  it("denies the stamped credential root from a worker whose HOME is the attempt directory", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "sf-deny-worker-data-"));
    const creds = await mkdtemp(path.join(tmpdir(), "sf-deny-worker-creds-"));
    const attempt = await mkdtemp(path.join(tmpdir(), "sf-deny-worker-attempt-"));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevStageflow = process.env.STAGEFLOW_HOME;
    const prevCredential = process.env.STAGEFLOW_CREDENTIAL_HOME;
    const prevAuth = process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV];
    const prevWorker = process.env[SF_STAGE_WORKER];
    try {
      process.env.STAGEFLOW_HOME = data;
      process.env.STAGEFLOW_CREDENTIAL_HOME = creds;
      resetGlobalStageflowHomeForTests();
      const hostAuth = sfOwnedAuthPath();
      await mkdir(path.dirname(hostAuth), { recursive: true });
      await writeFile(hostAuth, JSON.stringify({ anthropic: { type: "api_key", key: "k" } }));
      process.env.HOME = attempt;
      process.env.USERPROFILE = attempt;
      delete process.env.STAGEFLOW_CREDENTIAL_HOME;
      resetGlobalStageflowHomeForTests();
      process.env[SF_STAGE_WORKER] = "1";
      process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = hostAuth;

      const workspace = path.join(data, "runs", "r1");
      const note = path.join(workspace, "stages", "clarify", "attempts", "1", "note.md");
      await mkdir(path.dirname(note), { recursive: true });
      await writeFile(note, "keep");

      const denied = await stageFileTool(workspace, data, "read", hostAuth);
      expect(denied).toEqual({ block: true, reason: STAGEFLOW_PATH_DENIED });
      const allowed = await stageFileTool(workspace, data, "read", note);
      expect(allowed).toBeUndefined();
      const bash = await stageFileTool(workspace, data, "bash", hostAuth);
      expect(bash).toBeUndefined();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      if (prevStageflow === undefined) delete process.env.STAGEFLOW_HOME;
      else process.env.STAGEFLOW_HOME = prevStageflow;
      if (prevCredential === undefined) delete process.env.STAGEFLOW_CREDENTIAL_HOME;
      else process.env.STAGEFLOW_CREDENTIAL_HOME = prevCredential;
      if (prevAuth === undefined) delete process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV];
      else process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = prevAuth;
      if (prevWorker === undefined) delete process.env[SF_STAGE_WORKER];
      else process.env[SF_STAGE_WORKER] = prevWorker;
      resetGlobalStageflowHomeForTests();
      await rm(data, { recursive: true, force: true });
      await rm(creds, { recursive: true, force: true });
      await rm(attempt, { recursive: true, force: true });
    }
  });
});
