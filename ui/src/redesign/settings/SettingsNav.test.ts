import { describe, expect, it } from "vitest";
import {
  parseSettingsSection,
  settingsPath,
  settingsSectionDomId,
} from "./SettingsNav";

describe("parseSettingsSection", () => {
  it("defaults to general", () => {
    expect(parseSettingsSection("#/settings")).toBe("general");
    expect(parseSettingsSection("#/settings?section=unknown")).toBe("general");
  });

  it("parses known sections including project-mcp", () => {
    expect(parseSettingsSection("#/settings?section=providers")).toBe("providers");
    expect(parseSettingsSection("#/settings?section=concurrency")).toBe(
      "concurrency",
    );
    expect(parseSettingsSection("#/settings?section=mcp")).toBe("mcp");
    expect(parseSettingsSection("#/settings?section=project-mcp")).toBe(
      "project-mcp",
    );
    expect(parseSettingsSection("#/settings?section=notifications")).toBe(
      "notifications",
    );
    expect(parseSettingsSection("#/settings?section=appearance")).toBe(
      "appearance",
    );
  });
});

describe("settingsPath", () => {
  it("builds hash paths", () => {
    expect(settingsPath("general")).toBe("/settings?section=general");
    expect(settingsPath("project-mcp")).toBe("/settings?section=project-mcp");
  });
});

describe("settingsSectionDomId", () => {
  it("maps section ids to element ids", () => {
    expect(settingsSectionDomId("project-mcp")).toBe("sf-settings-project-mcp");
  });
});
