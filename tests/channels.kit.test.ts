import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChannelError } from "../src/channels/errors.js";
import { healthOf, receiptFor, withSendTimeout, withSpectrumApp, zodValidator } from "../src/channels/providers/kit.js";

describe("zodValidator", () => {
  const schema = z.object({ to: z.string().min(1), nested: z.object({ n: z.number() }).optional() }).strict();

  it("returns the parsed value, or a normalized one", () => {
    expect(zodValidator(schema, "target")({ to: "x" })).toEqual({ ok: true, value: { to: "x" } });
    expect(zodValidator(schema, "target", data => ({ recipient: data.to }))({ to: "x" })).toEqual({ ok: true, value: { recipient: "x" } });
  });

  it("names the failing paths, or the root when the input is not an object at all", () => {
    expect(zodValidator(schema, "target")({ to: "", nested: { n: "no" } })).toEqual({ ok: false, issues: ["to", "nested.n"] });
    expect(zodValidator(schema, "target")("nope")).toEqual({ ok: false, issues: ["target"] });
    expect(zodValidator(schema, "config")(null)).toEqual({ ok: false, issues: ["config"] });
  });
});

describe("healthOf", () => {
  it("is ok when the check returns", async () => {
    expect(await healthOf(async () => undefined)).toMatchObject({ state: "ok" });
  });

  it("keeps a ChannelError's code and retryability", async () => {
    expect(await healthOf(async () => { throw new ChannelError("CHANNEL_AUTH_FAILED"); })).toMatchObject({ state: "failed", error: { code: "CHANNEL_AUTH_FAILED", retryable: false } });
    expect(await healthOf(async () => { throw new ChannelError("CHANNEL_RATE_LIMIT", true); })).toMatchObject({ error: { code: "CHANNEL_RATE_LIMIT", retryable: true } });
  });

  it("treats any unexpected error as a retryable connection failure, the same for every provider", async () => {
    for (const thrown of [new TypeError("boom"), "text", undefined, { code: 1 }]) {
      expect(await healthOf(async () => { throw thrown; })).toMatchObject({ state: "failed", error: { code: "CHANNEL_CONNECTION_FAILED", retryable: true } });
    }
  });

  it("never leaks the error message", async () => {
    const health = await healthOf(async () => { throw new Error("token=super-secret"); });
    expect(JSON.stringify(health)).not.toContain("super-secret");
  });
});

describe("receiptFor", () => {
  it("carries the id, or warns when the provider returned none", () => {
    expect(receiptFor("m1")).toMatchObject({ providerMessageId: "m1" });
    expect(receiptFor("m1").warnings).toBeUndefined();
    expect(receiptFor(undefined)).toMatchObject({ warnings: ["CHANNEL_RESPONSE_UNPARSEABLE"] });
    expect(receiptFor(undefined).providerMessageId).toBeUndefined();
  });
});

describe("withSendTimeout", () => {
  it("passes through a result and a failure", async () => {
    expect(await withSendTimeout(1000, "c", Promise.resolve("ok"))).toBe("ok");
    await expect(withSendTimeout(1000, "c", Promise.reject(new ChannelError("CHANNEL_AUTH_FAILED")))).rejects.toMatchObject({ code: "CHANNEL_AUTH_FAILED" });
  });

  it("reports expiry as an unknown outcome, never as a failure that is safe to resend", async () => {
    await expect(withSendTimeout(20, "c", new Promise(() => undefined))).rejects.toMatchObject({ code: "CHANNEL_SEND_OUTCOME_UNKNOWN", retryable: false, detail: { connectionId: "c" } });
  });
});

describe("withSpectrumApp", () => {
  const credentials = { projectId: "p", projectSecret: "s" };
  const sdk = (log: string[], options: { stopFails?: boolean; missing?: string } = {}) => async (specifier: string) => {
    if (specifier === options.missing) throw new Error("Cannot find package");
    if (specifier === "@spectrum-ts/core") {
      return { Spectrum: async (config: { projectId: string; providers: unknown[] }) => { log.push(`app:${config.projectId}:${config.providers.length}`); return { stop: async () => { log.push("stop"); if (options.stopFails) throw new Error("stop failed"); } }; } };
    }
    return { thing: Object.assign((app: unknown) => ({ app }), { config: () => ({ cfg: true }) }), extra: "x" };
  };
  const platform = { pkg: "@spectrum-ts/thing", exportName: "thing" };

  it("creates the app once, hands over the platform and the module, then stops", async () => {
    const log: string[] = [];
    const result = await withSpectrumApp(sdk(log), credentials, platform, async ({ platform: entry, module }) => { log.push(`run:${module.extra}:${typeof entry.app}`); return "done"; });
    expect(result).toBe("done");
    expect(log).toEqual(["app:p:1", "run:x:object", "stop"]);
  });

  it("stops the app when the work fails and reports the work's own error", async () => {
    const log: string[] = [];
    await expect(withSpectrumApp(sdk(log), credentials, platform, async () => { throw new ChannelError("CHANNEL_RECIPIENT_REJECTED"); })).rejects.toMatchObject({ code: "CHANNEL_RECIPIENT_REJECTED" });
    expect(log.at(-1)).toBe("stop");
  });

  it("does not let a failing stop hide the result", async () => {
    const log: string[] = [];
    expect(await withSpectrumApp(sdk(log, { stopFails: true }), credentials, platform, async () => "kept")).toBe("kept");
  });

  it("reports either missing package as unsupported without creating an app", async () => {
    for (const missing of ["@spectrum-ts/core", "@spectrum-ts/thing"]) {
      const log: string[] = [];
      await expect(withSpectrumApp(sdk(log, { missing }), credentials, platform, async () => "x")).rejects.toMatchObject({ code: "CHANNEL_PROVIDER_UNSUPPORTED" });
      expect(log).toEqual([]);
    }
  });
});
