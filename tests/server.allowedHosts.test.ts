import { describe, expect, it } from "vitest";
import {
  isHostAllowed,
  isLoopbackHostname,
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
