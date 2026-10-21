import { describe, expect, it } from "vitest";
import { formatEnvelopeSubtitle } from "./EnvelopeFields";

describe("formatEnvelopeSubtitle", () => {
  const labelFor = (id: string) => (id === "work~1" ? "work · 1" : id);

  it.each([
    { name: "formatted labels joined by an arrow", from: "work~1", to: "collect", label: labelFor, expected: "work · 1 → collect" },
    { name: "no target stage", from: "work~1", to: undefined, label: labelFor, expected: "work · 1" },
    { name: "no labelFor falls back to ids", from: "a", to: "b", label: undefined, expected: "a → b" },
    { name: "no labelFor and no target", from: "a", to: undefined, label: undefined, expected: "a" },
  ])("$name", ({ from, to, label, expected }) => {
    expect(formatEnvelopeSubtitle(from, to, label)).toBe(expected);
  });
});
