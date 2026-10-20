import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctorChecks } from "../src/cli/doctorCommand.js";
import { probeGuard } from "../src/evals/engine/promptfoo/guard.js";
import { installPromptfoo, type RunNpm } from "../src/evals/engine/promptfoo/install.js";
import {
  engineBinPath,
  engineDir,
  engineRoot,
  locatePromptfoo,
} from "../src/evals/engine/promptfoo/locate.js";
import { assertNode, checkNode } from "../src/evals/engine/promptfoo/nodeVersion.js";
import {
  ENGINE_MARKER_FILE,
  MIN_NODE,
  PINNED_PROMPTFOO_VERSION,
} from "../src/evals/engine/promptfoo/pinned.js";
import { engineStatus } from "../src/evals/engine/promptfoo/status.js";

const temps: string[] = [];
const servers: Server[] = [];

function tempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-engine-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeFakeInstall(
  home: string,
  opts: { marker?: boolean; version?: string; bin?: boolean; markerVersion?: string } = {},
): string {
  const dir = engineDir(home);
  mkdirSync(path.join(dir, "node_modules", "promptfoo"), { recursive: true });
  mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(
    path.join(dir, "node_modules", "promptfoo", "package.json"),
    JSON.stringify({ name: "promptfoo", version: opts.version ?? PINNED_PROMPTFOO_VERSION }),
  );
  if (opts.bin !== false) writeFileSync(engineBinPath(dir), "#!/bin/sh\n");
  if (opts.marker !== false) {
    writeFileSync(
      path.join(dir, ENGINE_MARKER_FILE),
      JSON.stringify({
        version: opts.markerVersion ?? PINNED_PROMPTFOO_VERSION,
        node: "22.22.0",
        installedAt: "2026-10-20T00:00:00.000Z",
        integrity: null,
      }),
    );
  }
  return dir;
}

describe("checkNode", () => {
  it("accepts the minimum and above", () => {
    expect(checkNode("22.22.0").ok).toBe(true);
    expect(checkNode("22.22.1").ok).toBe(true);
    expect(checkNode("24.0.0").ok).toBe(true);
  });

  it("rejects below the minimum", () => {
    expect(checkNode("22.21.9").ok).toBe(false);
    expect(checkNode("20.18.0").ok).toBe(false);
    expect(checkNode("garbage").ok).toBe(false);
  });

  it("honors an explicit minimum", () => {
    expect(checkNode("23.0.0", "24.0.0")).toEqual({ ok: false, found: "23.0.0", required: "24.0.0" });
  });

  it("assertNode names found and required versions", () => {
    expect(() => assertNode("20.1.0")).toThrow(/20\.1\.0/);
    try {
      assertNode("20.1.0");
    } catch (err) {
      expect((err as { code: string }).code).toBe("EVAL_NODE_TOO_OLD");
      expect((err as Error).message).toContain(MIN_NODE);
    }
  });
});

describe("locatePromptfoo", () => {
  it("is not installed with no directory", () => {
    const res = locatePromptfoo({ home: tempHome() });
    expect(res.installed).toBe(false);
    if (!res.installed) expect(res.reason).toContain("sf eval engine install");
  });

  it("is not installed without a marker", () => {
    const home = tempHome();
    writeFakeInstall(home, { marker: false });
    expect(locatePromptfoo({ home }).installed).toBe(false);
  });

  it("is not installed when the package version is wrong", () => {
    const home = tempHome();
    writeFakeInstall(home, { version: "0.1.0" });
    const res = locatePromptfoo({ home });
    expect(res.installed).toBe(false);
    if (!res.installed) expect(res.reason).toContain("0.1.0");
  });

  it("is not installed when the marker version is wrong", () => {
    const home = tempHome();
    writeFakeInstall(home, { markerVersion: "0.2.0" });
    expect(locatePromptfoo({ home }).installed).toBe(false);
  });

  it("is not installed when only another version exists", () => {
    const home = tempHome();
    const other = path.join(engineRoot(home), "0.1.0");
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, ENGINE_MARKER_FILE), "{}");
    const res = locatePromptfoo({ home });
    expect(res.installed).toBe(false);
    if (!res.installed) {
      expect(res.reason).toContain("0.1.0");
      expect(res.reason).toContain(PINNED_PROMPTFOO_VERSION);
    }
  });

  it("is not installed when the binary is missing", () => {
    const home = tempHome();
    writeFakeInstall(home, { bin: false });
    expect(locatePromptfoo({ home }).installed).toBe(false);
  });

  it("finds a valid layout", () => {
    const home = tempHome();
    const dir = writeFakeInstall(home);
    expect(locatePromptfoo({ home })).toEqual({
      installed: true,
      version: PINNED_PROMPTFOO_VERSION,
      dir,
      binPath: engineBinPath(dir),
    });
  });
});

