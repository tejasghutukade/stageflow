import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const cliEntry = path.join(repoRoot, "src", "cli.ts");

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected TCP address"));
        return;
      }
      const port = address.port;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealthy(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.status === 200) {
        await res.text();
        return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`sf mcp did not become healthy on port ${port} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export type TestGlobalService = {
  port: number;
  baseUrl: string;
  env: NodeJS.ProcessEnv;
  stop: () => Promise<void>;
};

/**
 * Spawns a REAL `sf mcp` process on an isolated ephemeral port, as its own
 * OS process (not in-process). This is deliberate: tests that also invoke
 * `sf run`/`sf runs *` via `spawnSync` (a blocking call) would deadlock
 * against an in-process test server, since `spawnSync` freezes this
 * process's event loop — including whatever's serving the HTTP request the
 * spawned CLI is waiting on — until the child exits. A genuinely separate
 * process sidesteps that entirely.
 */
export async function spawnTestGlobalService(options: {
  cwd: string;
  home: string;
}): Promise<TestGlobalService> {
  const port = await getFreePort();
  const tsxCliPath = fileURLToPath(import.meta.resolve("tsx/cli"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: options.home,
  };
  const child: ChildProcess = spawn(
    process.execPath,
    [tsxCliPath, cliEntry, "mcp", "--port", String(port)],
    { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stderrChunks: Buffer[] = [];
  child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));

  try {
    await waitForHealthy(port, 20_000);
  } catch (err) {
    child.kill();
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}${stderr ? `\nstderr: ${stderr}` : ""}`,
    );
  }

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    env: { ...env, STAGEFLOW_SERVICE_PORT: String(port) },
    stop: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}
