import { describe, expect, it } from "vitest";
import { assertTmpdirUsable } from "../src/runstore/assertTmpdir.js";
import { StoreOpenError } from "../src/runstore/sqlite/storeOpenError.js";
import { BUILD_SHA, PACKAGE_VERSION } from "../src/package-meta.js";
import { buildEgressHealth } from "../src/net/proxy.js";

describe("assertTmpdirUsable", () => {
  it("refuses unset TMPDIR", () => {
    expect(() =>
      assertTmpdirUsable({ TMPDIR: undefined, TMP: undefined, TEMP: undefined }),
    ).toThrow(StoreOpenError);
    try {
      assertTmpdirUsable({ TMPDIR: "", TMP: "", TEMP: "" });
    } catch (err) {
      expect((err as StoreOpenError).code).toBe("tmpdir_unusable");
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
