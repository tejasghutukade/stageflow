import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { acceptWebhook } from "../src/runtime/webhookAccept.js";
import type { TriggerFile } from "../src/types/trigger.js";

const SECRET = "webhook-test-secret-please-ignore";

function sign(body: Buffer | string, secret: string, scheme: "hex" | "base64" = "hex"): string {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return crypto.createHmac("sha256", secret).update(bytes).digest(scheme);
}

function trigger(overrides: Partial<TriggerFile> = {}): TriggerFile {
  return {
    id: "webhook-dynamic",
    pipeline: "hello",
    kind: "event",
    enabled: true,
    event: {
      source: "webhook",
      match: { action: "opened" },
      config: { secretRef: "WEBHOOK_SECRET", header: "X-Signature" },
    },
    ...overrides,
  };
}

function accept(
  body: string,
  headers: Record<string, string | string[] | undefined>,
  definition: TriggerFile = trigger(),
  env: NodeJS.ProcessEnv = { WEBHOOK_SECRET: SECRET },
) {
  return acceptWebhook({
    trigger: definition,
    rawBody: Buffer.from(body),
    headers,
    env,
    now: () => 1_700_000_000_000,
  });
}

describe("acceptWebhook", () => {
  it("returns not_configured when signing config or the secret is missing", () => {
    const body = "{}";
    expect(
      accept(body, {}, trigger({ event: { source: "webhook" } })).kind,
    ).toBe("not_configured");
    expect(
      accept(body, {}, trigger(), {}).kind,
    ).toBe("not_configured");
    expect(
      accept(body, {}, trigger(), {
        WEBHOOK_SECRET: SECRET,
        WEBHOOK_SECRET_FILE: "/tmp/also-set",
      }).kind,
    ).toBe("not_configured");
  });

  it("returns bad_signature for a missing, empty, or wrong signature", () => {
    const body = JSON.stringify({ action: "opened" });
    expect(accept(body, {}).kind).toBe("bad_signature");
    expect(accept(body, { "x-signature": "" }).kind).toBe("bad_signature");
    expect(accept(body, { "x-signature": sign(body, "other") }).kind).toBe("bad_signature");
    expect(
      accept(body, { "x-signature": [sign(body, "other"), sign(body, SECRET)] }).kind,
    ).toBe("bad_signature");
  });

  it("accepts a hex signature, including a sha256= prefix and the first of multiple header values", () => {
    const body = JSON.stringify({ action: "opened", number: 11 });
    const signature = sign(body, SECRET);
    expect(accept(body, { "x-signature": signature }).kind).toBe("fire");
    expect(accept(body, { "x-signature": `sha256=${signature}` }).kind).toBe("fire");
    expect(accept(body, { "x-signature": [signature, "ignored"] }).kind).toBe("fire");
  });

  it("verifies a base64 scheme when configured", () => {
    const body = JSON.stringify({ action: "opened" });
    const definition = trigger({
      event: {
        source: "webhook",
        match: { action: "opened" },
        config: { secretRef: "WEBHOOK_SECRET", header: "x-signature", scheme: "base64" },
      },
    });
    expect(accept(body, { "x-signature": sign(body, SECRET, "hex") }, definition).kind).toBe(
      "bad_signature",
    );
    expect(accept(body, { "x-signature": sign(body, SECRET, "base64") }, definition).kind).toBe(
      "fire",
    );
  });

  it("returns bad_json after a valid signature when the body is not a JSON object", () => {
    const malformed = "{not valid json";
    const arrayBody = "[1]";
    const nullBody = "null";
    expect(accept(malformed, { "x-signature": sign(malformed, SECRET) })).toEqual({
      kind: "bad_json",
      error: "Invalid JSON body",
    });
    expect(accept(arrayBody, { "x-signature": sign(arrayBody, SECRET) })).toEqual({
      kind: "bad_json",
      error: "Invalid JSON body: expected an object",
    });
    expect(accept(nullBody, { "x-signature": sign(nullBody, SECRET) })).toEqual({
      kind: "bad_json",
      error: "Invalid JSON body: expected an object",
    });
    expect(accept(malformed, { "x-signature": sign(malformed, "other") }).kind).toBe(
      "bad_signature",
    );
  });

  it("treats an empty body as an empty object", () => {
    const definition = trigger({
      task: "my-task",
      event: {
        source: "webhook",
        config: { secretRef: "WEBHOOK_SECRET", header: "x-signature" },
      },
    });
    expect(accept("", { "x-signature": sign("", SECRET) }, definition)).toEqual({ kind: "fire" });
  });

  it("returns no_match when the payload fails the event filter", () => {
    const body = JSON.stringify({ action: "closed", number: 9 });
    expect(accept(body, { "x-signature": sign(body, SECRET) })).toEqual({ kind: "no_match" });
  });

  it("fires a catalog task without shaping a dynamic task", () => {
    const body = JSON.stringify({ action: "opened", number: 7 });
    const definition = trigger({
      id: "webhook-catalog",
      task: "my-task",
      event: {
        source: "webhook",
        config: { secretRef: "WEBHOOK_SECRET", header: "x-signature" },
      },
    });
    expect(accept(body, { "x-signature": sign(body, SECRET) }, definition)).toEqual({
      kind: "fire",
    });
  });

  it("shapes a dynamic task from the payload when the trigger has no catalog task", () => {
    const body = JSON.stringify({ action: "opened", number: 11 });
    expect(accept(body, { "x-signature": sign(body, SECRET) })).toEqual({
      kind: "fire",
      task: {
        id: "webhook-dynamic-webhook-1700000000000",
        goal: 'Handle webhook event for trigger "webhook-dynamic"',
        input: { action: "opened", number: 11 },
      },
    });
  });
});
