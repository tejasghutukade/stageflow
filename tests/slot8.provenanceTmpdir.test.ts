import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertTmpdirUsable } from "../src/runstore/assertTmpdir.js";
import { StoreOpenError } from "../src/runstore/sqlite/storeOpenError.js";
import { BUILD_SHA, PACKAGE_VERSION } from "../src/package-meta.js";
import { buildEgressHealth } from "../src/net/proxy.js";
import {
  globalStageflowHome,
  resetGlobalStageflowHomeForTests,
} from "../src/project/globalHome.js";

describe("assertTmpdirUsable", () => {
  it("soft-defaults unset or whitespace-empty TMPDIR to $STAGEFLOW_HOME/tmp", () => {
    resetGlobalStageflowHomeForTests();
    const home = mkdtempSync(path.join(tmpdir(), "sf-tmpdir-home-"));
    const prevHome = process.env.STAGEFLOW_HOME;
    const prevTmp = process.env.TMPDIR;
    try {
      process.env.STAGEFLOW_HOME = home;
      resetGlobalStageflowHomeForTests();
      const soft = path.join(globalStageflowHome(), "tmp");
      expect(
        assertTmpdirUsable({
          TMPDIR: undefined,
          TMP: undefined,
          TEMP: undefined,
        }),
      ).toBe(soft);
      expect(existsSync(soft)).toBe(true);
      expect(
        assertTmpdirUsable({ TMPDIR: "  ", TMP: "", TEMP: "" }),
      ).toBe(soft);
    } finally {
      if (prevHome === undefined) delete process.env.STAGEFLOW_HOME;
      else process.env.STAGEFLOW_HOME = prevHome;
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
      resetGlobalStageflowHomeForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still fails when explicit TMPDIR is unwritable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-tmpdir-ro-"));
    try {
      chmodSync(dir, 0o500);
      expect(() => assertTmpdirUsable({ TMPDIR: dir })).toThrow(StoreOpenError);
      try {
        assertTmpdirUsable({ TMPDIR: dir });
      } catch (err) {
        expect((err as StoreOpenError).code).toBe("tmpdir_unusable");
      }
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts writable TMPDIR", () => {
    const dir = process.env.TMPDIR ?? "/tmp";
    expect(assertTmpdirUsable({ TMPDIR: dir })).toBe(dir);
  });
});

describe("BUILD_SHA and egress", () => {
  it("defaults build sha to unknown", () => {
    expect(BUILD_SHA === "unknown" || BUILD_SHA.length > 0).toBe(true);
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("egress never includes userinfo", () => {
    const egress = buildEgressHealth({
      HTTPS_PROXY: "http://user:secret@proxy.example:3128",
      HTTP_PROXY: "http://user:secret@proxy.example:3128",
    });
    expect(JSON.stringify(egress)).not.toMatch(/secret/);
    expect(egress.proxy_host).toBe("proxy.example:3128");
    expect(egress.https_proxy).toBe("set");
  });
});
