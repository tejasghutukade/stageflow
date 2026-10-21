import { describe, expect, it } from "vitest";
import {
  triggerEnabledLabel,
  triggerKindLabel,
  triggerScheduleSummary,
  triggerTaskLabel,
  triggerTaskSummary,
} from "./TriggersPage";

describe("triggerKindLabel", () => {
  it("labels each trigger kind", () => {
    expect(triggerKindLabel("manual")).toBe("Manual");
    expect(triggerKindLabel("schedule")).toBe("Schedule");
    expect(triggerKindLabel("event")).toBe("Event");
  });
});

describe("triggerScheduleSummary", () => {
  it("shows the cron expression with timezone for schedule triggers", () => {
    expect(
      triggerScheduleSummary({
        kind: "schedule",
        schedule: { cron: "0 * * * *", timezone: "UTC" },
      }),
    ).toBe("0 * * * * (UTC)");
  });

  it("shows the cron expression alone when no timezone is set", () => {
    expect(
      triggerScheduleSummary({
        kind: "schedule",
        schedule: { cron: "0 * * * *" },
      }),
    ).toBe("0 * * * *");
  });

  it("shows the event source for event triggers", () => {
    expect(
      triggerScheduleSummary({ kind: "event", event: { source: "github" } }),
    ).toBe("on github");
  });

  it("falls back to manual-only when there is no schedule or event", () => {
    expect(triggerScheduleSummary({ kind: "manual" })).toBe(
      "Fired manually only",
    );
    expect(triggerScheduleSummary({ kind: "schedule" })).toBe(
      "Fired manually only",
    );
    expect(triggerScheduleSummary({ kind: "event" })).toBe(
      "Fired manually only",
    );
  });
});

describe("triggerEnabledLabel", () => {
  it("labels enabled and disabled state", () => {
    expect(triggerEnabledLabel(true)).toBe("Enabled");
    expect(triggerEnabledLabel(false)).toBe("Disabled");
  });
});

describe("triggerTaskLabel", () => {
  it("returns the task id unchanged when present", () => {
    expect(triggerTaskLabel("sample-task")).toBe("sample-task");
  });

  it("falls back to a dynamic-mode explanation when absent", () => {
    expect(triggerTaskLabel(undefined)).toBe(
      "Dynamic (task supplied at fire time)",
    );
  });
});

describe("triggerTaskSummary", () => {
  it("returns the task id unchanged when present", () => {
    expect(triggerTaskSummary("sample-task")).toBe("sample-task");
  });

  it("falls back to a short dynamic-mode label when absent", () => {
    expect(triggerTaskSummary(undefined)).toBe("Dynamic");
  });
});
