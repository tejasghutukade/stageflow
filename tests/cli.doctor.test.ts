import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctorChecks } from "../src/cli/doctorCommand.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      /* ignore */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("runDoctorChecks", () => {
  it("--json shape includes ok and checks with status", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-doctor-ok-"));
    temps.push(home);
    const store = createRunStore({ rootDir: home, openerMode: "migrate" });
    try {
      const result = await runDoctorChecks({
        cwd: home,
        homeDir: home,
        store,
        env: {},
      });
      expect(result).toEqual(
        expect.objectContaining({
          ok: expect.any(Boolean),
          checks: expect.any(Array),
        }),
      );
      expect(result.checks.length).toBeGreaterThan(0);
      for (const check of result.checks) {
        expect(check).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            status: expect.stringMatching(/^(pass|warn|fail|skipped)$/),
            message: expect.any(String),
          }),
        );
      }
      expect(result.checks.some((c) => c.id === "store_openable")).toBe(true);
      expect(result.checks.some((c) => c.id === "git")).toBe(true);
      expect(result.checks.some((c) => c.id === "bash")).toBe(true);
      expect(result.checks.some((c) => c.id === "free_disk")).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("fails when store is not openable", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-doctor-fail-"));
    temps.push(home);
    const badStore = {
      listRuns: async () => {
        throw new Error("store closed");
      },
    } as unknown as RunStore;

    const result = await runDoctorChecks({
      cwd: home,
      homeDir: home,
      store: badStore,
      env: {},
    });

    expect(result.ok).toBe(false);
    const storeCheck = result.checks.find((c) => c.id === "store_openable");
    expect(storeCheck?.status).toBe("fail");
    expect(storeCheck?.code).toBe("store_not_openable");
  });

  it("warns when CA env paths are missing", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-doctor-tls-"));
    temps.push(home);
    const store = createRunStore({ rootDir: home, openerMode: "migrate" });
    try {
      const missing = path.join(home, "no-such-ca.pem");
      const result = await runDoctorChecks({
        cwd: home,
        homeDir: home,
        store,
        env: { NODE_EXTRA_CA_CERTS: missing },
      });
      const tls = result.checks.find((c) => c.id === "tls_ca_paths");
      expect(tls?.status).toBe("warn");
      expect(tls?.code).toBe("ca_path_missing");
    } finally {
      await store.close();
    }
  });
});
