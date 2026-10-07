import { describe, expect, it } from "vitest";
import {
  effectiveNoProxy,
  installProxyDispatcher,
  proxyHealthFields,
  resetProxyDispatcherForTests,
} from "../src/net/proxy.js";

describe("proxy dispatcher", () => {
  it("no-ops without proxy vars", () => {
    resetProxyDispatcherForTests();
    const result = installProxyDispatcher({});
    expect(result.installed).toBe(false);
  });

  it("appends loopback to NO_PROXY when proxy set", () => {
    resetProxyDispatcherForTests();
    const result = installProxyDispatcher({
      HTTPS_PROXY: "http://user:secret@proxy.example:8080",
      NO_PROXY: "example.com",
    });
    expect(result.installed).toBe(true);
    expect(result.noProxy).toContain("127.0.0.1");
    expect(result.noProxy).toContain("::1");
    expect(result.httpsProxyHost).toBe("proxy.example:8080");
    const health = proxyHealthFields({
      HTTPS_PROXY: "http://user:secret@proxy.example:8080",
    });
    expect(JSON.stringify(health)).not.toContain("secret");
  });

  it("effectiveNoProxy is idempotent for loopback", () => {
    const once = effectiveNoProxy({ NO_PROXY: "example.com" });
    const twice = effectiveNoProxy({ NO_PROXY: once });
    const entries = twice.split(",").map((e) => e.trim().toLowerCase());
    expect(new Set(entries).size).toBe(entries.length);
    expect(entries).toEqual(expect.arrayContaining(["127.0.0.1", "::1", "localhost"]));
  });
});
