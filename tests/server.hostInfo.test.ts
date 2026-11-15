import { describe, expect, it } from "vitest";
import { resolveHostInfo } from "../src/server/hostInfo.js";

describe("resolveHostInfo", () => {
  it("has no public address on a local Host", () => {
    expect(resolveHostInfo({})).toEqual({ hosted: false, managed: false, publicUrl: null, publicChatUrl: null });
  });

  it("reports the public address and marks the Host as hosted and managed", () => {
    expect(
      resolveHostInfo({
        STAGEFLOW_PUBLIC_URL: "https://acme.stage-flow.dev",
        STAGEFLOW_PUBLIC_CHAT_URL: "https://acme-public.stage-flow.dev",
        STAGEFLOW_ALLOWED_HOSTS: "acme.stage-flow.dev,acme-public.stage-flow.dev",
        STAGEFLOW_PLATFORM_URL: "https://gateway.example",
      }),
    ).toEqual({
      hosted: true,
      managed: true,
      publicUrl: "https://acme.stage-flow.dev",
      publicChatUrl: "https://acme-public.stage-flow.dev",
    });
  });

  it("keeps only the origin and ignores a value A2A would reject", () => {
    expect(resolveHostInfo({ STAGEFLOW_PUBLIC_URL: "https://acme.stage-flow.dev/" }).publicUrl).toBe("https://acme.stage-flow.dev");
    expect(resolveHostInfo({ STAGEFLOW_PUBLIC_URL: "http://acme.stage-flow.dev" }).publicUrl).toBeNull();
    expect(resolveHostInfo({ STAGEFLOW_PUBLIC_URL: "https://acme.stage-flow.dev/path" }).publicUrl).toBeNull();
    expect(resolveHostInfo({ STAGEFLOW_PUBLIC_URL: "not a url" }).publicUrl).toBeNull();
    expect(resolveHostInfo({ STAGEFLOW_PUBLIC_CHAT_URL: "javascript:alert(1)" }).publicChatUrl).toBeNull();
  });

  it("allows http on loopback for a local public address", () => {
    expect(resolveHostInfo({ STAGEFLOW_PUBLIC_URL: "http://127.0.0.1:3847" }).publicUrl).toBe("http://127.0.0.1:3847");
  });
});
