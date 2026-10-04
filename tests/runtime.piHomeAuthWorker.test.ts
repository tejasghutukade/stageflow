import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piHomeAuthPath } from "../src/runtime/credentialBinding.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";

const ENV_NAME = "STAGEFLOW_PI_HOME_AUTH_PATH";
const saved = process.env[ENV_NAME];

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = saved;
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

describe("Pi-home credentials in a stage worker", () => {
  it("gives the worker the Host's Pi auth path, because the worker HOME is an empty attempt dir", async () => {
    delete process.env[ENV_NAME];
    const childEnv = await launchCapturingChildEnv();
    expect(childEnv[ENV_NAME]).toBe(path.join(os.homedir(), ".pi", "agent", "auth.json"));
  });

  it("resolves the Pi auth path from that variable when the worker HOME differs", () => {
    process.env[ENV_NAME] = "/real/home/.pi/agent/auth.json";
    expect(piHomeAuthPath()).toBe("/real/home/.pi/agent/auth.json");
  });

  it("still lets an explicit override win", () => {
    process.env[ENV_NAME] = "/real/home/.pi/agent/auth.json";
    expect(piHomeAuthPath("/custom/auth.json")).toBe("/custom/auth.json");
  });
});