describe("installPromptfoo", () => {
  const okNpm: RunNpm = async (args, { cwd, log }) => {
    expect(args).toEqual([
      "install",
      "--no-audit",
      "--no-fund",
      `promptfoo@${PINNED_PROMPTFOO_VERSION}`,
    ]);
    log("added 629 packages");
    mkdirSync(path.join(cwd, "node_modules", "promptfoo"), { recursive: true });
    mkdirSync(path.join(cwd, "node_modules", ".bin"), { recursive: true });
    writeFileSync(
      path.join(cwd, "node_modules", "promptfoo", "package.json"),
      JSON.stringify({ version: PINNED_PROMPTFOO_VERSION }),
    );
    writeFileSync(engineBinPath(cwd), "");
    return { code: 0 };
  };

  it("writes the marker and is a no-op the second time", async () => {
    const home = tempHome();
    const lines: string[] = [];
    const first = await installPromptfoo({ home, runNpm: okNpm, log: (l) => lines.push(l) });
    expect(first.status).toBe("installed");
    expect(lines).toContain("added 629 packages");
    const marker = JSON.parse(readFileSync(path.join(first.dir, ENGINE_MARKER_FILE), "utf8"));
    expect(marker.version).toBe(PINNED_PROMPTFOO_VERSION);
    expect(locatePromptfoo({ home }).installed).toBe(true);

    let calls = 0;
    const second = await installPromptfoo({
      home,
      runNpm: async () => {
        calls += 1;
        return { code: 0 };
      },
    });
    expect(second.status).toBe("already_installed");
    expect(calls).toBe(0);
  });

  it("leaves nothing behind when npm fails", async () => {
    const home = tempHome();
    await expect(
      installPromptfoo({ home, runNpm: async () => ({ code: 1 }) }),
    ).rejects.toMatchObject({ code: "EVAL_ENGINE_UNAVAILABLE" });
    expect(existsSync(engineRoot(home))).toBe(false);
  });

  it("leaves nothing behind when the install does not verify", async () => {
    const home = tempHome();
    await expect(
      installPromptfoo({ home, runNpm: async () => ({ code: 0 }) }),
    ).rejects.toMatchObject({ code: "EVAL_ENGINE_UNAVAILABLE" });
    expect(existsSync(engineDir(home))).toBe(false);
  });
});

describe("guard", () => {
  it("blocks promptfoo hosts and leaves others alone", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;

    expect((await probeGuard("fetch", "https://r.promptfoo.app/x")).blocked).toBe(true);
    expect((await probeGuard("https", "https://a.promptfoo.app/x")).blocked).toBe(true);
    expect((await probeGuard("https", "https://api.promptfoo.dev/x")).blocked).toBe(true);
    expect((await probeGuard("http", "http://promptfoo.dev/x")).blocked).toBe(true);

    expect(await probeGuard("fetch", local)).toMatchObject({ blocked: false, status: 200 });
    expect(await probeGuard("http", local)).toMatchObject({ blocked: false, status: 200 });
  }, 60_000);
});

describe("engineStatus", () => {
  it("reports not installed", () => {
    const home = tempHome();
    expect(engineStatus({ home, nodeVersion: "22.22.0" })).toEqual({
      installed: false,
      version: null,
      pinned: PINNED_PROMPTFOO_VERSION,
      node: "22.22.0",
      nodeOk: true,
      path: null,
      installCommand: "sf eval engine install",
    });
  });

  it("reports installed and old node", () => {
    const home = tempHome();
    const dir = writeFakeInstall(home);
    const status = engineStatus({ home, nodeVersion: "20.0.0" });
    expect(status).toMatchObject({
      installed: true,
      version: PINNED_PROMPTFOO_VERSION,
      nodeOk: false,
      path: dir,
    });
  });
});

describe("sf doctor eval engine line", () => {
  it("is informational when not installed", async () => {
    const home = tempHome();
    const result = await runDoctorChecks({ homeDir: home, cwd: home });
    const check = result.checks.find((c) => c.id === "eval_engine");
    expect(check?.status).toBe("skipped");
    expect(check?.message).toContain("sf eval engine install");
  });

  it("passes when installed", async () => {
    const home = tempHome();
    writeFakeInstall(home);
    const result = await runDoctorChecks({ homeDir: home, cwd: home });
    expect(result.checks.find((c) => c.id === "eval_engine")?.status).toBe("pass");
  });
});

describe("Dockerfile", () => {
  it("pins the same promptfoo version", () => {
    const docker = readFileSync(path.resolve(__dirname, "..", "Dockerfile"), "utf8");
    expect(docker).toContain(`ARG PROMPTFOO_VERSION=${PINNED_PROMPTFOO_VERSION}`);
  });
});
