import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { freePort } from "./helpers/freePort.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
});

function reservePort(_start?: number): Promise<number> {
  return freePort();
}

function startMcp(
  home: string,
  port: number,
  extra: NodeJS.ProcessEnv = {},
): { child: ChildProcess; output: () => string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    STAGEFLOW_HOME: home,
    STAGEFLOW_NO_AUTOSTART: "1",
  };
  delete env.STAGEFLOW_CONTROL_TOKEN;
  delete env.STAGEFLOW_CONTROL_TOKEN_FILE;
  if (!Object.prototype.hasOwnProperty.call(extra, "SF_SERVICE_CHILD")) {
    delete env.SF_SERVICE_CHILD;
  }
  const child = spawn(process.execPath, [tsxCli, cli, "mcp", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  return { child, output: () => stdout };
}

async function waitFor(read: () => string, pattern: RegExp, child: ChildProcess): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 25_000) {
    const text = read();
    if (pattern.test(text)) return text;
    if (child.exitCode !== null) {
      throw new Error(`mcp exited ${child.exitCode}: ${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${pattern}: ${read()}`);
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

describe("control token reveal", () => {
  it("prints a new token without a TTY, hides it on reuse and in the service child", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-reveal-"));
    const port = await reservePort();
    try {
      const first = startMcp(home, port);
      const firstOut = await waitFor(first.output, /Control token: [0-9a-f]{64}/, first.child);
      const match = /Control token: ([0-9a-f]{64})/.exec(firstOut);
      expect(match).not.toBeNull();
      const token = match![1]!;
      expect(readFileSync(path.join(home, "control-token"), "utf8").trim()).toBe(token);
      await stop(first.child);

      const secondPort = await reservePort();
      const second = startMcp(home, secondPort);
      const secondOut = await waitFor(second.output, /Control token file:/, second.child);
      expect(secondOut).not.toMatch(/Control token: /);
      await stop(second.child);

      const childHome = mkdtempSync(path.join(tmpdir(), "sf-reveal-child-"));
      const childPort = await reservePort();
      const service = startMcp(childHome, childPort, { SF_SERVICE_CHILD: "1" });
      const serviceOut = await waitFor(service.output, /Control token file:/, service.child);
      expect(serviceOut).not.toMatch(/Control token: /);
      await stop(service.child);
      rmSync(childHome, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
