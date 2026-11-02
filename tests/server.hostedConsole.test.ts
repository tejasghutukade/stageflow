import { describe, expect, it } from "vitest";
import { isHostedConsole } from "../src/server/hostedConsole.js";

describe("isHostedConsole", () => {
  it("is false for a local console", () => {
    expect(isHostedConsole({})).toBe(false);
    expect(isHostedConsole({ STAGEFLOW_BIND: "127.0.0.1" })).toBe(false);
    expect(isHostedConsole({ STAGEFLOW_BIND: "::1" })).toBe(false);
    expect(isHostedConsole({ STAGEFLOW_BIND: "  " })).toBe(false);
    expect(isHostedConsole({ STAGEFLOW_ALLOWED_HOSTS: " " })).toBe(false);
    expect(isHostedConsole({ STAGEFLOW_ALLOWED_HOSTS: "localhost" })).toBe(
      false,
    );
    expect(
      isHostedConsole({ STAGEFLOW_ALLOWED_HOSTS: "127.0.0.1,::1,[::1]" }),
    ).toBe(false);
  });

  it("is true when the bind or allowed hosts leave the machine", () => {
    expect(isHostedConsole({ STAGEFLOW_BIND: "0.0.0.0" })).toBe(true);
    expect(isHostedConsole({ STAGEFLOW_BIND: "::" })).toBe(true);
    expect(
      isHostedConsole({ STAGEFLOW_ALLOWED_HOSTS: "acme.stage-flow.dev" }),
    ).toBe(true);
    expect(
      isHostedConsole({ STAGEFLOW_ALLOWED_HOSTS: "[2001:db8::1]:443" }),
    ).toBe(true);
    expect(
      isHostedConsole({
        STAGEFLOW_BIND: "127.0.0.1",
        STAGEFLOW_ALLOWED_HOSTS: "build-box:3847",
      }),
    ).toBe(true);
  });

  it("does not throw on a bad bind or a rejected allow-list", () => {
    expect(isHostedConsole({ STAGEFLOW_BIND: "not-an-ip" })).toBe(false);
    expect(isHostedConsole({ STAGEFLOW_ALLOWED_HOSTS: "*" })).toBe(true);
  });
});
