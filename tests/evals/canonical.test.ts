import { describe, expect, it } from "vitest";
import { canonicalJson, hash6, sha256Hex } from "../../src/evals/canonical.js";

describe("canonicalJson", () => {
  it("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"z":1}]},"b":1}',
    );
  });

  it("is insensitive to key order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe("hashes", () => {
  it("hashes with sha256 and shortens to 6 chars", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hash6(sha256Hex("abc"))).toBe("ba7816");
  });
});
