import { describe, expect, it } from "vitest";
import {
  extensionFilePath,
  extensionPackagePath,
  parseHash,
  runStagePath,
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

  it("parses the provider connect route", () => {
    expect(parseHash("#/connect")).toEqual({ name: "connect" });
  });
});

describe("run stage hash", () => {
  it("parses a stream stage path", () => {
    expect(parseHash("#/runs/r1/stages/design")).toEqual({
      name: "detail",
      runId: "r1",
      view: { kind: "stream", stageId: "design" },
    });
  });

  it("keeps four-segment envelope paths", () => {
    expect(parseHash("#/runs/r1/stages/design/envelope")).toEqual({
      name: "detail",
      runId: "r1",
      view: { kind: "envelope", stageId: "design" },
    });
  });

  it("round-trips runStagePath through parseHash", () => {
    const path = runStagePath("r1", "design");
    expect(parseHash(`#${path}`)).toEqual({
      name: "detail",
      runId: "r1",
      view: { kind: "stream", stageId: "design" },
    });
  });

  it("yields the unknown stage id from the parser", () => {
    expect(parseHash("#/runs/r1/stages/unknown")).toEqual({
      name: "detail",
      runId: "r1",
      view: { kind: "stream", stageId: "unknown" },
    });
  });
});

