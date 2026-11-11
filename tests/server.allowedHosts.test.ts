import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  allowListenAddress,
  assertAllowedHttpAccess,
  isHostAllowed,
  isLoopbackHostname,
  isLoopbackRemoteAddress,
  isTrustedLocalHttpRequest,
  resolveAllowedHosts,
} from "../src/server/allowedHosts.js";

describe("resolveAllowedHosts", () => {
  it("defaults to loopback-only names", () => {
    const allowed = resolveAllowedHosts({});
    expect(isHostAllowed(allowed, "127.0.0.1")).toBe(true);
    expect(isHostAllowed(allowed, "evil.example")).toBe(false);
  });

  it("adds listed hosts and keeps loopback", () => {
    const allowed = resolveAllowedHosts({
      STAGEFLOW_ALLOWED_HOSTS: "build-box:3847,sf.example.com",
    });
    expect(isHostAllowed(allowed, "build-box", "3847")).toBe(true);
    expect(isHostAllowed(allowed, "build-box", "9999")).toBe(false);
    expect(isHostAllowed(allowed, "other-box")).toBe(false);
    expect(isHostAllowed(allowed, "sf.example.com")).toBe(true);
    expect(isHostAllowed(allowed, "127.0.0.1")).toBe(true);
  });

  it("rejects wildcard", () => {
    expect(() =>
      resolveAllowedHosts({ STAGEFLOW_ALLOWED_HOSTS: "*" }),
    ).toThrow(/\*/);
  });
});

describe("allowListenAddress", () => {
  it("allows the Host's own non-loopback listen IP on its port only", () => {
    const allowed = resolveAllowedHosts({ STAGEFLOW_ALLOWED_HOSTS: "ws.example.dev" });
    allowListenAddress(allowed, "10.20.0.21", 3847);
    expect(isHostAllowed(allowed, "10.20.0.21", "3847")).toBe(true);
    expect(isHostAllowed(allowed, "10.20.0.21", "3848")).toBe(false);
    expect(isHostAllowed(allowed, "10.20.0.21")).toBe(false);
    expect(isHostAllowed(allowed, "10.20.0.22", "3847")).toBe(false);
    allowListenAddress(allowed, "10.20.0.21", 3847);
    expect(allowed.entries.filter((e) => e.hostname === "10.20.0.21")).toHaveLength(1);
  });

  it("adds nothing for a wildcard, loopback or name bind", () => {
    for (const bind of ["0.0.0.0", "::", "127.0.0.1", "::1", "localhost", "box.example"]) {
      const allowed = resolveAllowedHosts({});
      const before = allowed.entries.length;
      allowListenAddress(allowed, bind, 3847);
      expect(allowed.entries.length, bind).toBe(before);
    }
  });

  it("matches an IPv6 listen address given with or without brackets", () => {
    const allowed = resolveAllowedHosts({});
    allowListenAddress(allowed, "[fd00::5]", 3847);
    expect(isHostAllowed(allowed, "fd00::5", "3847")).toBe(true);
  });
});

describe("isLoopbackHostname", () => {
  it("covers 127.0.0.0/8 plus localhost and ::1", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.0.0.2")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("192.168.0.1")).toBe(false);
  });
});

describe("isLoopbackRemoteAddress", () => {
  it("accepts loopback and IPv4-mapped loopback", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
  });
});

describe("assertAllowedHttpAccess origin", () => {
  function decide(headers: Record<string, string>): number | "ok" {
    let status: number | undefined;
    const res = {
      writeHead(code: number) {
        status = code;
        return res;
      },
      end() {},
    } as unknown as ServerResponse;
    const ok = assertAllowedHttpAccess(
      resolveAllowedHosts({}),
      { headers } as IncomingMessage,
      res,
    );
    return ok ? "ok" : (status ?? 0);
  }

  it("rejects an origin whose port does not match the Host header", () => {
    expect(
      decide({ host: "localhost:3847", origin: "http://localhost:5173" }),
    ).toBe(403);
    expect(
      decide({ host: "localhost:3847", origin: "http://127.0.0.1:3847" }),
    ).toBe(403);
  });

  it("allows an origin that matches the Host header, and requests with no origin", () => {
    expect(
      decide({ host: "localhost:3847", origin: "http://localhost:3847" }),
    ).toBe("ok");
    expect(
      decide({ host: "[::1]:3847", origin: "http://[::1]:3847" }),
    ).toBe("ok");
    expect(decide({ host: "localhost", origin: "http://localhost" })).toBe("ok");
    expect(decide({ host: "localhost", origin: "https://localhost" })).toBe("ok");
    expect(decide({ host: "localhost:3847" })).toBe("ok");
  });
});

describe("isTrustedLocalHttpRequest", () => {
  function req(
    headers: Record<string, string>,
    remoteAddress = "127.0.0.1",
  ): IncomingMessage {
    return { headers, socket: { remoteAddress } } as IncomingMessage;
  }

  it("accepts loopback Host without Origin", () => {
    expect(isTrustedLocalHttpRequest(req({ host: "127.0.0.1:3847" }))).toBe(
      true,
    );
    expect(isTrustedLocalHttpRequest(req({ host: "localhost:3847" }))).toBe(
      true,
    );
  });

  it("accepts IPv4-mapped loopback remote with loopback Host", () => {
    expect(
      isTrustedLocalHttpRequest(
        req({ host: "127.0.0.1:3847" }, "::ffff:127.0.0.1"),
      ),
    ).toBe(true);
  });

  it("rejects non-loopback Host even when otherwise allowlisted elsewhere", () => {
    expect(
      isTrustedLocalHttpRequest(req({ host: "build-box:3847" })),
    ).toBe(false);
  });

  it("rejects loopback Host with non-loopback Origin", () => {
    expect(
      isTrustedLocalHttpRequest(
        req({ host: "127.0.0.1:3847", origin: "https://evil.example" }),
      ),
    ).toBe(false);
  });

  it("rejects remote peer even with loopback Host", () => {
    expect(
      isTrustedLocalHttpRequest(req({ host: "127.0.0.1:3847" }, "8.8.8.8")),
    ).toBe(false);
    expect(
      isTrustedLocalHttpRequest(
        req({ host: "127.0.0.1:3847" }, "192.168.1.5"),
      ),
    ).toBe(false);
  });
});
