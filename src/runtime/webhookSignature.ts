import crypto from "node:crypto";

export function verifyHmacSignature(
  rawBody: Buffer,
  headerValue: string,
  secret: string,
  scheme: "hex" | "base64",
): boolean {
  const eqIndex = headerValue.indexOf("=");
  const hasPrefix = eqIndex !== -1 && eqIndex < headerValue.length - 1;
  const provided = hasPrefix ? headerValue.slice(eqIndex + 1) : headerValue;

  const computed = crypto.createHmac("sha256", secret).update(rawBody).digest(scheme);

  const providedBuffer = Buffer.from(provided, scheme);
  const computedBuffer = Buffer.from(computed, scheme);
  if (providedBuffer.length !== computedBuffer.length) return false;

  return crypto.timingSafeEqual(providedBuffer, computedBuffer);
}
