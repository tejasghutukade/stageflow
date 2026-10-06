import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STAGEFLOW_AGENT_AUTH_PATH_ENV,
  sfOwnedAuthPath,
  stageflowAgentAuthPath,
} from "../src/runtime/credentialBinding.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
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

  it("resolves the agent auth path from STAGEFLOW_AGENT_AUTH_PATH when the worker HOME differs", () => {
    process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = "/real/home/.stageflow/agent/auth.json";
    expect(stageflowAgentAuthPath()).toBe("/real/home/.stageflow/agent/auth.json");
  });

  it("still lets an explicit override win", () => {
    process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = "/real/home/.stageflow/agent/auth.json";
    expect(stageflowAgentAuthPath("/custom/auth.json")).toBe("/custom/auth.json");
  });
});
