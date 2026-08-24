import { describe, expect, it } from "vitest";
import {
  extensionFilePath,
  extensionPackagePath,
  parseHash,
} from "./routes";

describe("parseHash", () => {
  it("parses the skills list", () => {
    expect(parseHash("#/skills")).toEqual({ name: "skills" });
  });

  it("parses a skill detail name", () => {
    expect(parseHash("#/skills/brave-search")).toEqual({
      name: "skill",
      skillName: "brave-search",
    });
  });

  it("parses the extensions list", () => {
    expect(parseHash("#/extensions")).toEqual({ name: "extensions" });
  });

  it("parses an extension package detail", () => {
    const hash = `#${extensionPackagePath("user", "npm:pi-cursor-sdk")}`;
    expect(parseHash(hash)).toEqual({
      name: "extensionPackage",
      scope: "user",
      source: "npm:pi-cursor-sdk",
    });
  });

  it("parses an extension file detail with encoded path", () => {
    const filePath = "/tmp/agent/extensions/fixture-user.ts";
    expect(parseHash(`#${extensionFilePath(filePath)}`)).toEqual({
      name: "extensionFile",
      path: filePath,
    });
  });
});

  it("parses the provider connect route", () => {
    expect(parseHash("#/connect")).toEqual({ name: "connect" });
  });

