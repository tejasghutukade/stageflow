import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
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
