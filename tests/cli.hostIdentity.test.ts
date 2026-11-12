import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, setOpenBrowserForTests } from "../src/cli.js";
import { stageflowHomeId } from "../src/diagnostics/checks.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { probeStageflowHost } from "../src/server/ensureGlobalService.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const children: ChildProcess[] = [];

function reservePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = (port: number) => {
      if (port > 4199) {
        reject(new Error("no free port in 4100-4199"));
        return;
      }
      const server = createNetServer();
      server.once("error", () => probe(port + 1));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(port));
      });
    };
    probe(start);
  });
}

function useHome(home: string): void {
  process.env.STAGEFLOW_HOME = home;
  delete process.env.STAGEFLOW_CONTROL_TOKEN;
  delete process.env.STAGEFLOW_CONTROL_TOKEN_FILE;
  resetGlobalStageflowHomeForTests();
}

afterEach(() => {
  setOpenBrowserForTests(undefined);
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
  resetGlobalStageflowHomeForTests();
});

describe("host identity probe", () => {
  it("treats a non-Stageflow /livez as foreign and exits 1", async () => {
    const port = await reservePort(4150);
    const stub = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => stub.listen(port, "127.0.0.1", () => resolve()));
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    setOpenBrowserForTests(() => {
      throw new Error("should not open");
    });
    try {
      expect(await probeStageflowHost(`http://127.0.0.1:${port}`)).toBe("foreign");
      const code = await main(["node", "sf", "ui", "--port", String(port)]);
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain(
        `Port ${port} is in use by another program. Use --port.`,
      );
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        stub.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("names an older Stageflow Host (no service field) and exits 1", async () => {
    const port = await reservePort(4155);
    const stub = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "live" }));
    });
    await new Promise<void>((resolve) => stub.listen(port, "127.0.0.1", () => resolve()));
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    setOpenBrowserForTests(() => {
      throw new Error("should not open");
    });
    try {
      expect(await probeStageflowHost(`http://127.0.0.1:${port}`)).toBe("old_stageflow");
      const code = await main(["node", "sf", "ui", "--port", String(port)]);
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain(`An older Stageflow Host is running on port ${port}`);
    } finally {
      spy.mockRestore();
      setOpenBrowserForTests(undefined);
      await new Promise<void>((resolve, reject) => {
        stub.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("distinguishes another data directory from this one, and /livez hides the path", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-home-a-"));
    const other = mkdtempSync(path.join(tmpdir(), "sf-home-b-"));
    const port = await reservePort(4160);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      STAGEFLOW_HOME: home,
      STAGEFLOW_NO_AUTOSTART: "1",
    };
    delete env.STAGEFLOW_CONTROL_TOKEN;
    delete env.STAGEFLOW_CONTROL_TOKEN_FILE;
    const child = spawn(process.execPath, [tsxCli, cli, "mcp", "--port", String(port)], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const deadline = Date.now() + 25_000;
    let live = "";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/livez`);
        live = await res.text();
        if (res.status === 200 && live.includes("stageflow")) break;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(live).toContain('"service":"stageflow"');
    expect(live).not.toContain(home);
    expect(live).not.toContain(other);

    useHome(other);
    expect(
      await probeStageflowHost(`http://127.0.0.1:${port}`, {
        expectedHomeId: stageflowHomeId(),
      }),
    ).toBe("other_home");
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    setOpenBrowserForTests(() => {
      throw new Error("should not open");
    });
    try {
      const code = await main(["node", "sf", "ui", "--port", String(port), "--no-open"]);
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain(
        `Another Stageflow Host with a different data directory is on port ${port}. Stop it or use --port.`,
      );
    } finally {
      spy.mockRestore();
    }

    useHome(home);
    expect(
      await probeStageflowHost(`http://127.0.0.1:${port}`, {
        expectedHomeId: stageflowHomeId(),
      }),
    ).toBe("up");
    setOpenBrowserForTests(() => undefined);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      expect(await main(["node", "sf", "ui", "--port", String(port), "--no-open"])).toBe(0);
      expect(logs.join("\n")).toContain("Stageflow is already running");
    } finally {
      logSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  }, 40_000);
});
