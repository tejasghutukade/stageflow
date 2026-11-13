import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireHostLock,
  HOST_LOCK_FILENAME,
  HostLockError,
  resetHostLocksForTests,
} from "../src/server/hostLock.js";
import { freePort } from "./helpers/freePort.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

const homes: string[] = [];
const children: ChildProcess[] = [];

function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-host-lock-"));
  homes.push(dir);
  return dir;
}

function writeLock(dir: string, body: Record<string, unknown>): void {
  writeFileSync(path.join(dir, HOST_LOCK_FILENAME), JSON.stringify(body), { mode: 0o600 });
}

afterEach(() => {
  resetHostLocksForTests();
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("host lock", () => {
  it("writes pid and URL, refuses while another live Host holds it, and is removed on release", async () => {
    const dir = home();
    const lock = await acquireHostLock(dir);
    lock.setUrl("http://127.0.0.1:4999");
    const body = JSON.parse(readFileSync(path.join(dir, HOST_LOCK_FILENAME), "utf8"));
    expect(body).toMatchObject({ pid: process.pid, url: "http://127.0.0.1:4999", hostname: os.hostname() });
    lock.release();
    expect(existsSync(path.join(dir, HOST_LOCK_FILENAME))).toBe(false);

    // A live process on this machine that still answers at its URL holds the lock.
    writeLock(dir, { pid: process.ppid, hostname: os.hostname(), startedAt: new Date().toISOString(), url: "http://127.0.0.1:4998" });
    const refused = acquireHostLock(dir, { probe: async () => true });
    await expect(refused).rejects.toBeInstanceOf(HostLockError);
    await expect(acquireHostLock(dir, { probe: async () => true })).rejects.toThrow(
      /Another Stageflow Host is using this data directory \(pid \d+, http:\/\/127\.0\.0\.1:4998\)/,
    );
  });

  it("replaces a stale lock: dead pid, a URL that no longer answers, or a boot that never finished", async () => {
    const dir = home();
    writeLock(dir, { pid: 2 ** 22 - 1, hostname: os.hostname(), startedAt: new Date().toISOString() });
    (await acquireHostLock(dir)).release();

    writeLock(dir, { pid: process.ppid, hostname: os.hostname(), startedAt: new Date().toISOString(), url: "http://127.0.0.1:1" });
    (await acquireHostLock(dir, { probe: async () => false })).release();

    writeLock(dir, { pid: process.ppid, hostname: os.hostname(), startedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    (await acquireHostLock(dir)).release();

    writeLock(dir, { pid: process.ppid, hostname: os.hostname(), startedAt: new Date().toISOString() });
    await expect(acquireHostLock(dir)).rejects.toBeInstanceOf(HostLockError);

    writeFileSync(path.join(dir, HOST_LOCK_FILENAME), "not json");
    (await acquireHostLock(dir)).release();
  });

  it("treats a lock from another hostname as live only while its URL answers", async () => {
    const dir = home();
    writeLock(dir, { pid: 1, hostname: "other-container", startedAt: new Date().toISOString(), url: "http://10.0.0.9:3847" });
    await expect(acquireHostLock(dir, { probe: async () => true })).rejects.toBeInstanceOf(HostLockError);
    (await acquireHostLock(dir, { probe: async () => false })).release();
  });

  it("is shared by Hosts in one process and removed when the last one releases", async () => {
    const dir = home();
    const first = await acquireHostLock(dir);
    const second = await acquireHostLock(dir);
    first.release();
    expect(existsSync(path.join(dir, HOST_LOCK_FILENAME))).toBe(true);
    second.release();
    expect(existsSync(path.join(dir, HOST_LOCK_FILENAME))).toBe(false);
  });
});

async function startHost(dir: string, port: number, command = "mcp") {
  const env: NodeJS.ProcessEnv = { ...process.env, STAGEFLOW_HOME: dir, STAGEFLOW_NO_AUTOSTART: "1" };
  delete env.STAGEFLOW_CONTROL_TOKEN;
  delete env.STAGEFLOW_CONTROL_TOKEN_FILE;
  delete env.SF_SERVICE_CHILD;
  const child = spawn(process.execPath, [tsxCli, cli, command, "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (out += chunk));
  child.stderr?.on("data", (chunk: string) => (out += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, output: () => out, exited };
}

async function waitLive(port: number, child: ChildProcess): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (child.exitCode !== null) throw new Error(`host exited ${child.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/livez`)).status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("host did not start");
}

describe("one Host per data directory", () => {
  it("refuses a second Host on another port, without touching the first Host's runs", async () => {
    const dir = home();
    const firstPort = await freePort();
    const first = await startHost(dir, firstPort);
    await waitLive(firstPort, first.child);
    const lockBody = JSON.parse(readFileSync(path.join(dir, HOST_LOCK_FILENAME), "utf8"));
    expect(lockBody.url).toBe(`http://127.0.0.1:${firstPort}`);

    const secondPort = await freePort();
    const second = await startHost(dir, secondPort);
    const code = await second.exited;
    expect(code).not.toBe(0);
    expect(second.output()).toContain("Another Stageflow Host is using this data directory");
    expect(second.output()).toContain(`http://127.0.0.1:${firstPort}`);
    expect((await fetch(`http://127.0.0.1:${firstPort}/livez`)).status).toBe(200);

    first.child.kill("SIGTERM");
    await first.exited;
    expect(existsSync(path.join(dir, HOST_LOCK_FILENAME))).toBe(false);
  }, 60_000);

  it("does not apply a pending restore when another Host holds the data directory", async () => {
    const dir = home();
    const firstPort = await freePort();
    const first = await startHost(dir, firstPort);
    await waitLive(firstPort, first.child);

    const pending = path.join(dir, "restore-pending");
    mkdirSync(pending, { recursive: true });
    writeFileSync(path.join(pending, "marker"), "x");
    const before = readFileSync(path.join(dir, "state.db")).length;

    const second = await startHost(dir, await freePort());
    expect(await second.exited).not.toBe(0);
    expect(existsSync(path.join(pending, "marker"))).toBe(true);
    expect(readFileSync(path.join(dir, "state.db")).length).toBe(before);
    expect((await fetch(`http://127.0.0.1:${firstPort}/livez`)).status).toBe(200);
  }, 60_000);
});
