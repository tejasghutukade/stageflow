import { describe, expect, it } from "vitest";
import { advertisedHost, resolveListenHost } from "../src/server/listenHost.js";

describe("resolveListenHost", () => {
  it("defaults to 127.0.0.1", () => {
    expect(resolveListenHost({ env: {} })).toBe("127.0.0.1");
  });

  it("flag overrides STAGEFLOW_BIND", () => {
    expect(
      resolveListenHost({
        flag: "0.0.0.0",
        env: { STAGEFLOW_BIND: "127.0.0.1" },
      }),
    ).toBe("0.0.0.0");
  });

  it("reads STAGEFLOW_BIND when flag omitted", () => {
    expect(resolveListenHost({ env: { STAGEFLOW_BIND: "::" } })).toBe("::");
  });

  it("accepts bracketed IPv6", () => {
    expect(resolveListenHost({ flag: "[::1]", env: {} })).toBe("::1");
  });

  it("rejects hostnames, empty, ported, and schemed values", () => {
    for (const value of ["", "localhost", "build-box", "127.0.0.1:3847", "http://127.0.0.1"]) {
      expect(() => resolveListenHost({ flag: value, env: {} })).toThrow(
        /Invalid --host \/ STAGEFLOW_BIND/,
      );
    }
  });
});

describe("advertisedHost", () => {
  it("maps wildcards to loopback advertisements", () => {
    expect(advertisedHost("0.0.0.0")).toBe("127.0.0.1");
    expect(advertisedHost("::")).toBe("[::1]");
  });

  it("brackets non-wildcard IPv6", () => {
    expect(advertisedHost("2001:db8::1")).toBe("[2001:db8::1]");
  });

  it("passes through IPv4", () => {
    expect(advertisedHost("192.168.1.10")).toBe("192.168.1.10");
  });
});
