import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureGlobalService,
  type ServiceProbeResult,
} from "../src/server/ensureGlobalService.js";
import { globalStageflowHome } from "../src/project/globalHome.js";
import { DEFAULT_PORT } from "../src/server/createHttpHost.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliEntry = path.join(repoRoot, "src", "cli.ts");

describe("ensureGlobalService", () => {
  it("no-ops without spawning when the service is already up", async () => {
    let spawnCalls = 0;
    const result = await ensureGlobalService({
      probeHost: async () => "up",
      spawnFn: (() => {
        spawnCalls += 1;
        throw new Error("should not spawn");
      }) as unknown as typeof spawn,
    });

    expect(result).toEqual({ ok: true, alreadyRunning: true });
    expect(spawnCalls).toBe(0);
  });

  it("fails fast with port_occupied when something unhealthy already holds the port, without spawning", async () => {
    let spawnCalls = 0;
    const result = await ensureGlobalService({
      probeHost: async () => "unhealthy",
      spawnFn: (() => {
        spawnCalls += 1;
        throw new Error("should not spawn");
      }) as unknown as typeof spawn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("port_occupied");
      expect(result.message).toContain(String(DEFAULT_PORT));
    }
    expect(spawnCalls).toBe(0);
  });

  it("spawns detached and reports success once the service becomes healthy", async () => {
    await withIsolatedHome(async () => {
      const probeResults: ServiceProbeResult[] = ["unreachable", "unreachable", "up"];
      let probeIndex = 0;
      const spawnCalls: Array<{ command: string; args: string[] }> = [];

      const fakeSpawn = ((command: string, args: string[]) => {
        spawnCalls.push({ command, args });
        return { unref: () => undefined } as unknown as ReturnType<typeof spawn>;
      }) as unknown as typeof spawn;

      const result = await ensureGlobalService({
        cliEntry,
        probeHost: async () => probeResults[Math.min(probeIndex++, probeResults.length - 1)],
        spawnFn: fakeSpawn,
        pollIntervalMs: 1,
        timeoutMs: 1000,
      });

      expect(result).toEqual({ ok: true, alreadyRunning: false });
      expect(spawnCalls).toHaveLength(1);
      // cliEntry is raw TS source here, so ensureGlobalService routes it
      // through the same tsx loader `npm run dev` uses.
      expect(spawnCalls[0]?.args).toEqual([
        fileURLToPath(import.meta.resolve("tsx/cli")),
        cliEntry,
        "mcp",
        "--port",
        String(DEFAULT_PORT),
      ]);

      const logContent = await readFile(
        path.join(globalStageflowHome(), "service.log"),
        "utf8",
      ).catch(() => "");
      expect(logContent).toBe("");
    });
  });

  it("reports spawn_failed when the spawn call itself throws", async () => {
    await withIsolatedHome(async () => {
      const result = await ensureGlobalService({
        cliEntry,
        probeHost: async () => "unreachable",
        spawnFn: (() => {
          throw new Error("boom");
        }) as unknown as typeof spawn,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("spawn_failed");
        expect(result.message).toContain("boom");
      }
    });
  });

  it("reports timed_out when the service never becomes healthy after spawning", async () => {
    await withIsolatedHome(async () => {
      const result = await ensureGlobalService({
        cliEntry,
        probeHost: async () => "unreachable",
        spawnFn: (() => ({ unref: () => undefined })) as unknown as typeof spawn,
        pollIntervalMs: 1,
        timeoutMs: 20,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("timed_out");
      }
    });
  });
});

describe("ensureGlobalService integration", () => {
  let spawnedPid: number | undefined;

  afterEach(() => {
    if (spawnedPid !== undefined) {
      try {
        process.kill(spawnedPid);
      } catch {
        // already exited
      }
      spawnedPid = undefined;
    }
  });

  it.skipIf(!process.env.STAGEFLOW_TEST_INTEGRATION)(
    "really spawns `tsx src/cli.ts mcp` and observes it become healthy against an isolated HOME",
    async () => {
      await withIsolatedHome(async () => {
        const result = await ensureGlobalService({
          cliEntry,
          // ensureGlobalService already resolves cliEntry (raw TS) through
          // the tsx loader itself (see resolveSpawnArgs); args here already
          // starts with the tsx CLI path, so just run it directly.
          spawnFn: ((command, args, options) => {
            const child = spawn(command, args, {
              ...(options as object),
            });
            spawnedPid = child.pid;
            return child;
          }) as unknown as typeof spawn,
          timeoutMs: 20_000,
        });

        expect(result).toEqual({ ok: true, alreadyRunning: false });

        const health = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/health`);
        expect(health.status).toBe(200);
      });
    },
    30_000,
  );
});
