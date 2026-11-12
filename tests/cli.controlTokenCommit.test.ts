import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

describe("control token save failure", () => {
  it("keeps serving when the token file cannot be written", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-token-dir-"));
    mkdirSync(path.join(home, "control-token"));
    const port = await reservePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      STAGEFLOW_HOME: home,
      STAGEFLOW_NO_AUTOSTART: "1",
    };
    delete env.STAGEFLOW_CONTROL_TOKEN;
    delete env.STAGEFLOW_CONTROL_TOKEN_FILE;
    delete env.SF_SERVICE_CHILD;
    const child = spawn(process.execPath, [tsxCli, cli, "mcp", "--port", String(port)], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      out += chunk;
    });
    const started = Date.now();
    let live = 0;
    while (Date.now() - started < 20_000) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/livez`);
        // A booting Host answers 200 "starting"; the token is saved (or the warning printed) only after that.
        live = (await res.text()).includes('"starting"') ? 0 : res.status;
        if (live === 200) break;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(live).toBe(200);
    expect(out).toContain("Could not save the control token");
    const match = /Control token: ([0-9a-f]{64})/.exec(out);
    expect(match).not.toBeNull();
    const authed = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      headers: { Authorization: `Bearer ${match![1]}` },
    });
    expect(authed.status).toBe(200);
    expect(out.split(`Control token: ${match![1]}`).length - 1).toBe(1);
    expect(out).not.toContain("Control token file:");
    rmSync(home, { recursive: true, force: true });
  }, 30_000);

  it("does not print the token from the service child when the file cannot be written", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-token-dir-child-"));
    mkdirSync(path.join(home, "control-token"));
    const port = await reservePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      STAGEFLOW_HOME: home,
      STAGEFLOW_NO_AUTOSTART: "1",
      SF_SERVICE_CHILD: "1",
    };
    delete env.STAGEFLOW_CONTROL_TOKEN;
    delete env.STAGEFLOW_CONTROL_TOKEN_FILE;
    const child = spawn(process.execPath, [tsxCli, cli, "mcp", "--port", String(port)], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      out += chunk;
    });
    const started = Date.now();
    let live = 0;
    while (Date.now() - started < 20_000) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/livez`);
        // A booting Host answers 200 "starting"; the token is saved (or the warning printed) only after that.
        live = (await res.text()).includes('"starting"') ? 0 : res.status;
        if (live === 200) break;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(live).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(out).toContain("Other sf commands cannot authenticate");
    expect(out).not.toMatch(/[0-9a-f]{64}/);
    rmSync(home, { recursive: true, force: true });
  }, 30_000);
});
