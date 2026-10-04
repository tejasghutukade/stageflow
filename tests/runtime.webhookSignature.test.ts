import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyHmacSignature } from "../src/runtime/webhookSignature.js";

function sign(body: Buffer, secret: string, scheme: "hex" | "base64"): string {
  return crypto.createHmac("sha256", secret).update(body).digest(scheme);
}

describe("verifyHmacSignature", () => {
  it("accepts a valid hex-scheme signature", () => {
    const body = Buffer.from(JSON.stringify({ ok: true }));
    const secret = "s3cret";
    const signature = sign(body, secret, "hex");
    expect(verifyHmacSignature(body, signature, secret, "hex")).toBe(true);
  });

  it("accepts a valid base64-scheme signature", () => {
    const body = Buffer.from(JSON.stringify({ ok: true }));
    const secret = "s3cret";
    const signature = sign(body, secret, "base64");
    expect(verifyHmacSignature(body, signature, secret, "base64")).toBe(true);
  });

  it("accepts a valid signature with a GitHub-style sha256= prefix", () => {
    const body = Buffer.from(JSON.stringify({ pull_request: { number: 1 } }));
    const secret = "s3cret";
    const signature = sign(body, secret, "hex");
    expect(
      verifyHmacSignature(body, `sha256=${signature}`, secret, "hex"),
    ).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = Buffer.from(JSON.stringify({ ok: true }));
    const signature = sign(body, "wrong-secret", "hex");
    expect(verifyHmacSignature(body, signature, "s3cret", "hex")).toBe(false);
  });

  it("rejects a tampered body", () => {
    const secret = "s3cret";
    const originalBody = Buffer.from(JSON.stringify({ amount: 10 }));
    const signature = sign(originalBody, secret, "hex");
    const tamperedBody = Buffer.from(JSON.stringify({ amount: 1000 }));
    expect(verifyHmacSignature(tamperedBody, signature, secret, "hex")).toBe(
      false,
    );
  });

  it("rejects a malformed header value without throwing", () => {
    const body = Buffer.from("payload");
    expect(() =>
      verifyHmacSignature(body, "not-a-real-signature===", "s3cret", "hex"),
    ).not.toThrow();
    expect(verifyHmacSignature(body, "not-a-real-signature===", "s3cret", "hex")).toBe(
      false,
    );
  });

  it("accepts a correctly-computed signature over an empty body", () => {
    const body = Buffer.alloc(0);
    const secret = "s3cret";
    const signature = sign(body, secret, "hex");
    expect(verifyHmacSignature(body, signature, secret, "hex")).toBe(true);
  });
});
