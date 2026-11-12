import { createServer } from "node:net";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { main, setOpenBrowserForTests } from "../src/cli.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startMcpServer } from "../src/server/mcpHost.js";

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = (port: number) => {
      if (port > 4199) {
        reject(new Error("no free port in 4100-4199"));
        return;
      }
      const server = createServer();
      server.once("error", () => probe(port + 1));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(port));
      });
    };
    probe(4140);
  });
}

describe("sf ui when a Host is already running", () => {
  const prevHome = process.env.STAGEFLOW_HOME;
  const prevToken = process.env.STAGEFLOW_CONTROL_TOKEN;
  const prevFile = process.env.STAGEFLOW_CONTROL_TOKEN_FILE;

  afterEach(() => {
    setOpenBrowserForTests(undefined);
    if (prevHome === undefined) delete process.env.STAGEFLOW_HOME;
    else process.env.STAGEFLOW_HOME = prevHome;
    if (prevToken === undefined) delete process.env.STAGEFLOW_CONTROL_TOKEN;
    else process.env.STAGEFLOW_CONTROL_TOKEN = prevToken;
    if (prevFile === undefined) delete process.env.STAGEFLOW_CONTROL_TOKEN_FILE;
    else process.env.STAGEFLOW_CONTROL_TOKEN_FILE = prevFile;
  });

  it("opens the console with the file token and does not rewrite the file", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-ui-already-"));
    const token = "cd".repeat(32);
    const tokenFile = path.join(home, "control-token");
    writeFileSync(tokenFile, `${token}\n`, "utf8");
    chmodSync(tokenFile, 0o600);
    const before = statSync(tokenFile);
    process.env.STAGEFLOW_HOME = home;
    delete process.env.STAGEFLOW_CONTROL_TOKEN;
    delete process.env.STAGEFLOW_CONTROL_TOKEN_FILE;
    const port = await reservePort();
    const store = createRunStore({ rootDir: home });
    const started = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: home,
      rootDir: home,
      store,
      port,
      mcpStateless: true,
      controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: token }),
    });
    const opened: string[] = [];
    setOpenBrowserForTests((url) => {
      opened.push(url);
    });
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const code = await main(["node", "sf", "ui", "--port", String(port)]);
      expect(code).toBe(0);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#code=[0-9a-f]{32}$`));
      expect(opened[0]).not.toContain(token);
      expect(logs.join("\n")).toContain(`Control token file: ${tokenFile}`);
      const after = statSync(tokenFile);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.size).toBe(before.size);

      opened.length = 0;
      const quiet = await main(["node", "sf", "ui", "--port", String(port), "--no-open"]);
      expect(quiet).toBe(0);
      expect(opened).toEqual([]);
      expect(statSync(tokenFile).mtimeMs).toBe(before.mtimeMs);
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
      await store.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
