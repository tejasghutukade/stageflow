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
          import { configurePiProviderApiKey, createHostedRuntime, createPiStagePort, HostedRuntimeError } from "stageflow";
          if (typeof createHostedRuntime !== "function") process.exit(1);
          if (typeof HostedRuntimeError !== "function") process.exit(2);
          if (typeof createPiStagePort !== "function") process.exit(3);
          if (typeof configurePiProviderApiKey !== "function") process.exit(4);
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
