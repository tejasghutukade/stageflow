import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureGlobalService,
  hostBaseUrl,
  isNoAutostartEnabled,
  STAGEFLOW_NO_AUTOSTART,
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

describe("isNoAutostartEnabled", () => {
  it("is truthy when set and not empty/0/false (case-insensitive)", () => {
    expect(isNoAutostartEnabled({})).toBe(false);
    expect(isNoAutostartEnabled({ [STAGEFLOW_NO_AUTOSTART]: undefined })).toBe(
      false,
    );
    expect(isNoAutostartEnabled({ [STAGEFLOW_NO_AUTOSTART]: "" })).toBe(false);
    expect(isNoAutostartEnabled({ [STAGEFLOW_NO_AUTOSTART]: "   " })).toBe(
      false,
    );
    expect(isNoAutostartEnabled({ [STAGEFLOW_NO_AUTOSTART]: "0" })).toBe(false);
    expect(isNoAutostartEnabled({ [STAGEFLOW_NO_AUTOSTART]: "false" })).toBe(
      false,
    );
    expect(isNoAutostartEnabled({ [STAGEFLOW_NO_AUTOSTART]: "FALSE" })).toBe(
      false,
    );
    expect(isNoAutostartEnabled({ [STAGEFLOW_NO_AUTOSTART]: "False" })).toBe(
      false,
    );
    expect(isNoAutostartEnabled({ [STAGEFLOW_NO_AUTOSTART]: "1" })).toBe(true);
    expect(isNoAutostartEnabled({ [STAGEFLOW_NO_AUTOSTART]: "true" })).toBe(
      true,
    );
    expect(isNoAutostartEnabled({ [STAGEFLOW_NO_AUTOSTART]: "yes" })).toBe(true);
  });
});

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

  it("with STAGEFLOW_NO_AUTOSTART and no host: returns autostart_disabled without spawning or creating service.log", async () => {
    await withIsolatedHome(async () => {
      let spawnCalls = 0;
      const result = await ensureGlobalService({
        cliEntry,
        probeHost: async () => "unreachable",
        spawnFn: (() => {
          spawnCalls += 1;
          throw new Error("should not spawn");
        }) as unknown as typeof spawn,
        env: { [STAGEFLOW_NO_AUTOSTART]: "1" },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("autostart_disabled");
        expect(result.message).toContain(hostBaseUrl());
        expect(result.message).toMatch(/sf mcp/);
        expect(result.message.toLowerCase()).not.toMatch(/unset/);
      }
      expect(spawnCalls).toBe(0);
      expect(
        existsSync(path.join(globalStageflowHome(), "service.log")),
      ).toBe(false);
    });
  });

  it("still no-ops when already up even with STAGEFLOW_NO_AUTOSTART set", async () => {
    let spawnCalls = 0;
    const result = await ensureGlobalService({
      probeHost: async () => "up",
      spawnFn: (() => {
        spawnCalls += 1;
        throw new Error("should not spawn");
      }) as unknown as typeof spawn,
      env: { [STAGEFLOW_NO_AUTOSTART]: "1" },
    });
    expect(result).toEqual({ ok: true, alreadyRunning: true });
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

  it("fails with bind_refused before spawn when STAGEFLOW_BIND is non-loopback without a drive token", async () => {
    await withIsolatedHome(async () => {
      let spawnCalls = 0;
      const result = await ensureGlobalService({
        cliEntry,
        probeHost: async () => "unreachable",
        spawnFn: (() => {
          spawnCalls += 1;
          throw new Error("should not spawn");
        }) as unknown as typeof spawn,
        env: { STAGEFLOW_BIND: "0.0.0.0" },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("bind_refused");
        expect(result.message).toMatch(/Refusing to start/);
        expect(result.message).toContain("0.0.0.0");
      }
      expect(spawnCalls).toBe(0);
    });
  });

  it("still spawns when STAGEFLOW_BIND is non-loopback and drive token is set", async () => {
    await withIsolatedHome(async () => {
      const probeResults: ServiceProbeResult[] = ["unreachable", "up"];
      let probeIndex = 0;
      let spawnCalls = 0;
      const result = await ensureGlobalService({
        cliEntry,
        probeHost: async () =>
          probeResults[Math.min(probeIndex++, probeResults.length - 1)]!,
        spawnFn: (() => {
          spawnCalls += 1;
          return { unref: () => undefined } as unknown as ReturnType<typeof spawn>;
        }) as unknown as typeof spawn,
        pollIntervalMs: 1,
        timeoutMs: 1000,
        env: {
          STAGEFLOW_BIND: "0.0.0.0",
          STAGEFLOW_CONTROL_TOKEN: "d".repeat(32),
        },
      });

      expect(result).toEqual({ ok: true, alreadyRunning: false });
      expect(spawnCalls).toBe(1);
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

        const health = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/livez`);
        expect(health.status).toBe(200);
      });
    },
    30_000,
  );
});
