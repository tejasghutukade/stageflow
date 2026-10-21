import { describe, expect, it } from "vitest";
import type { RunSummary, TriggerListItem } from "../../api";
import {
  duplicateTrigger,
  formatCost,
  formatDuration,
  formatRelativeFuture,
  formatRunDate,
  humanizeCron,
  runDuration,
  runOutcome,
  timezoneLabel,
  triggerBehaviorNotes,
  triggerEventFields,
  triggerFilePath,
  triggerFireState,
  triggerFolderLabel,
  triggerNextCell,
  triggerSourceIcon,
  triggerSummaryLine,
} from "./triggerListModel";

function trigger(overrides: Partial<TriggerListItem> = {}): TriggerListItem {
  return {
    id: "t1",
    pipeline: "bugfix-loop",
    task: "dependency-audit",
    kind: "manual",
    enabled: true,
    definition_ref: "triggers/t1.trigger.yaml",
    ...overrides,
  };
}

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "run_9e21aa",
    pipeline_id: "bugfix-loop",
    status: "succeeded",
    created_at: "2026-10-05T02:00:00.000Z",
    stages: [],
    ...overrides,
  };
}

const NOW = new Date(2026, 9, 5, 15, 0, 0);

describe("humanizeCron", () => {
  it("humanizes common daily, weekday and interval crons", () => {
    expect(humanizeCron("0 2 * * *")).toBe("Every day at 02:00");
    expect(humanizeCron("30 9 * * 1-5")).toBe("Weekdays at 09:30");
    expect(humanizeCron("0 9 * * 1")).toBe("Every Mon at 09:00");
    expect(humanizeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(humanizeCron("5 * * * *")).toBe("Every hour at :05");
    expect(humanizeCron("0 */6 * * *")).toBe("Every 6 hours at :00");
    expect(humanizeCron("0 3 1 * *")).toBe("Monthly on day 1 at 03:00");
  });

  it("falls back to the raw expression", () => {
    expect(humanizeCron("0 2 1-7 * 1")).toBe("0 2 1-7 * 1");
    expect(humanizeCron("@daily")).toBe("@daily");
  });
});

describe("timezoneLabel", () => {
  it("uses the city segment", () => {
    expect(timezoneLabel("America/New_York")).toBe("New York");
    expect(timezoneLabel("UTC")).toBe("UTC");
  });
});

describe("triggerSourceIcon", () => {
  it("maps kinds and event sources", () => {
    expect(triggerSourceIcon(trigger({ kind: "schedule" }))).toBe("schedule");
    expect(triggerSourceIcon(trigger())).toBe("manual");
    expect(
      triggerSourceIcon(trigger({ kind: "event", event: { source: "github.pull_request" } })),
    ).toBe("github");
    expect(triggerSourceIcon(trigger({ kind: "event", event: { source: "webhook" } }))).toBe(
      "webhook",
    );
    expect(
      triggerSourceIcon(trigger({ kind: "event", event: { source: "email.message" } })),
    ).toBe("email");
    expect(triggerSourceIcon(trigger({ kind: "event", event: { source: "custom" } }))).toBe(
      "event",
    );
  });
});

describe("triggerSummaryLine", () => {
  it("summarizes schedules with timezone", () => {
    expect(
      triggerSummaryLine(
        trigger({
          kind: "schedule",
          schedule: { cron: "0 2 * * *", timezone: "America/New_York" },
        }),
      ),
    ).toEqual({ text: "Every day at 02:00 New York", warning: false });
  });

  it("warns for schedules without a catalog task", () => {
    expect(
      triggerSummaryLine(
        trigger({ kind: "schedule", task: undefined, schedule: { cron: "0 2 * * *" } }),
      ),
    ).toEqual({ text: "cannot auto-fire: dynamic task on a schedule", warning: true });
  });

  it("summarizes event sources", () => {
    expect(
      triggerSummaryLine(
        trigger({
          kind: "event",
          event: {
            source: "github.pull_request",
            match: { action: "opened" },
            config: { repo: "acme/app" },
          },
        }),
      ).text,
    ).toBe("GitHub PR opened in acme/app");
    expect(
      triggerSummaryLine(trigger({ kind: "event", event: { source: "github.pull_request" } }))
        .text,
    ).toBe("GitHub PR");
    expect(triggerSummaryLine(trigger({ kind: "event", event: { source: "webhook" } })).text).toBe(
      "Signed webhook",
    );
    expect(
      triggerSummaryLine(
        trigger({
          kind: "event",
          event: { source: "email.message", config: { folder: "INBOX" } },
        }),
      ).text,
    ).toBe("Email INBOX");
  });

  it("summarizes manual triggers", () => {
    expect(triggerSummaryLine(trigger()).text).toBe("Fired by hand");
  });
});

describe("formatRelativeFuture", () => {
  it("formats minutes, hours and days", () => {
    expect(formatRelativeFuture(new Date(NOW.getTime() + 5 * 60000), NOW)).toBe("in 5m");
    expect(formatRelativeFuture(new Date(NOW.getTime() + 11 * 3600000), NOW)).toBe("in 11h");
    expect(formatRelativeFuture(new Date(NOW.getTime() + 35 * 3600000), NOW)).toBe("in 1d 11h");
    expect(formatRelativeFuture(new Date(NOW.getTime() - 1000), NOW)).toBe("now");
  });
});

describe("triggerNextCell", () => {
  it("shows the next cron fire for schedules with a catalog task", () => {
    const cell = triggerNextCell(
      trigger({ kind: "schedule", schedule: { cron: "0 2 * * *" } }),
      NOW,
    );
    expect(cell).toEqual({ label: "in 11h", dot: false, muted: false });
  });

  it("shows a muted dash for dynamic or disabled schedules", () => {
    const dash = { label: "—", dot: false, muted: true };
    expect(
      triggerNextCell(
        trigger({ kind: "schedule", task: undefined, schedule: { cron: "0 2 * * *" } }),
        NOW,
      ),
    ).toEqual(dash);
    expect(
      triggerNextCell(
        trigger({ kind: "schedule", enabled: false, schedule: { cron: "0 2 * * *" } }),
        NOW,
      ),
    ).toEqual(dash);
    expect(triggerNextCell(trigger(), NOW)).toEqual(dash);
  });

  it("labels event adapters", () => {
    expect(
      triggerNextCell(trigger({ kind: "event", event: { source: "github.push" } }), NOW),
    ).toEqual({ label: "polling 60s", dot: true, muted: false });
    expect(
      triggerNextCell(trigger({ kind: "event", event: { source: "webhook" } }), NOW).label,
    ).toBe("webhook");
    expect(
      triggerNextCell(trigger({ kind: "event", event: { source: "email.message" } }), NOW).label,
    ).toBe("imap");
  });

  it("survives invalid cron expressions", () => {
    expect(
      triggerNextCell(trigger({ kind: "schedule", schedule: { cron: "nope" } }), NOW).label,
    ).toBe("—");
  });
});

describe("triggerFireState", () => {
  it("enables firing when enabled with a task", () => {
    expect(triggerFireState(trigger())).toEqual({ enabled: true });
    expect(triggerFireState(trigger({ kind: "schedule" }))).toEqual({ enabled: true });
  });

  it("disables firing without a task payload", () => {
    expect(triggerFireState(trigger({ task: undefined }))).toEqual({
      enabled: false,
      title: "needs a task payload",
    });
    expect(triggerFireState(trigger({ kind: "event", task: undefined }))).toEqual({
      enabled: false,
      title: "needs a task payload",
    });
  });

  it("disables firing when the trigger is disabled", () => {
    expect(triggerFireState(trigger({ enabled: false }))).toEqual({
      enabled: false,
      title: "Trigger is disabled",
    });
  });
});

describe("run helpers", () => {
  it("maps run outcomes", () => {
    expect(runOutcome(run())).toBe("succeeded");
    expect(runOutcome(run({ status: "failed" }))).toBe("failed");
    expect(runOutcome(run({ status: "running" }))).toBeUndefined();
    expect(runOutcome(undefined)).toBeUndefined();
  });

  it("formats durations and costs", () => {
    expect(formatDuration(372_000)).toBe("6m 12s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(3_900_000)).toBe("1h 05m");
    expect(
      runDuration(run({ finished_at: "2026-10-05T02:06:12.000Z" })),
    ).toBe("6m 12s");
    expect(runDuration(run())).toBeUndefined();
    expect(formatCost(0.381)).toBe("$0.38");
    expect(formatCost(undefined)).toBeUndefined();
  });

  it("formats run dates", () => {
    expect(formatRunDate(new Date(2026, 9, 6, 2, 0))).toBe("Tue 10-06 02:00");
  });
});

describe("paths", () => {
  it("uses the shared folder when all triggers live in one directory", () => {
    expect(
      triggerFolderLabel([
        trigger({ definition_ref: "ops/triggers/a.trigger.yaml" }),
        trigger({ definition_ref: "ops/triggers/b.trigger.yaml" }),
      ]),
    ).toBe("ops/triggers/");
    expect(
      triggerFolderLabel([
        trigger({ definition_ref: "a/x.trigger.yaml" }),
        trigger({ definition_ref: "b/y.trigger.yaml" }),
      ]),
    ).toBe("triggers/");
    expect(triggerFolderLabel([])).toBe("triggers/");
  });

  it("falls back to a conventional file path", () => {
    expect(triggerFilePath({ id: "x", definition_ref: "" })).toBe("triggers/x.trigger.yaml");
    expect(triggerFilePath({ id: "x", definition_ref: "a/x.trigger.yaml" })).toBe(
      "a/x.trigger.yaml",
    );
  });
});

describe("inspector helpers", () => {
  it("lists behavior notes per kind", () => {
    expect(triggerBehaviorNotes("schedule")).toHaveLength(2);
    expect(triggerBehaviorNotes("event")).toEqual([
      "If all agent slots are busy the run is queued.",
    ]);
    expect(triggerBehaviorNotes("manual")).toEqual(["Nothing runs until you fire it."]);
  });

  it("shows only event config keys that exist", () => {
    expect(
      triggerEventFields(
        trigger({
          kind: "event",
          event: { source: "webhook", config: { secretRef: "env:HOOK", header: "X-Sig", n: 1 } },
        }),
      ),
    ).toEqual([
      ["secretRef", "env:HOOK"],
      ["header", "X-Sig"],
    ]);
  });

  it("duplicates with a -copy id", () => {
    expect(duplicateTrigger(trigger()).id).toBe("t1-copy");
  });
});
