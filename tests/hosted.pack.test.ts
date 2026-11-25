import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("packed stageflow package", () => {
  it(
    "imports the hosted runtime from the package root",
    async () => {
      const repoRoot = path.resolve(import.meta.dirname, "..");
      await execFileAsync("npm", ["run", "build"], { cwd: repoRoot });
      const packDir = await mkdtemp(path.join(tmpdir(), "sf-pack-"));
      try {
        const { stdout } = await execFileAsync(
          "npm",
          ["pack", "--json", "--pack-destination", packDir],
          { cwd: repoRoot },
        );
        const packed = JSON.parse(stdout) as Array<{ filename: string }>;
        const tarball = path.join(packDir, packed[0]?.filename ?? "");
        const consumer = path.join(packDir, "consumer");
        await mkdir(consumer);
        await writeFile(
          path.join(consumer, "package.json"),
          JSON.stringify({ name: "hosted-consumer", private: true, type: "module" }),
        );
        await execFileAsync("npm", ["install", tarball], { cwd: consumer });
        const script = `
          import { readFileSync } from "node:fs";
          import path from "node:path";
          import { pathToFileURL, fileURLToPath } from "node:url";
          import { configurePiProviderApiKey, createHostedRuntime, createPiStagePort, HostedRuntimeError } from "stageflow";
          if (typeof createHostedRuntime !== "function") process.exit(1);
          if (typeof HostedRuntimeError !== "function") process.exit(2);
          if (typeof createPiStagePort !== "function") process.exit(3);
          if (typeof configurePiProviderApiKey !== "function") process.exit(4);
          const root = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("stageflow"))), "..");
          const file = path.join(root, "dist/sandbox-libs/chartjs@4.6.2/chart.umd.min.js");
          const bytes = readFileSync(file);
          if (bytes.length < 1000) process.exit(5);
          const { startSandboxListener } = await import(pathToFileURL(path.join(root, "dist/server/sandboxListener.js")).href);
          const listener = await startSandboxListener({
            consoleOrigins: ["http://127.0.0.1:9"],
            hostPort: 47000,
            listenHost: "127.0.0.1",
            env: {},
          });
          if (!listener.origin) process.exit(6);
          const response = await fetch(listener.origin + "/libs/chartjs@4.6.2/chart.umd.min.js");
          const served = Buffer.from(await response.arrayBuffer());
          await listener.close();
          if (response.status !== 200 || response.headers.get("access-control-allow-origin") !== "*") process.exit(7);
          if (!served.equals(bytes)) process.exit(8);
        `;
        await execFileAsync("node", ["--input-type=module", "-e", script], {
          cwd: consumer,
        });
      } finally {
        await rm(packDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
