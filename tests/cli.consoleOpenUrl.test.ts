import { describe, expect, it } from "vitest";
import { consoleOpenUrl } from "../src/cli.js";

describe("consoleOpenUrl", () => {
  it("adds the login code for loopback hosts, IPv6 included", () => {
    expect(consoleOpenUrl("http://127.0.0.1:3847", "abc")).toBe("http://127.0.0.1:3847/#code=abc");
    expect(consoleOpenUrl("http://localhost:3847", "abc")).toBe("http://localhost:3847/#code=abc");
    expect(consoleOpenUrl("http://[::1]:3847", "abc")).toBe("http://[::1]:3847/#code=abc");
  });

  it("never adds a code for another host or without one", () => {
    expect(consoleOpenUrl("http://192.168.1.5:3847", "abc")).toBe("http://192.168.1.5:3847");
    expect(consoleOpenUrl("http://127.0.0.1:3847", undefined)).toBe("http://127.0.0.1:3847");
  });
});
